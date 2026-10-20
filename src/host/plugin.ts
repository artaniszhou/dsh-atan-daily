/**
 * Host 半边装配。
 *
 * 这里只做三件事：把 Cordis 服务适配成窄端口、构造领域服务、注册路由与
 * 调度器生命周期。业务逻辑都在 `core/` 与 `host/{tasks,runs,scheduling,...}`。
 */

import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { ensureTaskLayout } from './migration.js'
import {
  hostTimeZone,
  ROUTE,
  SETTINGS_ROUTE,
  resolveConfig,
  type Config,
} from './config.js'
import { createLogger } from './logger.js'
import type {
  ApprovalPort,
  Logger,
  ModelPort,
  PermissionPresetPort,
  SessionPort,
  TimerPort,
  WebScope,
  WorkspacePort,
} from './ports.js'
import { createTaskRepository } from './repository.js'
import { createRunExecutor } from './runs/executor.js'
import { createRunRecovery } from './runs/recovery.js'
import { createRunRecords } from './runs/records.js'
import { createRunSessions } from './runs/session.js'
import { createScheduler } from './scheduling/scheduler.js'
import { createSettingsDescriber } from './settings/describe.js'
import { createSettingsStore } from './settings/store.js'
import { createWorkspaceService, isPluginOwned } from './settings/workspace.js'
import { createTask } from './tasks/create.js'
import { nextReportName } from './tasks/report.js'
import { createTaskRoutes, parseTaskPath } from './http/tasks.js'
import { createSettingsRoutes } from './http/settings.js'
import {
  answer,
  guard,
  methodNotAllowed,
  pathnameOf,
} from './http/server.js'

/** 宿主服务的最小面；只有本文件认识 Cordis 的形状。 */
export interface HostContext {
  logger: { info: (message: string) => void, warn: (message: string) => void }
  timer: TimerPort
  workspaceRegistry: WorkspacePort
  sessionController: SessionPort
  permissionPresets: PermissionPresetPort
  approval: ApprovalPort
  llm: ModelPort
  inject: (deps: string[], callback: (scope: WebScope) => void) => void
}

/** 插件依赖的宿主服务；与端口一一对应。 */
export const inject = [
  'timer',
  'sessionController',
  'approval',
  'permissionPresets',
  'workspaceRegistry',
  'llm',
]

/**
 * 目录是否为已存在的目录。
 * @param path - 绝对路径。
 * @returns true 表示存在且是目录。
 */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * 启动 Host：读设置、迁移、恢复中断记录、启动调度。
 * @param settings - 设置服务。
 * @param resolved - 解析后的配置。
 * @param services - 日志、恢复与调度。
 * @returns 启动完成的 promise。
 */
async function startup(
  settings: ReturnType<typeof createSettingsStore>,
  services: {
    logger: Logger
    recovery: ReturnType<typeof createRunRecovery>
    scheduler: ReturnType<typeof createScheduler>
  },
): Promise<void> {
  const { logger } = services
  await settings.load()
  const workDir = settings.workDir()
  logger.info(`working directory ${workDir}`)
  if (await isDirectory(workDir)) {
    // Migration is a one-time, explicit operation. Never run it on a GET, and
    // never move files in a directory the plugin does not own.
    if (isPluginOwned(settings.settingsRoot, settings.defaultWorkDir, workDir)) {
      await ensureTaskLayout(workDir, logger).catch((error: unknown) => {
        logger.warn(`task layout could not be prepared: ${String(error)}`)
      })
    }
    await settings.store().ensure().catch((error: unknown) => {
      logger.warn(`task list could not be prepared: ${String(error)}`)
    })
    // Startup is the one deliberate reconciliation point: drop registry rows
    // whose folder was removed while the Host was not looking. GET stays read-only.
    await settings.store().pruneMissingFolders().catch((error: unknown) => {
      logger.warn(`task list could not be reconciled: ${String(error)}`)
    })
  }
  await services.recovery.sweep().catch((error: unknown) => {
    logger.warn(`interrupted-run sweep failed: ${String(error)}`)
  })
  await services.scheduler.start()
}

/**
 * 激活 Host 半边。
 * @param ctx - Cordis 上下文。
 * @param config - 插件行配置。
 */
export function apply(ctx: HostContext, config?: Config): void {
  const resolved = resolveConfig(config)
  const logger = createLogger(ctx.logger)
  const bootId = randomUUID()

  const settings = createSettingsStore({
    settingsRoot: resolved.settingsRoot,
    defaultWorkDir: resolved.defaultWorkDir,
    historyDays: resolved.historyDays,
    logger,
  })
  const workspaces: WorkspacePort = {
    list: () => ctx.workspaceRegistry.list(),
    create: (path: string, title?: string) => ctx.workspaceRegistry.create(path, title),
    archiveSession: (sessionId, options) => ctx.workspaceRegistry.archiveSession(sessionId, options),
    unarchiveSession: (sessionId) => ctx.workspaceRegistry.unarchiveSession(sessionId),
  }
  const sessions: SessionPort = {
    create: request => ctx.sessionController.create(request),
    inspect: (sessionId, signal) => ctx.sessionController.inspect(sessionId, signal),
    resolveAgent: sessionId => ctx.sessionController.resolveAgent(sessionId),
    prompt: (request, signal) => ctx.sessionController.prompt(request, signal),
    selectModel: request => ctx.sessionController.selectModel(request),
  }

  const workspaceService = createWorkspaceService({ settings, workspaces, logger })
  const repository = createTaskRepository({
    store: () => settings.store(),
    workDir: () => settings.workDir(),
    logger,
  })
  const runSessions = createRunSessions({
    sessions,
    workspaces,
    store: () => settings.store(),
    workDir: () => settings.workDir(),
    prepareWorkDir: path => workspaceService.prepare(path),
    logger,
  })
  const records = createRunRecords({
    store: () => settings.store(),
    logger,
    bootId,
    pluginVersion: resolved.pluginVersion,
  })
  const executor = createRunExecutor({
    sessions,
    models: ctx.llm,
    permissions: ctx.permissionPresets,
    approval: ctx.approval,
    logger,
  })
  const scheduler = createScheduler({
    repository,
    records,
    sessions: runSessions,
    executor,
    nextReportName,
    timer: ctx.timer,
    logger,
    clock: () => Date.now(),
    runTimeoutMs: () => resolved.runTimeoutMs,
  })
  const recovery = createRunRecovery({
    repository,
    records,
    logger,
    bootId,
  })
  const describer = createSettingsDescriber({
    settings,
    repository,
    workspaces,
    pluginVersion: resolved.pluginVersion,
  })

  const taskRoutes = createTaskRoutes({
    repository,
    store: () => settings.store(),
    createTask: input => createTask({
      repository,
      store: () => settings.store(),
      workDir: () => settings.workDir(),
      defaultHistoryDays: resolved.historyDays,
    }, input),
    scheduler,
    sessions: runSessions,
    records,
    hostTimeZone,
  })
  const settingsRoutes = createSettingsRoutes({
    settings,
    describer,
    workspaces: workspaceService,
    scheduler,
    logger,
  })

  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => {
      const collection = guard(taskRoutes.collection, logger)
      const item = guard((request, response) => {
        const method = request.method ?? 'GET'
        if (method !== 'GET' && method !== 'POST' && method !== 'PATCH' && method !== 'DELETE') {
          methodNotAllowed(response, method)
          return
        }
        const pathname = pathnameOf(request)
        if (pathname === ROUTE) return
        const parsed = parseTaskPath(pathname)
        if (parsed === undefined) {
          answer(response, 404, { ok: false, code: 'not_found', error: 'not found' })
          return
        }
        return taskRoutes.item(request, response, parsed.id, parsed.action)
      }, logger)
      const disposers: Array<() => void> = [
        scope.webServer.register({ kind: 'exact', path: ROUTE, handler: collection }),
        scope.webServer.register({ kind: 'exact', path: SETTINGS_ROUTE, handler: guard(settingsRoutes.settings, logger) }),
        scope.webServer.register({ kind: 'exact', path: `${SETTINGS_ROUTE}/directory`, handler: guard(settingsRoutes.directory, logger) }),
        scope.webServer.register({ kind: 'prefix', path: ROUTE, handler: item }),
      ]
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'atan-daily: task routes')
  })

  ctx.inject(['timer'], (scope) => {
    scope.effect(() => {
      void startup(settings, { logger, recovery, scheduler }).catch((error: unknown) => {
        logger.warn(`scheduler start failed: ${String(error)}`)
      })
      return () => {
        scheduler.stop()
      }
    }, 'atan-daily: scheduler')
  })
}

export type { Config }
