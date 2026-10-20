/**
 * 运行会话：为一次运行创建新会话，并归档上一轮会话。
 *
 * 会话与任务目录都从注入的 service 取，不持有模块级状态；测试可以直接传
 * fake。归档是清理，不是执行前提：归档失败只记日志。
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { TaskListStore } from '../../core/task-list.js'
import type { TaskRecord } from '../../protocol.js'
import { CACHE_DIR, META_DIR, SCRIPT_DIR } from '../config.js'
import type { Logger, SessionPort, WorkspacePort } from '../ports.js'
import { workspaceAt, type PreparedWorkDir } from '../settings/workspace.js'

/** 会话服务依赖。 */
export interface RunSessionDeps {
  sessions: SessionPort
  workspaces: WorkspacePort
  store: () => TaskListStore
  workDir: () => string
  /** 建目录 + 迁移 + 注册 Workspace；由 settings/workspace 提供。 */
  prepareWorkDir: (path: string) => Promise<PreparedWorkDir>
  logger: Logger
}

/** 会话服务。 */
export interface RunSessionService {
  /** 归档上一轮会话、确保目录存在，然后创建一个新会话。 */
  prepare: (task: TaskRecord) => Promise<string>
  /** 打开任务记录的会话，必要时取消归档；没有则新建并登记。 */
  open: (task: TaskRecord) => Promise<string>
}

/**
 * 创建运行会话服务。
 * @param deps - 宿主会话/Workspace 端口与工作目录。
 * @returns 会话服务。
 */
export function createRunSessions(deps: RunSessionDeps): RunSessionService {
  async function ensureWorkspaceId(): Promise<string | undefined> {
    const current = deps.workDir()
    const existing = workspaceAt(deps.workspaces, current)
    if (existing !== undefined) return existing.id
    const prepared = await deps.prepareWorkDir(current).catch(() => undefined)
    return prepared?.workspace?.id
  }

  async function create(): Promise<string> {
    const workspaceId = await ensureWorkspaceId()
    const { sessionId } = await deps.sessions.create(
      workspaceId === undefined ? { cwd: deps.workDir() } : { workspaceId },
    )
    return sessionId
  }

  async function retire(task: TaskRecord): Promise<void> {
    const previous = task.sessionId
    if (previous === undefined || previous === '') return
    try {
      await deps.sessions.inspect(previous)
    } catch {
      deps.logger.info(`previous session ${previous} of ${task.id} is gone; nothing to archive`)
      return
    }
    try {
      await deps.workspaces.archiveSession(previous, { stopActivity: true })
      deps.logger.info(`archived previous session ${previous} of ${task.id}`)
    } catch (error: unknown) {
      deps.logger.warn(`could not archive previous session ${previous} of ${task.id}: ${String(error)}`)
    }
  }

  return {
    async prepare(task: TaskRecord): Promise<string> {
      // Empty directories can be missing after a copy or manual cleanup; the
      // rule points at them, so recreate them before the agent looks.
      await mkdir(join(task.folder, META_DIR, CACHE_DIR), { recursive: true }).catch(() => {})
      await mkdir(join(task.folder, META_DIR, SCRIPT_DIR), { recursive: true }).catch(() => {})
      await retire(task)
      return await create()
    },

    async open(task: TaskRecord): Promise<string> {
      const recorded = task.sessionId
      if (recorded !== undefined && recorded !== '') {
        try {
          await deps.sessions.inspect(recorded)
          // Unarchiving is a no-op for a session that is not archived, so it is
          // safe to ask every time; otherwise the conversation opens but stays
          // hidden from the sidebar.
          await deps.workspaces.unarchiveSession(recorded).catch((error: unknown) => {
            deps.logger.warn(`could not unarchive ${recorded}: ${String(error)}`)
          })
          return recorded
        } catch {
          deps.logger.info(`recorded session ${recorded} of ${task.id} is gone; creating a new one`)
        }
      }
      const sessionId = await create()
      await deps.store().setSession(task.id, sessionId).catch((error: unknown) => {
        deps.logger.warn(`task list update after session create failed: ${String(error)}`)
      })
      return sessionId
    },
  }
}
