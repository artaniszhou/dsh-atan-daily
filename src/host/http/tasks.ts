/**
 * 任务路由：集合（GET/POST）与单项（PATCH/DELETE/run/session/runs）。
 *
 * 路由只负责解析路径、调用 service、写响应；校验与业务都在这里之外的模块。
 */

import { rm } from 'node:fs/promises'
import { listRunRecords } from '../../core/runs.js'
import type { TaskMetaPatch } from '../../core/task-list.js'
import type { TaskRecord } from '../../protocol.js'
import { ROUTE } from '../config.js'
import { AppError } from '../errors.js'
import type { Workspace } from '../settings/hub.js'
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
  /** 当前工作区；未配置时抛 `no_workspace`。 */
  workspace: () => Workspace
  createTask: (input: CreateTaskInput) => Promise<TaskRecord>
  /** 应用元数据补丁；`name` 变化时连带把任务目录改成新名字。 */
  renameTask: (task: TaskRecord, patch: TaskMetaPatch) => Promise<TaskRecord>
  scheduler: Pick<Scheduler, 'refresh' | 'startManual' | 'isRunning' | 'nextRunAt'>
  sessions: Pick<RunSessionService, 'open'>
  records: Pick<RunRecords, 'prune'>
  /** 把编辑抽屉里的任务细节写回 `task-detail.md`。 */
  writeDetails: (folder: string, details: string) => Promise<void>
  hostTimeZone: () => string
  /** 当前宿主是否找到 Chrome/Edge；没有时不允许选 PNG。 */
  browserAvailable: () => boolean
}

/** 单项任务路由处理器。 */
export type TaskItemHandler = (
  request: Parameters<RouteHandler>[0],
  response: Parameters<RouteHandler>[1],
  taskId: string,
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
  const due = deps.scheduler.nextRunAt(task.taskId)
  return {
    ...task,
    ...due === undefined ? {} : { nextRunAt: new Date(due).toISOString() },
    ...deps.scheduler.isRunning(task.taskId) ? { running: true } : {},
  }
}

/**
 * 解析 `/atan-daily/tasks/<taskId>/<action>`。
 * @param pathname - URL pathname。
 * @returns taskId 与 action，或 undefined 当路径不属于任务前缀。
 */
export function parseTaskPath(pathname: string): { taskId: string, action: string } | undefined {
  if (pathname === ROUTE) return { taskId: '', action: '' }
  const prefix = `${ROUTE}/`
  if (!pathname.startsWith(prefix)) return undefined
  const segments = pathname.slice(prefix.length).split('/')
  if (segments.length > 2) throw new AppError('invalid_input', 400, 'a valid task id is required')
  try {
    return {
      taskId: decodeURIComponent(segments[0] ?? ''),
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
      const task = await deps.createTask({
        ...input,
        outputFormat: deps.browserAvailable() ? 'png' : 'pdf',
      })
      await deps.scheduler.refresh()
      answer(response, 201, { ok: true, task: withRuntime(deps, task) })
      return
    }
    methodNotAllowed(response, method)
  }

  const item: TaskItemHandler = async (request, response, taskId, action) => {
    const method = request.method ?? 'GET'
    if (taskId === '' || /[\\/]/u.test(taskId) || /[\\/]/u.test(action)) {
      throw new AppError('invalid_input', 400, 'a valid task id is required')
    }
    const task = await deps.repository.read(taskId)
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
      if (deps.scheduler.isRunning(task.taskId)) {
        throw new AppError('already_running', 409, 'a run is in progress for this task')
      }
      await rm(task.folder, { recursive: true, force: true })
      await deps.workspace().store.remove(task.taskId)
      await deps.scheduler.refresh()
      answer(response, 200, { ok: true, taskId: task.taskId })
      return
    }

    if (method === 'PATCH') {
      const payload = await readJsonBody(request)
      const { patch, details, historyDaysChanged } = parsePatchBody(payload, task)
      if (patch.outputFormat === 'png' && !deps.browserAvailable()) {
        throw new AppError('invalid_input', 400, '当前宿主没有找到 Chrome/Edge，不能选择 PNG；请改用 PDF')
      }
      // 名称变化会连带改目录：目录改名与其余补丁在同一次注册表写入里落盘。
      const renamed = Object.keys(patch).length > 0 ? await deps.renameTask(task, patch) : task
      if (details !== undefined) await deps.writeDetails(renamed.folder, details)
      await deps.scheduler.refresh()
      const updated = await deps.repository.read(task.taskId)
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
