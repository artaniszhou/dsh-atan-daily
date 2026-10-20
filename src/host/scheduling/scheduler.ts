/**
 * 调度器：一个串行执行队列 + 一个“计算下一次/触发到期”的单飞循环。
 *
 * 设计要点：
 *  - 所有 refresh 走同一个循环（single-flight），不会并发改写 timer；
 *  - 重新计算前先处理 `next` 里已经到期的槽位，避免 PATCH/创建/删除触发
 *    的 refresh 把刚到点的执行吞掉；
 *  - 计算失败时保留旧 timer / 安排重试，不会因为一次读失败永久停摆；
 *  - 执行准备阶段有上限，不会让一个卡住的会话调用堵死整个队列。
 */

import { latestOccurrence, nextOccurrence, parseCron, type CronRule } from '../../core/cron.js'
import type { TaskRecord } from '../../protocol.js'
import { MAX_TIMER_DELAY_MS } from '../config.js'
import { AppError } from '../errors.js'
import type { Logger, TimerPort } from '../ports.js'
import type { RunContext, RunOutcome, RunRecords } from '../runs/records.js'
import { runFailureOf } from '../runs/failure.js'
import type { RunExecutor } from '../runs/executor.js'
import type { RunSessionService } from '../runs/session.js'

/** 重新计算失败后的重试间隔。 */
const RETRY_DELAY_MS = 30_000
/** 新会话准备（建会话 + 解析 agent）的上限。 */
const DEFAULT_PREPARE_TIMEOUT_MS = 60_000
/** 一次执行所需的两个结果。 */
export interface PreparedRun {
  sessionId: string
  report: string
}

/** 调度器依赖（全部可替换，便于单测）。 */
export interface SchedulerDeps {
  repository: { list: () => Promise<TaskRecord[]> }
  records: Pick<RunRecords, 'begin' | 'finish' | 'recordSkip'>
  sessions: Pick<RunSessionService, 'prepare'>
  executor: Pick<RunExecutor, 'drive'>
  nextReportName: (task: TaskRecord) => Promise<string>
  timer: TimerPort
  logger: Logger
  clock: () => number
  runTimeoutMs: () => number
  prepareTimeoutMs?: number
}

/** 调度器对外接口。 */
export interface Scheduler {
  /** 启动：读设置后调用，执行 catch-up 并武装第一个 timer。 */
  start: () => Promise<void>
  /** 停止：取消 timer；已在执行的 run 不会被强行中断。 */
  stop: () => void
  /** 重新计算；`catchUp` 只在启动时为 true。 */
  refresh: (catchUp?: boolean) => Promise<void>
  /** 手动执行一次：先建会话并返回 id，回合在队列里继续。 */
  startManual: (task: TaskRecord) => Promise<{ sessionId: string }>
  isRunning: (taskId: string) => boolean
  hasRunning: () => boolean
  nextRunAt: (taskId: string) => number | undefined
  /** 等待队列排空（测试/关闭用）。 */
  waitForIdle: () => Promise<void>
}

/**
 * 创建调度器。
 * @param deps - 读模型、运行记录、会话、执行器、timer 与日志。
 * @returns 调度器。
 */
export function createScheduler(deps: SchedulerDeps): Scheduler {
  const prepareTimeoutMs = deps.prepareTimeoutMs ?? DEFAULT_PREPARE_TIMEOUT_MS
  const running = new Set<string>()
  let next = new Map<string, number>()
  let tail: Promise<void> = Promise.resolve()
  let timerDispose: (() => void) | undefined
  let loop: Promise<void> | undefined
  let requested = false
  let catchUpRequested = false
  let stopped = false
  let started = false

  const now = (): number => deps.clock()

  function cancelTimer(): void {
    timerDispose?.()
    timerDispose = undefined
  }

  function armRetry(): void {
    if (stopped) return
    // Replace whatever is armed: a stale timer for tomorrow must not delay the
    // recovery attempt after a failed pass.
    cancelTimer()
    try {
      timerDispose = deps.timer.timeout(() => {
        timerDispose = undefined
        void refresh(false)
      }, RETRY_DELAY_MS)
    } catch (error: unknown) {
      deps.logger.warn(`could not arm the retry timer: ${String(error)}`)
    }
  }

  function armAt(at: number | undefined): void {
    cancelTimer()
    if (at === undefined || stopped) return
    const wait = Math.min(Math.max(0, at - now()), MAX_TIMER_DELAY_MS)
    try {
      timerDispose = deps.timer.timeout(() => {
        timerDispose = undefined
        void refresh(false)
      }, wait)
    } catch (error: unknown) {
      deps.logger.warn(`could not arm the next timer: ${String(error)}`)
      armRetry()
    }
  }

  function enqueue(work: () => Promise<void>): Promise<void> {
    const run = tail.then(work, work)
    // Contain failures: one bad run must not poison the chain, and a rejected
    // chain would be fatal under DSH's fail-loud handler.
    tail = run.then(() => undefined, () => undefined)
    return run
  }

  async function prepare(task: TaskRecord): Promise<PreparedRun> {
    const withTimeout = async <T>(promise: Promise<T>, label: string): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${String(Math.round(prepareTimeoutMs / 1000))}s`))
        }, prepareTimeoutMs)
      })
      try {
        return await Promise.race([promise, timeout])
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    }
    const report = await withTimeout(deps.nextReportName(task), 'report naming')
    const sessionId = await withTimeout(deps.sessions.prepare(task), 'session preparation')
    return { sessionId, report }
  }

  async function finish(
    task: TaskRecord,
    context: RunContext,
    outcome: RunOutcome,
  ): Promise<void> {
    await deps.records.finish(task, context, outcome).catch((error: unknown) => {
      deps.logger.warn(`could not finish run ${context.runId}: ${String(error)}`)
    })
  }

  async function execute(
    task: TaskRecord,
    context: RunContext,
    prepared: PreparedRun,
  ): Promise<void> {
    if (stopped) {
      await finish(task, context, {
        status: 'cancelled',
        sessionId: prepared.sessionId,
        report: prepared.report,
        error: { code: 'cancelled', message: 'plugin stopped before the run started' },
      })
      return
    }
    try {
      await deps.executor.drive({
        task,
        sessionId: prepared.sessionId,
        report: prepared.report,
        timeoutMs: deps.runTimeoutMs(),
      })
      await finish(task, context, {
        status: 'ok',
        sessionId: prepared.sessionId,
        report: prepared.report,
      })
    } catch (error: unknown) {
      const failure = runFailureOf(error)
      deps.logger.warn(`run ${task.id} failed: ${failure.error.message}`)
      await finish(task, context, {
        status: failure.status,
        sessionId: prepared.sessionId,
        report: prepared.report,
        error: failure.error,
      })
    }
  }

  function startScheduled(task: TaskRecord, scheduledFor: number, catchUp: boolean): void {
    running.add(task.id)
    const run = enqueue(async () => {
      try {
        if (stopped) return
        const context = await deps.records.begin(task, 'schedule', catchUp, scheduledFor)
        let prepared: PreparedRun
        try {
          prepared = await prepare(task)
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error)
          deps.logger.warn(`run ${task.id} could not be prepared: ${message}`)
          await finish(task, context, {
            status: 'failed',
            error: { code: 'prepare_failed', message },
          })
          return
        }
        await execute(task, context, prepared)
      } finally {
        running.delete(task.id)
      }
    })
    void run.catch((error: unknown) => {
      deps.logger.warn(`queued run ${task.id} failed: ${String(error)}`)
      running.delete(task.id)
    })
  }

  async function dispatchDue(tasks: readonly TaskRecord[], at: number): Promise<void> {
    for (const task of tasks) {
      if (stopped) return
      if (!task.enabled || task.cron === undefined) continue
      const due = next.get(task.id)
      // `next` is the slot this scheduler was armed for. If a refresh arrives
      // late (slow disk, suspended machine), run that slot once instead of
      // moving `next` forward and losing it.
      if (due === undefined || due > at) continue
      let rule: CronRule
      try {
        rule = parseCron(task.cron)
      } catch (error: unknown) {
        deps.logger.warn(`task ${task.id} has an invalid cron rule: ${String(error)}`)
        continue
      }
      // If the schedule changed since this slot was armed, the old slot is not
      // a current occurrence and must not run.
      if (latestOccurrence(rule, task.timeZone, due) !== due) continue
      if (running.has(task.id)) {
        await deps.records.recordSkip(task, due, 'overlap').catch((error: unknown) => {
          deps.logger.warn(`could not record an overlap skip of ${task.id}: ${String(error)}`)
        })
        continue
      }
      deps.logger.info(`due ${task.id} (armed for ${new Date(due).toISOString()})`)
      startScheduled(task, due, false)
    }
  }

  async function dispatchCatchUp(tasks: readonly TaskRecord[], at: number): Promise<void> {
    for (const task of tasks) {
      if (stopped) return
      if (!task.enabled || task.cron === undefined) continue
      let rule: CronRule
      try {
        rule = parseCron(task.cron)
      } catch {
        continue
      }
      const latest = latestOccurrence(rule, task.timeZone, at)
      if (latest === undefined) continue
      const baseline = Math.max(
        task.lastRunAt === undefined ? 0 : Date.parse(task.lastRunAt),
        Date.parse(task.createdAt),
      )
      if (!Number.isFinite(baseline) || latest <= baseline) continue
      if (running.has(task.id)) continue
      deps.logger.info(`catching up ${task.id} for ${new Date(latest).toISOString()}`)
      startScheduled(task, latest, true)
    }
  }

  async function computeAndArm(tasks: readonly TaskRecord[], at: number): Promise<void> {
    const computed = new Map<string, number>()
    for (const task of tasks) {
      if (!task.enabled || task.cron === undefined) continue
      let rule: CronRule
      try {
        rule = parseCron(task.cron)
      } catch (error: unknown) {
        deps.logger.warn(`task ${task.id} has an invalid cron rule: ${String(error)}`)
        continue
      }
      const due = nextOccurrence(rule, task.timeZone, at)
      if (due !== undefined) computed.set(task.id, due)
    }
    next = computed
    let earliest: number | undefined
    for (const due of computed.values()) {
      earliest = earliest === undefined ? due : Math.min(earliest, due)
    }
    armAt(earliest)
  }

  async function pass(catchUp: boolean): Promise<void> {
    // Any read failure here is caught by the loop and turns into a retry; the
    // old timer is intentionally left armed.
    const tasks = await deps.repository.list()
    if (stopped) return
    const at = now()
    await dispatchDue(tasks, at)
    if (catchUp) await dispatchCatchUp(tasks, at)
    if (stopped) return
    await computeAndArm(tasks, at)
  }

  async function runLoop(): Promise<void> {
    do {
      requested = false
      const catchUp = catchUpRequested
      catchUpRequested = false
      try {
        await pass(catchUp)
      } catch (error: unknown) {
        deps.logger.warn(`scheduler pass failed: ${String(error)}`)
        armRetry()
      }
    } while (requested && !stopped)
  }

  async function refresh(catchUp = false): Promise<void> {
    if (stopped) return
    catchUpRequested ||= catchUp
    if (loop !== undefined) {
      requested = true
      await loop
      return
    }
    loop = runLoop()
    try {
      await loop
    } finally {
      loop = undefined
    }
  }

  return {
    async start(): Promise<void> {
      if (started || stopped) return
      started = true
      await refresh(true)
    },

    stop(): void {
      stopped = true
      cancelTimer()
    },

    refresh,

    async startManual(task: TaskRecord): Promise<{ sessionId: string }> {
      if (running.has(task.id)) throw new AppError('already_running', 409, 'already running')
      running.add(task.id)
      const context = await deps.records.begin(task, 'manual', false)
      let prepared: PreparedRun
      try {
        prepared = await prepare(task)
      } catch (error: unknown) {
        running.delete(task.id)
        const message = error instanceof Error ? error.message : String(error)
        deps.logger.warn(`run ${task.id} could not start: ${message}`)
        await finish(task, context, {
          status: 'failed',
          error: { code: 'prepare_failed', message },
        })
        throw new AppError('run_failed', 500, message)
      }
      const run = enqueue(async () => {
        try {
          await execute(task, context, prepared)
        } finally {
          running.delete(task.id)
        }
      })
      void run.catch((error: unknown) => {
        deps.logger.warn(`manual run ${task.id} failed: ${String(error)}`)
        running.delete(task.id)
      })
      return { sessionId: prepared.sessionId }
    },

    isRunning: (taskId: string): boolean => running.has(taskId),
    hasRunning: (): boolean => running.size > 0,
    nextRunAt: (taskId: string): number | undefined => next.get(taskId),
    waitForIdle: (): Promise<void> => tail,
  }
}
