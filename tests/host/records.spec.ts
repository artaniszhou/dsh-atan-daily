import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TaskListStore, type TaskMeta } from '../../src/core/task-list.js'
import { listRunRecords, runFilePath, type RunRecord } from '../../src/core/runs.js'
import { createRunRecords } from '../../src/host/runs/records.js'
import type { Logger } from '../../src/host/ports.js'
import { task } from '../fixtures.js'

const roots: string[] = []
const logger: Logger = { info: () => {}, warn: () => {}, run: () => {} }

async function setup(): Promise<{ dir: string, store: TaskListStore, folder: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'atan-records-'))
  roots.push(dir)
  const store = new TaskListStore(dir, { defaultHistoryDays: 7 })
  const meta: TaskMeta = {
    v: 2, id: 't1', name: 'T1', createdAt: '2026-10-01T00:00:00.000Z',
    scheduleMode: 'cron', cron: '0 9 * * *', scheduleText: null, timeZone: 'UTC',
    enabled: true, historyDays: 7, sessionId: null, lastRunAt: null, lastStatus: null,
    lastDurationMs: null, lastRunId: null, lastError: null, updatedAt: '2026-10-01T00:00:00.000Z',
  }
  await store.create(meta)
  const folder = join(dir, 't1')
  await mkdir(join(folder, 'meta', 'runs'), { recursive: true })
  return { dir, store, folder }
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('run records service', () => {
  it('writes a running record, then an ok record with the report state and summary', async () => {
    const { store, folder } = await setup()
    let current = new Date('2026-10-20T09:00:00.000Z')
    const records = createRunRecords({ store: () => store, logger, bootId: 'boot-1', clock: () => current })
    const taskRecord = task({ id: 't1', folder, timeZone: 'UTC' })
    const context = await records.begin(taskRecord, 'manual', false)
    const running = JSON.parse(await readFile(runFilePath(folder, context.runId), 'utf8')) as RunRecord
    expect(running.status).toBe('running')

    await writeFile(join(folder, 'report.md'), '# report', 'utf8')
    current = new Date('2026-10-20T09:00:05.000Z')
    await records.finish(taskRecord, context, { status: 'ok', sessionId: 's1', report: 'report.md' })
    const finished = JSON.parse(await readFile(runFilePath(folder, context.runId), 'utf8')) as RunRecord
    expect(finished.status).toBe('ok')
    expect(finished.reportExists).toBe(true)
    expect(finished.durationMs).toBe(5_000)
    const meta = await store.get('t1')
    expect(meta?.lastStatus).toBe('ok')
    expect(meta?.lastRunId).toBe(context.runId)
  })

  it('records a skipped slot without touching the task summary', async () => {
    const { store, folder } = await setup()
    const records = createRunRecords({ store: () => store, logger, bootId: 'boot-1' })
    const taskRecord = task({ id: 't1', folder })
    await records.recordSkip(taskRecord, Date.parse('2026-10-20T09:00:00Z'), 'overlap')
    const runs = await listRunRecords(folder, { limit: 10 })
    expect(runs[0]?.status).toBe('skipped')
    expect(runs[0]?.reason).toBe('overlap')
    expect((await store.get('t1'))?.lastStatus).toBeNull()
  })

  it('marks a stale running record interrupted and sets the baseline summary', async () => {
    const { store, folder } = await setup()
    const records = createRunRecords({ store: () => store, logger, bootId: 'boot-2' })
    const taskRecord = task({ id: 't1', folder })
    const record: RunRecord = {
      v: 1, runId: '20261020T090000000Z-abc123', taskId: 't1', trigger: 'schedule',
      catchUp: false, scheduledFor: null, startedAt: '2026-10-20T09:00:00.000Z',
      finishedAt: null, status: 'running', durationMs: null, sessionId: 's1',
      report: null, reportExists: null, error: null, bootId: 'boot-1', plugin: 'test',
    }
    await records.interrupt(taskRecord, record)
    const interrupted = JSON.parse(await readFile(runFilePath(folder, record.runId), 'utf8')) as RunRecord
    expect(interrupted.status).toBe('interrupted')
    expect(interrupted.error?.code).toBe('host_interrupted')
    const meta = await store.get('t1')
    expect(meta?.lastStatus).toBe('interrupted')
    expect(meta?.lastRunAt).toBe(record.startedAt)
  })

  it('prunes records after the retention window', async () => {
    const { store, folder } = await setup()
    let current = new Date('2026-10-01T00:00:00.000Z')
    const records = createRunRecords({ store: () => store, logger, bootId: 'boot-1', clock: () => current })
    const taskRecord = task({ id: 't1', folder, historyDays: 1 })
    const context = await records.begin(taskRecord, 'manual', false)
    await records.finish(taskRecord, context, { status: 'ok' })
    current = new Date('2026-10-05T00:00:00.000Z')
    await records.prune(taskRecord, true)
    expect(await listRunRecords(folder, { limit: 10 })).toEqual([])
  })
})
