/**
 * 设置路由：读设置、校验/切换工作区、改任务仓库地址。
 *
 * 目录切换的全部副作用（建目录、ensure 注册表、注册 Workspace、落盘、通知调度）
 * 都在 `settings/hub` 的 `switchTo` / `clear` 里完成，路由只做校验与响应。
 */

import { realpath, stat } from 'node:fs/promises'
import { AppError } from '../errors.js'
import { normalizeBaseUrl, pluginRoot } from '../config.js'
import type { Logger, RouteHandler, WorkspacePort } from '../ports.js'
import type { Scheduler } from '../scheduling/scheduler.js'
import type { SettingsDescriber } from '../settings/describe.js'
import type { SettingsPatch, WorkspaceHub } from '../settings/hub.js'
import { isInside, normalizeInput, pathKey, validateWorkspacePath } from '../settings/paths.js'
import { workspaceAt } from '../settings/workspace.js'
import type { WorkspacePathErrorCode } from '../../protocol.js'
import { answer, methodNotAllowed, readJsonBody } from './server.js'

/** 设置路由依赖。 */
export interface SettingsRoutesDeps {
  hub: WorkspaceHub
  describer: SettingsDescriber
  scheduler: Pick<Scheduler, 'refresh' | 'hasRunning'>
  workspaces: WorkspacePort
  logger: Logger
}

/** 设置路由集合。 */
export interface SettingsRoutes {
  settings: RouteHandler
  /** 目录地址校验：无副作用，不建目录、不注册、不落盘。 */
  check: RouteHandler
  directory: RouteHandler
}

/** 校验失败时给 PATCH 的人可读文本（check 走 code，客户端自己本地化）。 */
const PATH_ERROR_TEXT: Record<WorkspacePathErrorCode, string> = {
  path_empty: 'workDir is empty',
  path_not_absolute: 'workDir must be an absolute path',
  path_not_fully_qualified: 'workDir must be a fully qualified path (drive-qualified or complete UNC)',
  path_device_form: 'workDir must not be a Windows device path',
  path_forbidden_char: 'workDir contains a character the host platform forbids',
  path_reserved_name: 'workDir contains a reserved device name',
  path_trailing_dot_space: 'workDir contains a segment ending with a space or dot',
  path_component_too_long: 'a path segment is too long',
  path_too_long: 'workDir is too long',
  path_not_a_directory: 'workDir exists but is not a directory',
  path_unreadable: 'workDir cannot be read',
  path_in_settings_root: 'workDir must not be inside the plugin settings directory',
}

/**
 * 校验并归一化一个目录地址（语法 + 设置根保护）。
 * @param value - 原始字符串。
 * @returns 归一化路径；空串返回 null（表示「清除」）。
 * @throws AppError 语法非法或落在设置根内。
 */
function readWorkDir(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string') {
    throw new AppError('invalid_input', 400, 'workDir must be a string or null')
  }
  const text = normalizeInput(value)
  if (text === '') return null
  const result = validateWorkspacePath(text)
  if (!result.ok) {
    throw new AppError('invalid_path', 400, `${PATH_ERROR_TEXT[result.code]}${result.detail === undefined ? '' : `: ${result.detail}`}`)
  }
  if (isInside(pluginRoot(), result.normalized)) {
    throw new AppError('invalid_path', 400, PATH_ERROR_TEXT.path_in_settings_root)
  }
  return result.normalized
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
 * @returns 设置、校验与创建目录处理器。
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
      // 只有改工作区才和正在跑的任务冲突；改服务地址随时可以。
      if (patch.workDir !== undefined && patch.workDir !== null && deps.scheduler.hasRunning()) {
        throw new AppError('conflict', 409, 'cannot change the workspace while runs are in progress')
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

  const check: RouteHandler = async (request, response) => {
    const method = request.method ?? 'GET'
    if (method !== 'POST') {
      methodNotAllowed(response, method)
      return
    }
    const payload = await readJsonBody(request)
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw new AppError('invalid_input', 400, 'request body must be an object')
    }
    const raw = (payload as Record<string, unknown>)['workDir']
    if (typeof raw !== 'string') {
      throw new AppError('invalid_input', 400, 'workDir must be a string')
    }
    const text = normalizeInput(raw)
    if (text === '') {
      answer(response, 200, { ok: false, code: 'path_empty' })
      return
    }
    const validation = validateWorkspacePath(text)
    if (!validation.ok) {
      answer(response, 200, {
        ok: false,
        code: validation.code,
        ...validation.detail === undefined ? {} : { detail: validation.detail },
      })
      return
    }
    if (isInside(pluginRoot(), validation.normalized)) {
      answer(response, 200, { ok: false, code: 'path_in_settings_root' })
      return
    }
    let exists = false
    try {
      const info = await stat(validation.normalized)
      if (!info.isDirectory()) {
        answer(response, 200, { ok: false, code: 'path_not_a_directory' })
        return
      }
      exists = true
    } catch (error: unknown) {
      if ((error as { code?: string }).code !== 'ENOENT') {
        answer(response, 200, {
          ok: false,
          code: 'path_unreadable',
          detail: error instanceof Error ? error.message : String(error),
        })
        return
      }
    }
    const canonical = exists
      ? await realpath(validation.normalized).catch(() => validation.normalized)
      : validation.normalized
    const current = deps.hub.current()
    answer(response, 200, {
      ok: true,
      normalized: canonical,
      exists,
      alreadyWorkspace: workspaceAt(deps.workspaces, canonical) !== undefined,
      isCurrent: current !== null && pathKey(current.root) === pathKey(canonical),
      willCreate: !exists,
    })
  }

  const directory: RouteHandler = async (request, response) => {
    const method = request.method ?? 'GET'
    if (method !== 'POST') {
      methodNotAllowed(response, method)
      return
    }
    // 没有工作区就没有「当前目录」可创建；页面应先选择工作区。
    deps.hub.require()
    const prepared = await deps.hub.ensure()
    await deps.scheduler.refresh()
    answer(response, 200, {
      ok: true,
      ...prepared.workspaceError === undefined ? {} : { workspaceError: prepared.workspaceError },
      ...await deps.describer.describe(),
    })
  }

  return { settings, check, directory }
}
