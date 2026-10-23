import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TaskListStore, type TaskMeta } from '../../src/core/task-list.js'

const roots: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'atan-list-'))
  roots.push(dir)
  return dir
}

function meta(overrides: Partial<TaskMeta> = {}): TaskMeta {
  const at = '2026-10-01T00:00:00.000Z'
  return {
    v: 2,
    id: 't1',
    name: 'T1',
    createdAt: at,
    scheduleMode: 'manual',
    cron: null,
    scheduleText: null,
    timeZone: 'UTC',
    enabled: false,
    historyDays: 7,
    pushBotIds: [],
    pushEnabled: false,
    sessionId: null,
    lastRunAt: null,
    lastStatus: null,
    lastDurationMs: null,
    lastRunId: null,
    lastError: null,
    updatedAt: at,
    ...overrides,
  }
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('TaskListStore', () => {
  it('reads a missing working directory as empty without creating it', async () => {
    const root = await tempDir()
    const missing = join(root, 'missing')
    const store = new TaskListStore(missing, { defaultHistoryDays: 7 })
    await expect(store.list()).resolves.toEqual([])
    await expect(stat(missing)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('creates the directory and registry only for a write', async () => {
    const root = await tempDir()
    const dir = join(root, 'work')
    const store = new TaskListStore(dir, { defaultHistoryDays: 7 })
    await store.ensure()
    expect((await stat(dir)).isDirectory()).toBe(true)
    expect(await readFile(join(dir, 'task-list.jsonl'), 'utf8')).toBe('')
  })

  it('creates, lists, patches and removes a task', async () => {
    const dir = await tempDir()
    const store = new TaskListStore(dir, { defaultHistoryDays: 7 })
    await store.create(meta())
    await store.create(meta({ id: 't2', name: 'T2' }))
    expect((await store.list()).map(row => row.id).sort()).toEqual(['t1', 't2'])
    expect((await store.get('t2'))?.name).toBe('T2')

    const updated = await store.patch('t1', { enabled: true, cron: '0 9 * * *', scheduleMode: 'cron' })
    expect(updated.enabled).toBe(true)
    expect(updated.cron).toBe('0 9 * * *')

    await store.remove('t2')
    expect((await store.list()).map(row => row.id)).toEqual(['t1'])
  })

  it('rejects a duplicate create without changing the existing rows', async () => {
    const dir = await tempDir()
    const store = new TaskListStore(dir, { defaultHistoryDays: 7 })
    await store.create(meta())
    await expect(store.create(meta())).rejects.toMatchObject({ code: 'EEXIST' })
    expect((await store.list()).map(row => row.id)).toEqual(['t1'])
  })

  it('retries ensure after a transient failure', async () => {
    const root = await tempDir()
    const target = join(root, 'workdir')
    await writeFile(target, 'not a directory')
    const store = new TaskListStore(target, { defaultHistoryDays: 7 })
    await expect(store.ensure()).rejects.toBeTruthy()
    // Fix the filesystem; the store must not keep the rejected promise.
    await rm(target)
    await mkdir(target)
    await expect(store.ensure()).resolves.toBeUndefined()
    await expect(store.list()).resolves.toEqual([])
  })

  it('restores a truncated registry from the sibling backup', async () => {
    const dir = await tempDir()
    const store = new TaskListStore(dir, { defaultHistoryDays: 7 })
    await store.create(meta())
    const line = JSON.stringify(meta())
    await writeFile(join(dir, 'task-list.jsonl.bak'), `${line}\n`, 'utf8')
    await writeFile(join(dir, 'task-list.jsonl'), '', 'utf8')

    const recovered = new TaskListStore(dir, { defaultHistoryDays: 7 })
    // An explicitly empty registry is valid and must not be replaced...
    await recovered.ensure()
    expect(await recovered.list()).toEqual([])

    // ...but a deleted registry is restored from the backup.
    await rm(join(dir, 'task-list.jsonl'))
    const restored = new TaskListStore(dir, { defaultHistoryDays: 7 })
    await restored.ensure()
    expect((await restored.list()).map(row => row.id)).toEqual(['t1'])
  })

  it('normalizes an invalid timezone and manual rows', async () => {
    const dir = await tempDir()
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'task-list.jsonl'), `${JSON.stringify({
      ...meta(), timeZone: 'Bad/Zone', scheduleMode: 'manual', cron: '0 9 * * *', enabled: true,
    })}\n`, 'utf8')
    const store = new TaskListStore(dir, { defaultHistoryDays: 7 })
    const [row] = await store.list()
    expect(row?.timeZone).toBe(new Intl.DateTimeFormat().resolvedOptions().timeZone)
    expect(row?.cron).toBeNull()
    expect(row?.enabled).toBe(false)
  })

  it('把旧的单个 pushBotId 读成 pushBotIds 数组，并清洗非法项', async () => {
    const dir = await tempDir()
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'task-list.jsonl'), [
      JSON.stringify({ ...meta({ id: 't1' }), pushBotIds: undefined, pushBotId: 'fs_old' }),
      JSON.stringify({ ...meta({ id: 't2' }), pushBotIds: ['fs_a', 'fs_a', '  ', 'bad id!', 'fs_b'] }),
    ].join('\n') + '\n', 'utf8')

    const store = new TaskListStore(dir, { defaultHistoryDays: 7 })
    const rows = await store.list()
    expect(rows.find(row => row.id === 't1')?.pushBotIds).toEqual(['fs_old'])
    expect(rows.find(row => row.id === 't2')?.pushBotIds).toEqual(['fs_a', 'fs_b'])
  })
})
