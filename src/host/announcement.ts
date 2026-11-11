/**
 * 页面公告：Host 侧代理。
 *
 * 远端是 atan-admin-server 的 `/api/atan-daily/announcement/current`，返回
 * `{ code, msg, data }` 信封。字段名与信封都收敛在这里，页面拿到的永远是扁平
 * 的 {@link AnnouncementView}；将来远端换字段只改这个文件。
 *
 * 失败策略：Throw `AppError`，页面静默隐藏公告，绝不影响任务列表与设置。
 */
import { HOST_ROUTES, type AnnouncementView } from '../protocol.js'
import { AppError } from './errors.js'
import { answer, methodNotAllowed } from './http/server.js'
import type { Logger, RouteHandler } from './ports.js'

/** 缓存的存活时间；同一进程内多次打开页面不必每次都打远端。 */
const CACHE_TTL_MS = 30_000

/** 单次远端请求超时；公告是首屏附加信息，不能拖住页面。 */
const REMOTE_TIMEOUT_MS = 8_000

/** 没有公告时的标准视图。 */
const EMPTY: AnnouncementView = { enabled: false, title: '', content: '', updatedAt: null }

/** 代理需要的依赖。 */
export interface AnnouncementDeps {
  /** 任务仓库地址；空串表示未配置，直接当没有公告。 */
  serverBaseUrl: () => string
  logger: Logger
}

/** 代理对外暴露的两个方法。 */
export interface AnnouncementProxy {
  /** 注册到 webServer 的精确路由。 */
  handler: RouteHandler
  /** 清空缓存；测试与切换服务地址时用。 */
  invalidate: () => void
}

/**
 * 构造公告代理。
 * @param deps - 地址 getter 与日志。
 * @returns 路由处理器与缓存清理入口。
 */
export function createAnnouncementProxy(deps: AnnouncementDeps): AnnouncementProxy {
  let cache: { baseUrl: string, at: number, view: AnnouncementView } | null = null

  async function fetchRemote(baseUrl: string): Promise<AnnouncementView> {
    let response: Response
    try {
      response = await fetch(`${baseUrl}/api/atan-daily/announcement/current`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
      })
    } catch (error: unknown) {
      deps.logger.warn(`announcement fetch failed: ${error instanceof Error ? error.message : String(error)}`)
      throw new AppError('internal', 502, '公告服务暂不可用')
    }

    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      throw new AppError('internal', 502, '公告服务返回了无法解析的响应')
    }

    const envelope = asRecord(payload)
    // 业务码非 200 时同样按失败处理：page 侧只认 HTTP 成功 + 合法视图。
    if (!response.ok || envelope['code'] !== 200) {
      const message = typeof envelope['msg'] === 'string' ? envelope['msg'] : `公告服务返回 HTTP ${String(response.status)}`
      throw new AppError('internal', 502, message)
    }
    return decodeView(envelope['data'])
  }

  async function current(): Promise<AnnouncementView> {
    const baseUrl = deps.serverBaseUrl()
    // 没配地址就不发请求：新装用户不该看到「公告加载失败」。
    if (baseUrl === '') return EMPTY
    if (cache !== null && cache.baseUrl === baseUrl && Date.now() - cache.at < CACHE_TTL_MS) {
      return cache.view
    }
    const view = await fetchRemote(baseUrl)
    cache = { baseUrl, at: Date.now(), view }
    return view
  }

  const handler: RouteHandler = async (request, response) => {
    const method = request.method ?? 'GET'
    if (method !== 'GET') {
      methodNotAllowed(response, method)
      return
    }
    answer(response, 200, await current())
  }

  return {
    handler,
    invalidate: () => {
      cache = null
    },
  }
}

/** 远端可能出现的空对象。 */
function asRecord(payload: unknown): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new AppError('internal', 502, '公告服务返回格式不正确')
  }
  return payload as Record<string, unknown>
}

/**
 * 把远端 `data` 解码成页面视图。
 * @param payload - 远端 `data` 字段。
 * @returns 扁平视图；缺字段按「空」处理，但 `enabled` 必须是布尔。
 */
function decodeView(payload: unknown): AnnouncementView {
  const record = asRecord(payload)
  const enabled = record['enabled']
  if (typeof enabled !== 'boolean') {
    throw new AppError('internal', 502, '公告服务缺少 enabled 字段')
  }
  const title = typeof record['title'] === 'string' ? record['title'] : ''
  const content = typeof record['content'] === 'string' ? record['content'] : ''
  // 开关打开但标题与正文都空：视为没有公告，避免页面出现一个空卡片。
  // 只有标题空、正文还在时不在这里兜底——页面会用正文首行当标题，展开仍能看到全文。
  if (!enabled || (title.trim() === '' && content.trim() === '')) {
    return { enabled: false, title: '', content: '', updatedAt: null }
  }
  const updatedAt = typeof record['updatedAt'] === 'string' && record['updatedAt'] !== ''
    ? record['updatedAt']
    : null
  return { enabled: true, title, content, updatedAt }
}

/** 路由常量，供 plugin.ts 注册时复用。 */
export const ANNOUNCEMENT_ROUTE = HOST_ROUTES.announcement
