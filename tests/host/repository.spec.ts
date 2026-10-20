import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeRuleContent } from '../../src/core/rule.js'
import { TaskListStore, type TaskMeta } from '../../src/core/task-list.js'
import { createTaskRepository } from '../../src/host/repository.js'
import type { Logger } from '../../src/host/ports.js'

const roots: string[] = []
const logger: Logger = { info: () => {}, warn: () => {}, run: () => {} }

async function setup(): Promise<{ dir: string, store: TaskListStore }> {
  const dir = await mkdtemp(join(tmpdir(), 'atan-read-'))
  roots.push(dir)
  const store = new TaskListStore(dir, { defaultHistoryDays: 7 })
  await store.ensure()
  return { dir, store }
}

function meta(id: string, overrides: Partial<TaskMeta> = {}): TaskMeta {
  return {
    v: 2, id, name: id, createdAt: '2026-10-01T00:00:00.000Z', scheduleMode: 'cron',
    cron: '0 9 * * *', scheduleText: null, timeZone: 'UTC', enabled: true, historyDays: 7,
    sessionId: null, lastRunAt: null, lastStatus: null, lastDurationMs: null,
    lastRunId: null, lastError: null, updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  }
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('task repository', () => {
  it('decorates details, the latest fixed-width report and task count', async () => {
    const { dir, store } = await setup()
    await store.create(meta('t1'))
    const folder = join(dir, 't1')
    await mkdir(folder, { recursive: true })
    await writeRuleContent(folder, '任务详情')
    await writeFile(join(folder, '2026-10-18-090000.md'), 'old', 'utf8')
    await writeFile(join(folder, '2026-10-19-090000.md'), 'new', 'utf8')
    await writeFile(join(folder, 'notes.md'), 'note', 'utf8')

    const repository = createTaskRepository({ store: () => store, workDir: () => dir, logger })
    const [task] = await repository.list()
    expect(task?.details).toBe('任务详情')
    expect(task?.report).toBe('2026-10-19-090000.md')
    expect(task?.historyCount).toBe(1)
    expect(task?.frequency).toBe('daily')
    expect(await repository.count()).toEqual({ total: 1, enabled: 1 })
    expect((await repository.read('t1'))?.name).toBe('t1')
  })

  it('skips registry rows whose folder is gone', async () => {
    const { dir, store } = await setup()
    await store.create(meta('gone'))
    const repository = createTaskRepository({ store: () => store, workDir: () => dir, logger })
    expect(await repository.list()).toEqual([])
    expect(await repository.count()).toEqual({ total: 0, enabled: 0 })
    expect(await repository.read('gone')).toBeUndefined()
  })

  it('rejects unsafe ids in read', async () => {
    const { dir, store } = await setup()
    const repository = createTaskRepository({ store: () => store, workDir: () => dir, logger })
    expect(await repository.read('../escape')).toBeUndefined()
  })
})
