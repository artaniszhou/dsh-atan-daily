/**
 * 调度器：跨任务并发执行 + 一个“计算下一次/触发到期”的单飞循环。
 *
 * 设计要点：
 *  - 所有 refresh 走同一个循环（single-flight），不会并发改写 timer；
 *  - 重新计算前先处理 `next` 里已经到期的槽位，避免 PATCH/创建/删除触发
 *    的 refresh 把刚到点的执行吞掉；
 *  - 计算失败时保留旧 timer / 安排重试，不会因为一次读失败永久停摆；
 *  - 不设并发上限：不同任务的运行同时开始；同一任务仍然互斥（`running`），
 *    报告命名与会话归档因此不会被自己撞到；
 *  - 执行准备阶段有上限，不会让一个卡住的会话调用拖住整个调度循环。
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
  /** 把上一轮报告移进 `history/`；在挑选本轮报告名之前调用。 */
  archiveReports: (task: TaskRecord) => Promise<string[]>
  nextReportName: (task: TaskRecord) => Promise<string>
  timer: TimerPort
  logger: Logger
  clock: () => number
  runTimeoutMs: () => number
  prepareTimeoutMs?: number
  /**
   * 运行落库后回调（推送报告到 IM）。失败只记日志，不影响运行状态。
   * 只在 `status === 'ok'` 且存在报告时调用。
   */
  onRunFinished?: (task: TaskRecord, outcome: RunOutcome) => Promise<void>
}

/** 调度器对外接口。 */
export interface Scheduler {
  /** 启动：读设置后调用，执行 catch-up 并武装第一个 timer。 */
  start: () => Promise<void>
  /** 停止：取消 timer；已在执行的 run 不会被强行中断。 */
  stop: () => void
  /** 重新计算；`catchUp` 只在启动时为 true。 */
  refresh: (catchUp?: boolean) => Promise<void>
  /** 手动执行一次：先建会话并返回 id，回合在后台继续。 */
  startManual: (task: TaskRecord) => Promise<{ sessionId: string }>
  isRunning: (taskId: string) => boolean
  hasRunning: () => boolean
  nextRunAt: (taskId: string) => number | undefined
  /** 等待所有已启动的运行落地（测试/关闭用）。 */
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
  /** 已启动、尚未落地的运行；`waitForIdle` 等它们全部结束。 */
  const inflight = new Set<Promise<void>>()
  let next = new Map<string, number>()
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

  /**
   * 跟踪一次已经启动的运行。
   *
   * 不同任务之间不再排队：调用方 `await` 完准备就能返回，执行在后台跑。
   * 这里只负责兜住异常并释放任务锁——不能让一次失败污染其他运行。
   * @param task - 任务。
   * @param run - 已启动的运行。
   */
  function track(task: TaskRecord, run: Promise<void>): void {
    const settled = run.catch((error: unknown) => {
      deps.logger.warn(`run ${task.id} failed: ${String(error)}`)
    })
    inflight.add(settled)
    void settled.then(() => {
      running.delete(task.id)
      inflight.delete(settled)
    })
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
    // 先把上一轮完成并留在根目录的报告移进 history/，再挑本轮文件名。
    // 归档失败（占用、权限）只记日志：报告留在原地，运行照常开始。
    await withTimeout(deps.archiveReports(task), 'report archiving').catch((error: unknown) => {
      deps.logger.warn(`could not archive the previous report of ${task.id}: ${String(error)}`)
    })
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
    if (outcome.status !== 'ok' || outcome.report === undefined) return
    await deps.onRunFinished?.(task, outcome).catch((error: unknown) => {
      deps.logger.warn(`run ${context.runId} finished but its delivery failed: ${String(error)}`)
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
    const run = (async () => {
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
    })()
    track(task, run)
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
      let context: RunContext
      try {
        context = await deps.records.begin(task, 'manual', false)
      } catch (error: unknown) {
        running.delete(task.id)
        throw new AppError('run_failed', 500, error instanceof Error ? error.message : String(error))
      }
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
      // 不排队：准备完成后立刻开跑，其他任务的运行不会挡住它。
      track(task, execute(task, context, prepared))
      return { sessionId: prepared.sessionId }
    },

    isRunning: (taskId: string): boolean => running.has(taskId),
    hasRunning: (): boolean => running.size > 0,
    nextRunAt: (taskId: string): number | undefined => next.get(taskId),
    async waitForIdle(): Promise<void> {
      // 循环而不是单次快照：等待期间可能又有运行被启动。
      while (inflight.size > 0) await Promise.all([...inflight])
    },
  }
}
