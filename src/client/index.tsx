/**
 * Client 半边的唯一入口。
 *
 * 构建产物会被 tsdown 包成：
 *   window.__ModuleLoader__.load({ id, factory: (require) => { ... return module.exports } })
 * 因此这里**不**手写 `__ModuleLoader__.load`，只导出 Cordis 需要的 `inject` / `apply`。
 */
import { createApi } from './api/tasks.ts'
import { reportFailure } from './app/failure.tsx'
import { registerPlugin } from './plugin/register.tsx'
import type { ClientContext } from './plugin/context.ts'

/** 必须在 apply 之前就绪的宿主服务。 */
export const inject = ['slots', 'locale', 'uiWorkspace', 'layout']

/**
 * 插件启动。
 * @param ctx - 宿主注入的 client 上下文。
 */
export function apply(ctx: ClientContext): void {
  try {
    registerPlugin(ctx, createApi())
  } catch (error) {
    // 启动失败也要在页面上留下可诊断的信息，而不是静默白屏。
    reportFailure('apply', error)
  }
}
