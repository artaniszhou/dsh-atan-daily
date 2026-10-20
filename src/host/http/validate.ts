/**
 * HTTP body/query → 领域对象的校验。
 *
 * 所有非法输入在这里变成 `AppError(400)`；路由只拿到已经校验过的值。
 */

import { isKnownTimeZone, parseCron } from '../../core/cron.js'
import { parseScheduleText, type ParsedSchedule } from '../../core/schedule-text.js'
import type { ScheduleMode, TaskMetaPatch } from '../../core/task-list.js'
import { HISTORY_DAYS_MAX, RUN_PAGE_SIZE, type RunStatus, type TaskRecord } from '../../protocol.js'
import { isRunStatus, MAX_DETAIL_LENGTH, MAX_NAME_LENGTH } from '../config.js'
import { AppError } from '../errors.js'

/** 新建任务的已校验输入。 */
export interface CreateInput {
  name: string
  details: string
  schedule: ParsedSchedule | undefined
  timeZone: string
}

/** PATCH 任务的已校验输入。 */
export interface PatchInput {
  patch: TaskMetaPatch
  historyDaysChanged: boolean
}

/** 运行历史查询。 */
export interface RunsQuery {
  limit: number
  before?: string
  status?: RunStatus
}

/**
 * 取一个普通对象。
 * @param value - 原始值。
 * @param what - 错误信息里的名字。
 * @returns 对象。
 */
function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AppError('invalid_input', 400, `${what} must be an object`)
  }
  return value as Record<string, unknown>
}

/**
 * 校验任务名。
 * @param value - 原始 name。
 * @returns 截断后的名称。
 */
function readName(value: unknown): string {
  if (typeof value !== 'string') throw new AppError('invalid_input', 400, 'name is required')
  const name = value.trim().slice(0, MAX_NAME_LENGTH)
  if (name === '') throw new AppError('invalid_input', 400, 'name is required')
  return name
}

/**
 * 校验时区；显式提供但非法时返回 400，而不是静默回退。
 * @param value - 原始 timeZone。
 * @param hostZone - 缺省时使用的 Host 时区。
 * @returns IANA 时区。
 */
function readTimeZone(value: unknown, hostZone: string): string {
  if (value === undefined || value === null) return hostZone
  if (typeof value !== 'string') throw new AppError('invalid_input', 400, 'timeZone must be a string')
  const zone = value.trim()
  if (zone === '') return hostZone
  if (!isKnownTimeZone(zone)) throw new AppError('invalid_input', 400, `unknown time zone: ${zone}`)
  return zone
}

/**
 * 把 `schedule` 输入归一成 schedule patch 所需的字段。
 * @param value - `schedule` 的原始值。
 * @returns 模式与文本/cron。
 */
function readScheduleInput(value: unknown): { mode?: unknown, text?: unknown, cron?: unknown } | undefined {
  if (typeof value === 'string') return { mode: 'text', text: value }
  if (typeof value === 'object' && value !== null) return value as { mode?: unknown, text?: unknown, cron?: unknown }
  return undefined
}

/**
 * 校验新建任务请求。
 * @param payload - 请求体。
 * @param hostZone - Host 时区。
 * @returns 已校验输入。
 */
export function parseCreateBody(payload: unknown, hostZone: string): CreateInput {
  const record = asRecord(payload, 'request body')
  const name = readName(record['name'])
  const details = record['details'] === undefined
    ? ''
    : typeof record['details'] === 'string'
      ? record['details'].slice(0, MAX_DETAIL_LENGTH)
      : (() => { throw new AppError('invalid_input', 400, 'details must be a string') })()
  const timeZone = readTimeZone(record['timeZone'], hostZone)

  let schedule: ParsedSchedule | undefined
  if (record['schedule'] === undefined || record['schedule'] === null) {
    schedule = undefined
  } else if (typeof record['schedule'] !== 'string') {
    throw new AppError('invalid_input', 400, 'schedule must be a string')
  } else {
    try {
      schedule = parseScheduleText(record['schedule'])
    } catch (error: unknown) {
      throw new AppError('invalid_input', 400, error instanceof Error ? error.message : String(error))
    }
  }
  return { name, details, schedule, timeZone }
}

/**
 * 校验 PATCH 任务请求。
 *
 * 只有任务从“仅手动”变成有执行时间时才默认启用；已经停用的任务在编辑
 * 时间/时区/保留天数时保持停用。
 * @param payload - 请求体。
 * @param current - 当前任务。
 * @returns 元数据补丁。
 */
export function parsePatchBody(payload: unknown, current: TaskRecord): PatchInput {
  const record = asRecord(payload, 'request body')
  const patch: TaskMetaPatch = {}
  let historyDaysChanged = false

  if (record['enabled'] !== undefined) {
    if (typeof record['enabled'] !== 'boolean') {
      throw new AppError('invalid_input', 400, 'enabled must be a boolean')
    }
    patch.enabled = record['enabled']
  }

  if (record['sessionId'] !== undefined) {
    if (record['sessionId'] !== null && typeof record['sessionId'] !== 'string') {
      throw new AppError('invalid_input', 400, 'sessionId must be a string or null')
    }
    patch.sessionId = typeof record['sessionId'] === 'string' && record['sessionId'].trim() !== ''
      ? record['sessionId'].trim()
      : null
  }

  if (record['timeZone'] !== undefined) {
    if (typeof record['timeZone'] !== 'string' || !isKnownTimeZone(record['timeZone'].trim())) {
      throw new AppError('invalid_input', 400, 'unknown time zone')
    }
    patch.timeZone = record['timeZone'].trim()
  }

  if (record['historyDays'] !== undefined) {
    const days = record['historyDays']
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 0 || days > HISTORY_DAYS_MAX) {
      throw new AppError('invalid_input', 400, `historyDays must be an integer between 0 and ${String(HISTORY_DAYS_MAX)}`)
    }
    patch.historyDays = days
    historyDaysChanged = true
  }

  let scheduleInput: { mode?: unknown, text?: unknown, cron?: unknown } | undefined
  if (typeof record['schedule'] === 'string') {
    scheduleInput = record['schedule'].trim() === ''
      ? { mode: 'manual' }
      : { mode: 'text', text: record['schedule'] }
  } else if (typeof record['schedule'] === 'object' && record['schedule'] !== null) {
    scheduleInput = readScheduleInput(record['schedule'])
  } else if (record['scheduleMode'] !== undefined) {
    scheduleInput = {
      mode: record['scheduleMode'],
      text: record['scheduleText'],
      cron: record['cron'],
    }
  }

  if (scheduleInput !== undefined) {
    const mode = scheduleInput.mode as ScheduleMode | undefined
    if (mode !== 'text' && mode !== 'cron' && mode !== 'manual') {
      throw new AppError('invalid_input', 400, 'schedule mode must be text, cron, or manual')
    }
    if (mode === 'manual') {
      patch.scheduleMode = 'manual'
      patch.cron = null
      patch.scheduleText = null
      patch.enabled = false
    } else if (mode === 'text') {
      const rawText = typeof scheduleInput.text === 'string' ? scheduleInput.text.trim() : ''
      if (rawText === '') {
        throw new AppError('invalid_input', 400, '请填写执行时间，例如：每天 9 点')
      }
      if (typeof scheduleInput.cron === 'string' && scheduleInput.cron.trim() !== '') {
        throw new AppError('invalid_input', 400, 'text 模式不能同时提交 cron')
      }
      let parsed: ParsedSchedule | undefined
      try {
        parsed = parseScheduleText(rawText)
      } catch (error: unknown) {
        throw new AppError('invalid_input', 400, error instanceof Error ? error.message : String(error))
      }
      if (parsed === undefined) {
        throw new AppError('invalid_input', 400, '无法识别这个执行时间，请换一种说法或使用 cron')
      }
      patch.scheduleMode = 'text'
      patch.scheduleText = rawText
      patch.cron = parsed.cron
      if (patch.enabled === undefined && current.scheduleMode === 'manual') patch.enabled = true
    } else {
      const rawCron = typeof scheduleInput.cron === 'string' ? scheduleInput.cron.trim() : ''
      if (rawCron === '') throw new AppError('invalid_input', 400, '请填写 cron 表达式')
      if (typeof scheduleInput.text === 'string' && scheduleInput.text.trim() !== '') {
        throw new AppError('invalid_input', 400, 'cron 模式不能同时提交执行时间文本')
      }
      try {
        parseCron(rawCron)
      } catch (error: unknown) {
        throw new AppError('invalid_input', 400, `invalid cron: ${error instanceof Error ? error.message : String(error)}`)
      }
      patch.scheduleMode = 'cron'
      patch.cron = rawCron
      patch.scheduleText = null
      if (patch.enabled === undefined && current.scheduleMode === 'manual') patch.enabled = true
    }
  }

  if (Object.keys(patch).length === 0) {
    throw new AppError('invalid_input', 400, 'nothing to update')
  }
  return { patch, historyDaysChanged }
}

/**
 * 校验运行历史查询参数。
 * @param url - 请求 URL。
 * @returns limit、before、status。
 */
export function parseRunsQuery(url: string): RunsQuery {
  const parsed = new URL(url, 'http://atan-daily.invalid')
  const rawLimit = Number(parsed.searchParams.get('limit') ?? String(RUN_PAGE_SIZE))
  if (!Number.isFinite(rawLimit) || rawLimit < 1) {
    throw new AppError('invalid_input', 400, 'limit must be a positive number')
  }
  const before = parsed.searchParams.get('before') ?? undefined
  if (before !== undefined && Number.isNaN(Date.parse(before))) {
    throw new AppError('invalid_input', 400, 'before must be an ISO timestamp')
  }
  const rawStatus = parsed.searchParams.get('status') ?? undefined
  if (rawStatus !== undefined && !isRunStatus(rawStatus)) {
    throw new AppError('invalid_input', 400, 'unknown run status')
  }
  return {
    limit: Math.min(200, Math.trunc(rawLimit)),
    ...before === undefined ? {} : { before },
    ...rawStatus === undefined ? {} : { status: rawStatus as RunStatus },
  }
}
