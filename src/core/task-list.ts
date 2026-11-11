/**
 * The task registry (`task-list.jsonl`).
 *
 * This module is the **only writer** of task metadata. Callers get immutable
 * snapshots and must go through `create` / `patch` / `remove` / `recordRun`;
 * no other module may write the JSONL file directly.
 *
 * v3 stores all task metadata here. Task content lives in `task-detail.md` and
 * `.meta/index.md` is a separate document, so an edit to cron/timezone/retention
 * never rewrites either document.
 *
 * 身份与路径分开：`taskId` 是主键（UUID，改名不变），`folder` 是目录名（可变）。
 * 用户改名时目录可以跟着变，而主键、运行记录与会话归属都不受影响。
 */

import { randomUUID } from 'node:crypto'
import { copyFile, readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  DEFAULT_OUTPUT_FORMAT,
  DEFAULT_PERMISSION_LEVEL,
  type OutputFormat,
  type PermissionLevel,
} from '../protocol.js'
import { isKnownTimeZone } from './cron.js'
import { writeAtomic } from './fs.js'
import { SHARE_DIR, TASK_DETAIL_NAME, taskStateDir } from './documents.js'
import type { RunStatus } from './runs.js'

/** The registry file at the working directory's root. */
export const TASK_LIST_FILE = 'task-list.jsonl'

/** How a task's execution time is expressed. */
export type ScheduleMode = 'text' | 'cron' | 'manual'

/** All task metadata; this is the v3 JSONL row. */
export interface TaskMeta {
  v: 3
  /** 任务身份（UUID），创建时生成、改名不变；上传时作为链身份。 */
  taskId: string
  /** 任务目录名，可变；所有文件寻址只认它。 */
  folder: string
  name: string
  createdAt: string
  scheduleMode: ScheduleMode
  cron: string | null
  scheduleText: string | null
  timeZone: string
  enabled: boolean
  historyDays: number
  /** 运行成功后把报告发到哪些 IM 机器人；空数组表示没有目标。 */
  pushBotIds: string[]
  /** 推送开关：关掉保留目标但暂停发送。 */
  pushEnabled: boolean
  /** 每次运行是否新建会话；默认 true。关掉后复用上一次会话。 */
  newSession: boolean
  /** 运行会话的权限级别，见 `PermissionLevel`；默认工作区内修改。 */
  permissionLevel: PermissionLevel
  /** 最终文档格式；默认 PNG。 */
  outputFormat: OutputFormat
  sessionId: string | null
  lastRunAt: string | null
  lastStatus: RunStatus | null
  lastDurationMs: number | null
  lastRunId: string | null
  lastError: string | null
  updatedAt: string
}

/** Fields an edit or a run summary may change. */
export interface TaskMetaPatch {
  name?: string
  /** 新目录名；写回前由调用方完成 `fs.rename`。 */
  folder?: string
  scheduleMode?: ScheduleMode
  cron?: string | null
  scheduleText?: string | null
  timeZone?: string
  enabled?: boolean
  historyDays?: number
  pushBotIds?: string[]
  pushEnabled?: boolean
  newSession?: boolean
  permissionLevel?: PermissionLevel
  outputFormat?: OutputFormat
  sessionId?: string | null
  lastRunAt?: string | null
  lastStatus?: RunStatus | null
  lastDurationMs?: number | null
  lastRunId?: string | null
  lastError?: string | null
}

/** The latest-run summary written by the executor. */
export interface RunSummary {
  sessionId?: string | null
  lastRunAt: string
  lastStatus: RunStatus
  lastDurationMs: number
  lastRunId: string
  lastError?: string | null
}

/** Store options. */
export interface TaskListOptions {
  /** Default retention for tasks created without one. */
  defaultHistoryDays: number
  /** Diagnostics sink. */
  warn?: (message: string) => void
}

/** The run statuses a stored row may carry. */
const RUN_STATUSES: readonly RunStatus[] = [
  'running',
  'ok',
  'failed',
  'timeout',
  'cancelled',
  'interrupted',
  'skipped',
]

/**
 * Whether a string is a single, safe task segment.
 *
 * 同时用于 `taskId` 与 `folder`：两者最终都会进 URL 或路径，任何能跳出工作目录
 * 的取值都要在入口挡掉。
 * @param id - candidate id.
 * @returns true when it cannot escape the working directory.
 */
export function isSafeTaskId(id: string): boolean {
  return id !== '' && id !== '.' && id !== '..' && !/[\\/]/u.test(id) && !id.includes('\u0000')
}

/**
 * The host's IANA zone, used for new tasks.
 * @returns an IANA zone name.
 */
function hostTimeZone(): string {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return 'UTC'
  }
}

/**
 * Whether a stored status is one this build understands.
 * @param value - raw status.
 * @returns true when it is a known status.
 */
function isRunStatus(value: string | undefined): value is RunStatus {
  return value !== undefined && RUN_STATUSES.includes(value as RunStatus)
}

/**
 * Normalize the push target list.
 * @param value - raw field value.
 * @returns unique, trimmed bot ids in their original order.
 */
function normalizeBotIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const ids: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const id = item.trim()
    if (id === '' || !/^[A-Za-z0-9_-]{1,64}$/u.test(id) || ids.includes(id)) continue
    ids.push(id)
  }
  return ids
}

/**
 * Whether a value is one of the two known permission presets.
 * @param value - raw field value.
 * @returns true when it is a known preset name.
 */
function isPermissionLevel(value: unknown): value is PermissionLevel {
  return value === 'workspace-write' || value === 'danger-full-access'
}

/**
 * Normalize one parsed row.
 * @param row - parsed JSON.
 * @param fallbackHistoryDays - default retention.
 * @returns the normalized meta, or undefined when invalid.
 */
function normalizeRow(
  row: Partial<TaskMeta> & { taskId?: unknown, v?: unknown },
  fallbackHistoryDays: number,
): TaskMeta | undefined {
  if (row.v !== 3 || typeof row.taskId !== 'string' || !isSafeTaskId(row.taskId)) return undefined
  if (typeof row.folder !== 'string' || !isSafeTaskId(row.folder)) return undefined
  if (typeof row.name !== 'string') return undefined
  if (!Array.isArray(row.pushBotIds)) return undefined
  if (typeof row.newSession !== 'boolean') return undefined
  if (!isPermissionLevel(row.permissionLevel)) return undefined
  const outputFormat: OutputFormat = row.outputFormat === 'pdf' || row.outputFormat === 'png'
    ? row.outputFormat
    : DEFAULT_OUTPUT_FORMAT
  const mode: ScheduleMode = row.scheduleMode === 'text' || row.scheduleMode === 'cron' || row.scheduleMode === 'manual'
    ? row.scheduleMode
    : 'manual'
  const rawCron = typeof row.cron === 'string' && row.cron !== '' ? row.cron : null
  const rawScheduleText = typeof row.scheduleText === 'string' && row.scheduleText !== '' ? row.scheduleText : null
  const historyDays = typeof row.historyDays === 'number' && Number.isInteger(row.historyDays) && row.historyDays >= 0
    ? row.historyDays
    : fallbackHistoryDays
  // A manual row cannot carry a schedule; a scheduled row must carry a cron.
  const normalizedMode: ScheduleMode = rawCron === null || mode === 'manual' ? 'manual' : mode
  const cron = normalizedMode === 'manual' ? null : rawCron
  const scheduleText = normalizedMode === 'text' ? rawScheduleText : null
  return {
    v: 3,
    taskId: row.taskId,
    folder: row.folder,
    name: row.name,
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : new Date(0).toISOString(),
    scheduleMode: normalizedMode,
    cron,
    scheduleText: normalizedMode === 'text' ? scheduleText : null,
    timeZone: typeof row.timeZone === 'string' && isKnownTimeZone(row.timeZone) ? row.timeZone : hostTimeZone(),
    enabled: normalizedMode === 'manual' ? false : row.enabled !== false,
    historyDays,
    pushBotIds: normalizeBotIds(row.pushBotIds),
    pushEnabled: row.pushEnabled === true,
    newSession: row.newSession,
    permissionLevel: row.permissionLevel,
    outputFormat,
    sessionId: typeof row.sessionId === 'string' ? row.sessionId : null,
    lastRunAt: typeof row.lastRunAt === 'string' ? row.lastRunAt : null,
    lastStatus: typeof row.lastStatus === 'string' && isRunStatus(row.lastStatus) ? row.lastStatus : null,
    lastDurationMs: typeof row.lastDurationMs === 'number' && Number.isFinite(row.lastDurationMs)
      ? row.lastDurationMs
      : null,
    lastRunId: typeof row.lastRunId === 'string' ? row.lastRunId : null,
    lastError: typeof row.lastError === 'string' ? row.lastError : null,
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : new Date().toISOString(),
  }
}

/**
 * The registry store for one working directory.
 */
export class TaskListStore {
  private readonly path: string
  private readonly options: TaskListOptions
  private ready: Promise<void> | undefined
  private queue: Promise<void> = Promise.resolve()

  /**
   * @param workDir - the plugin's working directory.
   * @param options - defaults and diagnostics.
   */
  constructor(private readonly workDir: string, options: TaskListOptions) {
    this.path = join(taskStateDir(workDir), TASK_LIST_FILE)
    this.options = {
      defaultHistoryDays: Number.isFinite(options.defaultHistoryDays) && options.defaultHistoryDays >= 0
        ? options.defaultHistoryDays
        : 7,
      ...options.warn === undefined ? {} : { warn: options.warn },
    }
  }

  /** The registry file path. */
  get filePath(): string {
    return this.path
  }

  /**
   * Ensure the registry file is present and readable.
   * @returns a promise resolved when the registry is usable.
   */
  async ensure(): Promise<void> {
    if (this.ready === undefined) {
      this.ready = this.migrateIfNeeded().catch((error: unknown) => {
        // A transient failure (permissions, a locked file, a disk hiccup) must
        // not poison the store for the rest of the process.
        this.ready = undefined
        throw error
      })
    }
    await this.ready
  }

  /**
   * List all task metadata.
   *
   * Reads are deliberately side-effect free: a missing working directory is an
   * empty task list, not a reason to create files. Writes go through
   * {@link ensure}.
   * @returns metadata snapshots in file order.
   */
  async list(): Promise<TaskMeta[]> {
    return (await this.readAll()).map(meta => ({ ...meta }))
  }

  /**
   * Read one task's metadata.
   * @param taskId - task identity.
   * @returns the metadata, or undefined.
   */
  async get(taskId: string): Promise<TaskMeta | undefined> {
    const found = (await this.readAll()).find(meta => meta.taskId === taskId)
    return found === undefined ? undefined : { ...found }
  }

  /**
   * Add one task. The task folder must already exist.
   * @param meta - metadata to store.
   */
  async create(meta: TaskMeta): Promise<void> {
    await this.ensure()
    await this.enqueue(async () => {
      const records = await this.readAll()
      if (records.some(record => record.taskId === meta.taskId)) {
        throw Object.assign(new Error(`task ${meta.taskId} already exists`), { code: 'EEXIST' })
      }
      if (records.some(record => record.folder === meta.folder)) {
        throw Object.assign(new Error(`folder ${meta.folder} already exists`), { code: 'EEXIST' })
      }
      await this.writeAll([meta, ...records])
    })
  }

  /**
   * Update one task's metadata.
   * @param taskId - task identity.
   * @param patch - allowed fields.
   * @returns the updated metadata.
   */
  async patch(taskId: string, patch: TaskMetaPatch): Promise<TaskMeta> {
    await this.ensure()
    return await this.enqueue(async () => {
      const records = await this.readAll()
      const index = records.findIndex(record => record.taskId === taskId)
      if (index < 0) throw Object.assign(new Error(`task ${taskId} not found`), { code: 'ENOENT' })
      const current = records[index]
      if (current === undefined) throw Object.assign(new Error(`task ${taskId} not found`), { code: 'ENOENT' })
      const updated: TaskMeta = {
        ...current,
        ...patch,
        v: 3,
        taskId: current.taskId,
        updatedAt: new Date().toISOString(),
      }
      // 目录名是路径输入，不能只靠 create 时的校验：改名同样会写它。
      if (!isSafeTaskId(updated.folder)) {
        throw Object.assign(new Error(`invalid folder: ${updated.folder}`), { code: 'EINVAL' })
      }
      if (records.some(record => record.taskId !== taskId && record.folder === updated.folder)) {
        throw Object.assign(new Error(`folder ${updated.folder} already exists`), { code: 'EEXIST' })
      }
      if (updated.scheduleMode === 'manual') {
        updated.cron = null
        updated.scheduleText = null
        updated.enabled = false
      } else if (updated.scheduleMode === 'cron') {
        updated.scheduleText = null
      }
      if (updated.scheduleMode !== 'manual' && updated.cron === null) {
        throw new Error('a scheduled task needs a cron expression')
      }
      if (updated.scheduleMode === 'text' && (updated.scheduleText === null || updated.cron === null)) {
        throw new Error('a text schedule needs both text and a normalized cron')
      }
      const next = records.slice()
      next[index] = updated
      await this.writeAll(next)
      return { ...updated }
    })
  }

  /**
   * Remove one task row. The folder is the caller's responsibility.
   * @param taskId - task identity.
   */
  async remove(taskId: string): Promise<void> {
    await this.ensure()
    await this.enqueue(async () => {
      const records = await this.readAll()
      await this.writeAll(records.filter(record => record.taskId !== taskId))
    })
  }

  /**
   * Write the latest-run summary.
   * @param taskId - task identity.
   * @param summary - run outcome fields.
   */
  async recordRun(taskId: string, summary: RunSummary): Promise<void> {
    await this.patch(taskId, {
      ...summary.sessionId === undefined ? {} : { sessionId: summary.sessionId },
      lastRunAt: summary.lastRunAt,
      lastStatus: summary.lastStatus,
      lastDurationMs: summary.lastDurationMs,
      lastRunId: summary.lastRunId,
      lastError: summary.lastError ?? null,
    })
  }

  /**
   * Point the task at its latest session.
   * @param taskId - task identity.
   * @param sessionId - the session, or null to clear.
   */
  async setSession(taskId: string, sessionId: string | null): Promise<void> {
    await this.patch(taskId, { sessionId })
  }

  /**
   * Remove rows whose task folder no longer exists.
   */
  async pruneMissingFolders(): Promise<void> {
    await this.ensure()
    await this.enqueue(async () => {
      const records = await this.readAll()
      const kept: TaskMeta[] = []
      for (const record of records) {
        try {
          if ((await stat(join(this.workDir, record.folder))).isDirectory()) kept.push(record)
        } catch (error: unknown) {
          // Drop only a genuinely missing folder; a permission/transient error
          // must not silently remove the task from the registry.
          if ((error as { code?: string }).code === 'ENOENT') continue
          kept.push(record)
        }
      }
      if (kept.length !== records.length) await this.writeAll(kept)
    })
  }

  /**
   * Serialize one read-modify-write operation.
   * @param operation - the operation.
   * @returns its result.
   */
  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation)
    this.queue = run.then(() => undefined, () => undefined)
    return await run
  }

  /**
   * Read and parse the current JSONL file.
   * @returns valid rows.
   */
  private async readAll(): Promise<TaskMeta[]> {
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch (error: unknown) {
      // "No registry yet" and "the registry cannot be read" are different:
      // treating a permission/lock error as "no tasks" lets a later write
      // replace every row with just the new one.
      if ((error as { code?: string }).code === 'ENOENT') return []
      throw error
    }
    text = text.replace(/^\uFEFF/u, '')
    const records: TaskMeta[] = []
    for (const line of text.split(/\r?\n/u)) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      try {
        const parsed = JSON.parse(trimmed) as Partial<TaskMeta> & { taskId?: unknown, v?: unknown }
        const meta = normalizeRow(parsed, this.options.defaultHistoryDays)
        if (meta === undefined) {
          this.options.warn?.(`ignoring an invalid task row in ${this.path}`)
          continue
        }
        records.push(meta)
      } catch {
        this.options.warn?.(`ignoring a malformed line in ${this.path}`)
      }
    }
    return records
  }

  /**
   * Back up and atomically replace the registry.
   * @param records - complete new contents.
   */
  private async writeAll(records: readonly TaskMeta[]): Promise<void> {
    await copyFile(this.path, `${this.path}.bak`).catch(() => {})
    const text = records.map(record => JSON.stringify(record)).join('\n') + (records.length === 0 ? '' : '\n')
    await writeAtomic(this.path, text)
  }

  /**
   * Make sure the registry file exists: restore it from the sibling backup, or
   * rebuild it from the task folders that carry `task-detail.md`.
   */
  private async migrateIfNeeded(): Promise<void> {
    const text = await this.readOptional(this.path)
    if (text !== undefined) {
      const body = text.replace(/^\uFEFF/u, '')
      // An existing *empty* file is a valid registry with zero tasks.
      if (body.trim() === '' || this.hasV3Row(body)) return
    }
    // The registry is missing or holds rows this build cannot read. Prefer the
    // backup `writeAll` keeps beside it; otherwise rebuild from the folders.
    const backup = await this.readOptional(`${this.path}.bak`)
    if (backup !== undefined && this.hasV3Row(backup)) {
      await writeAtomic(this.path, backup)
      return
    }
    await this.rebuildFromFolders()
  }

  /**
   * Read a text file, treating only ENOENT as absent.
   * @param path - file to read.
   * @returns its text, or undefined when it does not exist.
   */
  private async readOptional(path: string): Promise<string | undefined> {
    try {
      return await readFile(path, 'utf8')
    } catch (error: unknown) {
      if ((error as { code?: string }).code === 'ENOENT') return undefined
      throw error
    }
  }

  /**
   * Whether a registry text has at least one v3 row.
   * @param text - registry contents.
   * @returns true when a v3 row is present.
   */
  private hasV3Row(text: string): boolean {
    for (const line of text.split(/\r?\n/u)) {
      if (line.trim() === '') continue
      try {
        if ((JSON.parse(line) as { v?: unknown }).v === 3) return true
      } catch {
        // A malformed line is skipped; a later v3 row can still identify the file.
      }
    }
    return false
  }

  /**
   * Rebuild the registry from the task folders.
   *
   * Only folders that carry `task-detail.md` count; each starts as a manual,
   * disabled task, so nothing runs until the user sets a time.
   */
  private async rebuildFromFolders(): Promise<void> {
    const metas: TaskMeta[] = []
    for (const id of await this.scanFolderIds()) {
      const meta = await this.buildFolderMeta(id)
      if (meta !== undefined) metas.push(meta)
    }
    const text = metas.map(meta => JSON.stringify(meta)).join('\n') + (metas.length === 0 ? '' : '\n')
    await writeAtomic(this.path, text)
  }

  /**
   * Build default metadata for a task found on disk.
   * @param id - task folder name.
   * @returns the meta, or undefined when the folder is gone.
   */
  private async buildFolderMeta(id: string): Promise<TaskMeta | undefined> {
    const folder = join(this.workDir, id)
    let birth: string
    try {
      birth = (await stat(folder)).birthtime.toISOString()
    } catch {
      return undefined
    }
    return {
      v: 3,
      taskId: randomUUID(),
      folder: id,
      name: id,
      createdAt: birth,
      scheduleMode: 'manual',
      cron: null,
      scheduleText: null,
      timeZone: hostTimeZone(),
      enabled: false,
      historyDays: this.options.defaultHistoryDays,
      pushBotIds: [],
      pushEnabled: false,
      newSession: true,
      permissionLevel: DEFAULT_PERMISSION_LEVEL,
      outputFormat: DEFAULT_OUTPUT_FORMAT,
      sessionId: null,
      lastRunAt: null,
      lastStatus: null,
      lastDurationMs: null,
      lastRunId: null,
      lastError: null,
      updatedAt: new Date().toISOString(),
    }
  }

  /**
   * List folders that carry `task-detail.md`.
   * @returns task ids.
   */
  private async scanFolderIds(): Promise<string[]> {
    let entries
    try {
      entries = await readdir(this.workDir, { withFileTypes: true })
    } catch {
      return []
    }
    const ids: string[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !isSafeTaskId(entry.name)) continue
      try {
        await stat(join(this.workDir, entry.name, SHARE_DIR, TASK_DETAIL_NAME))
        ids.push(entry.name)
      } catch {
        // Not a task folder.
      }
    }
    return ids
  }
}

/**
 * Render one task as JSONL for tests and diagnostics.
 * @param meta - the metadata.
 * @returns one JSON line.
 */
export function renderTaskMeta(meta: TaskMeta): string {
  return JSON.stringify(meta)
}

/**
 * Render a complete registry for tests.
 * @param metas - records.
 * @returns JSONL text.
 */
export function renderTaskList(metas: readonly TaskMeta[]): string {
  return metas.map(renderTaskMeta).join('\n') + (metas.length === 0 ? '' : '\n')
}
