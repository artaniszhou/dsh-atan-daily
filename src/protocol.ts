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
  taskHub: 'atan-daily/task-hub',
  announcement: 'atan-daily/announcement',
} as const

/** host 侧的路由前缀（带前导斜杠，用于精确匹配）。 */
export const HOST_ROUTES = {
  tasks: `/${ROUTES.tasks}`,
  settings: `/${ROUTES.settings}`,
  im: `/${ROUTES.im}`,
  taskHub: `/${ROUTES.taskHub}`,
  announcement: `/${ROUTES.announcement}`,
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

/**
 * 任务运行会话的权限级别。
 *
 * 取值直接复用 DSH 的权限预设名：`workspace-write`（工作区内修改）与
 * `danger-full-access`（完全权限）。两者都由宿主的 `permissionPresets`
 * 服务解析成「沙箱范围 + 审批策略」。
 */
export type PermissionLevel = 'workspace-write' | 'danger-full-access'

/** 权限级别全集；页面单选、响应解码与 Host 校验共用。 */
export const PERMISSION_LEVELS: readonly PermissionLevel[] = ['workspace-write', 'danger-full-access']

/** 最终文档格式；JSON/HTML 只是 `.meta/build` 下的中间件。 */
export type OutputFormat = 'pdf' | 'png'

/** 最终文档格式全集。 */
export const OUTPUT_FORMATS: readonly OutputFormat[] = ['pdf', 'png']

/** 新任务的默认格式。 */
export const DEFAULT_OUTPUT_FORMAT: OutputFormat = 'png'

/**
 * 判断一个值是否是合法的最终文档格式。
 * @param value - 原始值。
 * @returns true 表示 pdf 或 png。
 */
export function isOutputFormat(value: unknown): value is OutputFormat {
  return value === 'pdf' || value === 'png'
}

/** 新任务的默认权限级别：只能在工作区内读写文件。 */
export const DEFAULT_PERMISSION_LEVEL: PermissionLevel = 'workspace-write'

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
  /** 任务身份（UUID），创建时生成、改名不变。 */
  taskId: string
  name: string
  /** 用户写的任务细节，存放在任务根目录的 `task-detail.md`。 */
  details: string
  /** 报告命名节奏，由 `cron` 推导。 */
  frequency: Frequency
  createdAt: string
  /** 最近一次运行所用的会话。 */
  sessionId?: string
  /** 任务目录的绝对路径；目录名随任务名变化。 */
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
  /** 每次运行是否新建会话；默认 true。关掉后复用上一次会话。 */
  newSession: boolean
  /** 运行会话的权限级别；默认工作区内修改。 */
  permissionLevel: PermissionLevel
  /** 最终文档格式；默认 PNG。 */
  outputFormat: OutputFormat
}

/** 一次运行的完整记录，与 `.meta/runs/<runId>.json` 一一对应。 */
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
  /** 插件当前的工作目录，也是运行会话的 cwd；未配置时为空串。 */
  workDir: string
  /** 是否已经选过工作目录；false 时页面进入引导态，任务相关操作不可用。 */
  workDirConfigured: boolean
  /** 「使用建议目录」按钮上的值；由宿主按平台计算。 */
  suggestedWorkDir: string
  /** 已保存的工作目录覆盖；为空表示未配置。 */
  savedWorkDir: string
  /** 当前生效的任务仓库地址；空串表示未配置。 */
  serverBaseUrl: string
  /** 页面保存的任务仓库地址覆盖；空串表示没有覆盖。 */
  savedServerBaseUrl: string
  /** yaml 里的任务仓库地址默认值；空串表示未配置。 */
  defaultServerBaseUrl: string
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
  /** 当前宿主是否找到可用于 PNG/PDF 的 Chrome/Edge。 */
  browserAvailable: boolean
}

/**
 * 页面标题下方的公告；`enabled=false` 表示当前没有公告，页面不渲染这块。
 *
 * 正文可为空串：只有一句话的公告只填标题即可，此时页面不出现「展开」。
 */
export interface AnnouncementView {
  enabled: boolean
  /** 单行标题；`enabled=true` 时非空。 */
  title: string
  /** 正文，纯文本，可含换行；空串表示只有标题。 */
  content: string
  /** 最后修改时间；没有公告时为 null。只用于诊断与重置展开态。 */
  updatedAt: string | null
}

/** 一次调度补丁。 */
export interface TaskSchedulePatch {
  mode: ScheduleMode
  text?: string
  cron?: string
}

/** 对任务元数据的增量修改。 */
export interface TaskPatch {
  /** 新任务名；Host 会把任务目录同步改成新名字。 */
  name?: string
  /** 任务细节；Host 写到任务根目录的 `task-detail.md`，不进注册表。 */
  details?: string
  enabled?: boolean
  schedule?: TaskSchedulePatch
  timeZone?: string
  historyDays?: number
  sessionId?: string
  /** 绑定的机器人列表；空数组表示清空目标。 */
  pushBotIds?: string[]
  /** 推送开关。 */
  pushEnabled?: boolean
  /** 每次运行是否新建会话；false 表示复用上一次会话。 */
  newSession?: boolean
  /** 运行会话的权限级别；缺省时保持任务当前设置。 */
  permissionLevel?: PermissionLevel
  /** 最终文档格式；缺省时保持任务当前设置。 */
  outputFormat?: OutputFormat
}

// ---------------------------------------------------------------------------
// 展示覆盖（task-display.json）与面板接口
// ---------------------------------------------------------------------------

/** 字号阶名字。 */
export type DisplayTextName = '2xs' | 'xs' | 'sm' | 'base' | 'lg' | 'xl' | '2xl'

/** 可覆盖的语义颜色名。 */
export type DisplayColorName =
  | 'paper' | 'surface' | 'surfaceAlt' | 'ink' | 'body' | 'muted' | 'border' | 'accent'
  | 'accentSoft' | 'trust' | 'success' | 'warning' | 'danger' | 'warnSoft' | 'codeBg' | 'tableHeadBg'

/** 可覆盖的字体名。 */
export type DisplayFontName = 'serif' | 'sans' | 'mono'

/** 令牌补丁。 */
export interface DisplayTokens {
  fontScale?: number
  text?: Partial<Record<DisplayTextName, number>>
  leading?: { tight?: number, normal?: number }
  space?: number[]
  width?: string
  measure?: string
  radius?: { sm?: number, md?: number }
  color?: Partial<Record<DisplayColorName, string>>
  font?: Partial<Record<DisplayFontName, string>>
  chart?: string[]
}

/** 图表外观补丁。 */
export interface DisplayChart {
  height?: number
  width?: number
  fontScale?: number
  axisFontSize?: number
  labelFontSize?: number
  legendFontSize?: number
  valueFontSize?: number
  pointSize?: { min?: number, max?: number }
  barMaxWidth?: number
  lineWidth?: number
  legend?: boolean
  table?: { show?: boolean, columns?: string[] }
}

/** 单个块的外观补丁。 */
export interface DisplayBlock {
  fontSize?: number
  lineHeight?: number
  color?: string
  align?: 'left' | 'center' | 'right'
  maxWidth?: string
  marginTop?: number
  marginBottom?: number
  padding?: number
  background?: string
  border?: boolean
  density?: 'normal' | 'compact'
  columnWidths?: Record<string, string>
  headBackground?: string
  columns?: number
  chart?: DisplayChart
}

/** 展示覆盖文件。 */
export interface DisplaySpec {
  version: number
  theme?: string
  tokens?: DisplayTokens
  chart?: DisplayChart
  blocks?: Record<string, DisplayBlock>
  selectors?: Record<string, DisplayBlock>
}

/** 面板里的块目录条目。 */
export interface DisplayBlockRef {
  key: string
  component: string
  title?: string
  source?: string
  series?: string[]
  children?: DisplayBlockRef[]
}

/** 面板初始化状态。 */
export interface DisplayStateView {
  /** 覆盖文件是否存在。 */
  present: boolean
  /** 解析后的规格；解析失败时为 null。 */
  spec: DisplaySpec | null
  /** 解析与校验提示。 */
  warnings: string[]
  /** 块目录。 */
  outline: DisplayBlockRef[]
  /** 当前主题名。 */
  theme: string
  /** 可选主题。 */
  themes: string[]
  /** 最近一轮运行。 */
  runId: string | null
  /** 最近一轮的报告基名。 */
  report: string | null
  /** 是否有契约可编辑。 */
  schema: boolean
}

/** 改图型请求。 */
export interface DisplaySchemaEdit {
  key: string
  type: string
  bind?: { x?: string, y?: string, fields?: string[] }
}

/** 一条变更说明。 */
export interface DisplayChange {
  label: string
  from?: string
  to?: string
}

/** 图型提案结论。 */
export interface DisplayVerdict {
  key: string
  title?: string
  verdict: 'exact' | 'lossy' | 'needs_data' | 'blocked'
  findings: string[]
  error?: string
}

/** 预览响应。 */
export interface DisplayPreviewView {
  ok: boolean
  before: string
  after: string
  changes: DisplayChange[]
  warnings: string[]
  verdicts: DisplayVerdict[]
  /** 是否可以直接应用（存在 blocked / needs_data 时为 false）。 */
  applicable: boolean
  error?: string
}

/** 应用请求。 */
export interface DisplayApplyInput {
  spec: DisplaySpec
  edits?: DisplaySchemaEdit[]
  /** 应用后是否重推飞书。 */
  push?: boolean
}

/** 应用响应。 */
export interface DisplayApplyView {
  ok: boolean
  files: string[]
  warnings: string[]
  schemaRevision?: number
  error?: string
}

/** 重生成响应。 */
export interface DisplayRegenView {
  ok: boolean
  files: string[]
  htmlSha256?: string
  warnings: string[]
  error?: string
}
