import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { RouteRequest, RouteResponse, RouteSpec, TimerPort } from '../../src/host/ports.js'
import { apply, inject } from '../../src/host/plugin.js'

const roots: string[] = []
let previousHome: string | undefined

beforeAll(() => {
  previousHome = process.env['DSH_HOME']
})

afterEach(async () => {
  if (previousHome === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = previousHome
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

class FakeTimer implements TimerPort {
  entries: Array<{ callback: () => void, delay: number }> = []
  timeout(callback: () => void, delay: number): () => void {
    const entry = { callback, delay }
    this.entries.push(entry)
    return () => { this.entries = this.entries.filter(item => item !== entry) }
  }
}

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

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await new Promise(resolve => { setImmediate(resolve) })
}

interface Harness {
  routes: RouteSpec[]
  timer: FakeTimer
  invoke: (kind: 'exact' | 'prefix', path: string, method: string, url: string, body?: unknown) => Promise<{ status: number, body: string }>
}

async function harness(): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), 'atan-plugin-'))
  roots.push(home)
  process.env['DSH_HOME'] = home
  const timer = new FakeTimer()
  const routes: RouteSpec[] = []
  const disposers: Array<() => void> = []
  const logger = { info: vi.fn(), warn: vi.fn() }
  const agent = {
    status: 'running' as const,
    session: {},
    whenIdle: async () => {},
    cancel: () => {},
  }
  const sessionController = {
    create: vi.fn(async () => ({ sessionId: 'session-1' })),
    inspect: vi.fn(async () => ({})),
    resolveAgent: vi.fn(async () => ({ agent })),
    prompt: vi.fn(async () => ({})),
    selectModel: vi.fn(async () => ({})),
  }
  const workspaceRegistry = {
    list: () => [],
    create: vi.fn(async () => ({ id: 'workspace-1', title: 'Work' })),
    archiveSession: vi.fn(async () => {}),
    unarchiveSession: vi.fn(async () => {}),
  }
  const ctx = {
    logger,
    timer,
    workspaceRegistry,
    sessionController,
    permissionPresets: { set: vi.fn() },
    approval: { setPolicy: vi.fn() },
    credentials: {
      resolve: vi.fn(async () => undefined),
      set: vi.fn(async () => {}),
      unset: vi.fn(async () => {}),
    },
    llm: {
      listProviders: () => [{ id: 'deepseek-official' }],
      listModels: async () => [{ id: 'deepseek-flash' }],
    },
    inject(deps: string[], callback: (scope: unknown) => void) {
      const scope = {
        webServer: {
          register(spec: RouteSpec) {
            routes.push(spec)
            return () => { routes.splice(routes.indexOf(spec), 1) }
          },
        },
        effect(fn: () => () => void) {
          const dispose = fn()
          disposers.push(dispose)
        },
      }
      callback(scope)
      void deps
    },
  }
  apply(ctx as never)
  await flush()

  const invoke = async (
    kind: 'exact' | 'prefix',
    path: string,
    method: string,
    url: string,
    body?: unknown,
  ): Promise<{ status: number, body: string }> => {
    const route = routes.find(item => item.kind === kind && item.path === path)
    if (route === undefined) throw new Error(`route not registered: ${kind} ${path}`)
    const { state, response } = makeResponse()
    await route.handler(makeRequest(method, url, body), response)
    return state
  }

  return { routes, timer, invoke }
}

describe('apply', () => {
  it('exports the expected host services', () => {
    expect(inject).toContain('timer')
    expect(inject).toContain('sessionController')
    expect(inject).toContain('workspaceRegistry')
    expect(inject).toContain('credentials')
  })

  it('serves an empty bot list', async () => {
    const app = await harness()
    const status = await app.invoke('prefix', '/atan-daily/im', 'GET', '/atan-daily/im/status')
    expect(status.status).toBe(200)
    expect(JSON.parse(status.body)).toEqual({ ok: true, bots: [], provisioning: null })
  })

  it('registers the expected routes and serves a create/list/settings round trip', async () => {
    const app = await harness()
    expect(app.routes.map(route => `${route.kind}:${route.path}`).sort()).toEqual([
      'exact:/atan-daily/settings',
      'exact:/atan-daily/settings/directory',
      'exact:/atan-daily/tasks',
      'prefix:/atan-daily/im',
      'prefix:/atan-daily/tasks',
    ])

    const created = await app.invoke('exact', '/atan-daily/tasks', 'POST', '/atan-daily/tasks', {
      name: '集成任务',
      details: '详情',
      schedule: '每天9点',
      timeZone: 'UTC',
    })
    expect(created.status).toBe(201)

    const listed = await app.invoke('exact', '/atan-daily/tasks', 'GET', '/atan-daily/tasks')
    expect(listed.status).toBe(200)
    const body = JSON.parse(listed.body) as { tasks: Array<{ name: string, enabled: boolean, nextRunAt?: string }> }
    expect(body.tasks).toHaveLength(1)
    expect(body.tasks[0]?.name).toBe('集成任务')
    expect(body.tasks[0]?.enabled).toBe(true)
    expect(body.tasks[0]?.nextRunAt).toBeDefined()

    const settings = await app.invoke('exact', '/atan-daily/settings', 'GET', '/atan-daily/settings')
    expect(settings.status).toBe(200)
    const view = JSON.parse(settings.body) as { tasksTotal: number, dirExists: boolean }
    expect(view.tasksTotal).toBe(1)
    expect(view.dirExists).toBe(true)
  })

  it('serves a manual run through the prefix route', async () => {
    const app = await harness()
    await app.invoke('exact', '/atan-daily/tasks', 'POST', '/atan-daily/tasks', {
      name: '手动任务', schedule: '', timeZone: 'UTC',
    })
    const started = await app.invoke('prefix', '/atan-daily/tasks', 'POST', '/atan-daily/tasks/手动任务/run')
    expect(started.status).toBe(202)
    expect(JSON.parse(started.body)).toMatchObject({ ok: true, sessionId: 'session-1' })
    // Let the queued turn finish writing its run record before cleanup.
    await new Promise(resolve => { setTimeout(resolve, 50) })
    await flush()
  })
})
