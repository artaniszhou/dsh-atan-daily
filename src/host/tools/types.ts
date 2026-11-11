/**
 * 工具注册用的最小宿主面。
 *
 * 插件只依赖 `ctx.tools.register`，其余能力（仓库、渲染）由工具实现的依赖注入。
 */

import type { TaskRepository } from '../repository.js'

/** 宿主提供的工具注册表。 */
export interface ToolContext {
  tools: {
    register: (definition: unknown) => unknown
  }
}

/** 工具依赖。 */
export interface ToolDeps {
  repository: TaskRepository
  pluginVersion: string
}
