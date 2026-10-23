/**
 * 飞书 OpenAPI 的最小客户端：只做"发"。
 *
 * 用到的三个接口：
 *  - `POST /open-apis/auth/v3/tenant_access_token/internal` 换 token（缓存到过期前 5 分钟）
 *  - `POST /open-apis/im/v1/files` 上传文件拿 `file_key`
 *  - `POST /open-apis/im/v1/messages` 发消息（文本或文件）
 *
 * 不订阅事件、不建长连接、不需要公网地址。
 */

/** 一个飞书应用凭据。 */
export interface FeishuApp {
  appId: string
  appSecret: string
  domain: 'feishu' | 'lark'
}

/** 一次调用的可选信号。 */
export interface CallOptions {
  signal?: AbortSignal
}

/** 可直接展示的飞书错误。 */
export class FeishuError extends Error {
  readonly code: string
  readonly status?: number

  /**
   * @param code - 稳定错误码。
   * @param message - 可展示的说明。
   * @param status - 可选的 HTTP 状态。
   */
  constructor(code: string, message: string, status?: number) {
    super(message)
    this.name = 'FeishuError'
    this.code = code
    if (status !== undefined) this.status = status
  }
}

/** 默认域。 */
function baseUrl(domain: 'feishu' | 'lark'): string {
  return domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn'
}

/** 单次请求上限；飞书上传大文件可能慢一些，给 60s。 */
const REQUEST_TIMEOUT_MS = 60_000
/** token 提前刷新的余量。 */
const TOKEN_MARGIN_MS = 5 * 60_000

/** 读 JSON；非 2xx 或非 JSON 都归成 FeishuError。 */
async function readJson(response: Response, action: string): Promise<Record<string, unknown>> {
  let text: string
  try {
    text = await response.text()
  } catch {
    throw new FeishuError('feishu_unreadable', `${action}：响应无法读取`, response.status)
  }
  let body: unknown
  try {
    body = text.trim() === '' ? {} : JSON.parse(text)
  } catch {
    throw new FeishuError('feishu_invalid_json', `${action}：响应不是 JSON`, response.status)
  }
  const record = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
  if (!response.ok) {
    const msg = typeof record['msg'] === 'string' ? record['msg'] : `HTTP ${String(response.status)}`
    throw new FeishuError(`feishu_http_${String(response.status)}`, `${action}：${msg}`, response.status)
  }
  return record
}

/** 飞书业务码非 0 时抛错。 */
function assertOk(body: Record<string, unknown>, action: string): Record<string, unknown> {
  const code = body['code']
  if (code !== 0 && code !== undefined) {
    const msg = typeof body['msg'] === 'string' ? body['msg'] : 'unknown error'
    throw new FeishuError(`feishu_${String(code)}`, `${action}：${msg}`)
  }
  return body
}

/** 组合外部 signal 与超时。 */
function combined(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

/** 客户端接口。 */
export interface FeishuClient {
  /** 换 token（内部缓存）。 */
  token: (app: FeishuApp, options?: CallOptions) => Promise<string>
  /** 发一条文本。 */
  sendText: (app: FeishuApp, openId: string, text: string, options?: CallOptions) => Promise<void>
  /** 上传一个文件，返回 file_key。 */
  uploadFile: (app: FeishuApp, fileName: string, bytes: Uint8Array, options?: CallOptions) => Promise<string>
  /** 发一条文件消息。 */
  sendFile: (app: FeishuApp, openId: string, fileKey: string, options?: CallOptions) => Promise<void>
  /** 读机器人自身信息；失败返回 undefined（名称只是展示用）。 */
  botInfo: (app: FeishuApp, options?: CallOptions) => Promise<{ name?: string, openId?: string } | undefined>
  /** 丢弃某个应用的 token 缓存（凭据被重置后重试）。 */
  forget: (appId: string) => void
}

/**
 * 创建客户端。
 * @param deps - 可注入的 fetch 与时钟，便于测试。
 * @returns 客户端。
 */
export function createFeishuClient(deps: {
  fetchImpl?: typeof fetch
  now?: () => number
} = {}): FeishuClient {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  const now = deps.now ?? Date.now
  const tokens = new Map<string, { value: string, expiresAt: number }>()

  async function token(app: FeishuApp, options: CallOptions = {}): Promise<string> {
    const hit = tokens.get(app.appId)
    if (hit !== undefined && hit.expiresAt > now()) return hit.value
    const response = await fetchImpl(`${baseUrl(app.domain)}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: app.appId, app_secret: app.appSecret }),
      signal: combined(options.signal),
    })
    const body = assertOk(await readJson(response, '获取 tenant_access_token'), '获取 tenant_access_token')
    const value = body['tenant_access_token']
    if (typeof value !== 'string' || value === '') {
      throw new FeishuError('feishu_no_token', '飞书没有返回 tenant_access_token')
    }
    const expire = typeof body['expire'] === 'number' ? body['expire'] : 7200
    tokens.set(app.appId, { value, expiresAt: now() + Math.max(0, expire * 1000 - TOKEN_MARGIN_MS) })
    return value
  }

  async function botInfo(app: FeishuApp, options: CallOptions = {}): Promise<{ name?: string, openId?: string } | undefined> {
    try {
      const response = await fetchImpl(`${baseUrl(app.domain)}/open-apis/bot/v3/info/`, {
        method: 'GET',
        headers: { authorization: `Bearer ${await token(app, options)}` },
        signal: combined(options.signal),
      })
      const body = assertOk(await readJson(response, '读取机器人信息'), '读取机器人信息')
      const bot = body['bot']
      if (typeof bot !== 'object' || bot === null) return undefined
      const record = bot as Record<string, unknown>
      return {
        ...typeof record['app_name'] === 'string' ? { name: record['app_name'] } : {},
        ...typeof record['open_id'] === 'string' ? { openId: record['open_id'] } : {},
      }
    } catch {
      // 名称与 open_id 都不是发送的必需品；读不到就用默认名。
      return undefined
    }
  }

  async function sendMessage(
    app: FeishuApp,
    openId: string,
    msgType: string,
    content: Record<string, unknown>,
    options: CallOptions,
  ): Promise<void> {
    const response = await fetchImpl(`${baseUrl(app.domain)}/open-apis/im/v1/messages?receive_id_type=open_id`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await token(app, options)}`,
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ receive_id: openId, msg_type: msgType, content: JSON.stringify(content) }),
      signal: combined(options.signal),
    })
    assertOk(await readJson(response, '发送消息'), '发送消息')
  }

  return {
    token,
    botInfo,
    sendText: (app, openId, text, options = {}) => sendMessage(app, openId, 'text', { text }, options),
    sendFile: (app, openId, fileKey, options = {}) => sendMessage(app, openId, 'file', { file_key: fileKey }, options),
    uploadFile: async (app, fileName, bytes, options = {}) => {
      const form = new FormData()
      form.append('file_type', 'stream')
      form.append('file_name', fileName)
      // 复制成独立 ArrayBuffer：Blob 不接受带偏移的视图，且上传期间原缓冲可能被复用。
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
      form.append('file', new Blob([buffer]), fileName)
      const response = await fetchImpl(`${baseUrl(app.domain)}/open-apis/im/v1/files`, {
        method: 'POST',
        headers: { authorization: `Bearer ${await token(app, options)}` },
        body: form,
        signal: combined(options.signal),
      })
      const body = assertOk(await readJson(response, '上传文件'), '上传文件')
      const data = body['data']
      const fileKey = typeof data === 'object' && data !== null
        ? (data as Record<string, unknown>)['file_key']
        : undefined
      if (typeof fileKey !== 'string' || fileKey === '') {
        throw new FeishuError('feishu_no_file_key', '飞书没有返回 file_key')
      }
      return fileKey
    },
    forget: (appId) => { tokens.delete(appId) },
  }
}
