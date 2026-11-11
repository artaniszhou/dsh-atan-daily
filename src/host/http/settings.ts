/**
 * 设置路由：读设置、选/清工作目录、改任务仓库地址。
 *
 * 目录切换的全部副作用（建目录、ensure 注册表、注册 Workspace、落盘、通知调度）
 * 都在 `settings/hub` 的 `switchTo` / `clear` 里完成，路由只做校验与响应。
 */

import { isAbsolute, normalize } from 'node:path'
import { AppError } from '../errors.js'
import { normalizeBaseUrl } from '../config.js'
import type { Logger, RouteHandler } from '../ports.js'
import type { Scheduler } from '../scheduling/scheduler.js'
import type { SettingsDescriber } from '../settings/describe.js'
import type { SettingsPatch, WorkspaceHub } from '../settings/hub.js'
import { answer, methodNotAllowed, readJsonBody } from './server.js'

/** 设置路由依赖。 */
export interface SettingsRoutesDeps {
  hub: WorkspaceHub
  describer: SettingsDescriber
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
 * @returns 设置补丁；`null` 表示清除该项覆盖。
 */
function readPatch(payload: unknown): SettingsPatch {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new AppError('invalid_input', 400, 'request body must be an object')
  }
  const record = payload as Record<string, unknown>
  const patch: SettingsPatch = {}
  if ('workDir' in record) patch.workDir = readWorkDir(record['workDir'])
  if ('serverBaseUrl' in record) patch.serverBaseUrl = readServerBaseUrl(record['serverBaseUrl'])
  if (patch.workDir === undefined && patch.serverBaseUrl === undefined) {
    throw new AppError('invalid_input', 400, 'workDir or serverBaseUrl is required')
  }
  return patch
}

/**
 * 校验工作目录值。
 * @param value - 原始值；`null` 或空串表示清除覆盖。
 * @returns 目标路径；清除时为 null。
 */
function readWorkDir(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string') {
    throw new AppError('invalid_input', 400, 'workDir must be a string or null')
  }
  const requested = value.trim()
  if (requested === '') return null
  if (requested.includes('\u0000')) throw new AppError('invalid_path', 400, 'invalid path')
  // 不再有「默认目录」可以做相对路径的基准，相对路径会被解析到进程 cwd。
  if (!isAbsolute(requested)) {
    throw new AppError('invalid_path', 400, 'workDir must be an absolute path')
  }
  return normalize(requested)
}

/**
 * 校验任务仓库地址。
 * @param value - 原始值；`null` 或空串表示清除覆盖。
 * @returns 规范化后的地址；清除时为 null。
 */
function readServerBaseUrl(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string') {
    throw new AppError('invalid_input', 400, 'serverBaseUrl must be a string or null')
  }
  try {
    const normalized = normalizeBaseUrl(value, 'serverBaseUrl')
    return normalized === '' ? null : normalized
  } catch (error: unknown) {
    throw new AppError('invalid_input', 400, error instanceof Error ? error.message : String(error))
  }
}

/**
 * 创建设置路由。
 * @param deps - 工作区、读模型与调度器。
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
      const payload = await readJsonBody(request)
      const patch = readPatch(payload)
      // 只有改工作目录才和正在跑的任务冲突；改服务地址随时可以。
      if (patch.workDir !== undefined && patch.workDir !== null && deps.scheduler.hasRunning()) {
        throw new AppError('conflict', 409, 'cannot change the working directory while runs are in progress')
      }
      if (patch.workDir === null) {
        // 清除覆盖：回到「未配置」态，不创建任何目录。
        await deps.hub.clear()
        await deps.scheduler.refresh()
        answer(response, 200, { ok: true, ...await deps.describer.describe() })
        return
      }
      if (patch.workDir !== undefined) {
        const prepared = await deps.hub.switchTo(patch.workDir)
        if (patch.serverBaseUrl !== undefined) await deps.hub.saveServerBaseUrl(patch.serverBaseUrl)
        await deps.scheduler.refresh()
        answer(response, 200, {
          ok: true,
          ...prepared.workspaceError === undefined ? {} : { workspaceError: prepared.workspaceError },
          ...await deps.describer.describe(),
        })
        return
      }
      await deps.hub.saveServerBaseUrl(patch.serverBaseUrl ?? null)
      answer(response, 200, { ok: true, ...await deps.describer.describe() })
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
    // 没有工作目录就没有「当前目录」可创建；页面应先选择目录。
    deps.hub.require()
    const prepared = await deps.hub.ensure()
    await deps.scheduler.refresh()
    answer(response, 200, {
      ok: true,
      ...prepared.workspaceError === undefined ? {} : { workspaceError: prepared.workspaceError },
      ...await deps.describer.describe(),
    })
  }

  return { settings, directory }
}
