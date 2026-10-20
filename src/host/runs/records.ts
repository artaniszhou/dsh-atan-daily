/**
 * 运行记录：开始、结束、跳过与保留期清理。
 *
 * 每条记录一个 JSON 文件；开始写 `running`，结束原子重写。运行摘要写回
 * 任务注册表，但使用**运行开始时捕获的 store**，所以切换工作目录不会把
 * 旧任务的摘要写进新目录。
 */

import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { writeAtomic } from '../../core/fs.js'
import {
  newRunId,
  pruneRunRecords,
  runFilePath,
  type RunError,
  type RunRecord,
  type RunStatus,
  type RunTrigger,
} from '../../core/runs.js'
import type { TaskListStore } from '../../core/task-list.js'
import type { TaskRecord } from '../../protocol.js'
import { PLUGIN_VERSION } from '../config.js'
import type { Logger } from '../ports.js'

/** 一次运行的不可变身份。 */
export interface RunContext {
  runId: string
  taskId: string
  taskFolder: string
  trigger: RunTrigger
  catchUp: boolean
  scheduledFor: string | null
  startedAt: string
  bootId: string
  /** 本次运行开始时的工作目录注册表；摘要只写这里。 */
  store: TaskListStore
}

/** 运行结束时的结果。 */
export interface RunOutcome {
  status: RunStatus
  sessionId?: string
  report?: string
  error?: RunError
  reason?: string
}

/** 运行摘要字段。 */
export interface RunSummary {
  sessionId?: string | null
  lastRunAt: string
  lastStatus: RunStatus
  lastDurationMs: number
  lastRunId: string
  lastError?: string | null
}

/** 运行记录服务依赖。 */
export interface RunRecordsDeps {
  store: () => TaskListStore
  logger: Logger
  bootId: string
  pluginVersion?: string
  clock?: () => Date
}

/** 运行记录服务。 */
export interface RunRecords {
  begin: (
    task: TaskRecord,
    trigger: RunTrigger,
    catchUp: boolean,
    scheduledFor?: number,
  ) => Promise<RunContext>
  finish: (task: TaskRecord, context: RunContext, outcome: RunOutcome) => Promise<void>
  recordSkip: (task: TaskRecord, scheduledFor: number, reason: string) => Promise<void>
  interrupt: (task: TaskRecord, record: RunRecord) => Promise<void>
  prune: (task: TaskRecord, force?: boolean) => Promise<void>
  summarize: (task: TaskRecord, summary: RunSummary) => Promise<void>
}

/**
 * 创建运行记录服务。
 * @param deps - 注册表、日志、boot id 与可注入时钟。
 * @returns 运行记录服务。
 */
export function createRunRecords(deps: RunRecordsDeps): RunRecords {
  const now = (): Date => deps.clock?.() ?? new Date()
  const version = deps.pluginVersion ?? PLUGIN_VERSION
  const lastPrune = new Map<string, number>()

  async function write(context: RunContext, record: RunRecord): Promise<void> {
    await writeAtomic(runFilePath(context.taskFolder, context.runId), `${JSON.stringify(record, null, 2)}\n`)
  }

  async function summarize(task: TaskRecord, summary: RunSummary): Promise<void> {
    await deps.store().recordRun(task.id, summary).catch((error: unknown) => {
      deps.logger.warn(`could not update the summary of ${task.id}: ${String(error)}`)
    })
  }

  async function pruneHistory(task: TaskRecord, force = false): Promise<void> {
    const at = now().getTime()
    const last = lastPrune.get(task.id) ?? 0
    if (!force && at - last < 60 * 60 * 1000) return
    lastPrune.set(task.id, at)
    const removed = await pruneRunRecords(task.folder, task.historyDays, at)
    if (removed > 0) deps.logger.info(`pruned ${String(removed)} run record(s) of ${task.id}`)
  }

  return {
    async begin(task, trigger, catchUp, scheduledFor): Promise<RunContext> {
      const at = now()
      const context: RunContext = {
        runId: newRunId(at),
        taskId: task.id,
        taskFolder: task.folder,
        trigger,
        catchUp,
        scheduledFor: scheduledFor === undefined ? null : new Date(scheduledFor).toISOString(),
        startedAt: at.toISOString(),
        bootId: deps.bootId,
        store: deps.store(),
      }
      const record: RunRecord = {
        v: 1,
        runId: context.runId,
        taskId: context.taskId,
        trigger,
        catchUp,
        scheduledFor: context.scheduledFor,
        startedAt: context.startedAt,
        finishedAt: null,
        status: 'running',
        durationMs: null,
        sessionId: null,
        report: null,
        reportExists: null,
        error: null,
        bootId: context.bootId,
        plugin: version,
      }
      try {
        await write(context, record)
      } catch (error: unknown) {
        deps.logger.warn(`could not write the start record of ${context.runId}: ${String(error)}`)
      }
      return context
    },

    async finish(task, context, outcome): Promise<void> {
      const finishedAt = now().toISOString()
      const durationMs = Math.max(0, Date.parse(finishedAt) - Date.parse(context.startedAt))
      const report = outcome.report ?? null
      let reportExists: boolean | null = null
      if (report !== null) {
        try {
          reportExists = (await stat(join(task.folder, report))).isFile()
        } catch {
          reportExists = false
        }
      }
      const record: RunRecord = {
        v: 1,
        runId: context.runId,
        taskId: context.taskId,
        trigger: context.trigger,
        catchUp: context.catchUp,
        scheduledFor: context.scheduledFor,
        startedAt: context.startedAt,
        finishedAt,
        status: outcome.status,
        durationMs,
        sessionId: outcome.sessionId ?? null,
        report,
        reportExists,
        error: outcome.error ?? null,
        bootId: context.bootId,
        plugin: version,
        ...outcome.reason === undefined ? {} : { reason: outcome.reason },
      }
      try {
        await write(context, record)
      } catch (error: unknown) {
        deps.logger.warn(`could not write the finish record of ${context.runId}: ${String(error)}`)
      }
      // Summary traffic goes through the store captured at begin(), not the
      // current working directory's store.
      await context.store.recordRun(task.id, {
        ...outcome.sessionId === undefined ? {} : { sessionId: outcome.sessionId },
        lastRunAt: finishedAt,
        lastStatus: outcome.status,
        lastDurationMs: durationMs,
        lastRunId: context.runId,
        lastError: outcome.error?.message ?? null,
      }).catch((error: unknown) => {
        deps.logger.warn(`could not update the summary of ${task.id}: ${String(error)}`)
      })
      await pruneHistory(task).catch((error: unknown) => {
        deps.logger.warn(`could not prune the history of ${task.id}: ${String(error)}`)
      })
    },

    async recordSkip(task, scheduledFor, reason): Promise<void> {
      const at = now()
      const context: RunContext = {
        runId: newRunId(at),
        taskId: task.id,
        taskFolder: task.folder,
        trigger: 'schedule',
        catchUp: false,
        scheduledFor: new Date(scheduledFor).toISOString(),
        startedAt: at.toISOString(),
        bootId: deps.bootId,
        store: deps.store(),
      }
      const record: RunRecord = {
        v: 1,
        runId: context.runId,
        taskId: context.taskId,
        trigger: 'schedule',
        catchUp: false,
        scheduledFor: context.scheduledFor,
        startedAt: context.startedAt,
        finishedAt: context.startedAt,
        status: 'skipped',
        durationMs: 0,
        sessionId: null,
        report: null,
        reportExists: null,
        error: null,
        bootId: context.bootId,
        plugin: version,
        reason,
      }
      await write(context, record).catch((error: unknown) => {
        deps.logger.warn(`could not write the skip record of ${task.id}: ${String(error)}`)
      })
    },

    async interrupt(task, record): Promise<void> {
      const finishedAt = now().toISOString()
      const updated: RunRecord = {
        ...record,
        finishedAt,
        status: 'interrupted',
        durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(record.startedAt)),
        error: { code: 'host_interrupted', message: 'Host restarted before the run finished' },
        bootId: deps.bootId,
      }
      await writeAtomic(
        runFilePath(task.folder, record.runId),
        `${JSON.stringify(updated, null, 2)}\n`,
      )
      // Keep the startedAt baseline so a restart does not re-run the same slot.
      await summarize(task, {
        sessionId: record.sessionId,
        lastRunAt: record.startedAt,
        lastStatus: 'interrupted',
        lastDurationMs: updated.durationMs ?? 0,
        lastRunId: record.runId,
        lastError: 'Host restarted before the run finished',
      })
    },

    async prune(task, force = false): Promise<void> {
      await pruneHistory(task, force)
    },

    summarize,
  }
}
