/**
 * 工作区列表路由：已注册工作区 + 「atan-daily 用过」标记。
 *
 * 标记只做一次 `stat(<path>/.task)`；整批给 1s 预算，慢速网络盘按「未用过」处理，
 * 不阻塞弹窗（用户仍可勾选「显示全部工作区」看到它）。
 */

import { stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { WorkspaceOption } from '../../protocol.js'
import { TASK_DIR } from '../config.js'
import type { RouteHandler, WorkspacePort } from '../ports.js'
import type { WorkspaceHub } from '../settings/hub.js'
import { pathKey } from '../settings/paths.js'
import { answer, methodNotAllowed } from './server.js'

/** 整批 `stat` 的预算。 */
const HAS_DATA_BUDGET_MS = 1000

/** 工作区路由依赖。 */
export interface WorkspaceRoutesDeps {
  hub: WorkspaceHub
  workspaces: WorkspacePort
}

/** 工作区路由集合。 */
export interface WorkspaceRoutes {
  list: RouteHandler
}

/** 单个工作区是否存在 `.task/`。 */
async function hasData(path: string): Promise<boolean> {
  try {
    return (await stat(join(path, TASK_DIR))).isDirectory()
  } catch {
    return false
  }
}

/**
 * 在预算内解析；超时返回兜底值。
 * @param operation - 待解析的操作。
 * @param timeoutMs - 预算。
 * @param fallback - 超时兜底。
 * @returns 操作结果或兜底。
 */
async function within<T>(operation: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => { resolve(fallback) }, timeoutMs)
  })
  try {
    return await Promise.race([operation, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * 创建工作区路由。
 * @param deps - 当前工作区与注册表。
 * @returns 工作区列表处理器。
 */
export function createWorkspaceRoutes(deps: WorkspaceRoutesDeps): WorkspaceRoutes {
  const list: RouteHandler = async (request, response) => {
    const method = request.method ?? 'GET'
    if (method !== 'GET') {
      methodNotAllowed(response, method)
      return
    }
    const current = deps.hub.current()
    const rows = deps.workspaces.list()
    const scanned = await Promise.all(rows.map(async (row): Promise<WorkspaceOption | undefined> => {
      if (typeof row.id !== 'string' || typeof row.path !== 'string' || row.path === '') return undefined
      const path = row.path
      return {
        id: row.id,
        title: typeof row.title === 'string' && row.title !== '' ? row.title : basename(path),
        path,
        current: current !== null && pathKey(current.root) === pathKey(path),
        hasData: await within(hasData(path), HAS_DATA_BUDGET_MS, false),
      }
    }))
    answer(response, 200, { ok: true, workspaces: scanned.filter((row): row is WorkspaceOption => row !== undefined) })
  }
  return { list }
}
