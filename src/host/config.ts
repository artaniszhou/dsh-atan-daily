/**
 * Host 侧的常量、配置解析与共享的运行时模型。
 *
 * 只放「值」与「纯函数」：不碰 fs，不碰宿主服务，方便核心逻辑单测。
 * 任务文档的文件名从 `core/documents` 转出，避免两处各写一份。
 */

import { homedir } from 'node:os'
import { isAbsolute, join, normalize } from 'node:path'
import { HOST_ROUTES } from '../protocol.js'
import type { Frequency, RunStatus } from '../protocol.js'
import { PLUGIN_VERSION } from './version.js'

/** 任务集合路由（精确匹配）。 */
export const ROUTE = HOST_ROUTES.tasks
/** 设置路由（精确匹配）；`/directory` 是它的子路径。 */
export const SETTINGS_ROUTE = HOST_ROUTES.settings
/** 任务目录、任务文档与文件索引的名字；定义在 core/documents，Host 只转出。 */
export {
  BUILD_DIR,
  CHARTS_DIR,
  INDEX_NAME,
  META_DIR,
  SHARE_DIR,
  TASK_DETAIL_NAME,
  TASK_DIR,
} from '../core/documents.js'
/** 与 `.meta/` 同级：归档更早的报告，任务根只留最新一份。 */
export const HISTORY_DIR = 'history'
/** `.meta/` 下的缓存目录。 */
export const CACHE_DIR = 'cache'
/** `.meta/` 下的脚本目录。 */
export const SCRIPT_DIR = 'script'
/** 一个任务名的上限。 */
export const MAX_NAME_LENGTH = 200
/** 一份任务详情的上限（字符）。 */
export const MAX_DETAIL_LENGTH = 200_000
/** 单次无人值守运行的默认上限（秒）。 */
export const DEFAULT_RUN_TIMEOUT_SECONDS = 1800
/** 运行历史的默认保留天数。 */
export const DEFAULT_HISTORY_DAYS = 7
/** 任务仓库（任务管理服务）的默认地址；不写端口即 443。 */
export const DEFAULT_SERVER_BASE_URL = 'https://atandaily.cn'
/** 归内置服务所有的域名：这些主机只走 https，填 http 也会被升级。 */
const BUILT_IN_SERVER_HOSTS: readonly string[] = ['atandaily.cn', 'www.atandaily.cn']
/** 展示/存储的插件版本；唯一来源是 `package.json`，见 `host/version`。 */
export { PLUGIN_VERSION }
/** 超过此值的等待改为重新武装，对齐 32 位有符号定时器上限。 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647
/** 新会话被 prompt 后，等待回合开始的上限。 */
export const TURN_START_BOUND_MS = 10_000
/** 无人值守运行使用的模型。 */
export const RUN_MODEL = 'deepseek-flash'
/** 解析 {@link RUN_MODEL} 时优先尝试的 provider。 */
export const RUN_MODEL_PROVIDERS: readonly string[] = [
  'deepseek-official',
  'deepseek-account',
  'deepseek-messages',
  'deepseek',
]

/** 报告节奏，只用于展示与报告命名。 */
export const FREQUENCIES: readonly Frequency[] = ['daily', 'hourly', 'on-demand']

/** 运行状态全集；用于校验手改过的输入。 */
export const RUN_STATUSES: readonly RunStatus[] = [
  'running',
  'ok',
  'failed',
  'timeout',
  'cancelled',
  'interrupted',
  'skipped',
]

/**
 * 一个字符串是否是运行状态。
 * @param value - 原始字段。
 * @returns true 表示是已知状态。
 */
export function isRunStatus(value: string | undefined): value is RunStatus {
  return value !== undefined && RUN_STATUSES.includes(value as RunStatus)
}

/** 插件行的配置。 */
export interface Config {
  /**
   * 建议工作区：只作为页面「使用建议工作区」的默认值与一次性迁移的候选，
   * 不再是「用户没选就用它」。运行期的工作区由页面选择后写进 `settings.json`。
   */
  dataDir?: string
  /** 单次无人值守运行的上限（秒），默认 1800。 */
  runTimeoutSeconds?: number
  /** 每个任务保留多少天运行历史，默认 7。 */
  historyDays?: number
  /**
   * 任务仓库（任务管理服务）地址（协议 + host + 端口），例如 http://10.0.0.12:8080。
   * 不配置时用 `DEFAULT_SERVER_BASE_URL`；显式留空表示关闭上传与任务仓库。
   */
  serverBaseUrl?: string
}

/** 解析后的配置：所有默认值已经落定。 */
export interface ResolvedConfig {
  /** 插件固定的设置根；设置文件不能放在它指向的目录里。 */
  settingsRoot: string
  /** yaml 的 `dataDir`：只用于迁移与建议工作区，不再是默认工作区。 */
  configuredWorkDir?: string
  /** 旧版默认工作区（插件数据目录）：只用于一次性迁移。 */
  legacyWorkDir: string
  /** 新任务的默认保留天数。 */
  historyDays: number
  /** 单次运行的上限（毫秒）。 */
  runTimeoutMs: number
  /** 应答里带出的构建版本。 */
  pluginVersion: string
  /** 任务管理服务地址；空串表示未配置。 */
  serverBaseUrl: string
}

/**
 * 插件固定的设置根。
 * @returns 绝对目录路径。
 */
export function pluginRoot(): string {
  const home = typeof process.env['DSH_HOME'] === 'string' && process.env['DSH_HOME'].trim() !== ''
    ? process.env['DSH_HOME'].trim()
    : join(homedir(), '.dsh')
  return join(home, 'plugin-data', 'atan-daily')
}

/**
 * 宿主自身的 IANA 时区，任务未声明时使用。
 * @returns IANA 时区名。
 */
export function hostTimeZone(): string {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return 'UTC'
  }
}

/**
 * 解析配置并补齐默认值。
 * @param config - 插件行配置，可缺省。
 * @returns 已落定的配置。
 */
export function resolveConfig(config?: Config): ResolvedConfig {
  const settingsRoot = pluginRoot()
  const configured = config?.dataDir?.trim()
  const configuredWorkDir = configured !== undefined && configured !== ''
    ? (isAbsolute(configured) ? normalize(configured) : join(settingsRoot, configured))
    : undefined
  const seconds = Number(config?.runTimeoutSeconds)
  const timeoutSeconds = Number.isFinite(seconds) && seconds > 0
    ? seconds
    : DEFAULT_RUN_TIMEOUT_SECONDS
  const days = Number(config?.historyDays)
  const historyDays = Number.isFinite(days) && days >= 0 ? days : DEFAULT_HISTORY_DAYS
  return {
    settingsRoot,
    configuredWorkDir,
    legacyWorkDir: settingsRoot,
    historyDays,
    runTimeoutMs: timeoutSeconds * 1000,
    pluginVersion: PLUGIN_VERSION,
    // 没配置字段时用内置默认地址；显式留空（''）表示关掉上传与任务仓库。
    serverBaseUrl: config?.serverBaseUrl === undefined
      ? DEFAULT_SERVER_BASE_URL
      : normalizeBaseUrl(config.serverBaseUrl, 'serverBaseUrl'),
  }
}

/**
 * 规范化站点地址；只接受 http/https，去掉末尾斜杠。
 *
 * 内置域名（`atandaily.cn` / `www.atandaily.cn`）的 http 地址一律升级成 https：
 * 80 端口只剩 301，而带 body 的 POST 跟 301 会被降级成 GET，上传任务会直接失败。
 * 老安装 `settings.json` 里存的 `http://atandaily.cn` 也在读取时走这条规则。
 * @param value - 配置值。
 * @param field - 配置字段名，用于错误提示。
 * @returns 规范地址；未配置返回空串。
 * @throws Error 当地址不合法。
 */
export function normalizeBaseUrl(value: string | undefined, field: string): string {
  const raw = value?.trim() ?? ''
  if (raw === '') return ''
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`${field} 不是合法地址`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${field} 只支持 http/https`)
  }
  // 只升级默认端口：`http://atandaily.cn` 走 80 会 301，而带 body 的 POST 跟 301 会被
  // 降级成 GET；显式写了端口（如直连 Spring Boot 的 :8080）是另一种部署，保持原样。
  if (
    url.protocol === 'http:'
    && url.port === ''
    && BUILT_IN_SERVER_HOSTS.includes(url.hostname.toLowerCase())
  ) {
    url.protocol = 'https:'
  }
  return url.href.replace(/\/+$/u, '')
}
