/**
 * 机器人记录的持久化。
 *
 * 只存非密信息（secret 在 `ctx.credentials`）。读写都走原子写，文件权限尽量
 * 收到 0600；Windows 上 chmod 基本无效，但写代码不能假设用户永远在 Windows。
 */

import { chmod, readFile } from 'node:fs/promises'
import { writeAtomic } from '../../core/fs.js'
import type { ImChannel } from '../../protocol.js'
import type { BotRecord } from './types.js'

/** 文档版本；字段变动时递增并写迁移。 */
const VERSION = 1

/** 落盘形状。 */
interface StoreDocument {
  v: number
  bots: BotRecord[]
}

/** 一次读取的结果。 */
function parseDocument(text: string): BotRecord[] {
  const parsed = JSON.parse(text) as unknown
  if (typeof parsed !== 'object' || parsed === null) return []
  const document = parsed as Partial<StoreDocument>
  if (document.v !== VERSION || !Array.isArray(document.bots)) return []
  const bots: BotRecord[] = []
  for (const raw of document.bots) {
    if (typeof raw !== 'object' || raw === null) continue
    const row = raw as Partial<BotRecord>
    if (typeof row.botId !== 'string' || row.botId === '') continue
    if (typeof row.platformId !== 'string' || row.platformId === '') continue
    if (typeof row.secretRef !== 'string' || row.secretRef === '') continue
    if (typeof row.ownerId !== 'string' || row.ownerId === '') continue
    const channel: ImChannel = row.channel === 'feishu' ? 'feishu' : 'feishu'
    // 旧版本把用户起的名字存在 `alias`：迁移时优先用它，之后名字不再可改。
    const legacy = raw as { alias?: unknown }
    const displayName = typeof legacy.alias === 'string' && legacy.alias !== ''
      ? legacy.alias
      : typeof row.name === 'string' && row.name !== '' ? row.name : '飞书机器人'
    bots.push({
      botId: row.botId,
      channel,
      platformId: row.platformId,
      secretRef: row.secretRef,
      ownerId: row.ownerId,
      domain: row.domain === 'lark' ? 'lark' : 'feishu',
      name: displayName,
      createdAt: typeof row.createdAt === 'string' ? row.createdAt : new Date(0).toISOString(),
      ...typeof row.lastSend === 'object' && row.lastSend !== null
        ? {
            lastSend: {
              at: String((row.lastSend as { at?: unknown }).at ?? ''),
              ok: (row.lastSend as { ok?: unknown }).ok === true,
              ...typeof (row.lastSend as { code?: unknown }).code === 'string'
                ? { code: (row.lastSend as { code: string }).code }
                : {},
            },
          }
        : {},
    })
  }
  return bots
}

/** 机器人存储。 */
export class BotStore {
  private readonly path: string
  private readonly loaded: Promise<void>
  private bots: BotRecord[] = []
  private queue: Promise<void> = Promise.resolve()

  /**
   * @param path - `bots.json` 的绝对路径。
   */
  constructor(path: string) {
    this.path = path
    this.loaded = this.load()
  }

  /** 读取文件；文件不存在等价于空列表。 */
  private async load(): Promise<void> {
    try {
      this.bots = parseDocument(await readFile(this.path, 'utf8'))
    } catch (error: unknown) {
      // 文件不存在是正常的第一次启动；解析失败也不应让插件起不来。
      const code = (error as { code?: string }).code
      if (code !== 'ENOENT') this.bots = []
    }
  }

  /** 列出全部机器人（按创建时间倒序）。 */
  async list(): Promise<BotRecord[]> {
    await this.loaded
    return this.bots.slice().sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  }

  /** 读一个机器人。 */
  async get(botId: string): Promise<BotRecord | undefined> {
    await this.loaded
    return this.bots.find(bot => bot.botId === botId)
  }

  /** 新增或覆盖一个机器人。 */
  async put(record: BotRecord): Promise<void> {
    await this.mutate((bots) => {
      const index = bots.findIndex(bot => bot.botId === record.botId)
      if (index < 0) return [...bots, record]
      const next = bots.slice()
      next[index] = record
      return next
    })
  }

  /** 局部更新；不存在时返回 undefined。 */
  async update(botId: string, patch: Partial<BotRecord>): Promise<BotRecord | undefined> {
    let updated: BotRecord | undefined
    await this.mutate((bots) => {
      const index = bots.findIndex(bot => bot.botId === botId)
      if (index < 0) return bots
      const current = bots[index]
      if (current === undefined) return bots
      updated = { ...current, ...patch, botId: current.botId }
      const next = bots.slice()
      next[index] = updated
      return next
    })
    return updated
  }

  /** 删除一个机器人。 */
  async remove(botId: string): Promise<void> {
    await this.mutate(bots => bots.filter(bot => bot.botId !== botId))
  }

  /** 串行化读-改-写，避免并发扫码写入互相覆盖。 */
  private async mutate(operation: (bots: BotRecord[]) => BotRecord[]): Promise<void> {
    await this.loaded
    const run = this.queue.then(async () => {
      this.bots = operation(this.bots.slice())
      await this.flush()
    })
    this.queue = run.then(() => undefined, () => undefined)
    await run
  }

  /** 原子写盘。 */
  private async flush(): Promise<void> {
    const document: StoreDocument = { v: VERSION, bots: this.bots }
    await writeAtomic(this.path, `${JSON.stringify(document, null, 2)}\n`)
    await chmod(this.path, 0o600).catch(() => {})
  }
}
