/**
 * 当前工作区：把「工作区路径 + 任务注册表」合成一个不可变快照。
 *
 * 消费者只依赖 {@link WorkspaceProvider}，不再各自接收 `store` 与 `workDir` 两个参数，
 * 也就不会出现「两个值来自不同目录」的组合。「未配置」是一等状态：`current()` 为
 * `null`，写操作由 {@link WorkspaceProvider.require} 统一抛错，文案只有一份。
 */

import { mkdir, readdir, realpath, stat } from 'node:fs/promises'
import { join, normalize } from 'node:path'
import type { SuggestedWorkDirSource } from '../../protocol.js'
import { TASK_DETAIL_NAME, taskStateDir } from '../../core/documents.js'
import { TASK_LIST_FILE, TaskListStore } from '../../core/task-list.js'
import { AppError } from '../errors.js'
import { normalizeBaseUrl } from '../config.js'
import type { Logger, WorkspacePort } from '../ports.js'
import type { SavedSettings, SettingsFile } from './file.js'
import { workspaceAt, type PreparedWorkDir } from './workspace.js'
import type { WorkspaceSuggestion } from './suggest.js'

/** 未配置工作区时的统一文案。 */
export const NO_WORKSPACE_MESSAGE = '还没有选择工作区：先在工作区一栏点「选择工作区」或「使用建议工作区」'
/** 工作区注册被删除时的统一文案。 */
export const NO_WORKSPACE_UNREGISTERED_MESSAGE = '当前工作区的注册已被删除：先点「重新注册」或重新选择工作区'

/**
 * 目录的 canonical 路径；目录不存在时只做归一化。
 * @param path - 绝对路径。
 * @returns 可注册、可比较的路径。
 */
async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return normalize(path)
  }
}

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
  suggestedWorkDirSource: SuggestedWorkDirSource
  defaultWorkspaceParent: string
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
  /** 建议工作区；首次调用会等待一次系统探测，之后返回缓存。 */
  suggestion(): Promise<WorkspaceSuggestion>
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
  /** 建议工作区（路径 + 父目录 + 来源）；先给初始值，首次读取时再探测。 */
  suggestedRoot: WorkspaceSuggestion
  /** 完整探测（系统 Documents 等）；缺省表示只用初始值。 */
  resolveSuggestion?: () => Promise<WorkspaceSuggestion>
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
  let suggestion = deps.suggestedRoot
  let suggestionPending: Promise<WorkspaceSuggestion> | undefined
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
      // 不变式：生效的工作区必须是已注册工作区。注册被外部删除后，写入与运行
      // 一律拒绝，直到用户显式「重新注册」。
      if (workspaceAt(deps.workspaces, current.root) === undefined) {
        throw new AppError('no_workspace', 409, NO_WORKSPACE_UNREGISTERED_MESSAGE)
      }
      return current
    },
    suggestedRoot: () => suggestion.path,
    suggestion(): Promise<WorkspaceSuggestion> {
      if (suggestionPending === undefined) {
        const probe = deps.resolveSuggestion
        suggestionPending = (probe === undefined ? Promise.resolve(suggestion) : probe())
          .then((next) => {
            suggestion = next
            return next
          })
          .catch(() => suggestion)
      }
      return suggestionPending
    },
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
        suggestedWorkDir: suggestion.path,
        suggestedWorkDirSource: suggestion.source,
        defaultWorkspaceParent: suggestion.parent,
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
        // 历史版本可能存了符号链接或非 canonical 路径；注册表用 canonical 路径，
        // 这里对齐一次，避免把「已注册」误判成「注册被删」。
        const root = await canonicalPath(saved.workDir)
        adopt(root)
        deps.logger.info(`working workspace ${root}`)
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
        deps.logger.info(`沿用已有工作区 ${candidate}`)
        return
      }
      deps.logger.info('no workspace configured yet')
    },
    async switchTo(root: string): Promise<PreparedWorkDir> {
      // 先建目录再取 canonical：叶子不存在时 realpath 会失败；父目录是符号链接时，
      // 注册表会存 canonical 路径，插件若存原样路径就会被误判成「注册被删」。
      await mkdir(root, { recursive: true })
      const target = await canonicalPath(root)
      const store = createStore(target)
      // 先准备目录与注册表：失败时当前快照保持原样。
      const prepared = await deps.prepare(target, store)
      // 不变式要求「生效的必须是工作区」：注册失败即切换失败，不落盘。
      if (prepared.workspaceError !== undefined) {
        throw new AppError('workspace_registration_failed', 500, `注册工作区失败：${prepared.workspaceError}`)
      }
      const next: SavedSettings = { ...saved, workDir: target }
      await deps.settingsFile.save(next)
      saved = next
      current = { root: target, store }
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
