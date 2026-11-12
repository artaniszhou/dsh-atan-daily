/**
 * Host 的端口（ports）：只定义窄接口与传输类型。
 *
 * 只有 `plugin.ts` 认识 Cordis 的 `HostContext`；其余模块只依赖这里的接口，
 * 测试直接传 fake 实现。`core/` 不引用本文件。
 */

import type { WorkspaceRef } from '../protocol.js'

/** 一条运行日志；一条一行、可 grep，`runId` 能与 `meta/runs/<runId>.json` 对应。 */
export interface RunLogEntry {
  /** 任务 id（任务目录名）。 */
  taskId: string
  /** 本次运行的记录 id；到点判定等“还未开始”的事件可以没有。 */
  runId?: string
  /** 事件名，例如 `run.start` / `run.fail` / `sched.arm`。 */
  event: string
  /** 可选的补充字段（`key=value` 片段或人类可读原因）。 */
  detail?: string
}

/** 注入式日志：不再有模块级可变 logger。 */
export interface Logger {
  info(message: string): void
  warn(message: string): void
  /** 结构化运行日志。 */
  run(entry: RunLogEntry): void
}

/** 请求头：Node 的普通对象或 `Headers`，与宿主 `connection` 服务同形。 */
export type RouteHeaders =
  | Headers
  | Readonly<Record<string, string | readonly string[] | undefined>>

/** 宿主对一次请求的准入结论：401 / 403 表示拒绝，`undefined` 表示放行。 */
export type RequestRejection = 401 | 403 | undefined

/**
 * 宿主的连接信任服务（`connection`）。
 *
 * 浏览器里的任意网页都能向本机端口发跨站请求，插件路由必须先问它一次；
 * 判定用的是 Host / Origin / Sec-Fetch-Site 与部署的 `trustedHosts`。
 */
export interface ConnectionPort {
  requestRejection: (request: { headers: RouteHeaders }) => RequestRejection
}

/** 路由消费的 Node 请求面。 */
export interface RouteRequest extends AsyncIterable<Uint8Array> {
  method?: string
  url?: string
  /** 原始请求头，原样交给宿主的准入判定，插件不自行解释。 */
  headers: RouteHeaders
}

/** 路由写出的 Node 响应面。 */
export interface RouteResponse {
  writeHead: (status: number, headers: Record<string, string>) => void
  end: (body?: string) => void
}

/** 一次运行所驱动的 agent 面。 */
export interface AgentFace {
  readonly status?: 'idle' | 'running'
  /** 持久化 Session；权限等服务按 Session 作用。 */
  readonly session: unknown
  whenIdle: () => Promise<void>
  cancel: (cause: unknown, options?: unknown) => void
}

/** 发送 prompt 的请求形状。 */
export interface PromptRequest {
  requestId: string
  sessionId: string
  mode: 'queue' | 'steer'
  content: { type: 'text', text: string }[]
  clientTimeZone?: string
}

/** 会话端口。 */
export interface SessionPort {
  create: (request: { workspaceId?: string, cwd?: string }) => Promise<{ sessionId: string }>
  /**
   * 读取会话的持久化快照；会话不存在时返回 undefined。
   * 读取失败会抛错，调用方不能把它当成“不存在”。
   */
  stat: (sessionId: string, signal?: AbortSignal) => Promise<unknown | undefined>
  resolveAgent: (sessionId: string) => Promise<{ agent: AgentFace } | { error: unknown }>
  prompt: (request: PromptRequest, signal: AbortSignal) => Promise<unknown>
  /** 为下一次请求安装模型。 */
  selectModel: (request: {
    sessionId: string
    provider: string
    model: string
    reasoningEffort?: string
  }) => Promise<unknown>
}

/** Workspace 注册表端口。 */
export interface WorkspacePort {
  list: () => readonly { id: string, path?: string, title?: string }[]
  create: (path: string, title?: string) => Promise<unknown>
  /** 归档一个会话；会话既不在内存也未持久化时抛错。 */
  archiveSession: (sessionId: string, options?: { stopActivity?: boolean }) => Promise<void>
  /** 取消归档；未归档时是无操作。 */
  unarchiveSession: (sessionId: string) => Promise<void>
}

/** 模型目录端口。 */
export interface ModelPort {
  listProviders: () => readonly { id: string }[]
  listModels: (provider: string) => Promise<readonly { id: string }[]>
}

/** 权限预设端口。 */
export interface PermissionPresetPort {
  set: (session: unknown, preset: string) => void
}

/** 一份随插件注册的 skill；只暴露 Host 用到的字段。 */
export interface SkillRegistration {
  name: string
  description: string
  content: string
  source: 'bundled'
  /**
   * 技能目录：注册后宿主把它渲染成「Base directory for this skill: …」，
   * 模型据此按相对路径读取 `references/` 等资源。缺省时正文不能引用外部文件。
   */
  resourceBase?: { kind: 'directory', path: string }
}

/** 宿主 skill 注册表端口。 */
export interface SkillPort {
  /** 注册一份进程内 skill；返回卸载函数。 */
  register: (skill: SkillRegistration) => () => void
}

/** 一次审批请求的最小面；`agent.id` 就是会话 id。 */
export interface ApprovalRequestFace {
  agent: { id: string }
}

/** 审批结论。 */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/**
 * 审批闸门端口。
 *
 * 插件不直接改写会话的审批策略（否则会破坏权限预设的旋钮匹配，页面显示成
 * 「自定义」）；改为在无人值守运行期间，抢在交互方之前拒绝该会话的审批请求。
 */
export interface ApprovalPort {
  /**
   * 安装预分发闸门：命中 `rejectFor` 的会话直接拒绝，不再询问交互方。
   * @param rejectFor - 判断某个会话当前是否处于无人值守运行中。
   * @returns 卸载函数。
   */
  gate: (rejectFor: (sessionId: string) => boolean) => () => void
}

/**
 * 凭据库端口。
 *
 * 只暴露"读/写/删"三个动作：配置里永远只出现 key（`secretRef`），
 * secret 本身由宿主的凭据库托管，不进 `settings.json` 或 `bots.json`。
 */
export interface CredentialsPort {
  resolve: (ref: string) => Promise<{ value: string } | undefined>
  set: (ref: string, value: string) => Promise<void>
  unset: (ref: string) => Promise<void>
}

/** 定时器端口。 */
export interface TimerPort {
  timeout: (callback: () => void, delay: number) => () => void
}

/** 一个路由处理器；`routes` 只依赖这个窄面，测试可直接调用。 */
export type RouteHandler = (request: RouteRequest, response: RouteResponse) => Promise<void> | void

/** 一条路由注册。 */
export interface RouteSpec {
  kind: 'exact' | 'prefix'
  path: string
  handler: RouteHandler
}

/** webServer 端口。 */
export interface WebServerPort {
  register: (route: RouteSpec) => () => void
}

/** `ctx.inject([...])` 暴露的 webServer scope。 */
export interface WebScope {
  webServer: WebServerPort
  effect: (callback: () => () => void, label?: string) => void
  /** 宿主的连接信任服务；旧宿主可能没有，缺失时按拒绝处理。 */
  connection?: ConnectionPort
}

/** 本文件也再导出 WorkspaceRef，消费者只需认端口层。 */
export type { WorkspaceRef }
