/**
 * 命名与派生展示数据（纯函数）。
 *
 * 报告名由插件生成、固定宽度，所以「最新报告」按文件名的定宽时间戳排序即可，
 * 不再逐份 `stat`；节奏判断直接看解析后的 cron 字段，避免每次请求跑两次
 * `nextOccurrence`。
 */

import type { CronRule } from '../core/cron.js'
import type { Frequency } from '../protocol.js'

/** 报告扩展名。 */
export const REPORT_SUFFIX = '.md'

/** 定宽报告名：`YYYY-MM-DD-HHMMSS.md`，重名时追加 `-2`、`-3`。 */
const REPORT_PATTERN = /^(\d{4}-\d{2}-\d{2})-(\d{6})(?:-(\d+))?\.md$/u

/**
 * Whether a file name is a report produced by this plugin.
 * @param name - file name.
 * @returns true for the fixed-width report shape.
 */
export function isReportName(name: string): boolean {
  return REPORT_PATTERN.test(name)
}

/**
 * 报告文件名：运行开始的瞬间，精确到秒，按任务自己的时区渲染。
 * @param at - 生成报告的瞬间。
 * @param timeZone - 任务的 IANA 时区。
 * @returns 报告文件名。
 */
export function reportNameOf(at: Date, timeZone: string): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const local = (): string =>
    `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
    + `-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}.md`
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
    if (values.some(item => item === '')) return local()
    const [year, month, day, hour, minute, second] = values
    return `${year}-${month}-${day}-${hour}${minute}${second}.md`
  } catch {
    // 时区在写入前已经校验；未知时区仍给一个可用的名字，而不是让运行失败。
    return local()
  }
}

/**
 * 任务目录名：任务名本身，只去掉 Windows 禁止出现在路径里的字符。
 * @param name - 任务名。
 * @returns 目录名。
 * @throws 当名字里没有可用字符时。
 */
export function folderNameOf(name: string): string {
  const cleaned = name
    // Windows 保留字符与控制字符。
    .replace(/[\\/:*?"<>|\u0000-\u001f]/gu, ' ')
    // Windows 上结尾的点或空格不可寻址。
    .replace(/[. ]+$/u, '')
    .replace(/\s+/gu, ' ')
    .trim()
  // Truncate by code point, not UTF-16 code unit: a surrogate pair cut in
  // half is not a valid path segment.
  const bounded = [...cleaned].slice(0, 96).join('')
  if (bounded === '' || bounded === '.' || bounded === '..') {
    throw new Error('任务名称不能用作目录名，请换一个名称（去掉 \\ / : * ? " < > | 等字符）')
  }
  // Windows device names (CON, PRN, COM1, ...) are reserved even with an
  // extension; appending an underscore keeps the folder addressable.
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(bounded)) {
    return bounded.length < 96 ? `${bounded}_` : `${bounded.slice(0, 95)}_`
  }
  return bounded
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
 * 比较两个报告名：先定宽时间戳，再重名后缀。
 * @param left - 文件名。
 * @param right - 文件名。
 * @returns 排序结果。
 */
export function compareReportNames(left: string, right: string): number {
  const a = REPORT_PATTERN.exec(left)
  const b = REPORT_PATTERN.exec(right)
  if (a !== null && b !== null) {
    const stamp = `${a[1] ?? ''}${a[2] ?? ''}`.localeCompare(`${b[1] ?? ''}${b[2] ?? ''}`)
    if (stamp !== 0) return stamp
    return Number(a[3] ?? '1') - Number(b[3] ?? '1')
  }
  // 识别不出的名字（手工改名）排在生成的报告名之前，保证生成的最新报告仍被选中。
  if (a !== null) return 1
  if (b !== null) return -1
  return left.localeCompare(right)
}

/**
 * 选出一组目录项里最新的报告文件名。
 * @param names - 任务目录下的文件名。
 * @returns 最新报告名；没有报告时 undefined。
 */
export function latestReportName(names: readonly string[]): string | undefined {
  const reports = names.filter(isReportName)
  if (reports.length === 0) return undefined
  return reports.sort(compareReportNames).at(-1)
}
