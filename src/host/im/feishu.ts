/**
 * 飞书的扫码接入（设备码流程）。
 *
 * 官方 SDK 的 `registerApp` 实现了 OAuth 2.0 Device Authorization Grant：
 * 它回调一个带一次性 code 的验证链接，我们把它渲染成二维码；用户扫码确认后
 * SDK 直接返回 app_id / app_secret 与扫码人的 open_id。
 *
 * 这里把它包成"开始 → 轮询 → 取消"的短状态机，与 dsh-im 的做法一致：
 *  - `start()` 只等到二维码就绪就返回，绝不 await 整个扫码过程；
 *  - 新的一次开始会让旧的失效（attempt id 判等）；
 *  - 过期由本地定时器判定，不等平台报错；
 *  - 拿到凭据后进入 `saving`，写盘期间二维码立刻从公开状态里消失。
 */

import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import type { ImError, ProvisionState, ProvisionView } from '../../protocol.js'
import { qrDataUrl } from './qr.js'

/** SDK 返回的形状（只声明用到的字段）。 */
interface RegisterAppResult {
  client_id?: unknown
  client_secret?: unknown
  user_info?: unknown
}

/** SDK 回调参数。 */
interface QrReadyInfo {
  url?: unknown
  expireIn?: unknown
}

/** 状态回调参数。 */
interface StatusInfo {
  status?: unknown
  interval?: unknown
}

/** 注入点：默认是官方 SDK 的 registerApp。 */
export type RegisterApp = (options: Record<string, unknown>) => Promise<RegisterAppResult>

/** 定时器句柄。 */
export interface TimerHandle {
  cancel: () => void
}

/** 定时器注入点。 */
export type SetTimer = (callback: () => void, delayMs: number) => TimerHandle

/** 扫码成功后交给上层的凭据。 */
export interface ScannedCredentials {
  appId: string
  appSecret: string
  ownerId: string
  domain: 'feishu' | 'lark'
  /** 用户在扫码前填的名称；空表示用飞书应用名。 */
  name?: string
}

/** 构造参数。 */
export interface FeishuProvisionerDeps {
  /** 收到凭据后的落地动作（写凭据库 + 存记录 + 发欢迎消息）。 */
  onCredentials: (input: ScannedCredentials) => Promise<void>
  /** 覆盖 SDK；测试注入。 */
  registerApp?: RegisterApp
  /** 覆盖二维码编码；测试注入。 */
  makeQr?: (url: string) => Promise<string>
  now?: () => number
  setTimer?: SetTimer
  /** 等二维码就绪的上限。 */
  qrWaitMs?: number
  /** 二维码轮询间隔（服务端也可以要求降速）。 */
  pollIntervalMs?: number
}

/** 一次尝试的完整状态。 */
interface Attempt {
  id: string
  controller: AbortController
  state: ProvisionState
  qrUrl: string | null
  expiresAt: number | null
  pollIntervalMs: number
  /** 扫码前填的名称，成功后作为本地别名。 */
  name?: string
  error?: ImError
  timer?: TimerHandle
  ready: Promise<void>
  settleReady: () => void
  failReady: (error: unknown) => void
  settled: boolean
}

/** 默认定时器。 */
const defaultSetTimer: SetTimer = (callback, delayMs) => {
  const handle = setTimeout(callback, delayMs)
  handle.unref?.()
  return { cancel: () => { clearTimeout(handle) } }
}

/**
 * 惰性加载官方 SDK。
 * @returns registerApp 函数。
 */
function loadRegisterApp(): RegisterApp {
  const require = createRequire(import.meta.url)
  const sdk = require('@larksuiteoapi/node-sdk') as { registerApp?: RegisterApp }
  if (typeof sdk.registerApp !== 'function') {
    throw new Error('@larksuiteoapi/node-sdk 没有导出 registerApp')
  }
  return sdk.registerApp
}

/** 稳定错误。 */
function publicError(code: string, message: string): ImError {
  return { code, message }
}

/** 把 SDK 抛出的错误映射成稳定码。 */
function mapFailure(error: unknown): ImError {
  const code = (error as { code?: unknown } | undefined)?.code
  if (code === 'expired_token') return publicError('qr_expired', '二维码已过期，请重新生成。')
  if (code === 'access_denied') return publicError('qr_denied', '授权被拒绝，请重新扫码。')
  if (code === 'abort') return publicError('qr_cancelled', '扫码已取消。')
  return publicError('qr_start_failed', '无法生成飞书二维码，请检查网络后重试。')
}

/** 只接受 https 的验证链接。 */
function safeUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.href : undefined
  } catch {
    return undefined
  }
}

/**
 * 飞书扫码状态机。
 */
export class FeishuProvisioner {
  private readonly deps: FeishuProvisionerDeps
  private readonly now: () => number
  private readonly setTimer: SetTimer
  private readonly attempts = new Map<string, Attempt>()
  private activeId: string | null = null
  private closed = false

  constructor(deps: FeishuProvisionerDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
    this.setTimer = deps.setTimer ?? defaultSetTimer
  }

  /**
   * 开始一次扫码，等到二维码就绪后返回。
   * @param options - 可选的自定义名称（同时预填到飞书应用名）。
   * @returns 公开快照（含 data URL）。
   */
  async start(startOptions: { name?: string } = {}): Promise<ProvisionView> {
    if (this.closed) throw new Error('飞书扫码已关闭')
    this.supersede()
    const name = startOptions.name?.trim() === '' ? undefined : startOptions.name?.trim()

    let settleReady: () => void = () => {}
    let failReady: (error: unknown) => void = () => {}
    const ready = new Promise<void>((resolve, reject) => {
      settleReady = resolve
      failReady = reject
    })
    const attempt: Attempt = {
      id: randomUUID(),
      controller: new AbortController(),
      state: 'starting',
      qrUrl: null,
      expiresAt: null,
      pollIntervalMs: this.deps.pollIntervalMs ?? 1500,
      ...name === undefined ? {} : { name },
      ready,
      settleReady,
      failReady,
      settled: false,
    }
    this.attempts.set(attempt.id, attempt)
    this.activeId = attempt.id
    this.prune()

    const registerApp = this.deps.registerApp ?? loadRegisterApp()
    const options: Record<string, unknown> = {
      source: 'atan-daily',
      createOnly: true,
      appPreset: {
        // 用户填了就用它（{user} 仍会被替换），否则给一个默认名。
        name: name ?? '{user} 的阿碳日报',
        desc: '把定时任务的报告文件发到飞书对话里。',
      },
      // 只申请"发消息"和"上传文件"两条权限：不接收、不建卡、不下载用户文件。
      addons: {
        preset: false,
        scopes: { tenant: ['im:message:send_as_bot', 'im:resource'] },
      },
      signal: attempt.controller.signal,
      onQRCodeReady: (info: QrReadyInfo) => { this.onQrReady(attempt, info) },
      onStatusChange: (info: StatusInfo) => { this.onStatus(attempt, info) },
    }

    const task = Promise.resolve()
      .then(() => registerApp(options))
      .then(
        result => this.onSuccess(attempt, result),
        error => this.onFailure(attempt, error),
      )
    void task

    const timeoutMs = this.deps.qrWaitMs ?? 20_000
    try {
      await this.raceReady(attempt, ready, timeoutMs)
    } catch (error: unknown) {
      if (attempt.state === 'starting') {
        this.finish(attempt, 'failed', publicError('qr_start_failed', '无法生成飞书二维码，请稍后重试。'))
        attempt.controller.abort()
      }
      throw error
    }
    return await this.view(attempt)
  }

  /**
   * 读一次快照；不会触发任何外部请求（SDK 自己轮询）。
   * @param attemptId - 尝试 id。
   */
  async poll(attemptId: string): Promise<ProvisionView> {
    const attempt = this.attempts.get(attemptId)
    if (attempt === undefined) throw new Error('no such provisioning attempt')
    return await this.view(attempt)
  }

  /**
   * 取消一次尝试。
   * @param attemptId - 尝试 id。
   */
  async cancel(attemptId: string): Promise<ProvisionView> {
    const attempt = this.attempts.get(attemptId)
    if (attempt === undefined) throw new Error('no such provisioning attempt')
    if (!this.terminal(attempt.state)) {
      attempt.controller.abort()
      this.finish(attempt, 'cancelled', publicError('qr_cancelled', '扫码已取消。'))
    }
    return await this.view(attempt)
  }

  /** 当前是否有进行中的尝试。 */
  async current(): Promise<ProvisionView | null> {
    const attempt = this.activeId === null ? undefined : this.attempts.get(this.activeId)
    if (attempt === undefined) return null
    if (this.terminal(attempt.state)) return null
    return await this.view(attempt)
  }

  /** 关闭：取消进行中的尝试。 */
  close(): void {
    this.closed = true
    if (this.activeId !== null) {
      const attempt = this.attempts.get(this.activeId)
      if (attempt !== undefined) {
        attempt.controller.abort()
        this.cancelTimer(attempt)
      }
    }
  }

  /** 让上一个尝试失效。 */
  private supersede(): void {
    if (this.activeId === null) return
    const previous = this.attempts.get(this.activeId)
    if (previous === undefined) return
    this.cancelTimer(previous)
    previous.controller.abort()
    if (!this.terminal(previous.state)) {
      previous.state = 'cancelled'
      previous.error = publicError('qr_cancelled', '扫码已取消。')
    }
    this.activeId = null
  }

  /** 只保留最近 10 次尝试。 */
  private prune(): void {
    if (this.attempts.size <= 10) return
    const oldest = this.attempts.keys().next().value
    if (oldest !== undefined) this.attempts.delete(oldest)
  }

  /** 等二维码就绪，或失败/超时。 */
  private async raceReady(attempt: Attempt, ready: Promise<void>, timeoutMs: number): Promise<void> {
    let timer: TimerHandle | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = this.setTimer(() => {
        reject(new Error('timeout waiting for the Feishu QR code'))
      }, timeoutMs)
    })
    try {
      await Promise.race([
        ready,
        timeout,
        new Promise<never>((_resolve, reject) => {
          attempt.controller.signal.addEventListener('abort', () => {
            reject(new Error('provisioning aborted'))
          }, { once: true })
        }),
      ])
    } finally {
      timer?.cancel()
    }
  }

  /** SDK 报二维码就绪。 */
  private onQrReady(attempt: Attempt, info: QrReadyInfo): void {
    if (this.activeId !== attempt.id || this.terminal(attempt.state)) return
    const url = safeUrl(info.url)
    const seconds = Number(info.expireIn)
    if (url === undefined || !Number.isFinite(seconds) || seconds <= 0) {
      this.finish(attempt, 'failed', publicError('qr_start_failed', '飞书返回了无效的二维码。'))
      attempt.failReady(new Error('invalid QR code payload'))
      return
    }
    attempt.qrUrl = url
    attempt.expiresAt = this.now() + seconds * 1000
    attempt.state = 'waiting'
    this.cancelTimer(attempt)
    attempt.timer = this.setTimer(() => {
      if (this.terminal(attempt.state)) return
      this.finish(attempt, 'expired', publicError('qr_expired', '二维码已过期，请重新生成。'))
      attempt.controller.abort()
    }, seconds * 1000)
    if (!attempt.settled) {
      attempt.settled = true
      attempt.settleReady()
    }
  }

  /** SDK 报轮询状态变化：只关心降速。 */
  private onStatus(attempt: Attempt, info: StatusInfo): void {
    if (this.activeId !== attempt.id || this.terminal(attempt.state)) return
    if (info.status === 'slow_down') {
      const interval = Number(info.interval)
      if (Number.isFinite(interval) && interval > 0) {
        attempt.pollIntervalMs = Math.min(10_000, Math.max(800, Math.round(interval * 1000)))
      }
    }
  }

  /** SDK 返回凭据。 */
  private async onSuccess(attempt: Attempt, result: RegisterAppResult): Promise<void> {
    if (this.activeId !== attempt.id || this.terminal(attempt.state)) return
    const appId = typeof result.client_id === 'string' ? result.client_id : ''
    const appSecret = typeof result.client_secret === 'string' ? result.client_secret : ''
    const info = typeof result.user_info === 'object' && result.user_info !== null
      ? result.user_info as Record<string, unknown>
      : {}
    const ownerId = typeof info['open_id'] === 'string' ? info['open_id'] : ''
    if (appId === '' || appSecret === '' || ownerId === '') {
      this.finish(attempt, 'failed', publicError('qr_invalid_credentials', '飞书没有返回完整的凭据，请重新扫码。'))
      return
    }
    const domain: 'feishu' | 'lark' = info['tenant_brand'] === 'lark' ? 'lark' : 'feishu'

    this.cancelTimer(attempt)
    attempt.qrUrl = null
    attempt.expiresAt = null
    attempt.state = 'saving'
    try {
      await this.deps.onCredentials({
        appId,
        appSecret,
        ownerId,
        domain,
        ...attempt.name === undefined ? {} : { name: attempt.name },
      })
      this.finish(attempt, 'connected')
    } catch (error: unknown) {
      this.finish(attempt, 'failed', publicError(
        'credentials_save_failed',
        error instanceof Error ? `凭据保存失败：${error.message}` : '凭据保存失败。',
      ))
    }
  }

  /** SDK 失败。 */
  private onFailure(attempt: Attempt, error: unknown): void {
    if (this.activeId !== attempt.id || this.terminal(attempt.state)) return
    const mapped = mapFailure(error)
    this.finish(attempt, mapped.code === 'qr_expired' ? 'expired' : mapped.code === 'qr_cancelled' ? 'cancelled' : 'failed', mapped)
    if (!attempt.settled) {
      attempt.settled = true
      attempt.failReady(error)
    }
  }

  /** 落到终态并清理。 */
  private finish(attempt: Attempt, state: ProvisionState, error?: ImError): void {
    this.cancelTimer(attempt)
    attempt.state = state
    if (error !== undefined) attempt.error = error
    if (this.activeId === attempt.id && this.terminal(state)) this.activeId = null
  }

  /** 清掉过期定时器。 */
  private cancelTimer(attempt: Attempt): void {
    attempt.timer?.cancel()
    attempt.timer = undefined
  }

  /** 是否终态。 */
  private terminal(state: ProvisionState): boolean {
    return state === 'connected' || state === 'expired' || state === 'failed' || state === 'cancelled'
  }

  /** 组装公开快照（二维码按需编码）。 */
  private async view(attempt: Attempt): Promise<ProvisionView> {
    const view: ProvisionView = {
      attemptId: attempt.id,
      state: attempt.state,
      pollIntervalMs: attempt.pollIntervalMs,
    }
    if (attempt.qrUrl !== null && !this.terminal(attempt.state)) {
      const encode = this.deps.makeQr ?? qrDataUrl
      view.qrCodeDataUrl = await encode(attempt.qrUrl)
      if (attempt.expiresAt !== null) view.expiresAt = attempt.expiresAt
    }
    if (attempt.error !== undefined) view.error = attempt.error
    return view
  }
}

/** 供测试注入默认依赖。 */
export const __testing = { loadRegisterApp, mapFailure, safeUrl }
