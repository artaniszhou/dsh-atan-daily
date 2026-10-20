/**
 * Per-run history records.
 *
 * One run is one JSON file, directly under the task's runs folder:
 *
 *   <task>/meta/runs/<runId>.json
 *
 * The file is written once when the run starts with `status: "running"`, and
 * rewritten atomically when the run finishes. A file still marked running after
 * a Host restart is the crash signal the startup sweep looks for.
 *
 * A record may also sit in a `meta/runs/YYYY-MM/` month subdirectory; listings
 * scan those too, and the retention sweep removes the directory once empty.
 *
 * This module owns the record shape, run ids, reads, and the retention sweep.
 * Writing goes through the Host's atomic writer so Windows rename races are
 * handled in one place.
 */

import { randomUUID } from 'node:crypto'
import { readdir, readFile, rm, rmdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { RunError, RunRecord, RunStatus, RunTrigger } from '../protocol.js'

/** 运行记录的字段与状态来自共享契约，host 侧只做再导出。 */
export type { RunError, RunRecord, RunStatus, RunTrigger } from '../protocol.js'

/** Where run files live inside a task folder. */
const META_DIR = 'meta'
const RUNS_DIR = 'runs'
/** A legacy month subdirectory: `YYYY-MM`. */
const LEGACY_MONTH = /^\d{4}-\d{2}$/u

/** Every status a record may carry; used to reject hand-edited files. */
const STATUSES: readonly RunStatus[] = [
  'running',
  'ok',
  'failed',
  'timeout',
  'cancelled',
  'interrupted',
  'skipped',
]

/**
 * Build a sortable, unique run id.
 *
 * Format: `20261018T010001123Z-7f3a2c`. The timestamp part is UTC and fixed
 * width, so file names sort chronologically; the random suffix avoids a
 * collision when two runs start in the same millisecond.
 * @param at - the instant the run started.
 * @returns the run id.
 */
export function newRunId(at: Date): string {
  const stamp = at.toISOString().replace(/[-:]/gu, '').replace('.', '')
  return `${stamp}-${randomUUID().replace(/-/gu, '').slice(0, 6)}`
}

/**
 * The file a run belongs to.
 * @param taskFolder - absolute task directory.
 * @param runId - the run id.
 * @returns the absolute file path.
 */
export function runFilePath(taskFolder: string, runId: string): string {
  return join(taskFolder, META_DIR, RUNS_DIR, `${runId}.json`)
}

/** The directory holding every run of one task. */
export function runsRootOf(taskFolder: string): string {
  return join(taskFolder, META_DIR, RUNS_DIR)
}

/**
 * Parse one run file, tolerating hand edits and future schema additions.
 * @param file - absolute path.
 * @returns the record, or undefined when the file is unreadable/invalid.
 */
async function readRunFile(file: string): Promise<RunRecord | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const row = parsed as Partial<RunRecord>
    if (row.v !== 1) return undefined
    if (typeof row.runId !== 'string' || row.runId === '') return undefined
    if (typeof row.taskId !== 'string' || row.taskId === '') return undefined
    if (typeof row.startedAt !== 'string' || Number.isNaN(Date.parse(row.startedAt))) return undefined
    if (typeof row.status !== 'string' || !STATUSES.includes(row.status as RunStatus)) return undefined
    return row as RunRecord
  } catch {
    return undefined
  }
}

/** One candidate run file and its base name. */
interface RunFileRef {
  file: string
  name: string
}

/**
 * List every run file of one task, newest name first.
 *
 * New records live directly in `meta/runs/`; a legacy `YYYY-MM/` subdirectory
 * is still scanned so records written before the flattening stay visible.
 * @param taskFolder - absolute task directory.
 * @returns the candidate files, deduplicated by name and sorted newest first.
 */
async function collectRunFiles(taskFolder: string): Promise<RunFileRef[]> {
  const root = runsRootOf(taskFolder)
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const byName = new Map<string, string>()
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.json')) byName.set(entry.name, join(root, entry.name))
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !LEGACY_MONTH.test(entry.name)) continue
    const directory = join(root, entry.name)
    let names: string[]
    try {
      names = (await readdir(directory)).filter(name => name.endsWith('.json'))
    } catch {
      continue
    }
    for (const name of names) {
      if (!byName.has(name)) byName.set(name, join(directory, name))
    }
  }
  return [...byName.entries()]
    .map(([name, file]) => ({ name, file }))
    .sort((left, right) => right.name.localeCompare(left.name))
}

/** The file modification time, or undefined when it cannot be read. */
async function mtimeOf(file: string): Promise<number | undefined> {
  try {
    return (await stat(file)).mtimeMs
  } catch {
    return undefined
  }
}

/** Delete one file, reporting whether it was removed. */
async function removeFile(file: string): Promise<boolean> {
  try {
    await rm(file, { force: true })
    return true
  } catch {
    return false
  }
}

/** Options accepted when reading history. */
export interface RunQuery {
  /** Maximum records to return. */
  limit: number
  /** Only records that started strictly before this ISO instant. */
  before?: string
  /** Only this status. */
  status?: RunStatus
}

/**
 * Read a task's newest runs, newest first.
 *
 * Run ids sort chronologically, so the walk can stop as soon as enough matching
 * records are collected. Legacy month files are included in the same ordering.
 * @param taskFolder - absolute task directory.
 * @param query - limit, optional cursor, optional status filter.
 * @returns the records, newest first.
 */
export async function listRunRecords(
  taskFolder: string,
  query: RunQuery,
): Promise<RunRecord[]> {
  const limit = Math.max(1, Math.min(200, Math.trunc(query.limit)))
  const beforeMs = query.before === undefined ? undefined : Date.parse(query.before)
  const records: RunRecord[] = []
  for (const ref of await collectRunFiles(taskFolder)) {
    const record = await readRunFile(ref.file)
    if (record === undefined) continue
    const startedMs = Date.parse(record.startedAt)
    if (beforeMs !== undefined && Number.isFinite(beforeMs) && startedMs >= beforeMs) continue
    if (query.status !== undefined && record.status !== query.status) continue
    records.push(record)
    if (records.length >= limit && query.status === undefined) break
  }
  records.sort((left, right) =>
    right.startedAt.localeCompare(left.startedAt) || right.runId.localeCompare(left.runId))
  return records.slice(0, limit)
}

/**
 * Read every run started at/after an instant.
 *
 * The startup sweep uses this rather than the UI's page query: a run left
 * `running` can be thousands of records old on a minute-level task, and a
 * 200-record page would miss it.
 * @param taskFolder - absolute task directory.
 * @param sinceMs - epoch milliseconds; 0 means every record.
 * @returns the records, newest first.
 */
export async function listRunsSince(
  taskFolder: string,
  sinceMs: number,
): Promise<RunRecord[]> {
  const records: RunRecord[] = []
  for (const ref of await collectRunFiles(taskFolder)) {
    const namedStarted = startedAtFromRunId(ref.name)
    if (namedStarted !== undefined && namedStarted < sinceMs) continue
    const record = await readRunFile(ref.file)
    if (record === undefined) continue
    if (Date.parse(record.startedAt) < sinceMs) continue
    records.push(record)
  }
  records.sort((left, right) =>
    right.startedAt.localeCompare(left.startedAt) || right.runId.localeCompare(left.runId))
  return records
}

/**
 * Extract the UTC instant encoded in a run id.
 * @param runId - a run id, or any file name.
 * @returns epoch milliseconds, or undefined when the name is not recognizable.
 */
function startedAtFromRunId(runId: string): number | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z-/u.exec(runId)
  if (match === null) return undefined
  return Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
    Number(match[7]),
  )
}

/**
 * Delete run records older than the retention window.
 *
 * Only expired files are removed. A file whose name cannot be parsed falls back
 * to its mtime, so hand-copied records are still eventually cleaned up. A
 * legacy month directory is removed once it is empty; the runs folder itself is
 * never removed.
 * @param taskFolder - absolute task directory.
 * @param retentionDays - keep this many days; <= 0 keeps everything.
 * @param now - current epoch milliseconds, injectable for tests.
 * @returns how many files were removed.
 */
export async function pruneRunRecords(
  taskFolder: string,
  retentionDays: number,
  now = Date.now(),
): Promise<number> {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000
  const root = runsRootOf(taskFolder)
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return 0
  }
  let removed = 0
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const file = join(root, entry.name)
    const started = startedAtFromRunId(entry.name) ?? await mtimeOf(file)
    if (started === undefined || started >= cutoff) continue
    if (await removeFile(file)) removed += 1
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !LEGACY_MONTH.test(entry.name)) continue
    const directory = join(root, entry.name)
    let names: string[]
    try {
      names = (await readdir(directory)).filter(name => name.endsWith('.json'))
    } catch {
      continue
    }
    for (const name of names) {
      const file = join(directory, name)
      const started = startedAtFromRunId(name) ?? await mtimeOf(file)
      if (started === undefined || started >= cutoff) continue
      if (await removeFile(file)) removed += 1
    }
    await rmdir(directory).catch(() => {})
  }
  return removed
}
