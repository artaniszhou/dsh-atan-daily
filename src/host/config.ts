/**
 * Host 侧的常量、配置解析与共享的运行时模型。
 *
 * 只放「值」与「纯函数」：不碰 fs，不碰宿主服务，方便核心逻辑单测。
 */

import { homedir } from 'node:os'
import { isAbsolute, join, normalize } from 'node:path'
import { HOST_ROUTES } from '../protocol.js'
import type { Frequency, RunStatus } from '../protocol.js'

/** 任务集合路由（精确匹配）。 */
export const ROUTE = HOST_ROUTES.tasks
/** 设置路由（精确匹配）；`/directory` 是它的子路径。 */
export const SETTINGS_ROUTE = HOST_ROUTES.settings
/** 任务目录里承载规则、缓存、脚本与运行记录的子目录。 */
export const META_DIR = 'meta'
/** 与 `meta/` 同级：归档更早的报告，任务根只留最新一份。 */
export const HISTORY_DIR = 'history'
/** `meta/` 下的规则文件名。 */
export const RULE_NAME = 'rule.md'
/** `meta/` 下的缓存目录。 */
export const CACHE_DIR = 'cache'
/** `meta/` 下的脚本目录。 */
export const SCRIPT_DIR = 'script'
/** 一个任务名的上限。 */
export const MAX_NAME_LENGTH = 200
/** 一份任务详情的上限（字符）。 */
export const MAX_DETAIL_LENGTH = 200_000
/** 单次无人值守运行的默认上限（秒）。 */
export const DEFAULT_RUN_TIMEOUT_SECONDS = 1800
/** 运行历史的默认保留天数。 */
export const DEFAULT_HISTORY_DAYS = 7
/** 展示/存储的插件版本；与 package.json 保持同步。 */
export const PLUGIN_VERSION = '1.1.0'
/** 超过此值的等待改为重新武装，对齐 32 位有符号定时器上限。 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647
/** 新会话被 prompt 后，等待回合开始的上限。 */
export const TURN_START_BOUND_MS = 10_000
/** 无人值守运行固定使用的模型。 */
export const RUN_MODEL = 'deepseek-flash'
/** 解析 {@link RUN_MODEL} 时优先尝试的 provider。 */
export const RUN_MODEL_PROVIDERS: readonly string[] = [
  'deepseek-official',
  'deepseek-account',
  'deepseek-messages',
  'deepseek',
]
/** 无人值守运行使用的权限预设（沙箱 + 审批）。 */
export const RUN_PERMISSION_PRESET = 'danger-full-access'

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
   * 插件的初始工作目录，同时也是运行会话的 cwd。页面可在运行时改它，
   * 页面保存的值优先于这里。
   */
  dataDir?: string
  /** 单次无人值守运行的上限（秒），默认 1800。 */
  runTimeoutSeconds?: number
  /** 每个任务保留多少天运行历史，默认 7。 */
  historyDays?: number
}

/** 解析后的配置：所有默认值已经落定。 */
export interface ResolvedConfig {
  /** 插件固定的设置根；设置文件不能放在它指向的目录里。 */
  settingsRoot: string
  /** 没有保存覆盖时使用的工作目录。 */
  defaultWorkDir: string
  /** 新任务的默认保留天数。 */
  historyDays: number
  /** 单次运行的上限（毫秒）。 */
  runTimeoutMs: number
  /** 应答里带出的构建版本。 */
  pluginVersion: string
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
  const defaultWorkDir = configured !== undefined && configured !== ''
    ? (isAbsolute(configured) ? normalize(configured) : join(settingsRoot, configured))
    : settingsRoot
  const seconds = Number(config?.runTimeoutSeconds)
  const timeoutSeconds = Number.isFinite(seconds) && seconds > 0
    ? seconds
    : DEFAULT_RUN_TIMEOUT_SECONDS
  const days = Number(config?.historyDays)
  const historyDays = Number.isFinite(days) && days >= 0 ? days : DEFAULT_HISTORY_DAYS
  return {
    settingsRoot,
    defaultWorkDir,
    historyDays,
    runTimeoutMs: timeoutSeconds * 1000,
    pluginVersion: PLUGIN_VERSION,
  }
}
