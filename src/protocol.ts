/**
 * 前后端共享的线上契约。
 *
 * 这个文件是 host（`src/index.ts`、`src/runs.ts`）与 client（`src/client/**`）
 * 唯一的字段与常量来源：
 *  - 任务视图（22 字段）、运行记录（17 字段）、运行状态（7 值）、设置视图；
 *  - 页面与 host 之间的路由前缀、运行时补丁形状、保留期与分页上限。
 *
 * 约束：本文件必须保持**无副作用、无 Node 依赖**，两端都能安全引用。
 */

/** 页面与 host 共享的路由前缀（相对页面挂载点，不含前导斜杠）。 */
export const ROUTES = {
  tasks: 'atan-daily/tasks',
  settings: 'atan-daily/settings',
  im: 'atan-daily/im',
} as const

/** host 侧的路由前缀（带前导斜杠，用于精确匹配）。 */
export const HOST_ROUTES = {
  tasks: `/${ROUTES.tasks}`,
  settings: `/${ROUTES.settings}`,
  im: `/${ROUTES.im}`,
} as const

/** 机器人管理路由前缀。 */
export const HOST_IM_ROUTE = HOST_ROUTES.im

/** 历史保留天数的上限；页面校验与 host 校验共用。 */
export const HISTORY_DAYS_MAX = 3650

/** 运行历史每页条数；页面请求与 host 上限共用。 */
export const RUN_PAGE_SIZE = 50

/** 任务报告节奏，由 cron 推导，只用于展示与报告命名。 */
export type Frequency = 'daily' | 'hourly' | 'on-demand'

/** 一次运行的生命周期状态。 */
export type RunStatus =
  | 'running'
  | 'ok'
  | 'failed'
  | 'timeout'
  | 'cancelled'
  | 'interrupted'
  | 'skipped'

/** 运行触发方式。 */
export type RunTrigger = 'schedule' | 'manual'

/** 调度时间的表达方式。 */
export type ScheduleMode = 'text' | 'cron' | 'manual'

/** 结构化运行错误，随运行记录持久化。 */
export interface RunError {
  code: string
  message: string
}

/** 已支持的 IM 渠道；新增平台时只在这里加一项。 */
export type ImChannel = 'feishu'

/** 一次扫码尝试的状态。 */
export type ProvisionState =
  | 'starting'
  | 'waiting'
  | 'scanned'
  | 'saving'
  | 'connected'
  | 'expired'
  | 'failed'
  | 'cancelled'

/** 最近一次发送的结果。 */
export interface LastSend {
  at: string
  ok: boolean
  code?: string
}

/** 页面可见的机器人；不含 secretRef 与完整 app_id。 */
export interface BotView {
  botId: string
  channel: ImChannel
  /** 展示名：接入时确定，之后不可修改。 */
  name: string
  appIdMasked: string
  domain: 'feishu' | 'lark'
  createdAt: string
  lastSend: LastSend | null
}

/** 可直接展示的稳定错误。 */
export interface ImError {
  code: string
  message: string
}

/** 一次扫码尝试的公开快照。 */
export interface ProvisionView {
  attemptId: string
  state: ProvisionState
  /** 二维码图片；只有 `waiting` 阶段才有。 */
  qrCodeDataUrl?: string
  expiresAt?: number
  pollIntervalMs: number
  error?: ImError
}

/** 机器人列表 + 进行中的扫码。 */
export interface BotsStatus {
  bots: BotView[]
  provisioning: ProvisionView | null
}

/** 一个任务，按 host 的读模型描述。 */
export interface TaskRecord {
  id: string
  name: string
  details: string
  /** 报告命名节奏，由 `cron` 推导。 */
  frequency: Frequency
  createdAt: string
  /** 最近一次运行所用的会话。 */
  sessionId?: string
  /** 任务目录的绝对路径。 */
  folder: string
  /** 最新报告的文件名。 */
  report?: string
  /** 任务目录中更早的报告数量。 */
  historyCount: number
  /** 五段 cron 表达式；缺省表示只能手动执行。 */
  cron?: string
  /** 调度时间的表达方式。 */
  scheduleMode: ScheduleMode
  /** 用户自己的时间说法，与规范化后的 cron 并存。 */
  scheduleText?: string
  /** cron 解释所用的 IANA 时区。 */
  timeZone: string
  /** 定时器是否应触发该任务。 */
  enabled: boolean
  /** 运行历史保留天数；0 表示永久。 */
  historyDays: number
  /** 最近一次运行结束的 ISO 时间（中断记录用开始时间作补跑基线）。 */
  lastRunAt?: string
  /** 最近一次运行的状态。 */
  lastStatus?: RunStatus
  /** 最近一次运行的耗时（毫秒）。 */
  lastDurationMs?: number
  /** 最近一次运行的记录 id。 */
  lastRunId?: string
  /** 最近一次运行的失败原因。 */
  lastError?: string
  /** 下一次定时执行的 ISO 时间（计算值，不持久化）。 */
  nextRunAt?: string
  /** 当前是否正在执行（计算值，不持久化）。 */
  running?: boolean
  /** 运行成功后把报告发到哪些机器人；空数组表示没有目标。 */
  pushBotIds: string[]
  /** 推送开关：关掉保留目标但暂停发送。 */
  pushEnabled: boolean
}

/** 一次运行的完整记录，与 `meta/runs/<runId>.json` 一一对应。 */
export interface RunRecord {
  v: 1
  runId: string
  taskId: string
  trigger: RunTrigger
  catchUp: boolean
  scheduledFor: string | null
  startedAt: string
  finishedAt: string | null
  status: RunStatus
  durationMs: number | null
  sessionId: string | null
  report: string | null
  reportExists: boolean | null
  error: RunError | null
  bootId: string
  plugin: string
  /** 跳过执行时的原因：重叠、已停止或已停用。 */
  reason?: string
}

/** 一个 harness Workspace 的最小描述。 */
export interface WorkspaceRef {
  id: string
  title: string
}

/** 设置页读取与写回的工作目录视图。 */
export interface SettingsView {
  /** 插件当前的工作目录，也是运行会话的 cwd。 */
  workDir: string
  /** 未保存覆盖时使用的默认目录。 */
  defaultWorkDir: string
  /** 已保存的覆盖值；为空表示使用默认目录。 */
  savedWorkDir: string
  tasksTotal: number
  tasksEnabled: number
  /** 目录当前是否存在，每次打开页面都会检查。 */
  dirExists: boolean
  /** 该目录对应的 harness Workspace；没有则为 null。 */
  workspace: WorkspaceRef | null
  /** 应答的 host 构建版本。 */
  pluginVersion?: string
  /** 保存时目录已创建、但 Workspace 注册失败的原因。 */
  workspaceError?: string
}

/** 一次调度补丁。 */
export interface TaskSchedulePatch {
  mode: ScheduleMode
  text?: string
  cron?: string
}

/** 对任务元数据的增量修改。 */
export interface TaskPatch {
  enabled?: boolean
  schedule?: TaskSchedulePatch
  timeZone?: string
  historyDays?: number
  sessionId?: string
  /** 绑定的机器人列表；空数组表示清空目标。 */
  pushBotIds?: string[]
  /** 推送开关。 */
  pushEnabled?: boolean
}
