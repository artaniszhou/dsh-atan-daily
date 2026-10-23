/**
 * 机器人服务：把"扫码 / 手工凭据 / 发报告"收在一处。
 *
 * 三条不变量：
 *  - secret 只进 `ctx.credentials`，`bots.json` 与任何响应里都没有；
 *  - 目标只有一个：扫码人的 open_id（发件箱模型，不需要接收消息）；
 *  - 发送失败不抛，返回稳定错误码给调用方记录。
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { BotsStatus, BotView, ProvisionView, TaskRecord } from '../../protocol.js'
import type { CredentialsPort, Logger } from '../ports.js'
import { reportPathOf } from '../tasks/archive.js'
import { FeishuError, type FeishuClient } from './feishu-api.js'
import { FeishuProvisioner, type RegisterApp } from './feishu.js'
import { BotStore } from './store.js'
import { maskAppId, type BotRecord, type SendOutcome } from './types.js'

/** 接入成功后发给扫码人的第一条消息。 */
export const WELCOME_TEXT = '阿碳日报已接入。之后任务报告会发到这个对话里。'

/**
 * 一份报告在对话里的抬头：任务名 + 报告名。
 *
 * 只作为文本消息发出，报告文件（本地名与飞书里的文档名）保持原样。
 * @param task - 任务视图。
 * @param report - 报告文件名。
 * @returns 抬头文本。
 */
export function reportTitleOf(task: Pick<TaskRecord, 'name'>, report: string): string {
  return `${task.name} · ${report}`
}

/** 飞书单文件上限（30 MB）。 */
export const MAX_FILE_BYTES = 30 * 1024 * 1024

/** 服务依赖。 */
export interface BotServiceDeps {
  store: BotStore
  credentials: CredentialsPort
  client: FeishuClient
  logger: Logger
  now?: () => number
  /** 覆盖扫码状态机（测试注入）。 */
  provisioner?: FeishuProvisioner
  /** 覆盖飞书 SDK 的 registerApp；与 provisioner 二选一。 */
  registerApp?: RegisterApp
  /** 覆盖二维码编码；测试注入。 */
  makeQr?: (url: string) => Promise<string>
}

/** 对外接口。 */
export interface BotService {
  status: () => Promise<BotsStatus>
  /** `name` 会写进飞书应用名，也是本机展示名；接入后不可修改。 */
  beginProvision: (name?: string) => Promise<ProvisionView>
  pollProvision: (attemptId: string) => Promise<ProvisionView>
  cancelProvision: (attemptId: string) => Promise<ProvisionView>
  remove: (botId: string) => Promise<BotsStatus>
  /**
   * 任务报告发给它绑定的每个机器人。
   * @param task - 任务视图。
   * @param report - 本次运行的报告名；缺省用 `task.report`（兼容旧调用）。
   */
  sendReport: (task: TaskRecord, report?: string) => Promise<SendOutcome>
  /** 关闭（取消进行中的扫码）。 */
  close: () => void
}

/**
 * 由 app_id 派生稳定标识。
 * @param appId - 飞书应用 id。
 * @returns botId 与凭据 key。
 */
export function deriveIdentity(appId: string): { botId: string, secretRef: string } {
  const digest = createHash('sha256').update(appId).digest('hex')
  return {
    botId: `fs_${digest.slice(0, 16)}`,
    secretRef: `ATAN_FEISHU_${digest.slice(0, 12).toUpperCase()}`,
  }
}

/** 记录转视图：去掉 secretRef 与完整 app_id。 */
function toView(record: BotRecord): BotView {
  return {
    botId: record.botId,
    channel: record.channel,
    name: record.name,
    appIdMasked: maskAppId(record.platformId),
    domain: record.domain,
    createdAt: record.createdAt,
    lastSend: record.lastSend ?? null,
  }
}

/**
 * 创建服务。
 * @param deps - 存储、凭据、客户端与日志。
 * @returns 机器人服务。
 */
export function createBotService(deps: BotServiceDeps): BotService {
  const now = deps.now ?? Date.now
  const at = (): string => new Date(now()).toISOString()

  const provisioner = deps.provisioner ?? new FeishuProvisioner({
    onCredentials: async input => {
      await activate({
        appId: input.appId,
        appSecret: input.appSecret,
        ownerId: input.ownerId,
        domain: input.domain,
        ...input.name === undefined ? {} : { name: input.name },
      })
    },
    ...deps.registerApp === undefined ? {} : { registerApp: deps.registerApp },
    ...deps.makeQr === undefined ? {} : { makeQr: deps.makeQr },
  })

  /** 写凭据、存记录、发欢迎消息；任一步失败都尽量回滚。 */
  async function activate(input: {
    appId: string
    appSecret: string
    ownerId: string
    domain: 'feishu' | 'lark'
    /** 用户自定义名称；存成本地别名，不改飞书侧。 */
    name?: string
  }): Promise<BotRecord> {
    const identity = deriveIdentity(input.appId)
    const app = { appId: input.appId, appSecret: input.appSecret, domain: input.domain }

    try {
      await deps.credentials.set(identity.secretRef, input.appSecret)
    } catch (error: unknown) {
      throw new Error(`无法保存凭据：${error instanceof Error ? error.message : String(error)}`)
    }

    const info = await deps.client.botInfo(app)
    const record: BotRecord = {
      botId: identity.botId,
      channel: 'feishu',
      platformId: input.appId,
      secretRef: identity.secretRef,
      ownerId: input.ownerId,
      domain: input.domain,
      // 接入时定名：用户填的优先，否则用飞书应用名。之后不再提供改名。
      name: input.name ?? info?.name ?? '飞书机器人',
      createdAt: at(),
    }

    try {
      await deps.store.put(record)
    } catch (error: unknown) {
      await deps.credentials.unset(identity.secretRef).catch(() => {})
      throw new Error(`无法保存机器人配置：${error instanceof Error ? error.message : String(error)}`)
    }

    // 欢迎消息同时充当"发送链路"的验证：失败不阻断接入，但会被记录下来。
    try {
      await deps.client.sendText(app, input.ownerId, WELCOME_TEXT)
      await deps.store.update(record.botId, { lastSend: { at: at(), ok: true } })
    } catch (error: unknown) {
      const code = error instanceof FeishuError ? error.code : 'welcome_failed'
      deps.logger.warn(`欢迎消息发送失败（${code}）`)
      await deps.store.update(record.botId, { lastSend: { at: at(), ok: false, code } }).catch(() => {})
    }
    return record
  }

  /** 读取一个可用机器人的凭据；不可用时给出稳定码。 */
  async function resolveBot(botId: string): Promise<
    | { ok: true, bot: BotRecord, secret: string }
    | { ok: false, outcome: SendOutcome }
  > {
    const bot = await deps.store.get(botId)
    if (bot === undefined) {
      return { ok: false, outcome: { ok: false, code: 'bot_missing', message: '任务绑定的机器人已不存在。' } }
    }
    const hit = await deps.credentials.resolve(bot.secretRef)
    if (hit === undefined || hit.value === undefined || hit.value === '') {
      return { ok: false, outcome: { ok: false, code: 'credentials_missing', message: '机器人凭据丢失，请重新接入。' } }
    }
    return { ok: true, bot, secret: hit.value }
  }

  return {
    async status(): Promise<BotsStatus> {
      const bots = (await deps.store.list()).map(toView)
      return { bots, provisioning: await provisioner.current() }
    },

    beginProvision: (name?: string) => provisioner.start(name === undefined || name === '' ? {} : { name }),

    pollProvision: attemptId => provisioner.poll(attemptId),

    cancelProvision: attemptId => provisioner.cancel(attemptId),

    async remove(botId: string): Promise<BotsStatus> {
      const bot = await deps.store.get(botId)
      if (bot !== undefined) {
        await deps.credentials.unset(bot.secretRef).catch(() => {})
        await deps.store.remove(botId)
      }
      return await this.status()
    },

    async sendReport(task: TaskRecord, reportName?: string): Promise<SendOutcome> {
      const botIds = task.pushBotIds
      const total = botIds.length
      if (total === 0) return { ok: false, code: 'no_bot', sent: 0, total }

      // 先把目标解析出来：机器人被移除或凭据丢失时，错误码比"报告不存在"更有用。
      let firstFailure: SendOutcome | undefined
      const targets: Array<{ bot: BotRecord, secret: string }> = []
      for (const botId of botIds) {
        const resolved = await resolveBot(botId)
        if (resolved.ok) targets.push({ bot: resolved.bot, secret: resolved.secret })
        else firstFailure ??= resolved.outcome
      }
      if (targets.length === 0) {
        return { ...(firstFailure ?? { ok: false, code: 'no_bot' }), sent: 0, total }
      }

      const report = reportName ?? task.report
      if (report === undefined || report === '') {
        return { ok: false, code: 'report_missing', message: '本次运行没有生成报告。', sent: 0, total }
      }
      // 报告可能已经被下一轮运行归档进 history/，两处都要找。
      const path = await reportPathOf(task.folder, report)
      if (path === undefined) {
        return { ok: false, code: 'report_missing', message: `报告文件不存在：${report}`, sent: 0, total }
      }
      let bytes: Buffer
      try {
        bytes = await readFile(path)
      } catch {
        return { ok: false, code: 'report_missing', message: `报告文件不存在：${report}`, sent: 0, total }
      }
      if (bytes.byteLength > MAX_FILE_BYTES) {
        return { ok: false, code: 'file_too_large', message: '报告超过 30 MB，飞书拒绝上传。', sent: 0, total }
      }
      const title = reportTitleOf(task, report)

      // 一个任务可以推给多个机器人：文件只读一次，上传与发送逐个来，
      // 单个失败不打断其余目标。
      let sent = 0
      for (const { bot, secret } of targets) {
        const app = { appId: bot.platformId, appSecret: secret, domain: bot.domain }
        try {
          const fileKey = await deps.client.uploadFile(app, report, new Uint8Array(bytes))
          // 抬头是一行普通文本，发在文件前面；它失败不影响文件本身送达。
          await deps.client.sendText(app, bot.ownerId, title).catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error)
            deps.logger.warn(`报告抬头发送失败（${bot.botId}）：${message}`)
          })
          await deps.client.sendFile(app, bot.ownerId, fileKey)
          await deps.store.update(bot.botId, { lastSend: { at: at(), ok: true } }).catch(() => {})
          sent += 1
        } catch (error: unknown) {
          const code = error instanceof FeishuError ? error.code : 'send_failed'
          const message = error instanceof Error ? error.message : String(error)
          deps.logger.warn(`报告推送失败（${code}）：${message}`)
          await deps.store.update(bot.botId, { lastSend: { at: at(), ok: false, code } }).catch(() => {})
          firstFailure ??= { ok: false, code, message }
        }
      }

      if (sent === total) return { ok: true, sent, total }
      return { ...(firstFailure ?? { ok: false, code: 'send_failed' }), sent, total }
    },

    close: () => { provisioner.close() },
  }
}
