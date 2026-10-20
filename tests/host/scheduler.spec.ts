import { describe, expect, it, vi } from 'vitest'
import type { TaskRecord } from '../../src/protocol.js'
import type { TaskListStore } from '../../src/core/task-list.js'
import type { Logger, TimerPort } from '../../src/host/ports.js'
import type { RunContext, RunRecords } from '../../src/host/runs/records.js'
import { createScheduler, type SchedulerDeps } from '../../src/host/scheduling/scheduler.js'
import { AppError } from '../../src/host/errors.js'
import { task } from '../fixtures.js'

const logger: Logger = { info: () => {}, warn: () => {}, run: () => {} }

class FakeTimer implements TimerPort {
  private seq = 0
  entries: Array<{ id: number, delay: number, callback: () => void }> = []

  timeout(callback: () => void, delay: number): () => void {
    const id = ++this.seq
    this.entries.push({ id, delay, callback })
    return () => { this.entries = this.entries.filter(entry => entry.id !== id) }
  }

  get count(): number {
    return this.entries.length
  }

  get delay(): number | undefined {
    return this.entries.at(-1)?.delay
  }

  fire(): void {
    const entry = this.entries.shift()
    if (entry === undefined) throw new Error('no timer armed')
    entry.callback()
  }
}

async function flush(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await new Promise(resolve => { setImmediate(resolve) })
}

function contextFor(taskRecord: TaskRecord): RunContext {
  return {
    runId: 'run-1',
    taskId: taskRecord.id,
    taskFolder: taskRecord.folder,
    trigger: 'schedule',
    catchUp: false,
    scheduledFor: null,
    startedAt: '2026-10-20T09:00:00.000Z',
    bootId: 'boot',
    store: {} as TaskListStore,
  }
}

function setup(initial: TaskRecord): {
  scheduler: ReturnType<typeof createScheduler>
  timer: FakeTimer
  executor: ReturnType<typeof vi.fn>
  begin: ReturnType<typeof vi.fn>
  finish: ReturnType<typeof vi.fn>
  recordSkip: ReturnType<typeof vi.fn>
  prepare: ReturnType<typeof vi.fn>
  list: ReturnType<typeof vi.fn>
  setTasks: (tasks: TaskRecord[]) => void
  clock: { now: number }
} {
  const timer = new FakeTimer()
  const clock = { now: Date.parse('2026-10-20T08:00:00.000Z') }
  let tasks = [initial]
  const begin = vi.fn(async (taskRecord: TaskRecord) => contextFor(taskRecord))
  const finish = vi.fn(async () => {})
  const recordSkip = vi.fn(async () => {})
  const prepare = vi.fn(async () => 'session-1')
  const executor = vi.fn(async () => {})
  const list = vi.fn(async () => tasks)
  const records = { begin, finish, recordSkip } as unknown as Pick<RunRecords, 'begin' | 'finish' | 'recordSkip'>
  const deps: SchedulerDeps = {
    repository: { list },
    records,
    sessions: { prepare },
    executor: { drive: executor },
    nextReportName: async () => 'report.md',
    timer,
    logger,
    clock: () => clock.now,
    runTimeoutMs: () => 60_000,
  }
  return {
    scheduler: createScheduler(deps),
    timer, executor, begin, finish, recordSkip, prepare, list,
    setTasks: (next: TaskRecord[]) => { tasks = next },
    clock,
  }
}

const daily = task({
  id: 't1',
  folder: '/work/t1',
  timeZone: 'UTC',
  cron: '0 9 * * *',
  enabled: true,
  createdAt: '2026-10-01T00:00:00.000Z',
  lastRunAt: '2026-10-19T09:00:00.000Z',
})

describe('scheduler', () => {
  it('arms one timer for the next occurrence', async () => {
    const s = setup(daily)
    await s.scheduler.start()
    expect(s.timer.count).toBe(1)
    expect(s.timer.delay).toBe(60 * 60 * 1000)
    expect(s.scheduler.nextRunAt('t1')).toBe(Date.parse('2026-10-20T09:00:00.000Z'))
  })

  it('runs a due task once and re-arms the next day', async () => {
    const s = setup(daily)
    await s.scheduler.start()
    s.clock.now = Date.parse('2026-10-20T09:00:00.000Z')
    s.timer.fire()
    await flush()
    await s.scheduler.waitForIdle()
    expect(s.executor).toHaveBeenCalledTimes(1)
    expect(s.finish).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't1' }),
      expect.anything(),
      expect.objectContaining({ status: 'ok' }),
    )
    expect(s.scheduler.isRunning('t1')).toBe(false)
    expect(s.scheduler.nextRunAt('t1')).toBe(Date.parse('2026-10-21T09:00:00.000Z'))
  })

  it('does not run an old slot after the schedule changed', async () => {
    const s = setup(daily)
    await s.scheduler.start()
    s.clock.now = Date.parse('2026-10-20T09:00:00.000Z')
    s.setTasks([{ ...daily, cron: '0 10 * * *' }])
    await s.scheduler.refresh()
    expect(s.executor).not.toHaveBeenCalled()
    expect(s.scheduler.nextRunAt('t1')).toBe(Date.parse('2026-10-20T10:00:00.000Z'))
  })

  it('catches up the latest missed slot when starting after it', async () => {
    const s = setup(daily)
    s.clock.now = Date.parse('2026-10-20T10:00:00.000Z')
    await s.scheduler.start()
    await s.scheduler.waitForIdle()
    expect(s.begin).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't1' }),
      'schedule',
      true,
      Date.parse('2026-10-20T09:00:00.000Z'),
    )
    expect(s.executor).toHaveBeenCalledTimes(1)
  })

  it('arms a retry when the repository read fails, then recovers', async () => {
    const s = setup(daily)
    s.list.mockRejectedValueOnce(new Error('offline'))
    await s.scheduler.start()
    expect(s.timer.count).toBe(1)
    expect(s.timer.delay).toBe(30_000)

    s.timer.fire()
    await flush()
    expect(s.timer.count).toBe(1)
    expect(s.timer.delay).toBe(60 * 60 * 1000)
  })

  it('keeps a single timer across concurrent refreshes', async () => {
    const s = setup(daily)
    await s.scheduler.start()
    await Promise.all([s.scheduler.refresh(), s.scheduler.refresh(), s.scheduler.refresh()])
    expect(s.timer.count).toBe(1)
  })

  it('does not arm a timer for a disabled task', async () => {
    const s = setup({ ...daily, enabled: false })
    await s.scheduler.start()
    expect(s.timer.count).toBe(0)
    expect(s.scheduler.nextRunAt('t1')).toBeUndefined()
  })

  it('starts a manual run, returns its session, and rejects a second one', async () => {
    const s = setup(daily)
    const first = s.scheduler.startManual(daily)
    await expect(s.scheduler.startManual(daily)).rejects.toBeInstanceOf(AppError)
    await expect(first).resolves.toEqual({ sessionId: 'session-1' })
    await s.scheduler.waitForIdle()
    expect(s.executor).toHaveBeenCalledTimes(1)
    expect(s.begin).toHaveBeenCalledWith(daily, 'manual', false)
  })

  it('records an overlap skip instead of starting a second run', async () => {
    const s = setup(daily)
    await s.scheduler.start()
    let release: (() => void) | undefined
    s.executor.mockImplementation(() => new Promise<void>((resolve) => { release = resolve }))
    s.clock.now = Date.parse('2026-10-20T09:00:00.000Z')
    await s.scheduler.startManual(daily)
    await flush()
    s.timer.fire()
    await flush()
    expect(s.recordSkip).toHaveBeenCalledWith(daily, Date.parse('2026-10-20T09:00:00.000Z'), 'overlap')
    release?.()
    await s.scheduler.waitForIdle()
    expect(s.executor).toHaveBeenCalledTimes(1)
  })
})
