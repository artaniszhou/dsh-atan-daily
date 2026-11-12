/**
 * Host 半边装配。
 *
 * 这里只做四件事：把 Cordis 服务适配成窄端口、注册共用执行规则 skill、
 * 构造领域服务、注册路由与调度器生命周期。业务逻辑都在 `core/` 与
 * `host/{tasks,runs,scheduling,...}`。
 */

import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  hostTimeZone,
  ROUTE,
  SETTINGS_ROUTE,
  resolveConfig,
  type Config,
} from './config.js'
import { createLogger } from './logger.js'
import { readRunSkill } from './skill.js'
import { writeTaskDetail } from '../core/documents.js'
import type {
  ApprovalOutcome,
  ApprovalRequestFace,
  CredentialsPort,
  Logger,
  ModelPort,
  PermissionPresetPort,
  RouteHandler,
  SessionPort,
  SkillPort,
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
import { createSettingsFile } from './settings/file.js'
import { createWorkspaceHub, type WorkspaceHub } from './settings/hub.js'
import { initialSuggestion, resolveSuggestedWorkspace } from './settings/suggest.js'
import { createWorkspaceService } from './settings/workspace.js'
import { createTask, type CreateTaskInput } from './tasks/create.js'
import { renameTask } from './tasks/rename.js'
import { createTaskHub } from './task-hub.js'
import { createAnnouncementProxy } from './announcement.js'
import { createAccountProvider, type DeepSeekAccountPort } from './account.js'
import { archiveReports } from './tasks/archive.js'
import { nextReportBase } from './tasks/report.js'
import { renderRunReport } from '../report/render/run.js'
import { browserAvailable } from '../report/render/pdf.js'
import { createTaskRoutes, parseTaskPath } from './http/tasks.js'
import { createSettingsRoutes } from './http/settings.js'
import { createWorkspaceRoutes } from './http/workspaces.js'
import { registerAtanTools } from './tools/index.js'
import { BotStore } from './im/store.js'
import { createBotService } from './im/service.js'
import { createFeishuClient } from './im/feishu-api.js'
import { createBotRoutes } from './im/routes.js'
import { HOST_IM_ROUTE, HOST_ROUTES, type TaskRecord } from '../protocol.js'
import type { TaskMetaPatch } from '../core/task-list.js'
import {
  answer,
  fence,
  guard,
  methodNotAllowed,
  pathnameOf,
} from './http/server.js'

/** 宿主服务的最小面；只有本文件认识 Cordis 的形状。 */
export interface HostContext {
  logger: { info: (message: string) => void, warn: (message: string) => void }
  /** 宿主工具注册表；插件用 `atan_daily_*` 注册粗粒度工具。 */
  tools: { register: (definition: unknown) => unknown }
  timer: TimerPort
  workspaceRegistry: WorkspacePort
  sessionController: SessionPort
  /** 持久化会话目录；用于判断记录里的 sessionId 是否仍然存在。 */
  sessionPersistence: {
    stat: (sessionId: string, options?: { signal?: AbortSignal }) => Promise<unknown | undefined>
  }
  permissionPresets: PermissionPresetPort
  llm: ModelPort
  /** 宿主的 skill 注册表；执行规则 skill 注册在这里。 */
  skills: SkillPort
  /** 把注册动作挂到插件生命周期上。 */
  effect: (callback: () => () => void, label?: string) => () => void
  /** 宿主的凭据库；secret 只存这里。 */
  credentials: CredentialsPort
  /** DeepSeek 账号服务；任务上传用它解析四项身份。 */
  deepseekAccount?: DeepSeekAccountPort
  /**
   * 注册审批瀑布监听器。`prepend` 让插件先于远端审批桥裁决；未命中时
   * 调用 `next()` 交还给宿主原本的审批链。
   */
  on: (
    event: 'approval/request',
    listener: (
      request: ApprovalRequestFace,
      next: () => Promise<ApprovalOutcome>,
    ) => Promise<ApprovalOutcome>,
    options?: { prepend?: boolean },
  ) => () => void
  inject: (deps: string[], callback: (scope: WebScope) => void) => void
}

/** 插件依赖的宿主服务；与端口一一对应。 */
export const inject = [
  'timer',
  'sessionController',
  'sessionPersistence',
  'approval',
  'permissionPresets',
  'workspaceRegistry',
  'llm',
  'skills',
  'credentials',
  'deepseekAccount',
  'tools',
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
 * 启动 Host：读设置、准备注册表、恢复中断记录、启动调度。
 * @param settings - 设置服务。
 * @param resolved - 解析后的配置。
 * @param services - 日志、恢复与调度。
 * @returns 启动完成的 promise。
 */
async function startup(
  hub: WorkspaceHub,
  services: {
    logger: Logger
    recovery: ReturnType<typeof createRunRecovery>
    scheduler: ReturnType<typeof createScheduler>
  },
): Promise<void> {
  const { logger } = services
  await hub.load()
  const workspace = hub.current()
  if (workspace === null) {
    // 未配置即空态：不建目录、不注册 Workspace、不跑调度。
    logger.info('no workspace configured yet; waiting for the user to pick one')
  } else if (await isDirectory(workspace.root)) {
    await workspace.store.ensure().catch((error: unknown) => {
      logger.warn(`task list could not be prepared: ${String(error)}`)
    })
    // Startup is the one deliberate reconciliation point: drop registry rows
    // whose folder was removed while the Host was not looking. GET stays read-only.
    await workspace.store.pruneMissingFolders().catch((error: unknown) => {
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
export async function apply(ctx: HostContext, config?: Config): Promise<void> {
  const resolved = resolveConfig(config)
  const logger = createLogger(ctx.logger)
  const bootId = randomUUID()
  // 公共执行规则只有一份，注册进宿主的 skill 目录；执行指令让会话在动手前
  // 先加载它。注册挂在插件 fiber 上，插件卸载时一起消失。
  // `resourceBase` 让正文里的 `references/…` 相对路径可解析：数据契约的写法
  // 说明放在技能目录下，模型按需读取，而不是整段塞进正文。
  const runSkill = readRunSkill()
  ctx.effect(() => ctx.skills.register({
    name: runSkill.name,
    description: runSkill.description,
    content: runSkill.content,
    resourceBase: { kind: 'directory', path: runSkill.dir },
    source: 'bundled',
  }), 'atan-daily: run skill')

  const workspaces: WorkspacePort = {
    list: () => ctx.workspaceRegistry.list(),
    create: (path: string, title?: string) => ctx.workspaceRegistry.create(path, title),
    archiveSession: (sessionId, options) => ctx.workspaceRegistry.archiveSession(sessionId, options),
    unarchiveSession: (sessionId) => ctx.workspaceRegistry.unarchiveSession(sessionId),
  }
  const sessions: SessionPort = {
    create: request => ctx.sessionController.create(request),
    stat: (sessionId, signal) => ctx.sessionPersistence.stat(
      sessionId,
      signal === undefined ? undefined : { signal },
    ),
    resolveAgent: sessionId => ctx.sessionController.resolveAgent(sessionId),
    prompt: (request, signal) => ctx.sessionController.prompt(request, signal),
    selectModel: request => ctx.sessionController.selectModel(request),
  }

  const workspaceService = createWorkspaceService({ workspaces, logger })
  // 建议工作区先给「配置覆盖 / 家目录回退」的同步值，页面首次读取设置时再做一次
  // 系统探测（默认工作区父目录 → Documents），避免插件启动被 PowerShell/osascript 拖住。
  const initialSuggestionValue = initialSuggestion({ configured: resolved.configuredWorkDir })
  // 工作区是「目录 + 注册表」的同一来源：消费者只拿一个对象，不会拼错。
  const hub = createWorkspaceHub({
    settingsFile: createSettingsFile(resolved.settingsRoot),
    workspaces,
    prepare: (path, store) => workspaceService.prepare(path, store),
    suggestedRoot: initialSuggestionValue,
    resolveSuggestion: async () => {
      let rows: readonly { id: string, path?: string, title?: string }[] = []
      try {
        rows = workspaces.list()
      } catch (error: unknown) {
        logger.warn(`could not read the workspace registry for the suggestion: ${String(error)}`)
      }
      const next = await resolveSuggestedWorkspace({
        configured: resolved.configuredWorkDir,
        workspaces: rows,
      })
      logger.info(`suggested workspace ${next.path} (${next.source})`)
      return next
    },
    configuredWorkDir: resolved.configuredWorkDir,
    legacyWorkDir: resolved.legacyWorkDir,
    historyDays: resolved.historyDays,
    defaultServerBaseUrl: resolved.serverBaseUrl,
    logger,
  })
  const repository = createTaskRepository({
    workspace: () => hub.current(),
    logger,
  })
  // 粗粒度工具：生成、清单、一次性脚本、草稿修改与重生成。
  ctx.effect(() => {
    const disposers: Array<() => void> = []
    registerAtanTools({
      tools: {
        register: (definition: unknown) => {
          const dispose = ctx.tools.register(definition)
          if (typeof dispose === 'function') disposers.push(dispose as () => void)
          return dispose
        },
      },
    }, { repository, pluginVersion: resolved.pluginVersion })
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'atan-daily: tools')
  // IM 机器人：只存非密信息，secret 走宿主的凭据库。
  const bots = createBotService({
    store: new BotStore(join(resolved.settingsRoot, 'bots.json')),
    credentials: ctx.credentials,
    client: createFeishuClient(),
    logger,
  })
  const runSessions = createRunSessions({
    sessions,
    workspaces,
    workspace: () => hub.require(),
    ensureWorkspace: () => hub.ensure(),
    logger,
  })
  const records = createRunRecords({
    workspace: () => hub.require(),
    logger,
    bootId,
    pluginVersion: resolved.pluginVersion,
  })
  const executor = createRunExecutor({
    sessions,
    models: ctx.llm,
    permissions: ctx.permissionPresets,
    approval: {
      // 提前于远端审批桥裁决：无人值守运行中的会话不再把审批请求发给浏览器。
      // 关键是只拦请求、不改 approval/policy——预设的沙箱与审批两个旋钮保持
      // 匹配，页面才会继续显示用户选择的原生预设名，而不是「自定义」。
      gate: rejectFor => ctx.on('approval/request', (request, next) => {
        return rejectFor(request.agent.id) ? Promise.resolve<ApprovalOutcome>('rejected') : next()
      }, { prepend: true }),
    },
    logger,
  })
  const scheduler = createScheduler({
    repository,
    records,
    sessions: runSessions,
    executor,
    archiveReports: task => archiveReports(task, logger),
    nextReportBase,
    timer: ctx.timer,
    logger,
    clock: () => Date.now(),
    runTimeoutMs: () => resolved.runTimeoutMs,
    // 运行成功后先渲染派生格式，再按需推送。渲染失败只记日志：数据（json）
    // 已经落盘，采集本身是成功的，不能因为版式坏了就把这一轮判成失败。
    onRunFinished: async (task, outcome) => {
      const base = outcome.report
      if (base === undefined || outcome.buildDir === undefined) return
      const rendered = await renderRunReport({
        folder: task.folder,
        base,
        buildDir: outcome.buildDir,
        format: task.outputFormat,
      })
      if (!rendered.ok) {
        logger.warn(`render ${base} of ${task.taskId} failed: ${rendered.error ?? 'unknown'}`)
      }
      for (const warning of rendered.warnings) {
        logger.warn(`render ${base} of ${task.taskId}: ${warning}`)
      }
      if (!task.pushEnabled || task.pushBotIds.length === 0) return
      const delivery = await bots.sendReport(task, base)
      const progress = `${String(delivery.sent ?? 0)}/${String(delivery.total ?? 0)}`
      logger.run({
        taskId: task.taskId,
        event: 'im.push',
        detail: delivery.ok ? `ok ${progress}` : `${delivery.code ?? 'failed'} ${progress}`,
      })
    },
  })
  const recovery = createRunRecovery({
    repository,
    records,
    logger,
    bootId,
  })
  // 目录切换的副作用统一在 hub 内完成；调度在这里跟随变化，路由不再手动刷。
  ctx.effect(() => hub.onChange(() => {
    void scheduler.refresh().catch((error: unknown) => {
      logger.warn(`scheduler refresh after workspace change failed: ${String(error)}`)
    })
  }), 'atan-daily: workspace changes')
  const describer = createSettingsDescriber({
    hub,
    repository,
    workspaces,
    pluginVersion: resolved.pluginVersion,
    browserAvailable,
  })

  const createLocalTask = (input: CreateTaskInput): Promise<TaskRecord> => createTask({
    repository,
    workspace: () => hub.require(),
    defaultHistoryDays: resolved.historyDays,
  }, input)
  const renameLocalTask = (task: TaskRecord, patch: TaskMetaPatch): Promise<TaskRecord> => renameTask({
    repository,
    workspace: () => hub.require(),
    isRunning: taskId => scheduler.isRunning(taskId),
  }, task, patch)
  const taskRoutes = createTaskRoutes({
    repository,
    workspace: () => hub.require(),
    createTask: createLocalTask,
    renameTask: renameLocalTask,
    scheduler,
    sessions: runSessions,
    records,
    writeDetails: (folder, details) => writeTaskDetail(folder, details),
    hostTimeZone,
    browserAvailable,
  })
  const taskHub = createTaskHub({
    serverBaseUrl: () => hub.serverBaseUrl(),
    account: createAccountProvider(ctx.deepseekAccount),
    repository,
    createTask: createLocalTask,
    refreshSchedule: async () => { await scheduler.refresh() },
    logger,
  })
  // 公告只是首屏附加信息：远端挂了就抛错，页面静默隐藏，不影响任务与设置。
  const announcement = createAnnouncementProxy({
    serverBaseUrl: () => hub.serverBaseUrl(),
    logger,
  })
  const settingsRoutes = createSettingsRoutes({
    hub,
    describer,
    scheduler,
    workspaces,
    logger,
  })
  const workspaceRoutes = createWorkspaceRoutes({ hub, workspaces })
  const botRoutes = createBotRoutes(bots)

  ctx.inject(['connection', 'webServer'], (scope) => {
    scope.effect(() => {
      /**
       * 每条路由都先过宿主的连接信任判定，再做业务处理。
       *
       * 浏览器里的任意网页都能向本机端口发跨站请求，读文件、改设置、建任务
       * 这类接口必须先拒掉外来请求；判定归宿主的 `connection` 服务，
       * 插件只负责「拿不到判定就拒绝」。
       */
      const admit = (handler: RouteHandler): RouteHandler => fence(handler, scope.connection, logger)
      const collection = admit(guard(taskRoutes.collection, logger))
      const item = admit(guard((request, response) => {
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
        return taskRoutes.item(request, response, parsed.taskId, parsed.action)
      }, logger))
      const disposers: Array<() => void> = [
        scope.webServer.register({ kind: 'exact', path: ROUTE, handler: collection }),
        scope.webServer.register({ kind: 'exact', path: SETTINGS_ROUTE, handler: admit(guard(settingsRoutes.settings, logger)) }),
        scope.webServer.register({ kind: 'exact', path: `${SETTINGS_ROUTE}/check`, handler: admit(guard(settingsRoutes.check, logger)) }),
        scope.webServer.register({ kind: 'exact', path: `${SETTINGS_ROUTE}/directory`, handler: admit(guard(settingsRoutes.directory, logger)) }),
        scope.webServer.register({ kind: 'exact', path: HOST_ROUTES.workspaces, handler: admit(guard(workspaceRoutes.list, logger)) }),
        scope.webServer.register({ kind: 'prefix', path: ROUTE, handler: item }),
        scope.webServer.register({ kind: 'prefix', path: HOST_ROUTES.taskHub, handler: admit(guard(taskHub, logger)) }),
        scope.webServer.register({ kind: 'exact', path: HOST_ROUTES.announcement, handler: admit(guard(announcement.handler, logger)) }),
        scope.webServer.register({ kind: 'prefix', path: HOST_IM_ROUTE, handler: admit(guard(botRoutes.handler, logger)) }),
      ]
      return () => {
        for (const dispose of disposers) dispose()
        bots.close()
      }
    }, 'atan-daily: task routes')
  })

  ctx.inject(['timer'], (scope) => {
    scope.effect(() => {
      void startup(hub, { logger, recovery, scheduler }).catch((error: unknown) => {
        logger.warn(`scheduler start failed: ${String(error)}`)
      })
      return () => {
        scheduler.stop()
      }
    }, 'atan-daily: scheduler')
  })
}

export type { Config }

