/**
 * HTTP 传输细节：写 JSON、读 body、把领域错误映射成响应。
 *
 * 路由只处理 GET/POST/PATCH/DELETE，其余方法明确回答 405 —— 不再出现
 * 未响应导致连接挂住的情况。
 */

import { AppError, appErrorOf, errorBodyOf } from '../errors.js'
import type { Logger, RouteHandler, RouteRequest, RouteResponse } from '../ports.js'

/** 单次请求体上限。 */
const MAX_BODY_BYTES = 2 * 1024 * 1024

/**
 * 写一条 JSON 响应。
 * @param response - Node 响应。
 * @param status - HTTP 状态码。
 * @param payload - 响应体。
 */
export function answer(response: RouteResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(body, 'utf8')),
  })
  response.end(body)
}

/**
 * 读取并解析 JSON 请求体。
 * @param request - 请求。
 * @returns 解析值；空 body 返回 undefined。
 * @throws AppError 当 body 过大或不是合法 JSON。
 */
export async function readJsonBody(request: RouteRequest): Promise<unknown> {
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of request) {
    total += chunk.byteLength
    if (total > MAX_BODY_BYTES) {
      throw new AppError('invalid_input', 413, `request body exceeds ${String(MAX_BODY_BYTES)} bytes`)
    }
    chunks.push(chunk)
  }
  if (total === 0) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new AppError('invalid_input', 400, 'request body is not valid JSON')
  }
}

/**
 * 把任意抛出值写成错误响应。
 * @param response - Node 响应。
 * @param error - 捕获值。
 * @param logger - 可选的诊断日志。
 */
export function answerError(response: RouteResponse, error: unknown, logger?: Logger): void {
  const appError = appErrorOf(error)
  if (appError.status >= 500) logger?.warn(`${appError.code}: ${appError.message}`)
  answer(response, appError.status, errorBodyOf(error))
}

/**
 * 405 响应。
 * @param response - Node 响应。
 * @param method - 实际方法。
 */
export function methodNotAllowed(response: RouteResponse, method: string): void {
  answer(response, 405, { ok: false, code: 'invalid_input', error: `method ${method} is not allowed` })
}

/**
 * 包一层错误映射，路由函数只写成功路径。
 * @param handler - 业务处理器。
 * @param logger - 诊断日志。
 * @returns 不会抛出的路由处理器。
 */
export function guard(handler: RouteHandler, logger: Logger): RouteHandler {
  return async (request, response) => {
    try {
      await handler(request, response)
    } catch (error: unknown) {
      answerError(response, error, logger)
    }
  }
}

/** 请求 URL 的 pathname；解析失败时返回 `/`。 */
export function pathnameOf(request: RouteRequest): string {
  try {
    return new URL(request.url ?? '/', 'http://atan-daily.invalid').pathname
  } catch {
    return '/'
  }
}
