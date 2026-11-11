/**
 * 运行会话：按任务设置新建会话或复用上一次会话。
 *
 * 会话与任务目录都从注入的 service 取，不持有模块级状态；测试可以直接传
 * fake。归档是清理，不是执行前提：归档失败只记日志。
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { ensureTaskDocuments } from '../../core/documents.js'
import type { TaskRecord } from '../../protocol.js'
import { CACHE_DIR, CHARTS_DIR, HISTORY_DIR, META_DIR, BUILD_DIR, SCRIPT_DIR, SHARE_DIR } from '../config.js'
import type { Logger, SessionPort, WorkspacePort } from '../ports.js'
import type { Workspace } from '../settings/hub.js'
import { workspaceAt, type PreparedWorkDir } from '../settings/workspace.js'

/** 会话服务依赖。 */
export interface RunSessionDeps {
  sessions: SessionPort
  workspaces: WorkspacePort
  /** 当前工作区；未配置时抛 `no_workspace`。 */
  workspace: () => Workspace
  /** 建目录 + 准备注册表 + 注册 Workspace（不落盘、不切换）。 */
  ensureWorkspace: () => Promise<PreparedWorkDir>
  logger: Logger
}

/** 会话服务。 */
export interface RunSessionService {
  /** 确保目录存在，然后按 `task.newSession` 新建或复用会话。 */
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
  /**
   * 同一时刻只准备一次 Workspace。
   *
   * 运行之间不再排队，插件刚启动时多个任务可能同时到达；没有这个单飞，
   * 同一目录会被重复注册成多个 Workspace。
   */
  let workspaceReady: Promise<string | undefined> | undefined

  async function ensureWorkspaceId(): Promise<string | undefined> {
    if (workspaceReady !== undefined) return await workspaceReady
    const attempt = (async (): Promise<string | undefined> => {
      const workspace = deps.workspace()
      const existing = workspaceAt(deps.workspaces, workspace.root)
      if (existing !== undefined) return existing.id
      const prepared = await deps.ensureWorkspace().catch(() => undefined)
      return prepared?.workspace?.id
    })()
    workspaceReady = attempt
    try {
      return await attempt
    } finally {
      workspaceReady = undefined
    }
  }

  async function create(): Promise<string> {
    const workspace = deps.workspace()
    const workspaceId = await ensureWorkspaceId()
    const { sessionId } = await deps.sessions.create(
      workspaceId === undefined ? { cwd: workspace.root } : { workspaceId },
    )
    return sessionId
  }

  /**
   * 新建会话并立刻写回任务记录。
   *
   * 运行结束才写回会让“运行中点击会话”看到上一轮的旧指针，所以创建成功就登记。
   * @param task - 任务。
   * @returns 新会话 id。
   */
  async function createFor(task: TaskRecord): Promise<string> {
    const sessionId = await create()
    await deps.workspace().store.setSession(task.taskId, sessionId).catch((error: unknown) => {
      deps.logger.warn(`task list update after session create failed: ${String(error)}`)
    })
    return sessionId
  }

  /**
   * 判断记录里的会话是否还存在。
   *
   * `SessionPersistence.stat` 在不存在时返回 undefined；只有读取失败才是未知，
   * 不能把异常当成“不存在”，否则会静默新建会话、丢掉上一轮上下文。
   * @param sessionId - 会话 id。
   * @returns true/false，读取失败时 undefined。
   */
  async function sessionState(sessionId: string): Promise<boolean | undefined> {
    try {
      return (await deps.sessions.stat(sessionId)) !== undefined
    } catch (error: unknown) {
      deps.logger.warn(`could not read session ${sessionId}: ${String(error)}`)
      return undefined
    }
  }

  async function retire(task: TaskRecord): Promise<void> {
    const previous = task.sessionId
    if (previous === undefined || previous === '') return
    // 不存在就无需归档；读取失败（undefined）仍尝试归档，交给 archive 自己报错。
    if (await sessionState(previous) === false) {
      deps.logger.info(`previous session ${previous} of ${task.taskId} is gone; nothing to archive`)
      return
    }
    try {
      await deps.workspaces.archiveSession(previous, { stopActivity: true })
      deps.logger.info(`archived previous session ${previous} of ${task.taskId}`)
    } catch (error: unknown) {
      deps.logger.warn(`could not archive previous session ${previous} of ${task.taskId}: ${String(error)}`)
    }
  }

  /**
   * 复用上一次会话；会话已经不存在时退回新建。
   *
   * 复用前先 `stat`：任务记录里的 sessionId 可能来自被手动删掉的会话，
   * 直接 prompt 会失败。`unarchiveSession` 对未归档会话是无操作，所以每次都问，
   * 否则复用的会话会在侧栏里找不到。
   * @param task - 任务。
   * @returns 已有或新建的会话 id。
   */
  async function reuse(task: TaskRecord): Promise<string> {
    const recorded = task.sessionId
    if (recorded !== undefined && recorded !== '') {
      if (await sessionState(recorded) !== false) {
        await deps.workspaces.unarchiveSession(recorded).catch((error: unknown) => {
          deps.logger.warn(`could not unarchive ${recorded}: ${String(error)}`)
        })
        return recorded
      }
      deps.logger.info(`recorded session ${recorded} of ${task.taskId} is gone; creating a new one`)
    }
    return await createFor(task)
  }

  return {
    async prepare(task: TaskRecord): Promise<string> {
      // Empty directories can be missing after a copy or manual cleanup; the
      // rule points at them, so recreate them before the agent looks.
      await mkdir(join(task.folder, SHARE_DIR, CHARTS_DIR), { recursive: true }).catch(() => {})
      await mkdir(join(task.folder, META_DIR, CACHE_DIR), { recursive: true }).catch(() => {})
      await mkdir(join(task.folder, META_DIR, SCRIPT_DIR), { recursive: true }).catch(() => {})
      await mkdir(join(task.folder, META_DIR, BUILD_DIR), { recursive: true }).catch(() => {})
      // 归档目录与 `.meta/` 同级，报告才能按轮次搬进去。
      await mkdir(join(task.folder, HISTORY_DIR), { recursive: true }).catch(() => {})
      // 手工删掉文档时补回空文件，执行指令指向的路径必须存在。
      await ensureTaskDocuments(task.folder).catch(() => {})
      // 默认每次运行都从新会话开始：旧会话归档，侧栏只留本轮。关掉后
      // 复用同一会话，适合需要跨轮次积累上下文的选题。
      if (!task.newSession) return await reuse(task)
      await retire(task)
      return await createFor(task)
    },

    async open(task: TaskRecord): Promise<string> {
      const recorded = task.sessionId
      if (recorded !== undefined && recorded !== '') {
        if (await sessionState(recorded) !== false) {
          // Unarchiving is a no-op for a session that is not archived, so it is
          // safe to ask every time; otherwise the conversation opens but stays
          // hidden from the sidebar.
          await deps.workspaces.unarchiveSession(recorded).catch((error: unknown) => {
            deps.logger.warn(`could not unarchive ${recorded}: ${String(error)}`)
          })
          return recorded
        }
        deps.logger.info(`recorded session ${recorded} of ${task.taskId} is gone; creating a new one`)
      }
      return await createFor(task)
    },
  }
}
