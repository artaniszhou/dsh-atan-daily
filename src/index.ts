/**
 * Host 半边的包入口。
 *
 * 只做 re-export：`package.json` 的 `exports["."]` 与 DSH profile 都按包根加载
 * `lib/index.js`，入口路径是包契约的一部分。真正的装配在 `host/plugin.ts`，
 * 领域代码在 `core/`，HTTP/服务在 `host/`。
 */

export { apply, inject } from './host/plugin.js'
export type { Config } from './host/config.js'
/** 共享契约里的展示类型，保留旧的入口再导出，避免下游类型引用断裂。 */
export type { Frequency, TaskRecord } from './protocol.js'
