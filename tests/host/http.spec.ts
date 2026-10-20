import { describe, expect, it, vi } from 'vitest'
import type { SettingsView, TaskRecord } from '../../src/protocol.js'
import type { TaskListStore } from '../../src/core/task-list.js'
import type { Logger, RouteRequest, RouteResponse } from '../../src/host/ports.js'
import type { TaskRepository } from '../../src/host/repository.js'
import type { SettingsStore } from '../../src/host/settings/store.js'
import { createTaskRoutes } from '../../src/host/http/tasks.js'
import { createSettingsRoutes } from '../../src/host/http/settings.js'
import { guard } from '../../src/host/http/server.js'
import { parseCreateBody, parsePatchBody, parseRunsQuery } from '../../src/host/http/validate.js'
import { task } from '../fixtures.js'

const logger: Logger = { info: () => {}, warn: () => {}, run: () => {} }

function makeRequest(method: string, url: string, body?: unknown): RouteRequest {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function makeResponse(): { state: { status: number, body: string }, response: RouteResponse } {
  const state = { status: 0, body: '' }
  return {
    state,
    response: {
      writeHead: (status: number) => { state.status = status },
      end: (body?: string) => { state.body = body ?? '' },
    },
  }
}

const frozen = task({
  id: 't1',
  folder: '/work/t1',
  timeZone: 'UTC',
  scheduleMode: 'text',
  scheduleText: '每天 9 点',
  cron: '0 9 * * *',
  enabled: false,
})

function taskDeps(): Parameters<typeof createTaskRoutes>[0] {
  const repository = {
    list: vi.fn(async () => [frozen]),
    read: vi.fn(async (id: string) => id === 't1' ? frozen : undefined),
    count: vi.fn(async () => ({ total: 1, enabled: 0 })),
    decorate: vi.fn(async () => frozen),
  } satisfies TaskRepository
  const store = {
    patch: vi.fn(async () => frozen),
    remove: vi.fn(async () => {}),
  } as unknown as TaskListStore
  return {
    repository,
    store: () => store,
    createTask: vi.fn(async () => frozen),
    scheduler: {
      refresh: vi.fn(async () => {}),
      startManual: vi.fn(async () => ({ sessionId: 's1' })),
      isRunning: vi.fn(() => false),
      nextRunAt: vi.fn(() => undefined),
    },
    sessions: { open: vi.fn(async () => 's1') },
    records: { prune: vi.fn(async () => {}) },
    hostTimeZone: () => 'UTC',
  }
}

describe('validate', () => {
  it('rejects an unknown create timezone instead of silently falling back', () => {
    expect(() => parseCreateBody({ name: 'x', timeZone: 'Bad/Zone' }, 'UTC')).toThrow(/unknown time zone/)
    expect(parseCreateBody({ name: 'x', timeZone: 'Asia/Shanghai' }, 'UTC').timeZone).toBe('Asia/Shanghai')
    expect(parseCreateBody({ name: 'x' }, 'UTC').timeZone).toBe('UTC')
  })

  it('does not re-enable a paused task when only the timezone changes', () => {
    const result = parsePatchBody({ timeZone: 'UTC' }, frozen)
    expect(result.patch).toEqual({ timeZone: 'UTC' })
  })

  it('enables a manual task when it gets a schedule', () => {
    const manual = task({ scheduleMode: 'manual', cron: undefined, enabled: false })
    const result = parsePatchBody({ schedule: { mode: 'text', text: '每天 9 点' } }, manual)
    expect(result.patch.enabled).toBe(true)
    expect(result.patch.cron).toBe('0 9 * * *')
  })

  it('validates run query parameters', () => {
    expect(parseRunsQuery('/x?limit=5').limit).toBe(5)
    expect(() => parseRunsQuery('/x?limit=0')).toThrow()
    expect(() => parseRunsQuery('/x?before=nope')).toThrow()
    expect(() => parseRunsQuery('/x?status=nope')).toThrow()
  })
})

describe('task routes', () => {
  it('decorates list rows with nextRunAt and running', async () => {
    const deps = taskDeps()
    deps.scheduler.isRunning = vi.fn(() => true)
    deps.scheduler.nextRunAt = vi.fn(() => Date.parse('2026-10-20T09:00:00Z'))
    const { state, response } = makeResponse()
    await createTaskRoutes(deps).collection(makeRequest('GET', '/atan-daily/tasks'), response)
    expect(state.status).toBe(200)
    const body = JSON.parse(state.body) as { tasks: TaskRecord[] }
    expect(body.tasks[0]?.running).toBe(true)
    expect(body.tasks[0]?.nextRunAt).toBe('2026-10-20T09:00:00.000Z')
  })

  it('returns 400 for an invalid create timezone and does not create', async () => {
    const deps = taskDeps()
    const createTask = deps.createTask as unknown as ReturnType<typeof vi.fn>
    const { state, response } = makeResponse()
    await guard(createTaskRoutes(deps).collection, logger)(
      makeRequest('POST', '/atan-daily/tasks', { name: 'x', timeZone: 'Bad/Zone' }),
      response,
    )
    expect(state.status).toBe(400)
    expect(createTask).not.toHaveBeenCalled()
  })

  it('PATCHes only the fields the client sent', async () => {
    const deps = taskDeps()
    const store = deps.store() as unknown as { patch: ReturnType<typeof vi.fn> }
    const { state, response } = makeResponse()
    await createTaskRoutes(deps).item(
      makeRequest('PATCH', '/atan-daily/tasks/t1', { timeZone: 'UTC' }),
      response,
      't1',
      '',
    )
    expect(state.status).toBe(200)
    expect(store.patch).toHaveBeenCalledWith('t1', { timeZone: 'UTC' })
  })

  it('refuses to delete a running task', async () => {
    const deps = taskDeps()
    const store = deps.store() as unknown as { remove: ReturnType<typeof vi.fn> }
    deps.scheduler.isRunning = vi.fn(() => true)
    const routes = createTaskRoutes(deps)
    const { state, response } = makeResponse()
    await guard((request, res) => routes.item(request, res, 't1', ''), logger)(
      makeRequest('DELETE', '/atan-daily/tasks/t1'),
      response,
    )
    expect(state.status).toBe(409)
    expect(store.remove).not.toHaveBeenCalled()
  })

  it('starts a manual run and returns 202 with its session', async () => {
    const deps = taskDeps()
    const { state, response } = makeResponse()
    await createTaskRoutes(deps).item(makeRequest('POST', '/atan-daily/tasks/t1/run'), response, 't1', 'run')
    expect(state.status).toBe(202)
    expect(JSON.parse(state.body)).toEqual({ ok: true, accepted: true, sessionId: 's1' })
  })
})

describe('settings routes', () => {
  const view: SettingsView = {
    workDir: '/work', defaultWorkDir: '/default', savedWorkDir: '/work',
    tasksTotal: 0, tasksEnabled: 0, dirExists: true, workspace: null, pluginVersion: '1.0.0',
  }

  function settingsDeps(): Parameters<typeof createSettingsRoutes>[0] {
    const settings = {
      settingsRoot: '/settings',
      defaultWorkDir: '/default',
      historyDays: 7,
      workDir: () => '/work',
      store: () => ({} as TaskListStore),
      settings: () => ({ workDir: '/work' }),
      useWorkDir: () => {},
      load: async () => {},
      save: vi.fn(async () => {}),
    } satisfies SettingsStore
    return {
      settings,
      describer: { describe: vi.fn(async () => view) },
      workspaces: {
        at: vi.fn(() => undefined),
        prepare: vi.fn(async () => ({})),
      },
      scheduler: {
        refresh: vi.fn(async () => {}),
        hasRunning: vi.fn(() => false),
      },
      logger,
    }
  }

  it('clears a saved directory with null without creating the default', async () => {
    const deps = settingsDeps()
    const save = deps.settings.save as unknown as ReturnType<typeof vi.fn>
    const prepare = deps.workspaces.prepare as unknown as ReturnType<typeof vi.fn>
    const routes = createSettingsRoutes(deps)
    const { state, response } = makeResponse()
    await guard(routes.settings, logger)(
      makeRequest('PATCH', '/atan-daily/settings', { workDir: null }),
      response,
    )
    expect(state.status).toBe(200)
    expect(prepare).not.toHaveBeenCalled()
    expect(save).toHaveBeenCalledWith({ workDir: null })
  })

  it('refuses a directory switch while runs are in progress', async () => {
    const deps = settingsDeps()
    const save = deps.settings.save as unknown as ReturnType<typeof vi.fn>
    deps.scheduler.hasRunning = vi.fn(() => true)
    const { state, response } = makeResponse()
    await guard(createSettingsRoutes(deps).settings, logger)(
      makeRequest('PATCH', '/atan-daily/settings', { workDir: '/other' }),
      response,
    )
    expect(state.status).toBe(409)
    expect(save).not.toHaveBeenCalled()
  })
})
