/**
 * 设置路由：读取/修改工作目录，创建当前目录并注册 Workspace。
 *
 * `workDir: null`（或空串）会真正清除已保存覆盖并回到默认目录；切换目录
 * 在运行中会被拒绝，避免运行摘要写到另一份注册表里。
 */

import { isAbsolute, join, normalize } from 'node:path'
import { AppError } from '../errors.js'
import type { Logger, RouteHandler } from '../ports.js'
import type { Scheduler } from '../scheduling/scheduler.js'
import type { SettingsDescriber } from '../settings/describe.js'
import type { SettingsStore } from '../settings/store.js'
import type { WorkspaceService } from '../settings/workspace.js'
import { answer, methodNotAllowed, readJsonBody } from './server.js'

/** 设置路由依赖。 */
export interface SettingsRoutesDeps {
  settings: SettingsStore
  describer: SettingsDescriber
  workspaces: WorkspaceService
  scheduler: Pick<Scheduler, 'refresh' | 'hasRunning'>
  logger: Logger
}

/** 设置路由集合。 */
export interface SettingsRoutes {
  settings: RouteHandler
  directory: RouteHandler
}

/**
 * 校验 PATCH /settings 的 body。
 * @param payload - 请求体。
 * @returns 清除标记与目标路径（清除时为 undefined）。
 */
function readWorkDir(payload: unknown): { clear: boolean, path?: string } {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new AppError('invalid_input', 400, 'request body must be an object')
  }
  const record = payload as Record<string, unknown>
  if (!('workDir' in record)) {
    throw new AppError('invalid_input', 400, 'workDir is required (use null to clear)')
  }
  const value = record['workDir']
  if (value === null) return { clear: true }
  if (typeof value !== 'string') {
    throw new AppError('invalid_input', 400, 'workDir must be a string or null')
  }
  const requested = value.trim()
  if (requested === '') return { clear: true }
  if (requested.includes('\u0000')) throw new AppError('invalid_path', 400, 'invalid path')
  return { clear: false, path: requested }
}

/**
 * 创建设置路由。
 * @param deps - 设置、读模型、Workspace 与调度器。
 * @returns 设置与创建目录处理器。
 */
export function createSettingsRoutes(deps: SettingsRoutesDeps): SettingsRoutes {
  const settings: RouteHandler = async (request, response) => {
    const method = request.method ?? 'GET'
    if (method === 'GET') {
      answer(response, 200, { ok: true, ...await deps.describer.describe() })
      return
    }
    if (method === 'PATCH') {
      if (deps.scheduler.hasRunning()) {
        throw new AppError('conflict', 409, 'cannot change the working directory while runs are in progress')
      }
      const payload = await readJsonBody(request)
      const requested = readWorkDir(payload)
      if (requested.clear) {
        // Clearing never creates the default directory: the page then shows
        // 「创建工作目录」 instead of silently creating it on a settings write.
        await deps.settings.save({ workDir: null })
        await deps.scheduler.refresh()
        answer(response, 200, { ok: true, ...await deps.describer.describe() })
        return
      }
      // A relative path resolves against the default root, so a short value
      // typed on the page still names a directory the plugin owns.
      const target = isAbsolute(requested.path ?? '')
        ? normalize(requested.path ?? '')
        : join(deps.settings.defaultWorkDir, requested.path ?? '')
      let workspaceError: string | undefined
      try {
        const prepared = await deps.workspaces.prepare(target)
        workspaceError = prepared.workspaceError
      } catch (error: unknown) {
        throw new AppError('invalid_path', 400, `cannot use that directory: ${error instanceof Error ? error.message : String(error)}`)
      }
      await deps.settings.save({ workDir: target })
      await deps.scheduler.refresh()
      answer(response, 200, {
        ok: true,
        ...workspaceError === undefined ? {} : { workspaceError },
        ...await deps.describer.describe(),
      })
      return
    }
    methodNotAllowed(response, method)
  }

  const directory: RouteHandler = async (request, response) => {
    const method = request.method ?? 'GET'
    if (method !== 'POST') {
      methodNotAllowed(response, method)
      return
    }
    let workspaceError: string | undefined
    try {
      const prepared = await deps.workspaces.prepare(deps.settings.workDir())
      workspaceError = prepared.workspaceError
    } catch (error: unknown) {
      throw new AppError('invalid_path', 400, `cannot create the directory: ${error instanceof Error ? error.message : String(error)}`)
    }
    await deps.scheduler.refresh()
    answer(response, 200, {
      ok: true,
      ...workspaceError === undefined ? {} : { workspaceError },
      ...await deps.describer.describe(),
    })
  }

  return { settings, directory }
}
