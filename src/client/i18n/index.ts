/**
 * 文案绑定与翻译。
 *
 * 设计要点：
 *  - `zh.ts` 是唯一真源，`CopyKey` 由它推导，`en.ts` 在编译期被约束；
 *  - `apply()` 里把 `ctx.locale.bind(namespace)` 绑定进来，运行期切语言即时生效；
 *  - 没绑定（独立测试、宿主降级）时回退到本地字典，绝不显示 `undefined`。
 */
import { en } from './en.ts'
import { zh, type CopyKey } from './zh.ts'

export type { CopyKey } from './zh.ts'

/** 本插件在 locale 服务里占用的命名空间。 */
export const NAMESPACE = 'atanDaily'

/** 注册给 `ctx.locale.register` 的字典表。 */
export const DICTIONARIES = { zh, en }

/** 翻译函数签名；`{name}` 占位符由参数替换。 */
export type Translator = (key: CopyKey, params?: Record<string, string | number>) => string

/** `ctx.locale.bind` 的窄接口，避免把整个 locale 服务带进每个模块。 */
export type LocaleBinder = (namespace: string) => (key: string, params?: Record<string, string | number>) => string

/** 宿主注入的翻译器；未注入时为 undefined。 */
let bound: ((key: string, params?: Record<string, string | number>) => string) | undefined

/**
 * 绑定宿主的 locale 服务。
 * @param bind - `ctx.locale.bind`，只依赖这一个方法。
 */
export function attachLocale(bind: LocaleBinder): void {
  bound = bind(NAMESPACE)
}

/**
 * 翻译一个键。
 *
 * 宿主返回键本身表示“该命名空间没有这条文案”（未注册/语言缺失），此时回退到
 * 本地中文，保证界面永远有可读文字。
 * @param key - 文案键。
 * @param params - `{name}` 占位符的替换值。
 * @returns 插值后的文案。
 */
export function t(key: CopyKey, params?: Record<string, string | number>): string {
  let text = bound?.(key, params)
  if (typeof text !== 'string' || text === '' || text === key) {
    text = (zh as Record<string, string>)[key] ?? key
  }
  if (params !== undefined) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, String(value))
    }
  }
  return text
}
