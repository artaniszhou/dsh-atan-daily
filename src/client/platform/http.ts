/**
 * 浏览器侧的 HTTP 端口。
 *
 * 只做“把请求发出去”这一件事，超时、错误归一、JSON 解析都在 `api/http.ts`。
 * 单独抽出来是为了测试时能替换成假端口（不需要 mock 全局 fetch）。
 */

/** 一次响应里 client 真正需要的最小面。 */
export interface HttpResponse {
  readonly ok: boolean
  readonly status: number
  text(): Promise<string>
}

/** 请求初始化参数；只暴露 client 用得到的字段。 */
export interface HttpRequestInit {
  method?: string
  body?: string
  signal?: AbortSignal
  headers?: Record<string, string>
}

/** 一个可注入的 HTTP 端口。 */
export type HttpPort = (path: string, init?: HttpRequestInit) => Promise<HttpResponse>

/** 默认端口：直接用页面的 `fetch`。 */
export const browserHttp: HttpPort = (path, init) => fetch(path, init)
