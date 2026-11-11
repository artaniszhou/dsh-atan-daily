/**
 * 工作目录与 Workspace。
 *
 * 只做三件事：`mkdir`、`store.ensure`、注册 Workspace。它不认识设置文件，
 * 「当前是哪个目录」由 `settings/hub` 决定，这里只按传入的路径干活。
 */

import { mkdir } from 'node:fs/promises'
import { normalize } from 'node:path'
import type { TaskListStore } from '../../core/task-list.js'
import type { WorkspaceRef } from '../../protocol.js'
import type { Logger, WorkspacePort } from '../ports.js'

/** 准备目录的结果。 */
export interface PreparedWorkDir {
  workspace?: WorkspaceRef
  workspaceError?: string
}

/** Workspace 服务。 */
export interface WorkspaceService {
  /** 路径上已注册的 Workspace。 */
  at(path: string): WorkspaceRef | undefined
  /** 建目录、确保注册表并注册 Workspace。 */
  prepare(path: string, store: TaskListStore): Promise<PreparedWorkDir>
}

/**
 * Normalize a path for comparison; Windows is case-insensitive, POSIX is not.
 * @param path - raw path.
 * @returns the comparison key.
 */
function pathKey(path: string): string {
  const normalized = normalize(path)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/**
 * 找到与路径匹配的已注册 Workspace。
 * @param workspaces - Workspace 注册表端口。
 * @param path - 绝对目录。
 * @returns 匹配项，或 undefined。
 */
export function workspaceAt(workspaces: WorkspacePort, path: string): WorkspaceRef | undefined {
  try {
    const target = pathKey(path)
    for (const workspace of workspaces.list()) {
      const row = workspace as { id?: unknown, path?: unknown, title?: unknown }
      if (typeof row.path !== 'string' || typeof row.id !== 'string') continue
      if (pathKey(row.path) !== target) continue
      return { id: row.id, title: typeof row.title === 'string' ? row.title : row.id }
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * 创建 Workspace 服务。
 * @param deps - Workspace 端口与日志。
 * @returns Workspace 服务。
 */
export function createWorkspaceService(deps: {
  workspaces: WorkspacePort
  logger: Logger
}): WorkspaceService {
  return {
    at(path: string): WorkspaceRef | undefined {
      return workspaceAt(deps.workspaces, path)
    },
    async prepare(path: string, store: TaskListStore): Promise<PreparedWorkDir> {
      await mkdir(path, { recursive: true })
      await store.ensure().catch((error: unknown) => {
        deps.logger.warn(`task list for ${path} could not be prepared: ${String(error)}`)
      })
      const existing = workspaceAt(deps.workspaces, path)
      if (existing !== undefined) return { workspace: existing }
      try {
        const title = path.split(/[\\/]/u).filter(part => part !== '').pop()
        const created = await deps.workspaces.create(path, title)
        const row = created as { id?: unknown, title?: unknown }
        return {
          workspace: {
            id: typeof row.id === 'string' ? row.id : '',
            title: typeof row.title === 'string' ? row.title : (title ?? path),
          },
        }
      } catch (error: unknown) {
        // 目录本身可用，保存照常成功；把注册失败原因如实带回页面。
        const message = error instanceof Error ? error.message : String(error)
        deps.logger.warn(`workspace registration failed for ${path}: ${message}`)
        return { workspaceError: message }
      }
    },
  }
}
