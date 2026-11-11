/**
 * 命名与派生展示数据（纯函数）。
 *
 * 报告名形如 `<任务名>-2026-10-31_21-30-00.pdf`。时间放在固定格式的后缀里，
 * 「最新报告」按解析出的时间戳排序，不依赖整串文件名排序。
 */

import type { CronRule } from '../core/cron.js'
import type { Frequency } from '../protocol.js'

/** 最终文档格式；JSON/HTML 只是 `.meta/build` 下的中间件。 */
export const REPORT_FORMATS = ['pdf', 'png'] as const

/** 一种最终文档格式。 */
export type ReportFormat = typeof REPORT_FORMATS[number]

/** 任务显示名的字符上限。 */
export const MAX_TASK_NAME_CHARS = 200

/** 目录名 / 报告名前缀的 UTF-8 字节上限，给时间后缀和扩展名留余量。 */
export const MAX_FILE_PREFIX_BYTES = 180

/** 时间后缀：`YYYY-MM-DD_HH-mm-ss`。 */
const STAMP_PATTERN = '\\d{4}-\\d{2}-\\d{2}_\\d{2}-\\d{2}-\\d{2}'

/** 不带扩展名的报告基名。 */
const BASE_PATTERN = new RegExp(`^(.+)-(${STAMP_PATTERN})(?:-(\\d+))?$`, 'u')

/** 带扩展名的报告文件名。 */
const NAME_PATTERN = new RegExp(`^(.+)-(${STAMP_PATTERN})(?:-(\\d+))?\\.(pdf|png)$`, 'u')

/** Windows 设备名；大小写不敏感，带扩展名也算。 */
const DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu

/** 跨平台非法的路径字符与控制字符。 */
const ILLEGAL_PATH = /[\\/:*?"<>|\u0000-\u001f\u007f]/u

/**
 * 按 UTF-8 字节截断，不切断多字节字符。
 * @param text - 原文。
 * @param maxBytes - 上限。
 * @returns 截断后的文本。
 */
function truncateUtf8(text: string, maxBytes: number): string {
  let bytes = 0
  let out = ''
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8')
    if (bytes + size > maxBytes) break
    bytes += size
    out += char
  }
  return out
}

/**
 * 把任务名收缩成一个可用的文件前缀。
 * @param name - 任务名（通常已经过校验）。
 * @returns 非空、无非法字符、字节数受限的前缀。
 */
export function filePrefixOf(name: string): string {
  const cleaned = name
    .replace(ILLEGAL_PATH, ' ')
    .replace(/\s+/gu, ' ')
    .replace(/[. ]+$/u, '')
    .trim()
  const bounded = truncateUtf8(cleaned, MAX_FILE_PREFIX_BYTES).replace(/[. ]+$/u, '').trim()
  return bounded === '' ? 'task' : bounded
}

/**
 * 校验任务显示名是否可跨平台使用。
 * @param name - 原始任务名。
 * @returns 去掉首尾空白后的合法名称。
 * @throws 名称含非法字符、是保留名或过长时。
 */
export function validateTaskName(name: string): string {
  const trimmed = name.trim()
  if (trimmed === '') throw new Error('任务名称不能为空')
  if ([...trimmed].length > MAX_TASK_NAME_CHARS) {
    throw new Error(`任务名称不能超过 ${String(MAX_TASK_NAME_CHARS)} 个字符`)
  }
  if (trimmed === '.' || trimmed === '..') throw new Error('任务名称不能是 . 或 ..')
  const lower = trimmed.toLowerCase()
  if (lower === '.task' || lower === '.meta') {
    throw new Error('任务名称不能使用 .task 或 .meta')
  }
  if (trimmed.startsWith('.')) throw new Error('任务名称不能以 . 开头')
  if (ILLEGAL_PATH.test(trimmed)) {
    throw new Error('任务名称不能包含 \\ / : * ? " < > | 或控制字符')
  }
  if (/[. ]$/u.test(trimmed)) throw new Error('任务名称不能以空格或点结尾')
  if (DEVICE_NAME.test(trimmed)) throw new Error('任务名称不能使用 CON、PRN、COM1 等系统保留名')
  return trimmed
}

/**
 * 任务目录名：校验后按 UTF-8 字节截断。
 * @param name - 任务名。
 * @returns 目录名。
 * @throws 名称不合法时。
 */
export function folderNameOf(name: string): string {
  const valid = validateTaskName(name)
  const folder = truncateUtf8(valid.replace(/\s+/gu, ' '), MAX_FILE_PREFIX_BYTES)
    .replace(/[. ]+$/u, '')
    .trim()
  if (folder === '' || folder === '.' || folder === '..') {
    throw new Error('任务名称不能用作目录名，请换一个名称')
  }
  return folder
}

/**
 * 文件名里的格式。
 * @param name - 文件名。
 * @returns 已知格式；不是最终文档时 undefined。
 */
export function reportFormatOf(name: string): ReportFormat | undefined {
  return NAME_PATTERN.exec(name)?.[4] as ReportFormat | undefined
}

/**
 * 文件名对应的报告基名。
 * @param name - 文件名或基名。
 * @returns 基名；认不出时 undefined。
 */
export function reportBaseOf(name: string): string | undefined {
  if (BASE_PATTERN.test(name)) return name
  const match = NAME_PATTERN.exec(name)
  if (match === null) return undefined
  const suffix = match[3] === undefined ? '' : `-${match[3]}`
  return `${match[1] ?? ''}-${match[2] ?? ''}${suffix}`
}

/**
 * Whether a file name is a final report produced by this plugin.
 * @param name - file name.
 * @returns true for the new report shape.
 */
export function isReportName(name: string): boolean {
  return NAME_PATTERN.test(name)
}

/**
 * 拼出一个报告文件名。
 * @param base - 报告基名。
 * @param format - 目标格式。
 * @returns 文件名。
 */
export function reportFileName(base: string, format: ReportFormat): string {
  return `${base}.${format}`
}

/**
 * 报告基名：任务名前缀 + 运行开始的本地时间。
 * @param at - 生成报告的瞬间。
 * @param timeZone - 任务的 IANA 时区。
 * @param taskName - 任务显示名。
 * @returns 基名（不含扩展名）。
 */
export function reportBaseAt(at: Date, timeZone: string, taskName: string): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const localStamp = (): string =>
    `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
    + `_${pad(at.getHours())}-${pad(at.getMinutes())}-${pad(at.getSeconds())}`
  let stamp: string
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(at)
    const value = (type: string): string => parts.find(part => part.type === type)?.value ?? ''
    const values = ['year', 'month', 'day', 'hour', 'minute', 'second'].map(value)
    if (values.some(item => item === '')) {
      stamp = localStamp()
    } else {
      const [year, month, day, hour, minute, second] = values
      stamp = `${year}-${month}-${day}_${hour}-${minute}-${second}`
    }
  } catch {
    // 时区在写入前已经校验；未知时区仍给一个可用的名字，而不是让运行失败。
    stamp = localStamp()
  }
  return `${filePrefixOf(taskName)}-${stamp}`
}

/**
 * 由解析后的 cron 字段判断报告节奏。
 *
 * 同一天内不存在两个相隔小于两小时的触发点就视为 daily；没有 cron 的任务
 * 只能手动执行，报告名带秒级精度。这个判断与旧实现（测量前两次触发间隔）
 * 对常规 cron 等价，但不再做时区搜索。
 * @param cron - 已解析的规则；手动任务为 undefined。
 * @returns 报告节奏。
 */
export function frequencyOf(cron: CronRule | undefined): Frequency {
  if (cron === undefined) return 'on-demand'
  const times: number[] = []
  for (const hour of cron.hours) {
    for (const minute of cron.minutes) times.push(hour * 60 + minute)
  }
  times.sort((left, right) => left - right)
  if (times.length === 0) return 'on-demand'
  let shortest = Infinity
  for (let index = 1; index < times.length; index += 1) {
    const previous = times[index - 1]
    const current = times[index]
    if (previous !== undefined && current !== undefined) shortest = Math.min(shortest, current - previous)
  }
  // The day wraps: 23:00 and 00:00 are one hour apart, not twenty-three.
  const first = times[0]
  const last = times[times.length - 1]
  if (first !== undefined && last !== undefined) shortest = Math.min(shortest, 24 * 60 - last + first)
  return shortest < 2 * 60 ? 'hourly' : 'daily'
}

/**
 * 解析基名里的时间戳与重名后缀。
 * @param base - 报告基名。
 * @returns 时间戳与后缀；认不出时 undefined。
 */
function stampOf(base: string): { stamp: string, suffix: number } | undefined {
  const match = BASE_PATTERN.exec(base)
  if (match === null) return undefined
  return { stamp: match[2] ?? '', suffix: Number(match[3] ?? '1') }
}

/**
 * 比较两个报告基名：先时间戳，再重名后缀。
 * @param left - 基名。
 * @param right - 基名。
 * @returns 排序结果。
 */
export function compareReportBases(left: string, right: string): number {
  const a = stampOf(left)
  const b = stampOf(right)
  if (a !== undefined && b !== undefined) {
    const stamp = a.stamp.localeCompare(b.stamp)
    if (stamp !== 0) return stamp
    return a.suffix - b.suffix
  }
  // 识别不出的名字（手工改名）排在生成的基名之前，保证生成的最新报告仍被选中。
  if (a !== undefined) return 1
  if (b !== undefined) return -1
  return left.localeCompare(right)
}

/**
 * 选出一组目录项里最新的报告基名。
 * @param names - 任务目录与 history/ 下的文件名。
 * @returns 最新基名；没有报告时 undefined。
 */
export function latestReportBase(names: readonly string[]): string | undefined {
  const bases = names
    .map(name => reportBaseOf(name))
    .filter((base): base is string => base !== undefined)
  if (bases.length === 0) return undefined
  return [...new Set(bases)].sort(compareReportBases).at(-1)
}
