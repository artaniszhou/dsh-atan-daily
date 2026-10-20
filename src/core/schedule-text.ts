/**
 * Turn a everyday phrasing of a run time into a canonical five-field cron
 * expression.
 *
 * The page asks for 「执行时间」 and the user answers as they would say it out
 * loud ("每天9点", "每个小时一次", "每周一和周四 8:30"); this module normalizes
 * that to the cron the rule document stores. A literal five-field expression is
 * accepted too, so a power user is never blocked by the parser.
 *
 * Supported phrasings (Chinese and a few English synonyms):
 *
 *   每 30 分钟 / 每 N 小时 / 每小时
 *   每天 9 点 / 每天早上 8:00 / 每天下午 3 点半
 *   工作日 9 点 / 周末 10 点
 *   每周一 9 点 / 每周一到周五 9 点 / 每周一和周四 8 点
 *   每月 1 号 9 点
 *   every 30 minutes / hourly / daily at 9 / weekdays at 9 /
 *   every monday at 9 / monthly on the 1st at 9
 */

import { parseCron } from './cron.js'

/** The normalized schedule: a canonical cron expression and its display text. */
export interface ParsedSchedule {
  /** Canonical five-field expression. */
  cron: string
  /** The user's own phrasing, trimmed. */
  text: string
}

/** The day-of-week index for each Chinese weekday token. */
const WEEKDAY: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0,
}

/** Chinese numeral characters that appear as hours or days. */
const NUMERAL: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
}

/** English weekday names, mapped to the cron index. */
const ENGLISH_WEEKDAY: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
}

/**
 * Fold the punctuation users actually type into what the patterns expect.
 * @param input - the raw phrase.
 * @returns the folded phrase.
 */
function fold(input: string): string {
  return input
    .replace(/：/gu, ':')
    .replace(/[，、]/gu, ',')
    .replace(/（/gu, '(')
    .replace(/）/gu, ')')
    .replace(/\u3000/gu, ' ')
    .trim()
}

/**
 * Read a Chinese or Arabic numeral, including tens such as `十二` or `二十`.
 * @param text - the token.
 * @returns the number, or undefined.
 */
function numberOf(text: string): number | undefined {
  const trimmed = text.trim()
  if (/^\d+$/u.test(trimmed)) return Number(trimmed)
  if (trimmed in NUMERAL) return NUMERAL[trimmed]
  const match = trimmed.match(/^([一二三四五六七八九])?十([一二三四五六七八九])?$/u)
  if (match === null) return undefined
  const tens = match[1] === undefined ? 1 : (NUMERAL[match[1]] ?? 0)
  const ones = match[2] === undefined ? 0 : (NUMERAL[match[2]] ?? 0)
  return tens * 10 + ones
}

/**
 * Shift an hour by the phrase's part-of-day word.
 * @param text - the phrase holding the word.
 * @param hour - the hour as written.
 * @returns the 24-hour hour.
 */
function applyMeridiem(text: string, hour: number): number {
  if (/下午|晚上|傍晚|夜里|pm/iu.test(text) && hour < 12) return hour + 12
  if (/中午/u.test(text) && hour < 11) return hour + 12
  if (/凌晨/u.test(text) && hour === 12) return 0
  return hour
}

/**
 * Read one clock time from a phrase.
 *
 * Understands `9`, `9点`, `9:30`, `9点30分`, `早上8点`, `下午3点半`, `9am`.
 * @param text - the whole phrase.
 * @returns the 24-hour hour and minute, or undefined when no time is present.
 */
function readTime(text: string): { hour: number, minute: number } | undefined {
  // `9:30`, `09:05`
  const colon = text.match(/(\d{1,2}):(\d{2})/u)
  if (colon !== null) {
    const hour = Number(colon[1])
    const minute = Number(colon[2])
    if (hour > 23 || minute > 59) return undefined
    return { hour: applyMeridiem(text, hour), minute }
  }
  // `9点30分`, `九点`, `9时`, `9点半`
  const dotted = text.match(/([0-9]{1,2}|[零一二三四五六七八九十]{1,3})\s*[点时](?:\s*([0-9]{1,2}|[零一二三四五六七八九十]{1,3})\s*分?)?/u)
  if (dotted !== null) {
    const hour = numberOf(dotted[1] ?? '')
    if (hour === undefined || hour > 23) return undefined
    const minute = dotted[2] === undefined ? 0 : (numberOf(dotted[2]) ?? 0)
    if (minute > 59) return undefined
    const half = /半/u.test(text.slice(dotted.index ?? 0, (dotted.index ?? 0) + dotted[0].length + 1))
    return { hour: applyMeridiem(text, hour), minute: half ? 30 : minute }
  }
  // `at 9`, `at 9am`, `9:00 am`
  const english = text.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/u)
  if (english !== null) {
    const hour = Number(english[1])
    if (hour > 23) return undefined
    const minute = english[2] === undefined ? 0 : Number(english[2])
    if (minute > 59) return undefined
    const suffix = english[3]
    const base = suffix === 'pm' && hour < 12 ? hour + 12 : suffix === 'am' && hour === 12 ? 0 : hour
    return { hour: base, minute }
  }
  return undefined
}

/**
 * Compose a cron expression from its fields.
 * @param minute - minute field.
 * @param hour - hour field.
 * @param dayOfMonth - day-of-month field.
 * @param month - month field.
 * @param dayOfWeek - day-of-week field.
 * @returns the expression.
 */
function cron(minute: string, hour: string, dayOfMonth: string, month: string, dayOfWeek: string): string {
  return `${minute} ${hour} ${dayOfMonth} ${month} ${dayOfWeek}`
}

/**
 * Read the weekday list of a `每周…` phrase.
 * @param tail - the text after `每周`, for example `一和周四` or `一到周五`.
 * @returns the cron weekday numbers as strings, ascending.
 */
function readWeekdays(tail: string): string[] {
  const days = new Set<number>()
  const range = tail.match(/([一二三四五六日天])\s*(?:到|至|-|~)\s*(?:周|星期|礼拜)?\s*([一二三四五六日天])/u)
  if (range !== null) {
    const from = WEEKDAY[range[1] ?? ''] ?? 1
    const to = WEEKDAY[range[2] ?? ''] ?? 5
    // Walk the written range, including a wrap such as 周五到周一.
    let current = from
    for (let step = 0; step < 7; step += 1) {
      days.add(current)
      if (current === to) break
      current = current === 6 ? 0 : current + 1
    }
  }
  // A phrase may combine a range with extra days ("周一到周五和周日"): the
  // range above only covers its endpoints, so keep collecting explicit tokens.
  for (const token of tail.matchAll(/[一二三四五六日天]/gu)) {
    const day = WEEKDAY[token[0]]
    if (day !== undefined) days.add(day)
  }
  return [...days].sort((left, right) => left - right).map(String)
}

/**
 * Parse one phrasing into a canonical cron expression.
 * @param input - the user's phrase, or a literal five-field expression.
 * @returns the schedule; undefined when the phrase is empty (run on demand only).
 * @throws when the phrase cannot be understood.
 */
export function parseScheduleText(input: string): ParsedSchedule | undefined {
  const text = fold(input)
  if (text === '') return undefined
  const lower = text.toLowerCase()

  // A literal expression passes straight through, so a power user is not blocked.
  if (/^\s*\S+\s+\S+\s+\S+\s+\S+\s+\S+\s*$/u.test(text)) {
    parseCron(text)
    return { cron: text, text }
  }

  // `每 30 分钟` / `every 30 minutes`
  const everyMinutes = lower.match(/每\s*([0-9]{1,2}|[一二三四五六七八九十]{1,3})\s*分钟/u)
    ?? lower.match(/every\s+(\d{1,2})\s*min/u)
  if (everyMinutes !== null) {
    const step = numberOf(everyMinutes[1] ?? '')
    if (step === undefined || step < 1 || step > 59) {
      throw new Error('分钟间隔需要在 1 到 59 之间，例如：每 30 分钟')
    }
    return { cron: cron(`*/${String(step)}`, '*', '*', '*', '*'), text }
  }

  // `每 2 小时` / `every 2 hours`
  const everyHours = lower.match(/每\s*([0-9]{1,2}|[一二三四五六七八九十]{1,3})\s*(?:个)?小时/u)
    ?? lower.match(/every\s+(\d{1,2})\s*hour/u)
  if (everyHours !== null) {
    const step = numberOf(everyHours[1] ?? '')
    if (step === undefined || step < 1 || step > 23) {
      throw new Error('小时间隔需要在 1 到 23 之间，例如：每 2 小时')
    }
    return { cron: cron('0', `*/${String(step)}`, '*', '*', '*'), text }
  }

  // `每小时` / `hourly` / `every hour`
  if (/每(?:个)?小时|hourly|every\s+hour/u.test(lower)) {
    return { cron: cron('0', '*', '*', '*', '*'), text }
  }

  // `周末 10 点`
  if (/周末|weekend/u.test(lower)) {
    const time = readTime(text)
    if (time === undefined) throw new Error('请写明时间，例如：周末 10 点')
    return { cron: cron(String(time.minute), String(time.hour), '*', '*', '0,6'), text }
  }

  // `工作日 9 点`
  if (/工作日|weekday/u.test(lower)) {
    const time = readTime(text)
    if (time === undefined) throw new Error('请写明时间，例如：工作日 9 点')
    return { cron: cron(String(time.minute), String(time.hour), '*', '*', '1-5'), text }
  }

  // `每周一 9 点` / `每周一到周五 9 点` / `每周一和周四 8 点`
  const weekly = text.match(/每\s*(?:周|星期|礼拜)\s*(.{0,20})$/u)
  if (weekly !== null) {
    const time = readTime(text)
    if (time === undefined) throw new Error('请写明时间，例如：每周一 9 点')
    const days = readWeekdays(weekly[1] ?? '')
    if (days.length === 0) throw new Error('请写明星期几，例如：每周一 9 点')
    return { cron: cron(String(time.minute), String(time.hour), '*', '*', days.join(',')), text }
  }
  const englishWeekly = lower.match(/every\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)/u)
  if (englishWeekly !== null) {
    const time = readTime(lower)
    if (time === undefined) throw new Error('please name a time, for example: every monday at 9')
    const day = ENGLISH_WEEKDAY[englishWeekly[1] ?? ''] ?? 1
    return { cron: cron(String(time.minute), String(time.hour), '*', '*', String(day)), text }
  }

  // `每月 1 号 9 点` / `monthly on the 1st at 9`
  const monthly = text.match(/每\s*(?:个)?月\s*([0-9]{1,2}|[一二三四五六七八九十]{1,3})\s*[号日]/u)
    ?? lower.match(/monthly\s+on\s+(?:the\s+)?(\d{1,2})/u)
  if (monthly !== null) {
    const day = numberOf(monthly[1] ?? '')
    if (day === undefined || day < 1 || day > 31) throw new Error('日期需要在 1 到 31 之间，例如：每月 1 号 9 点')
    const time = readTime(text)
    if (time === undefined) throw new Error('请写明时间，例如：每月 1 号 9 点')
    return { cron: cron(String(time.minute), String(time.hour), String(day), '*', '*'), text }
  }

  // `每天 9 点` / `每天早上 8 点` / `daily at 9`
  if (/每天|每日|daily|everyday|every\s+day/u.test(lower)) {
    const time = readTime(text)
    if (time === undefined) throw new Error('请写明时间，例如：每天 9 点')
    return { cron: cron(String(time.minute), String(time.hour), '*', '*', '*'), text }
  }

  throw new Error('无法识别这个执行时间，例如：每天 9 点、每小时一次、每周一 9 点、每 30 分钟')
}
