/**
 * 任务读模型。
 *
 * 只读：`GET /tasks` 与 `GET /settings` 走这里，不再执行布局迁移或注册表 prune。
 * 最新报告按定宽文件名排序（不逐份 `stat`），计数只读注册表元数据。
 */

import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { parseCron } from '../core/cron.js'
import { readRuleContent } from '../core/rule.js'
import { isSafeTaskId, type TaskListStore, type TaskMeta } from '../core/task-list.js'
import type { Frequency, TaskRecord } from '../protocol.js'
import { frequencyOf, isReportName, latestReportName } from './naming.js'
import { HISTORY_DIR } from './config.js'
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
  /** 读一个任务；id 不安全、元数据或目录缺失时 undefined。 */
  read(id: string): Promise<TaskRecord | undefined>
  /** 用元数据 + 规则详情组装视图。 */
  decorate(meta: TaskMeta, details: string): Promise<TaskRecord>
  /** 只读注册表的计数，不读 rule.md。 */
  count(): Promise<TaskCounts>
}

/** 读模型依赖：注册表按当前工作目录惰性取值。 */
export interface TaskRepositoryDeps {
  store: () => TaskListStore
  workDir: () => string
  logger: Logger
}

/**
 * 创建任务读模型。
 * @param deps - 注册表与工作目录的取值函数。
 * @returns 只读的任务仓库。
 */
export function createTaskRepository(deps: TaskRepositoryDeps): TaskRepository {
  const workDir = (): string => deps.workDir()

  async function decorate(meta: TaskMeta, details: string): Promise<TaskRecord> {
    const folder = join(workDir(), meta.id)
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
    const reports = names.filter(isReportName)
    const archivedReports = archived.filter(isReportName)
    // 运行开始时上一份报告会被移进 history/，所以最新报告可能只存在于那里。
    const report = latestReportName([...reports, ...archivedReports])
    const historyCount = Math.max(0, reports.length + archivedReports.length - 1)
    const cron = meta.cron ?? undefined
    let frequency: Frequency = 'on-demand'
    try {
      frequency = frequencyOf(cron === undefined ? undefined : parseCron(cron))
    } catch {
      // 手改坏的 cron 仍然可以列出；调度器会记录并跳过它。
    }
    return {
      id: meta.id,
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
      ...meta.lastRunAt === null ? {} : { lastRunAt: meta.lastRunAt },
      ...meta.lastStatus === null ? {} : { lastStatus: meta.lastStatus },
      ...meta.lastDurationMs === null ? {} : { lastDurationMs: meta.lastDurationMs },
      ...meta.lastRunId === null ? {} : { lastRunId: meta.lastRunId },
      ...meta.lastError === null ? {} : { lastError: meta.lastError },
      ...report === undefined ? {} : { report },
    }
  }

  async function list(): Promise<TaskRecord[]> {
    const metas = await deps.store().list()
    const tasks: TaskRecord[] = []
    for (const meta of metas) {
      const folder = join(workDir(), meta.id)
      try {
        if (!(await stat(folder)).isDirectory()) continue
      } catch {
        continue
      }
      tasks.push(await decorate(meta, await readRuleContent(folder)))
    }
    return tasks.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  }

  async function read(id: string): Promise<TaskRecord | undefined> {
    if (!isSafeTaskId(id)) return undefined
    const meta = await deps.store().get(id)
    if (meta === undefined) return undefined
    const folder = join(workDir(), id)
    try {
      if (!(await stat(folder)).isDirectory()) return undefined
    } catch {
      return undefined
    }
    return await decorate(meta, await readRuleContent(folder))
  }

  async function count(): Promise<TaskCounts> {
    const metas = await deps.store().list()
    let total = 0
    let enabled = 0
    for (const meta of metas) {
      try {
        if (!(await stat(join(workDir(), meta.id))).isDirectory()) continue
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
