/**
 * The task registry (`task-list.jsonl`).
 *
 * This module is the **only writer** of task metadata. Callers get immutable
 * snapshots and must go through `create` / `patch` / `remove` / `recordRun`;
 * no other module may write the JSONL file directly.
 *
 * v2 stores all task metadata here. `meta/rule.md` is task content only, so an
 * edit to cron/timezone/retention never rewrites the rule document.
 */

import { copyFile, readFile, readdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { parseScheduleText } from './schedule-text.js'
import { isKnownTimeZone } from './cron.js'
import { writeAtomic } from './fs.js'
import {
  CACHE_HEADING,
  parseManifestRows,
  parseLegacyRule,
  SCRIPT_HEADING,
  writeRuleContent,
} from './rule.js'
import type { RunStatus } from './runs.js'

/** The registry file at the working directory's root. */
export const TASK_LIST_FILE = 'task-list.jsonl'
/** The pre-JSONL registry. */
export const LEGACY_TASK_LIST_FILE = 'task-list.md'

/** How a task's execution time is expressed. */
export type ScheduleMode = 'text' | 'cron' | 'manual'

/** All task metadata; this is the v2 JSONL row. */
export interface TaskMeta {
  v: 2
  id: string
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
  scheduleMode?: ScheduleMode
  cron?: string | null
  scheduleText?: string | null
  timeZone?: string
  enabled?: boolean
  historyDays?: number
  pushBotIds?: string[]
  pushEnabled?: boolean
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
  /** Default retention for new/legacy tasks. */
  defaultHistoryDays: number
  /** Diagnostics sink. */
  warn?: (message: string) => void
}

/** A v1 row, read only for migration. */
interface V1Row {
  id?: unknown
  name?: unknown
  schedule?: unknown
  enabled?: unknown
  sessionId?: unknown
  lastRunAt?: unknown
  lastStatus?: unknown
  lastError?: unknown
}

/** The run statuses accepted from legacy data. */
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
 * Whether a string is a single, safe task-folder segment.
 * @param id - candidate id.
 * @returns true when it cannot escape the working directory.
 */
export function isSafeTaskId(id: string): boolean {
  return id !== '' && id !== '.' && id !== '..' && !/[\\/]/u.test(id) && !id.includes('\u0000')
}

/**
 * The host's IANA zone, used when legacy data has none.
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
 * Read task ids out of the legacy Markdown table.
 * @param text - the Markdown registry.
 * @returns ids in document order.
 */
function parseLegacyMarkdown(text: string): string[] {
  const ids: string[] = []
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|')) continue
    const cells = trimmed.replace(/^\|/u, '').replace(/\|$/u, '').split(/(?<!\\)\|/u)
    const first = (cells[0] ?? '').trim()
    if (first === '' || first === '任务目录' || /^-+$/u.test(first)) continue
    const id = first.replace(/^`|`$/gu, '').replace(/\\\|/gu, '|').trim()
    if (isSafeTaskId(id) && !ids.includes(id)) ids.push(id)
  }
  return ids
}

/**
 * Normalize the push target list.
 *
 * Accepts the v2 array, and the earlier single `pushBotId` string so old rows
 * keep their target after the field was widened to a list.
 * @param value - raw field value.
 * @returns unique, trimmed bot ids in their original order.
 */
function normalizeBotIds(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  const ids: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const id = item.trim()
    if (id === '' || !/^[A-Za-z0-9_-]{1,64}$/u.test(id) || ids.includes(id)) continue
    ids.push(id)
  }
  return ids
}

/**
 * Normalize one parsed row, filling defaults for fields introduced in v2.
 * @param row - parsed JSON.
 * @param fallbackHistoryDays - default retention.
 * @returns the normalized meta, or undefined when invalid.
 */
function normalizeRow(
  row: Partial<TaskMeta> & { id?: unknown, v?: unknown },
  fallbackHistoryDays: number,
): TaskMeta | undefined {
  if (row.v !== 2 || typeof row.id !== 'string' || !isSafeTaskId(row.id)) return undefined
  if (typeof row.name !== 'string') return undefined
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
    v: 2,
    id: row.id,
    name: row.name,
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : new Date(0).toISOString(),
    scheduleMode: normalizedMode,
    cron,
    scheduleText: normalizedMode === 'text' ? scheduleText : null,
    timeZone: typeof row.timeZone === 'string' && isKnownTimeZone(row.timeZone) ? row.timeZone : hostTimeZone(),
    enabled: normalizedMode === 'manual' ? false : row.enabled !== false,
    historyDays,
    pushBotIds: normalizeBotIds(row.pushBotIds ?? (row as { pushBotId?: unknown }).pushBotId),
    pushEnabled: row.pushEnabled === true,
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
  private readonly legacyPath: string
  private readonly options: TaskListOptions
  private ready: Promise<void> | undefined
  private queue: Promise<void> = Promise.resolve()

  /**
   * @param workDir - the plugin's working directory.
   * @param options - defaults and diagnostics.
   */
  constructor(private readonly workDir: string, options: TaskListOptions) {
    this.path = join(workDir, TASK_LIST_FILE)
    this.legacyPath = join(workDir, LEGACY_TASK_LIST_FILE)
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
   * Ensure the registry is v2, migrating v1/Markdown when needed.
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
   * @param id - task folder name.
   * @returns the metadata, or undefined.
   */
  async get(id: string): Promise<TaskMeta | undefined> {
    const found = (await this.readAll()).find(meta => meta.id === id)
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
      if (records.some(record => record.id === meta.id)) {
        throw Object.assign(new Error(`task ${meta.id} already exists`), { code: 'EEXIST' })
      }
      await this.writeAll([meta, ...records])
    })
  }

  /**
   * Update one task's metadata.
   * @param id - task id.
   * @param patch - allowed fields.
   * @returns the updated metadata.
   */
  async patch(id: string, patch: TaskMetaPatch): Promise<TaskMeta> {
    await this.ensure()
    return await this.enqueue(async () => {
      const records = await this.readAll()
      const index = records.findIndex(record => record.id === id)
      if (index < 0) throw Object.assign(new Error(`task ${id} not found`), { code: 'ENOENT' })
      const current = records[index]
      if (current === undefined) throw Object.assign(new Error(`task ${id} not found`), { code: 'ENOENT' })
      const updated: TaskMeta = {
        ...current,
        ...patch,
        v: 2,
        id: current.id,
        updatedAt: new Date().toISOString(),
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
   * @param id - task id.
   */
  async remove(id: string): Promise<void> {
    await this.ensure()
    await this.enqueue(async () => {
      const records = await this.readAll()
      await this.writeAll(records.filter(record => record.id !== id))
    })
  }

  /**
   * Write the latest-run summary.
   * @param id - task id.
   * @param summary - run outcome fields.
   */
  async recordRun(id: string, summary: RunSummary): Promise<void> {
    await this.patch(id, {
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
   * @param id - task id.
   * @param sessionId - the session, or null to clear.
   */
  async setSession(id: string, sessionId: string | null): Promise<void> {
    await this.patch(id, { sessionId })
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
          if ((await stat(join(this.workDir, record.id))).isDirectory()) kept.push(record)
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
        const parsed = JSON.parse(trimmed) as Partial<TaskMeta> & { id?: unknown, v?: unknown }
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
   * Detect the current version and migrate.
   */
  private async migrateIfNeeded(): Promise<void> {
    let text = await this.readOptional(this.path)
    // A truncated or unreadable registry can be recovered from the sibling
    // backup written by `writeAll`. An existing *empty* file is a valid v2
    // registry with zero tasks, so it must not resurrect rows from the backup.
    if (text === undefined || (text.trim() !== '' && !this.hasV2Row(text))) {
      const backup = await this.readOptional(`${this.path}.bak`)
      if (backup !== undefined && this.hasV2Row(backup)) {
        await writeAtomic(this.path, backup)
        text = backup
      }
    }
    if (text !== undefined) {
      text = text.replace(/^\uFEFF/u, '')
      if (text.trim() === '') {
        // A valid empty registry: no tasks, and no legacy migration to run.
        await this.backupLegacyMarkdown()
        return
      }
      if (this.hasV2Row(text)) {
        await this.backupLegacyMarkdown()
        return
      }
      await this.migrateFromV1(text)
      return
    }
    let legacyMarkdown: string | undefined
    try {
      legacyMarkdown = await readFile(this.legacyPath, 'utf8')
    } catch {
      legacyMarkdown = undefined
    }
    if (legacyMarkdown !== undefined) {
      await this.migrateFromMarkdown(legacyMarkdown)
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
   * Whether a registry text has at least one v2 row.
   * @param text - registry contents.
   * @returns true when a v2 row is present.
   */
  private hasV2Row(text: string): boolean {
    for (const line of text.split(/\r?\n/u)) {
      if (line.trim() === '') continue
      try {
        if ((JSON.parse(line) as { v?: unknown }).v === 2) return true
      } catch {
        // A malformed line is skipped; a later v2 row can still identify the file.
      }
    }
    return false
  }

  /**
   * Migrate a v1 JSONL registry (snapshots only) using rules for real metadata.
   * @param text - current v1 file.
   */
  private async migrateFromV1(text: string): Promise<void> {
    const v1 = new Map<string, V1Row>()
    for (const line of text.split(/\r?\n/u)) {
      if (line.trim() === '') continue
      try {
        const row = JSON.parse(line) as V1Row
        if (typeof row.id === 'string' && isSafeTaskId(row.id)) v1.set(row.id, row)
      } catch {
        // A malformed v1 row is skipped; folder scanning below can still find it.
      }
    }
    const ids = [...v1.keys()]
    const metas: TaskMeta[] = []
    for (const id of ids.length > 0 ? ids : await this.scanFolderIds()) {
      const meta = await this.buildLegacyMeta(id, v1.get(id))
      if (meta !== undefined) metas.push(meta)
    }
    await this.commitMigration(metas, `${this.path}.v1.bak`)
    await this.backupLegacyMarkdown()
    await this.cleanupLegacyRules(metas.map(meta => meta.id))
  }

  /**
   * Migrate the Markdown registry.
   * @param text - old `task-list.md`.
   */
  private async migrateFromMarkdown(text: string): Promise<void> {
    const ids = parseLegacyMarkdown(text)
    const list = ids.length > 0 ? ids : await this.scanFolderIds()
    const metas: TaskMeta[] = []
    for (const id of list) {
      const meta = await this.buildLegacyMeta(id)
      if (meta !== undefined) metas.push(meta)
    }
    await this.commitMigration(metas)
    await this.backupLegacyMarkdown()
    await this.cleanupLegacyRules(metas.map(meta => meta.id))
  }

  /**
   * Rebuild from folders when no registry exists.
   */
  private async rebuildFromFolders(): Promise<void> {
    const metas: TaskMeta[] = []
    for (const id of await this.scanFolderIds()) {
      const meta = await this.buildLegacyMeta(id)
      if (meta !== undefined) metas.push(meta)
    }
    await this.commitMigration(metas)
    await this.cleanupLegacyRules(metas.map(meta => meta.id))
  }

  /**
   * Write the migrated registry and back up the old one.
   * @param metas - v2 records.
   * @param backup - optional explicit backup source.
   */
  private async commitMigration(metas: readonly TaskMeta[], backup?: string): Promise<void> {
    if (backup !== undefined) await copyFile(this.path, backup).catch(() => {})
    const text = metas.map(meta => JSON.stringify(meta)).join('\n') + (metas.length === 0 ? '' : '\n')
    await writeAtomic(this.path, text)
  }

  /**
   * Build one v2 meta from a legacy rule and optional v1 row.
   * @param id - task id.
   * @param row - v1 snapshot, if any.
   * @returns the meta, or undefined when the folder is gone.
   */
  private async buildLegacyMeta(id: string, row?: V1Row): Promise<TaskMeta | undefined> {
    const folder = join(this.workDir, id)
    let birth: string
    try {
      birth = (await stat(folder)).birthtime.toISOString()
    } catch {
      return undefined
    }
    let text = ''
    try {
      text = await readFile(join(folder, 'meta', 'rule.md'), 'utf8')
    } catch {
      // A folder without a rule is still registered, with empty details.
    }
    const legacy = parseLegacyRule(text, id, birth)
    const fallbackName = typeof row?.name === 'string' ? row.name : id
    const fallbackSchedule = typeof row?.schedule === 'string' ? row.schedule : undefined
    const fallbackLastError = typeof row?.lastError === 'string' ? row.lastError : undefined
    const legacyLastRun = legacy.lastRunAt ?? (typeof row?.lastRunAt === 'string' ? row.lastRunAt : undefined)
    const legacyLastError = legacy.lastError ?? fallbackLastError
    const rowStatus = typeof row?.lastStatus === 'string' ? row.lastStatus : undefined
    const fallbackStatus = isRunStatus(rowStatus) ? rowStatus : undefined

    let scheduleText = legacy.scheduleText ?? null
    let cron = legacy.cron ?? null
    let mode: ScheduleMode = legacy.hasMetadata
      ? (scheduleText !== null ? 'text' : cron !== null ? 'cron' : 'manual')
      : 'manual'
    if (!legacy.hasMetadata && fallbackSchedule !== undefined && fallbackSchedule !== '') {
      // v1 snapshots did not store cron separately; try the old text as a
      // best-effort recovery, using the host zone.
      const parsed = parseScheduleText(fallbackSchedule)
      if (parsed === undefined) {
        scheduleText = null
        mode = 'manual'
      } else {
        scheduleText = fallbackSchedule
        cron = parsed.cron
        mode = 'text'
      }
    }
    if (scheduleText !== null && cron === null) {
      const parsed = parseScheduleText(scheduleText)
      if (parsed === undefined) {
        scheduleText = null
        mode = 'manual'
      } else {
        cron = parsed.cron
        mode = 'text'
      }
    }
    const lastStatus = isRunStatus(legacy.lastStatus)
      ? legacy.lastStatus
      : fallbackStatus ?? (legacyLastRun === undefined ? null : legacyLastError === undefined ? 'ok' : 'failed')
    return {
      v: 2,
      id,
      name: legacy.name ?? fallbackName,
      createdAt: legacy.createdAt ?? birth,
      scheduleMode: mode,
      cron,
      scheduleText: mode === 'text' ? scheduleText : null,
      timeZone: legacy.timeZone !== undefined && isKnownTimeZone(legacy.timeZone)
        ? legacy.timeZone
        : hostTimeZone(),
      enabled: mode === 'manual'
        ? false
        : legacy.hasMetadata
          ? legacy.enabled === true
          : row?.enabled !== false,
      historyDays: this.options.defaultHistoryDays,
      pushBotIds: [],
      pushEnabled: false,
      sessionId: legacy.sessionId ?? (typeof row?.sessionId === 'string' ? row.sessionId : null),
      lastRunAt: legacyLastRun ?? null,
      lastStatus,
      lastDurationMs: legacy.lastDurationMs ?? null,
      lastRunId: legacy.lastRunId ?? null,
      lastError: legacy.lastError ?? fallbackLastError ?? null,
      updatedAt: new Date().toISOString(),
    }
  }

  /**
   * Rewrite migrated legacy rules as content-only, keeping a backup.
   * @param ids - task ids to clean.
   */
  private async cleanupLegacyRules(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      const folder = join(this.workDir, id)
      let text: string
      try {
        text = await readFile(join(folder, 'meta', 'rule.md'), 'utf8')
      } catch {
        continue
      }
      if (!text.trimStart().startsWith('---')) continue
      const legacy = parseLegacyRule(text, id, new Date().toISOString())
      try {
        await copyFile(join(folder, 'meta', 'rule.md'), join(folder, 'meta', 'rule.md.v1.bak')).catch(() => {})
        await writeRuleContent(
          folder,
          legacy.details,
          parseManifestRows(text, CACHE_HEADING),
          parseManifestRows(text, SCRIPT_HEADING),
        )
      } catch (error: unknown) {
        this.options.warn?.(`could not rewrite ${id}/meta/rule.md: ${String(error)}`)
      }
    }
  }

  /**
   * Move the legacy Markdown registry out of the way, keeping a backup.
   */
  private async backupLegacyMarkdown(): Promise<void> {
    try {
      await stat(this.legacyPath)
    } catch {
      return
    }
    try {
      await rename(this.legacyPath, `${this.legacyPath}.bak`)
    } catch {
      await rename(this.legacyPath, `${this.legacyPath}.bak-${Date.now()}`).catch(() => {})
    }
  }

  /**
   * List folders that contain a `meta/rule.md`.
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
        await stat(join(this.workDir, entry.name, 'meta', 'rule.md'))
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
