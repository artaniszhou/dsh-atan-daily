/**
 * 响应形状的运行时解码。
 *
 * TypeScript 的 `as` 在边界上是假的：Host 少一个字段、把数字写成字符串，
 * 页面会在很远的地方静默出错。这里把边界收在一次解码里，失败就是
 * `invalid-response`，并且能指出是哪个字段。
 *
 * 取舍：手写校验而不是引入 zod，是为了让 client bundle 不增加运行时依赖。
 */
import type {
  Frequency,
  RunRecord,
  RunStatus,
  ScheduleMode,
  SettingsView,
  TaskRecord,
} from '../../protocol.ts'
import { HostError } from './errors.ts'

const FREQUENCIES: readonly Frequency[] = ['daily', 'hourly', 'on-demand']
const RUN_STATUSES: readonly RunStatus[] = ['running', 'ok', 'failed', 'timeout', 'cancelled', 'interrupted', 'skipped']
const SCHEDULE_MODES: readonly ScheduleMode[] = ['text', 'cron', 'manual']

/** 统一的解码失败。 */
function fail(message: string): never {
  throw new HostError('invalid-response', message)
}

/** 取一个对象；不是对象就失败。 */
function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${what} 不是对象`)
  return value as Record<string, unknown>
}

/** 必填字符串。 */
function reqString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string') fail(`字段 ${key} 不是字符串`)
  return value
}

/** 选填字符串。 */
function optString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') fail(`字段 ${key} 不是字符串`)
  return value
}

/** 必填布尔值。 */
function reqBool(record: Record<string, unknown>, key: string): boolean {
  const value = record[key]
  if (typeof value !== 'boolean') fail(`字段 ${key} 不是布尔值`)
  return value
}

/** 选填布尔值。 */
function optBool(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') fail(`字段 ${key} 不是布尔值`)
  return value
}

/** 必填数字。 */
function reqNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`字段 ${key} 不是数字`)
  return value
}

/** 选填数字。 */
function optNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`字段 ${key} 不是数字`)
  return value
}

/** 可空字符串（Host 用 null 表示“没有”）。 */
function nullableString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  if (value === null) return null
  if (typeof value !== 'string') fail(`字段 ${key} 不是字符串或 null`)
  return value
}

/** 可空数字。 */
function nullableNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key]
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`字段 ${key} 不是数字或 null`)
  return value
}

/** 可空布尔值。 */
function nullableBool(record: Record<string, unknown>, key: string): boolean | null {
  const value = record[key]
  if (value === null) return null
  if (typeof value !== 'boolean') fail(`字段 ${key} 不是布尔值或 null`)
  return value
}

/** 必填枚举。 */
function oneOf<T extends string>(record: Record<string, unknown>, key: string, allowed: readonly T[]): T {
  const value = record[key]
  if (typeof value !== 'string' || !allowed.includes(value as T)) fail(`字段 ${key} 不是已知取值`)
  return value as T
}

/** 解码一条运行错误。 */
function decodeRunError(value: unknown): { code: string, message: string } | null {
  if (value === null) return null
  const record = asRecord(value, 'run.error')
  return { code: reqString(record, 'code'), message: reqString(record, 'message') }
}

/**
 * 解码一个任务。
 * @param value - Host 返回的单条任务。
 * @returns 校准后的任务对象。
 */
export function decodeTask(value: unknown): TaskRecord {
  const record = asRecord(value, 'task')
  const task: TaskRecord = {
    id: reqString(record, 'id'),
    name: reqString(record, 'name'),
    details: reqString(record, 'details'),
    frequency: oneOf(record, 'frequency', FREQUENCIES),
    createdAt: reqString(record, 'createdAt'),
    folder: reqString(record, 'folder'),
    historyCount: reqNumber(record, 'historyCount'),
    scheduleMode: oneOf(record, 'scheduleMode', SCHEDULE_MODES),
    timeZone: reqString(record, 'timeZone'),
    enabled: reqBool(record, 'enabled'),
    historyDays: reqNumber(record, 'historyDays'),
  }
  const sessionId = optString(record, 'sessionId')
  if (sessionId !== undefined) task.sessionId = sessionId
  const report = optString(record, 'report')
  if (report !== undefined) task.report = report
  const cron = optString(record, 'cron')
  if (cron !== undefined) task.cron = cron
  const scheduleText = optString(record, 'scheduleText')
  if (scheduleText !== undefined) task.scheduleText = scheduleText
  const lastRunAt = optString(record, 'lastRunAt')
  if (lastRunAt !== undefined) task.lastRunAt = lastRunAt
  const lastStatus = optString(record, 'lastStatus')
  if (lastStatus !== undefined) task.lastStatus = oneOf(record, 'lastStatus', RUN_STATUSES)
  const lastDurationMs = optNumber(record, 'lastDurationMs')
  if (lastDurationMs !== undefined) task.lastDurationMs = lastDurationMs
  const lastRunId = optString(record, 'lastRunId')
  if (lastRunId !== undefined) task.lastRunId = lastRunId
  const lastError = optString(record, 'lastError')
  if (lastError !== undefined) task.lastError = lastError
  const nextRunAt = optString(record, 'nextRunAt')
  if (nextRunAt !== undefined) task.nextRunAt = nextRunAt
  const running = optBool(record, 'running')
  if (running !== undefined) task.running = running
  return task
}

/**
 * 解码一条运行记录。
 * @param value - Host 返回的单条记录。
 * @returns 校准后的记录。
 */
export function decodeRun(value: unknown): RunRecord {
  const record = asRecord(value, 'run')
  if (record.v !== 1) fail('运行记录版本不是 1')
  const reason = optString(record, 'reason')
  return {
    v: 1,
    runId: reqString(record, 'runId'),
    taskId: reqString(record, 'taskId'),
    trigger: oneOf(record, 'trigger', ['schedule', 'manual'] as const),
    catchUp: reqBool(record, 'catchUp'),
    scheduledFor: nullableString(record, 'scheduledFor'),
    startedAt: reqString(record, 'startedAt'),
    finishedAt: nullableString(record, 'finishedAt'),
    status: oneOf(record, 'status', RUN_STATUSES),
    durationMs: nullableNumber(record, 'durationMs'),
    sessionId: nullableString(record, 'sessionId'),
    report: nullableString(record, 'report'),
    reportExists: nullableBool(record, 'reportExists'),
    error: decodeRunError(record.error),
    bootId: reqString(record, 'bootId'),
    plugin: reqString(record, 'plugin'),
    ...(reason === undefined ? {} : { reason }),
  }
}

/**
 * 解码设置视图。
 * @param payload - `GET/PATCH/POST settings` 的响应体。
 * @returns 校准后的设置。
 */
export function decodeSettings(payload: unknown): SettingsView {
  const record = asRecord(payload, 'settings')
  const workspaceRaw = record.workspace
  let workspace: SettingsView['workspace'] = null
  if (workspaceRaw !== null && workspaceRaw !== undefined) {
    const workspaceRecord = asRecord(workspaceRaw, 'settings.workspace')
    workspace = { id: reqString(workspaceRecord, 'id'), title: reqString(workspaceRecord, 'title') }
  }
  const pluginVersion = optString(record, 'pluginVersion')
  const workspaceError = optString(record, 'workspaceError')
  return {
    workDir: reqString(record, 'workDir'),
    defaultWorkDir: reqString(record, 'defaultWorkDir'),
    savedWorkDir: reqString(record, 'savedWorkDir'),
    tasksTotal: reqNumber(record, 'tasksTotal'),
    tasksEnabled: reqNumber(record, 'tasksEnabled'),
    dirExists: reqBool(record, 'dirExists'),
    workspace,
    ...(pluginVersion === undefined ? {} : { pluginVersion }),
    ...(workspaceError === undefined ? {} : { workspaceError }),
  }
}

/** 解码任务列表响应。 */
export function decodeTaskList(payload: unknown): TaskRecord[] {
  const record = asRecord(payload, 'response')
  if (!Array.isArray(record.tasks)) fail('字段 tasks 不是数组')
  return record.tasks.map(decodeTask)
}

/** 解码单任务响应。 */
export function decodeSingleTask(payload: unknown): TaskRecord {
  const record = asRecord(payload, 'response')
  return decodeTask(record.task)
}

/** 解码运行历史响应。 */
export function decodeRunList(payload: unknown): RunRecord[] {
  const record = asRecord(payload, 'response')
  if (!Array.isArray(record.runs)) fail('字段 runs 不是数组')
  return record.runs.map(decodeRun)
}

/** 解码会话 id（可能没有）。 */
export function decodeSessionId(payload: unknown): string | undefined {
  const record = asRecord(payload, 'response')
  return typeof record.sessionId === 'string' && record.sessionId !== '' ? record.sessionId : undefined
}

/** 删除等无内容响应。 */
export function decodeVoid(): void {
  // 有意为空：只要状态码是 2xx，响应体不作要求。
}
