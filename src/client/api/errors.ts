/**
 * Host 错误的唯一表示。
 *
 * 约定：网络层只抛 {@link HostError}，并带上一个可分支的 `code`。
 * 界面需要显示文字时，通过 {@link hostErrorText} 把 code 映射到文案键，
 * 这样“时区非法”和“cron 非法”不会再被压成同一句“加载失败”。
 */
import type { CopyKey, Translator } from '../i18n/index.ts'

/** Host 交互中可能出现的一类失败。 */
export type HostErrorCode =
  | 'network'
  | 'timeout'
  | 'invalid-response'
  | 'http'
  | 'not-found'
  | 'conflict'
  | 'invalid-input'

/** 一次失败的完整描述。 */
export class HostError extends Error {
  /** 可分支的错误码。 */
  readonly code: HostErrorCode
  /** HTTP 状态码；网络层失败时没有。 */
  readonly status: number | undefined
  /** Host 返回的细节文本（可能为空）。 */
  readonly detail: string

  constructor(code: HostErrorCode, message: string, status?: number, detail = '') {
    super(message)
    this.name = 'HostError'
    this.code = code
    this.status = status
    this.detail = detail
  }
}

/** 把 HTTP 状态码归一到错误码。 */
export function codeForStatus(status: number): HostErrorCode {
  if (status === 400) return 'invalid-input'
  if (status === 404) return 'not-found'
  if (status === 409) return 'conflict'
  return 'http'
}

/** 文案键与参数。 */
export interface HostErrorDescriptor {
  key: CopyKey
  params?: Record<string, string | number>
  detail: string
}

/**
 * 把任意错误转成可显示的结构。
 * @param error - 捕获到的值。
 * @returns 文案键、插值参数与 Host 细节。
 */
export function describeHostError(error: unknown): HostErrorDescriptor {
  if (error instanceof HostError) {
    if (error.code === 'network') {
      // 浏览器给的是 "Failed to fetch" 这类实现文案，对用户没有信息量，
      // 只保留本地化的「无法连接 Host」；真正的排查细节看 Host 日志。
      return { key: 'errorNetwork', detail: '' }
    }
    if (error.code === 'timeout') return { key: 'errorTimeout', detail: '' }
    if (error.code === 'invalid-response') return { key: 'errorInvalidResponse', detail: error.message }
    if (error.code === 'not-found') return { key: 'errorNotFound', detail: error.detail }
    if (error.code === 'conflict') return { key: 'errorConflict', detail: error.detail }
    if (error.code === 'invalid-input') return { key: 'errorInvalidInput', detail: error.detail }
    return { key: 'errorHttp', params: { status: error.status ?? '-' }, detail: error.detail }
  }
  return { key: 'errorHttp', params: { status: '-' }, detail: error instanceof Error ? error.message : String(error) }
}

/**
 * 生成一条可直接渲染的错误文案。
 * @param error - 捕获到的值。
 * @param translate - 当前语言的翻译函数。
 * @returns 形如“Host 返回错误（HTTP 400）：unknown time zone”。
 */
export function hostErrorText(error: unknown, translate: Translator): string {
  const descriptor = describeHostError(error)
  const text = descriptor.key === 'errorHttp'
    ? translate(descriptor.key, descriptor.params)
    : translate(descriptor.key)
  const detail = descriptor.detail.trim()
  if (detail === '' || detail === text) return text
  return `${text}：${detail}`
}
