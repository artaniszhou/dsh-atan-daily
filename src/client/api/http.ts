/**
 * HTTP 请求的唯一入口。
 *
 * 负责四件事，其余模块不再重复：
 *  1. 超时：用 `AbortController` 真正取消请求（不只是让 Promise 提前失败）；
 *  2. 响应归一：空 body、非 JSON、非 2xx 都变成带 `code` 的 {@link HostError}；
 *  3. 解码：把 `unknown` 交给调用方的 decoder，解码失败同样归为 `invalid-response`；
 *  4. 细节保留：Host 的 `error`/`message` 字段带进 `detail`，界面上能看到真实原因。
 */
import { REQUEST_TIMEOUT_MS } from '../constants.ts'
import type { HttpPort, HttpRequestInit } from '../platform/http.ts'
import { codeForStatus, HostError } from './errors.ts'

/**
 * 发一个请求并解码。
 * @param port - HTTP 端口（生产用 `browserHttp`，测试可注入假实现）。
 * @param path - 页面相对路径（不带前导斜杠，兼容反向代理前缀）。
 * @param decode - 把已解析的 JSON 转成目标类型；抛错表示响应形状不合法。
 * @param init - 方法、body 等。
 * @returns 解码后的值。
 */
export async function request<T>(
  port: HttpPort,
  path: string,
  decode: (payload: unknown) => T,
  init?: HttpRequestInit,
): Promise<T> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, REQUEST_TIMEOUT_MS)
  try {
    let response
    try {
      response = await port(path, { ...init, signal: controller.signal })
    } catch (error) {
      if (timedOut) throw new HostError('timeout', `请求超时：${path}`)
      throw new HostError('network', error instanceof Error ? error.message : String(error))
    }

    let text: string
    try {
      text = await response.text()
    } catch (error) {
      if (timedOut) throw new HostError('timeout', `读取响应超时：${path}`)
      throw new HostError('network', error instanceof Error ? error.message : String(error))
    }

    let payload: unknown = {}
    if (text.trim() !== '') {
      try {
        payload = JSON.parse(text)
      } catch {
        const snippet = text.replace(/\s+/gu, ' ').trim().slice(0, 120)
        throw new HostError('invalid-response', `Host 返回的不是 JSON：${path}`, response.status, snippet)
      }
    }

    const record = (payload ?? {}) as Record<string, unknown>
    if (!response.ok) {
      const detail = typeof record.error === 'string'
        ? record.error
        : typeof record.message === 'string' ? record.message : ''
      throw new HostError(
        codeForStatus(response.status),
        detail === '' ? `HTTP ${response.status}：${path}` : detail,
        response.status,
        detail,
      )
    }

    try {
      return decode(payload)
    } catch (error) {
      if (error instanceof HostError) throw error
      throw new HostError(
        'invalid-response',
        error instanceof Error ? error.message : String(error),
        response.status,
      )
    }
  } finally {
    clearTimeout(timer)
  }
}
