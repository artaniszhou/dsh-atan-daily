/**
 * 任务仓库的页面侧类型与响应解码。
 *
 * 任务包 v2：`files` 是 `{ path, content }` 数组；包里不含 uid / taskId，
 * 身份只在提交请求体里出现。仓库对外用 `publicId` 访问。
 */
import type { TaskRecord } from '../../protocol.ts'

/** 提交者联系方式；uid 在请求体顶层。 */
export interface TaskHubSubmitter {
  email: string
  phone: string
  realNameId: string
}

/** 包里的一份文件。 */
export interface TaskHubFile {
  path: string
  content: string
}

/** 文件摘要（预览返回）。 */
export interface TaskHubFileInfo {
  path: string
  bytes: number
  sha256: string
  kind: 'detail' | 'schema' | 'display' | 'chart'
  language: 'markdown' | 'json' | 'javascript' | 'text'
}

/** 静态检查结果。 */
export interface TaskHubScanFinding {
  code: string
  severity: 'block' | 'warn' | 'info'
  path: string
  message: string
  line?: number
  evidence?: string
}

export interface TaskHubScan {
  ok: boolean
  block: number
  warn: number
  info: number
  findings: TaskHubScanFinding[]
}

/** 包内汇总。 */
export interface TaskHubTotals {
  count: number
  bytes: number
  executables: number
}

export interface TaskHubPackage {
  schemaVersion: number
  kind: string
  name: string
  summary: string
  tags: string[]
  defaults: {
    schedule: string
    timeZone: string
    historyDays: number
    permissionLevel: string
    outputFormat?: string
    newSession: boolean
  }
  files: TaskHubFile[]
  checks: TaskHubTotals & { fileCount: number, totalBytes: number, hasExecutable: boolean }
}

export interface TaskHubPreview {
  files: TaskHubFileInfo[]
  totals: TaskHubTotals
  scan: TaskHubScan
  package: TaskHubPackage
}

/** 仓库里的一件任务：对外只有 publicId，没有 uid / taskId。 */
export interface TaskHubRemoteTask {
  publicId: string
  name: string
  summary: string
  tags: string[]
  version: number
  loadCount: number
  updatedAt: number
}

export interface TaskHubWarehouse {
  items: TaskHubRemoteTask[]
  total: number
}

/** 任务详情里的任务包。 */
export interface TaskHubDetailPackage {
  schemaVersion: number
  kind: string
  name: string
  summary: string
  tags: string[]
  defaults: TaskHubPackage['defaults']
  files: TaskHubFile[]
  checks?: TaskHubTotals & { fileCount?: number, totalBytes?: number, hasExecutable?: boolean }
}

/** 任务详情的轻量元数据。 */
export interface TaskHubTaskMeta {
  publicId: string
  name: string
  version: number
  updatedAt: number
  loadCount: number
}

export interface TaskHubTaskDetail {
  task: TaskHubDetailPackage
  meta: TaskHubTaskMeta
}

/** 预览 / 提交的入参；`taskId` 是本地任务身份。 */
export interface TaskHubSubmitInput {
  taskId: string
  details: string
}

export interface TaskHubSubmitResult {
  taskId: string
  version: number
  status: string
}

export interface TaskHubLoadInput {
  publicId: string
  name?: string
  schedule?: string
  timeZone?: string
  enabled?: boolean
}

function asRecord(payload: unknown): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('响应必须是对象')
  }
  return payload as Record<string, unknown>
}

function objectOf(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${what} 缺失`)
  }
  return value as Record<string, unknown>
}

function arrayOf<T>(value: unknown, what: string): T[] {
  if (!Array.isArray(value)) throw new Error(`${what} 缺失`)
  return value as T[]
}

function numberOf(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`字段 ${key} 不是数字`)
  return value
}

export function decodeTaskHubPreview(payload: unknown): TaskHubPreview {
  const record = asRecord(payload)
  const files = arrayOf<TaskHubFileInfo>(record['files'], '文件清单')
  const totals = objectOf(record['totals'], '文件汇总') as unknown as TaskHubTotals
  const scan = objectOf(record['scan'], '静态检查') as unknown as TaskHubScan
  const pkg = objectOf(record['package'], '任务包')
  arrayOf<TaskHubFile>(pkg['files'], '任务包文件')
  return {
    files,
    totals,
    scan,
    package: pkg as unknown as TaskHubPackage,
  }
}

export function decodeTaskHubWarehouse(payload: unknown): TaskHubWarehouse {
  const record = asRecord(payload)
  const items = record['items']
  if (!Array.isArray(items)) throw new Error('任务列表缺失')
  return { items: items as TaskHubRemoteTask[], total: Number(record['total'] ?? items.length) }
}

export function decodeTaskHubSubmit(payload: unknown): TaskHubSubmitResult {
  const record = asRecord(payload)
  return {
    taskId: String(record['taskId'] ?? ''),
    version: numberOf(record, 'version'),
    status: String(record['status'] ?? 'checking'),
  }
}

export function decodeTaskHubLoadedTask(payload: unknown): TaskRecord {
  const record = asRecord(payload)
  const task = record['task']
  if (typeof task !== 'object' || task === null) throw new Error('任务缺失')
  return task as TaskRecord
}

export function decodeTaskHubDetail(payload: unknown): TaskHubTaskDetail {
  const record = asRecord(payload)
  const task = objectOf(record['task'], '任务包')
  arrayOf<TaskHubFile>(task['files'], '任务包文件')
  return {
    task: task as unknown as TaskHubDetailPackage,
    meta: objectOf(record['meta'], '任务元数据') as unknown as TaskHubTaskMeta,
  }
}

/** 加载后的本地任务；字段由页面按需读取。 */
type TaskHubLoadedTask = Record<string, unknown>
