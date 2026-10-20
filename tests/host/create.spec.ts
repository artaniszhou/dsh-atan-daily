import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TaskListStore } from '../../src/core/task-list.js'
import type { TaskRepository } from '../../src/host/repository.js'
import { createTask } from '../../src/host/tasks/create.js'
import { AppError } from '../../src/host/errors.js'
import { task } from '../fixtures.js'

const roots: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'atan-create-'))
  roots.push(dir)
  return dir
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function deps(dir: string, store: TaskListStore): {
  repository: TaskRepository
  store: () => TaskListStore
  workDir: () => string
  defaultHistoryDays: number
} {
  const repository: TaskRepository = {
    list: async () => [],
    read: async () => undefined,
    count: async () => ({ total: 0, enabled: 0 }),
    decorate: async (meta, details) => task({
      id: meta.id,
      name: meta.name,
      details,
      folder: join(dir, meta.id),
      createdAt: meta.createdAt,
      historyDays: meta.historyDays,
      cron: meta.cron ?? undefined,
      scheduleMode: meta.scheduleMode,
      enabled: meta.enabled,
      timeZone: meta.timeZone,
    }),
  }
  return {
    repository,
    store: () => store,
    workDir: () => dir,
    defaultHistoryDays: 7,
  }
}

describe('createTask', () => {
  it('scaffolds the folder, rule and registry row', async () => {
    const dir = await tempDir()
    const store = new TaskListStore(dir, { defaultHistoryDays: 7 })
    const created = await createTask(deps(dir, store), {
      name: 'A股 银行',
      details: '详情',
      schedule: { cron: '0 9 * * *', text: '每天9点' },
      timeZone: 'Asia/Shanghai',
    })
    expect(created.id).toBe('A股 银行')
    expect((await stat(join(dir, 'A股 银行', 'meta', 'rule.md'))).isFile()).toBe(true)
    const [row] = await store.list()
    expect(row?.cron).toBe('0 9 * * *')
    expect(row?.enabled).toBe(true)
    expect(row?.historyDays).toBe(7)
  })

  it('rejects a duplicate name without deleting the original folder', async () => {
    const dir = await tempDir()
    const store = new TaskListStore(dir, { defaultHistoryDays: 7 })
    await createTask(deps(dir, store), {
      name: 'same', details: '', schedule: undefined, timeZone: 'UTC',
    })
    await expect(createTask(deps(dir, store), {
      name: 'same', details: '', schedule: undefined, timeZone: 'UTC',
    })).rejects.toMatchObject({ code: 'conflict', status: 409 })
    expect((await stat(join(dir, 'same', 'meta', 'rule.md'))).isFile()).toBe(true)
    expect(await store.list()).toHaveLength(1)
  })

  it('lets exactly one of two concurrent creates with the same name win', async () => {
    const dir = await tempDir()
    const store = new TaskListStore(dir, { defaultHistoryDays: 7 })
    const shared = deps(dir, store)
    const results = await Promise.allSettled([
      createTask(shared, { name: 'race', details: 'a', schedule: undefined, timeZone: 'UTC' }),
      createTask(shared, { name: 'race', details: 'b', schedule: undefined, timeZone: 'UTC' }),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(await store.list()).toHaveLength(1)
    expect((await stat(join(dir, 'race', 'meta', 'rule.md'))).isFile()).toBe(true)
  })

  it('rejects an unusable name', async () => {
    const dir = await tempDir()
    const store = new TaskListStore(dir, { defaultHistoryDays: 7 })
    await expect(createTask(deps(dir, store), {
      name: '...', details: '', schedule: undefined, timeZone: 'UTC',
    })).rejects.toBeInstanceOf(AppError)
  })
})
