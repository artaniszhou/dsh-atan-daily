import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeAtomic } from '../../src/core/fs.js'
import {
  listRunRecords,
  newRunId,
  pruneRunRecords,
  runFilePath,
  type RunRecord,
  type RunStatus,
} from '../../src/core/runs.js'

const roots: string[] = []

async function taskFolder(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'atan-runs-'))
  roots.push(root)
  await mkdir(join(root, 'meta', 'runs'), { recursive: true })
  return root
}

function record(runId: string, status: RunStatus, startedAt: string): RunRecord {
  return {
    v: 1,
    runId,
    taskId: 't1',
    trigger: 'manual',
    catchUp: false,
    scheduledFor: null,
    startedAt,
    finishedAt: null,
    durationMs: 1,
    sessionId: null,
    report: null,
    reportExists: null,
    error: null,
    bootId: 'boot',
    plugin: 'test',
    status,
  }
}

async function write(folder: string, rec: RunRecord): Promise<string> {
  const id = newRunId(new Date(rec.startedAt))
  await writeAtomic(runFilePath(folder, id), JSON.stringify({ ...rec, runId: id }))
  return id
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('run records', () => {
  it('lists newest first and honours status/before/limit', async () => {
    const folder = await taskFolder()
    const first = await write(folder, record('x', 'ok', '2026-10-01T00:00:00.000Z'))
    const second = await write(folder, record('x', 'failed', '2026-10-02T00:00:00.000Z'))
    const third = await write(folder, record('x', 'running', '2026-10-03T00:00:00.000Z'))

    expect((await listRunRecords(folder, { limit: 50 })).map(row => row.runId)).toEqual([third, second, first])
    expect((await listRunRecords(folder, { limit: 50, status: 'failed' })).map(row => row.status)).toEqual(['failed'])
    expect((await listRunRecords(folder, { limit: 50, before: '2026-10-03T00:00:00.000Z' })).map(row => row.runId))
      .toEqual([second, first])
    expect((await listRunRecords(folder, { limit: 1 })).map(row => row.runId)).toEqual([third])
  })

  it('ignores malformed records', async () => {
    const folder = await taskFolder()
    const id = await write(folder, record('x', 'ok', '2026-10-01T00:00:00.000Z'))
    await writeAtomic(runFilePath(folder, 'bad'), '{"v":1,"runId":"bad"}')
    expect((await listRunRecords(folder, { limit: 50 })).map(row => row.runId)).toEqual([id])
  })

  it('prunes records older than the retention window and keeps recent ones', async () => {
    const folder = await taskFolder()
    await write(folder, record('x', 'ok', '2026-10-01T00:00:00.000Z'))
    const recent = await write(folder, record('x', 'ok', '2026-10-04T00:00:00.000Z'))
    const removed = await pruneRunRecords(folder, 1, Date.parse('2026-10-05T00:00:00.000Z'))
    expect(removed).toBe(1)
    expect((await listRunRecords(folder, { limit: 50 })).map(row => row.runId)).toEqual([recent])
  })

  it('keeps everything when retention is zero', async () => {
    const folder = await taskFolder()
    await write(folder, record('x', 'ok', '2020-01-01T00:00:00.000Z'))
    expect(await pruneRunRecords(folder, 0, Date.now())).toBe(0)
    expect(await listRunRecords(folder, { limit: 50 })).toHaveLength(1)
  })
})
