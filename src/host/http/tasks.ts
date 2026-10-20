/**
 * 任务路由：集合（GET/POST）与单项（PATCH/DELETE/run/session/runs）。
 *
 * 路由只负责解析路径、调用 service、写响应；校验与业务都在这里之外的模块。
 */

import { rm } from 'node:fs/promises'
import { listRunRecords } from '../../core/runs.js'
import type { TaskListStore } from '../../core/task-list.js'
import type { TaskRecord } from '../../protocol.js'
import { ROUTE } from '../config.js'
import { AppError } from '../errors.js'
import { answer, methodNotAllowed, pathnameOf, readJsonBody } from './server.js'
import type { RouteHandler } from '../ports.js'
import type { TaskRepository } from '../repository.js'
import type { RunRecords } from '../runs/records.js'
import type { RunSessionService } from '../runs/session.js'
import type { Scheduler } from '../scheduling/scheduler.js'
import type { CreateTaskInput } from '../tasks/create.js'
import { parseCreateBody, parsePatchBody, parseRunsQuery } from './validate.js'

/** 任务路由依赖。 */
export interface TaskRoutesDeps {
  repository: TaskRepository
  store: () => TaskListStore
  createTask: (input: CreateTaskInput) => Promise<TaskRecord>
  scheduler: Pick<Scheduler, 'refresh' | 'startManual' | 'isRunning' | 'nextRunAt'>
  sessions: Pick<RunSessionService, 'open'>
  records: Pick<RunRecords, 'prune'>
  hostTimeZone: () => string
}

/** 单项任务路由处理器。 */
export type TaskItemHandler = (
  request: Parameters<RouteHandler>[0],
  response: Parameters<RouteHandler>[1],
  id: string,
  action: string,
) => Promise<void>

/** 任务路由集合。 */
export interface TaskRoutes {
  collection: RouteHandler
  item: TaskItemHandler
}

/**
 * 给任务视图补上计算字段。
 * @param deps - 路由依赖。
 * @param task - 基础视图。
 * @returns 带 nextRunAt/running 的视图。
 */
function withRuntime(deps: TaskRoutesDeps, task: TaskRecord): TaskRecord {
  const due = deps.scheduler.nextRunAt(task.id)
  return {
    ...task,
    ...due === undefined ? {} : { nextRunAt: new Date(due).toISOString() },
    ...deps.scheduler.isRunning(task.id) ? { running: true } : {},
  }
}

/**
 * 解析 `/atan-daily/tasks/<id>/<action>`。
 * @param pathname - URL pathname。
 * @returns id 与 action，或 undefined 当路径不属于任务前缀。
 */
export function parseTaskPath(pathname: string): { id: string, action: string } | undefined {
  if (pathname === ROUTE) return { id: '', action: '' }
  const prefix = `${ROUTE}/`
  if (!pathname.startsWith(prefix)) return undefined
  const segments = pathname.slice(prefix.length).split('/')
  if (segments.length > 2) throw new AppError('invalid_input', 400, 'a valid task id is required')
  try {
    return {
      id: decodeURIComponent(segments[0] ?? ''),
      action: decodeURIComponent(segments[1] ?? ''),
    }
  } catch {
    throw new AppError('invalid_input', 400, 'invalid task id')
  }
}

/**
 * 创建任务路由。
 * @param deps - repository、scheduler、会话与日志。
 * @returns 集合与单项处理器。
 */
export function createTaskRoutes(deps: TaskRoutesDeps): TaskRoutes {
  const collection: RouteHandler = async (request, response) => {
    const method = request.method ?? 'GET'
    if (method === 'GET') {
      const tasks = await deps.repository.list()
      answer(response, 200, { ok: true, tasks: tasks.map(task => withRuntime(deps, task)) })
      return
    }
    if (method === 'POST') {
      const payload = await readJsonBody(request)
      const input = parseCreateBody(payload, deps.hostTimeZone())
      const task = await deps.createTask(input)
      await deps.scheduler.refresh()
      answer(response, 201, { ok: true, task: withRuntime(deps, task) })
      return
    }
    methodNotAllowed(response, method)
  }

  const item: TaskItemHandler = async (request, response, id, action) => {
    const method = request.method ?? 'GET'
    if (id === '' || /[\\/]/u.test(id) || /[\\/]/u.test(action)) {
      throw new AppError('invalid_input', 400, 'a valid task id is required')
    }
    const task = await deps.repository.read(id)
    if (task === undefined) throw new AppError('not_found', 404, 'task not found')

    if (action === 'runs') {
      if (method !== 'GET') {
        methodNotAllowed(response, method)
        return
      }
      const query = parseRunsQuery(request.url ?? '/')
      const runs = await listRunRecords(task.folder, query)
      answer(response, 200, { ok: true, runs })
      return
    }

    if (action === 'run') {
      if (method !== 'POST') {
        methodNotAllowed(response, method)
        return
      }
      const { sessionId } = await deps.scheduler.startManual(task)
      answer(response, 202, { ok: true, accepted: true, sessionId })
      return
    }

    if (action === 'session') {
      if (method !== 'POST') {
        methodNotAllowed(response, method)
        return
      }
      const sessionId = await deps.sessions.open(task)
      answer(response, 200, { ok: true, sessionId })
      return
    }

    if (action !== '') throw new AppError('not_found', 404, 'not found')

    if (method === 'DELETE') {
      if (deps.scheduler.isRunning(id)) {
        throw new AppError('already_running', 409, 'a run is in progress for this task')
      }
      await rm(task.folder, { recursive: true, force: true })
      await deps.store().remove(id)
      await deps.scheduler.refresh()
      answer(response, 200, { ok: true, id })
      return
    }

    if (method === 'PATCH') {
      const payload = await readJsonBody(request)
      const { patch, historyDaysChanged } = parsePatchBody(payload, task)
      await deps.store().patch(id, patch)
      await deps.scheduler.refresh()
      const updated = await deps.repository.read(id)
      if (updated === undefined) throw new AppError('not_found', 404, 'task not found')
      if (historyDaysChanged) await deps.records.prune(updated, true)
      answer(response, 200, { ok: true, task: withRuntime(deps, updated) })
      return
    }

    methodNotAllowed(response, method)
  }

  return { collection, item }
}

/** 供插件前缀路由复用的 pathname 读取。 */
export { pathnameOf }
