/**
 * 工作目录与 Workspace。
 *
 * 保存目录时只做三件事：`mkdir`、`store.ensure`、注册 Workspace。
 * legacy 迁移只对插件自有目录（`settingsRoot` 下或配置的 defaultWorkDir）执行，
 * 任意用户仓库目录不会被移动文件。
 */

import { mkdir } from 'node:fs/promises'
import { normalize, sep } from 'node:path'
import { TaskListStore } from '../../core/task-list.js'
import type { WorkspaceRef } from '../../protocol.js'
import { ensureTaskLayout } from '../migration.js'
import type { Logger, WorkspacePort } from '../ports.js'
import type { SettingsStore } from './store.js'

/** 准备目录的结果。 */
export interface PreparedWorkDir {
  workspace?: WorkspaceRef
  workspaceError?: string
}

/** Workspace 服务。 */
export interface WorkspaceService {
  /** 路径上已注册的 Workspace。 */
  at(path: string): WorkspaceRef | undefined
  /** 建目录、确保注册表、按需迁移并注册 Workspace。 */
  prepare(path: string): Promise<PreparedWorkDir>
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
 * 一个目录是否属于插件可安全迁移的范围。
 *
 * `settingsRoot` 下的目录一定是插件自己的；配置的 defaultWorkDir 视为管理员
 * 显式指定，也允许迁移。其他用户目录一律不动。
 * @param settingsRoot - 插件固定设置根。
 * @param defaultWorkDir - 配置的默认工作目录。
 * @param path - 待判断目录。
 * @returns true 表示可迁移。
 */
export function isPluginOwned(settingsRoot: string, defaultWorkDir: string, path: string): boolean {
  const target = pathKey(path)
  for (const root of [settingsRoot, defaultWorkDir]) {
    const base = pathKey(root)
    if (target === base || target.startsWith(`${base}${sep}`)) return true
  }
  return false
}

/**
 * 创建 Workspace 服务。
 * @param deps - 设置服务、Workspace 端口与日志。
 * @returns Workspace 服务。
 */
export function createWorkspaceService(deps: {
  settings: SettingsStore
  workspaces: WorkspacePort
  logger: Logger
}): WorkspaceService {
  // 同一次激活里对同一目录只迁移一次。
  const migrated = new Set<string>()

  function storeFor(path: string): TaskListStore {
    if (path === deps.settings.workDir()) return deps.settings.store()
    return new TaskListStore(path, {
      defaultHistoryDays: deps.settings.historyDays,
      warn: (message: string) => {
        deps.logger.warn(message)
      },
    })
  }

  return {
    at(path: string): WorkspaceRef | undefined {
      return workspaceAt(deps.workspaces, path)
    },
    async prepare(path: string): Promise<PreparedWorkDir> {
      await mkdir(path, { recursive: true })
      const owned = isPluginOwned(deps.settings.settingsRoot, deps.settings.defaultWorkDir, path)
      if (owned && !migrated.has(path)) {
        await ensureTaskLayout(path, deps.logger).catch((error: unknown) => {
          deps.logger.warn(`task layout for ${path} could not be prepared: ${String(error)}`)
        })
        migrated.add(path)
      }
      const store = storeFor(path)
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
