/**
 * 任务读模型。
 *
 * 只读：`GET /tasks` 与 `GET /settings` 走这里，不再执行布局迁移或注册表 prune。
 * 最新报告按定宽文件名排序（不逐份 `stat`），计数只读注册表元数据。
 *
 * 工作区未配置时读操作返回空集，写操作（`decorate`）抛 `no_workspace`：
 * 列表页因此是空态而不是报错，创建任务则拿到明确的提示。
 */

import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { parseCron } from '../core/cron.js'
import { readTaskDetail } from '../core/documents.js'
import { isSafeTaskId, type TaskMeta } from '../core/task-list.js'
import type { Frequency, TaskRecord } from '../protocol.js'
import { AppError } from './errors.js'
import { frequencyOf, latestReportBase, reportBaseOf } from './naming.js'
import { HISTORY_DIR } from './config.js'
import { NO_WORKSPACE_MESSAGE, type Workspace } from './settings/hub.js'
import type { Logger } from './ports.js'

/** 设置页需要的两个计数。 */
export interface TaskCounts {
  total: number
  enabled: number
}

/** 任务读模型接口。 */
export interface TaskRepository {
  /** 列出所有任务，按 createdAt 倒序。 */
  list(): Promise<TaskRecord[]>
  /** 读一个任务；taskId 不安全、元数据或目录缺失时 undefined。 */
  read(id: string): Promise<TaskRecord | undefined>
  /** 用元数据 + 规则详情组装视图。 */
  decorate(meta: TaskMeta, details: string): Promise<TaskRecord>
  /** 只读注册表的计数，不读任务文档。 */
  count(): Promise<TaskCounts>
}

/** 读模型依赖：工作区按当前状态惰性取值。 */
export interface TaskRepositoryDeps {
  workspace: () => Workspace | null
  logger: Logger
}

/**
 * 创建任务读模型。
 * @param deps - 工作区取值函数与日志。
 * @returns 只读的任务仓库。
 */
export function createTaskRepository(deps: TaskRepositoryDeps): TaskRepository {
  /** 取当前工作区；未配置时抛统一错误。 */
  function requireWorkspace(): Workspace {
    const workspace = deps.workspace()
    if (workspace === null) throw new AppError('no_workspace', 409, NO_WORKSPACE_MESSAGE)
    return workspace
  }

  async function decorate(meta: TaskMeta, details: string): Promise<TaskRecord> {
    const workspace = requireWorkspace()
    const folder = join(workspace.root, meta.folder)
    let names: string[] = []
    try {
      names = await readdir(folder)
    } catch {
      names = []
    }
    let archived: string[] = []
    try {
      archived = await readdir(join(folder, HISTORY_DIR))
    } catch {
      archived = []
    }
    // 一轮报告是一组同基名的文件（json/html/pdf），所以按「基名」去重计数：
    // 按文件数算会把一轮当成三份。
    const bases = new Set<string>()
    for (const name of [...names, ...archived]) {
      const base = reportBaseOf(name)
      if (base !== undefined) bases.add(base)
    }
    // 运行开始时上一份报告会被移进 history/，所以最新报告可能只存在于那里。
    const report = latestReportBase([...names, ...archived])
    const historyCount = Math.max(0, bases.size - 1)
    const cron = meta.cron ?? undefined
    let frequency: Frequency = 'on-demand'
    try {
      frequency = frequencyOf(cron === undefined ? undefined : parseCron(cron))
    } catch {
      // 手改坏的 cron 仍然可以列出；调度器会记录并跳过它。
    }
    return {
      taskId: meta.taskId,
      name: meta.name,
      details,
      frequency,
      createdAt: meta.createdAt,
      folder,
      historyCount,
      scheduleMode: meta.scheduleMode,
      ...meta.sessionId === null ? {} : { sessionId: meta.sessionId },
      ...cron === undefined ? {} : { cron },
      ...meta.scheduleText === null ? {} : { scheduleText: meta.scheduleText },
      timeZone: meta.timeZone,
      enabled: meta.enabled,
      historyDays: meta.historyDays,
      pushBotIds: [...meta.pushBotIds],
      pushEnabled: meta.pushEnabled,
      newSession: meta.newSession,
      permissionLevel: meta.permissionLevel,
      outputFormat: meta.outputFormat,
      ...meta.lastRunAt === null ? {} : { lastRunAt: meta.lastRunAt },
      ...meta.lastStatus === null ? {} : { lastStatus: meta.lastStatus },
      ...meta.lastDurationMs === null ? {} : { lastDurationMs: meta.lastDurationMs },
      ...meta.lastRunId === null ? {} : { lastRunId: meta.lastRunId },
      ...meta.lastError === null ? {} : { lastError: meta.lastError },
      ...report === undefined ? {} : { report },
    }
  }

  async function list(): Promise<TaskRecord[]> {
    const workspace = deps.workspace()
    if (workspace === null) return []
    const metas = await workspace.store.list()
    const tasks: TaskRecord[] = []
    for (const meta of metas) {
      const folder = join(workspace.root, meta.folder)
      try {
        if (!(await stat(folder)).isDirectory()) continue
      } catch {
        continue
      }
      tasks.push(await decorate(meta, await readTaskDetail(folder)))
    }
    return tasks.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  }

  async function read(taskId: string): Promise<TaskRecord | undefined> {
    if (!isSafeTaskId(taskId)) return undefined
    const workspace = deps.workspace()
    if (workspace === null) return undefined
    const meta = await workspace.store.get(taskId)
    if (meta === undefined) return undefined
    const folder = join(workspace.root, meta.folder)
    try {
      if (!(await stat(folder)).isDirectory()) return undefined
    } catch {
      return undefined
    }
    return await decorate(meta, await readTaskDetail(folder))
  }

  async function count(): Promise<TaskCounts> {
    const workspace = deps.workspace()
    if (workspace === null) return { total: 0, enabled: 0 }
    const metas = await workspace.store.list()
    let total = 0
    let enabled = 0
    for (const meta of metas) {
      try {
        if (!(await stat(join(workspace.root, meta.folder))).isDirectory()) continue
      } catch {
        continue
      }
      total += 1
      if (meta.cron !== null && meta.enabled) enabled += 1
    }
    return { total, enabled }
  }

  return { list, read, decorate, count }
}
