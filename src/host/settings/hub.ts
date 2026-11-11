/**
 * 当前工作区：把「工作目录 + 任务注册表」合成一个不可变快照。
 *
 * 消费者只依赖 {@link WorkspaceProvider}，不再各自接收 `store` 与 `workDir` 两个参数，
 * 也就不会出现「两个值来自不同目录」的组合。「未配置」是一等状态：`current()` 为
 * `null`，写操作由 {@link WorkspaceProvider.require} 统一抛错，文案只有一份。
 */

import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { TASK_DETAIL_NAME, taskStateDir } from '../../core/documents.js'
import { TASK_LIST_FILE, TaskListStore } from '../../core/task-list.js'
import { AppError } from '../errors.js'
import { normalizeBaseUrl } from '../config.js'
import type { Logger, WorkspacePort } from '../ports.js'
import type { SavedSettings, SettingsFile } from './file.js'
import type { PreparedWorkDir } from './workspace.js'

/** 未配置工作目录时的统一文案。 */
export const NO_WORKSPACE_MESSAGE = '还没有选择工作目录：先在工作目录一栏点「选择目录」或「使用建议目录」'

/** 一个工作区快照：路径与注册表同一来源。 */
export interface Workspace {
  readonly root: string
  readonly store: TaskListStore
}

/** 消费方看到的窄接口。 */
export interface WorkspaceProvider {
  /** 当前工作区；未配置时为 null。 */
  current(): Workspace | null
  /** 当前工作区；未配置时抛 {@link AppError}（code `no_workspace`）。 */
  require(): Workspace
  /** 页面「使用建议目录」按钮显示的值。 */
  suggestedRoot(): string
  /** 工作区变化（切换或清除）时通知；返回 disposer。 */
  onChange(listener: (workspace: Workspace | null) => void): () => void
}

/** 一次设置补丁：`undefined` 不改，`null` 清除覆盖。 */
export interface SettingsPatch {
  workDir?: string | null
  serverBaseUrl?: string | null
}

/** 设置页需要的只读快照。 */
export interface SettingsSnapshot {
  workDir: string
  savedWorkDir: string
  suggestedWorkDir: string
  workDirConfigured: boolean
  serverBaseUrl: string
  savedServerBaseUrl: string
  defaultServerBaseUrl: string
}

/** 设置与服务地址的读写。 */
export interface WorkspaceHub extends WorkspaceProvider {
  /** 已保存的设置快照。 */
  settings(): SavedSettings
  /** 设置页视图。 */
  snapshot(): SettingsSnapshot
  /** 当前生效的任务仓库地址。 */
  serverBaseUrl(): string
  /** 保存任务仓库地址覆盖；null 或空串表示清除覆盖。 */
  saveServerBaseUrl(serverBaseUrl: string | null): Promise<void>
  /** 读设置；没有 `workDir` 时尝试沿用历史默认目录（一次性迁移）。 */
  load(): Promise<void>
  /** 建目录 + 准备注册表 + 注册 Workspace，落盘后切换；任一步失败都不改变当前快照。 */
  switchTo(root: string): Promise<PreparedWorkDir>
  /** 只确保当前目录可用（建目录、ensure、注册），不落盘、不切换。 */
  ensure(): Promise<PreparedWorkDir>
  /** 清除工作目录覆盖，回到未配置态。 */
  clear(): Promise<void>
}

/** 工作区服务依赖。 */
export interface WorkspaceHubDeps {
  settingsFile: SettingsFile
  workspaces: WorkspacePort
  /** 建目录、确保注册表并注册 Workspace。 */
  prepare: (path: string, store: TaskListStore) => Promise<PreparedWorkDir>
  /** 平台建议目录。 */
  suggestedRoot: string
  /** yaml 的 `dataDir`：迁移候选之一，也是建议值的覆盖来源。 */
  configuredWorkDir?: string
  /** 旧版默认目录（插件数据目录）：迁移候选之一。 */
  legacyWorkDir: string
  historyDays: number
  defaultServerBaseUrl: string
  logger: Logger
}

/**
 * 判断一个目录里是否已有任务：有注册表，或有任一含 `task-detail.md` 的子目录。
 * @param root - 目录。
 * @returns 是否有任务。
 */
async function hasTasks(root: string): Promise<boolean> {
  try {
    if ((await stat(join(taskStateDir(root), TASK_LIST_FILE))).isFile()) return true
  } catch {
    // 没有注册表：继续看目录。
  }
  try {
    const entries = await readdir(root, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      try {
        if ((await stat(join(root, entry.name, TASK_DETAIL_NAME))).isFile()) return true
      } catch {
        // 不是任务目录。
      }
    }
  } catch {
    return false
  }
  return false
}

/**
 * 创建工作区服务。
 * @param deps - 设置文件、Workspace 端口、迁移候选与日志。
 * @returns 工作区服务。
 */
export function createWorkspaceHub(deps: WorkspaceHubDeps): WorkspaceHub {
  let saved: SavedSettings = {}
  let current: Workspace | null = null
  const listeners = new Set<(workspace: Workspace | null) => void>()

  function createStore(root: string): TaskListStore {
    return new TaskListStore(root, {
      defaultHistoryDays: deps.historyDays,
      warn: (message: string) => {
        deps.logger.warn(message)
      },
    })
  }

  function adopt(root: string): void {
    current = { root, store: createStore(root) }
  }

  function emit(): void {
    for (const listener of listeners) {
      try {
        listener(current)
      } catch (error: unknown) {
        deps.logger.warn(`workspace listener failed: ${String(error)}`)
      }
    }
  }

  /** 迁移候选：yaml 的 dataDir 优先，其次旧版默认目录。 */
  function candidates(): string[] {
    const list = [deps.configuredWorkDir, deps.legacyWorkDir]
    return [...new Set(list.filter((value): value is string => value !== undefined && value !== ''))]
  }

  return {
    current: () => current,
    require(): Workspace {
      if (current === null) throw new AppError('no_workspace', 409, NO_WORKSPACE_MESSAGE)
      return current
    },
    suggestedRoot: () => deps.configuredWorkDir ?? deps.suggestedRoot,
    onChange(listener): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    settings: () => saved,
    snapshot(): SettingsSnapshot {
      const workspace = current
      return {
        workDir: workspace?.root ?? '',
        savedWorkDir: saved.workDir ?? '',
        suggestedWorkDir: deps.configuredWorkDir ?? deps.suggestedRoot,
        workDirConfigured: workspace !== null,
        serverBaseUrl: saved.serverBaseUrl ?? deps.defaultServerBaseUrl,
        savedServerBaseUrl: saved.serverBaseUrl ?? '',
        defaultServerBaseUrl: deps.defaultServerBaseUrl,
      }
    },
    serverBaseUrl: () => saved.serverBaseUrl ?? deps.defaultServerBaseUrl,
    async saveServerBaseUrl(serverBaseUrl: string | null): Promise<void> {
      const next: SavedSettings = { ...saved }
      if (serverBaseUrl === null || serverBaseUrl === '') delete next.serverBaseUrl
      else next.serverBaseUrl = normalizeBaseUrl(serverBaseUrl, 'serverBaseUrl')
      await deps.settingsFile.save(next)
      saved = next
    },
    async load(): Promise<void> {
      saved = await deps.settingsFile.load()
      if (saved.workDir !== undefined) {
        adopt(saved.workDir)
        deps.logger.info(`working directory ${saved.workDir}`)
        return
      }
      // 一次性迁移：老用户没有保存过覆盖、任务却在历史默认目录里，沿用并写回，
      // 否则升级后任务列表会突然变空。
      for (const candidate of candidates()) {
        if (!(await hasTasks(candidate))) continue
        const next: SavedSettings = { ...saved, workDir: candidate }
        await deps.settingsFile.save(next).catch((error: unknown) => {
          deps.logger.warn(`could not persist the migrated working directory: ${String(error)}`)
        })
        saved = next
        adopt(candidate)
        deps.logger.info(`沿用已有工作目录 ${candidate}`)
        return
      }
      deps.logger.info('no working directory configured yet')
    },
    async switchTo(root: string): Promise<PreparedWorkDir> {
      const store = createStore(root)
      // 先准备目录与注册表：失败时当前快照保持原样。
      const prepared = await deps.prepare(root, store)
      const next: SavedSettings = { ...saved, workDir: root }
      await deps.settingsFile.save(next)
      saved = next
      current = { root, store }
      emit()
      return prepared
    },
    async ensure(): Promise<PreparedWorkDir> {
      const workspace = current
      if (workspace === null) throw new AppError('no_workspace', 409, NO_WORKSPACE_MESSAGE)
      return await deps.prepare(workspace.root, workspace.store)
    },
    async clear(): Promise<void> {
      const next: SavedSettings = { ...saved }
      delete next.workDir
      await deps.settingsFile.save(next)
      saved = next
      current = null
      emit()
    },
  }
}
