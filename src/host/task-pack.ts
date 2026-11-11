/**
 * 任务包：把 `.share/` 收集成一份结构化 JSON。
 *
 * 每份文件严格两个字段：`path`（目录 + 名字）与 `content`（文本）。
 * 只收 `.share/` 根下三份文件与 `charts/*.mjs`；脚本、缓存留在 `.meta/`，
 * 不随包上传（复现口径是「内容大致一样」）。
 *
 * 组包前先跑 {@link scanFiles}，有 block 级问题直接拒绝，避免把明显坏包
 * 送进上传流程。
 */

import { createHash } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TaskRecord } from '../protocol.js'
import { scanFiles, type ScanFinding, type ScanResult } from '../core/scan.js'
import {
  CHART_EXTENSION,
  SHARE_CHARTS,
  SHARE_DIR,
  SHARE_ROOT_FILES,
  checkSharePath,
  classifySharePath,
  languageOf,
  sharePathOf,
  type ShareKind,
} from '../core/share.js'

/** 任务详情字符上限；与 Host 侧创建任务一致。 */
const MAX_DETAIL_CHARS = 200_000

/** 提交者身份；与 `task-hub` 的请求体一致。 */
export interface TaskSubmitter {
  uid: string
  email: string
  phone: string
  realNameId?: string
}

/** 任务包的默认执行参数。 */
export interface PackageDefaults {
  schedule: string
  timeZone: string
  historyDays: number
  permissionLevel: string
  outputFormat?: string
  newSession: boolean
}

/** 包里的一份文件。 */
export interface ShareFile {
  path: string
  content: string
}

/** 文件摘要。 */
export interface PackageFileInfo {
  path: string
  bytes: number
  sha256: string
  kind: ShareKind
  language: 'markdown' | 'json' | 'javascript' | 'text'
}

/** 包内汇总。 */
export interface PackageTotals {
  count: number
  bytes: number
  executables: number
}

/** 任务包 v2。 */
export interface TaskPackageV2 {
  schemaVersion: 2
  kind: 'atan-daily/task'
  name: string
  summary: string
  tags: string[]
  defaults: PackageDefaults
  files: ShareFile[]
  checks: PackageTotals & { fileCount: number, totalBytes: number, hasExecutable: boolean }
}

/** 组包结果。 */
export interface BuildResult {
  package: TaskPackageV2
  files: PackageFileInfo[]
  totals: PackageTotals
  scan: ScanResult
}

/** 组包失败；`code` 给页面与工具做区分。 */
export class PackError extends Error {
  readonly code: string
  readonly path: string | undefined

  /**
   * @param code - 机器可读的错误码。
   * @param message - 面向用户的说明。
   * @param path - 相关文件路径。
   */
  constructor(code: string, message: string, path?: string) {
    super(message)
    this.name = 'PackError'
    this.code = code
    this.path = path
  }
}

/** 统一换行并去掉 BOM；保留其余内容。 */
export function normalizeShareText(text: string): string {
  return text.replace(/^\uFEFF/u, '').replaceAll(/\r\n?/gu, '\n')
}

/**
 * 读一份 UTF-8 文本；非法字节直接报错，不做替换。
 * @param path - 绝对路径。
 * @param relative - 报错用的相对路径。
 * @returns 文本。
 */
async function readUtf8(path: string, relative: string): Promise<string> {
  const buffer = await readFile(path)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    throw new PackError('invalid_utf8', `${relative} 不是合法的 UTF-8 文本`, relative)
  }
}

/** 判断文件是否存在。 */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile()
  } catch {
    return false
  }
}

/**
 * 收集 `.share/` 下应随包上传的文件。
 * @param folder - 任务目录。
 * @returns 已排序的文件列表。
 */
export async function collectShareFiles(folder: string): Promise<ShareFile[]> {
  const files: ShareFile[] = []
  for (const name of SHARE_ROOT_FILES) {
    const relative = `${SHARE_DIR}/${name}`
    const path = sharePathOf(folder, relative)
    if (!(await isFile(path))) {
      if (name === 'task-display.json') continue
      throw new PackError('missing_file', `缺少 ${relative}`, relative)
    }
    files.push({ path: relative, content: normalizeShareText(await readUtf8(path, relative)) })
  }

  const chartsDir = join(folder, SHARE_DIR, SHARE_CHARTS)
  let entries: Dirent[]
  try {
    entries = await readdir(chartsDir, { withFileTypes: true }) as Dirent[]
  } catch (error: unknown) {
    if ((error as { code?: string }).code === 'ENOENT') entries = []
    else throw new PackError('unreadable_charts', `无法读取 ${SHARE_DIR}/${SHARE_CHARTS}：${String(error)}`)
  }
  for (const entry of entries) {
    // 系统残留文件不参与打包，也不报错。
    if (entry.name.startsWith('.') || entry.name === 'Thumbs.db') continue
    const relative = `${SHARE_DIR}/${SHARE_CHARTS}/${entry.name}`
    if (!entry.isFile()) {
      throw new PackError('invalid_file', `${relative} 不是普通文件`, relative)
    }
    if (!entry.name.endsWith(CHART_EXTENSION)) {
      throw new PackError('invalid_file', `${SHARE_DIR}/${SHARE_CHARTS}/ 只允许 ${CHART_EXTENSION} 文件：${entry.name}`, relative)
    }
    const problem = checkSharePath(relative)
    if (problem !== undefined) throw new PackError(problem.code, problem.message, relative)
    files.push({ path: relative, content: normalizeShareText(await readUtf8(join(chartsDir, entry.name), relative)) })
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return files
}

/**
 * 覆盖详情内容并重新排序。
 * @param files - 收集到的文件。
 * @param details - 用户在页面上编辑中的任务详情；空串表示沿用文件。
 * @returns 规范化后的文件列表。
 */
export function normalizeFiles(files: readonly ShareFile[], details = ''): ShareFile[] {
  const text = details.trim() === '' ? undefined : normalizeShareText(details)
  const normalized = files.map((file) => {
    const path = file.path.replaceAll('\\', '/')
    const content = text !== undefined && path === `${SHARE_DIR}/task-detail.md`
      ? text
      : normalizeShareText(file.content)
    return { path, content }
  })
  normalized.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return normalized
}

/** 计算文件内容的 sha256。 */
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * 组装任务包。
 * @param input.task - 任务记录。
 * @param input.details - 页面上编辑中的任务详情；空串表示沿用文件。
 * @param input.files - 已收集的文件；省略时现读目录。
 * @returns 包、文件摘要与扫描结果。
 * @throws PackError 缺文件、非法编码、校验不通过。
 */
export async function buildTaskPackage(input: {
  task: TaskRecord
  details?: string
  files?: readonly ShareFile[]
}): Promise<BuildResult> {
  const collected = input.files ?? await collectShareFiles(input.task.folder)
  const files = normalizeFiles(collected, input.details ?? '')

  for (const file of files) {
    const problem = checkSharePath(file.path)
    if (problem !== undefined) throw new PackError(problem.code, problem.message, file.path)
  }
  const scan = scanFiles(files)
  if (!scan.ok) {
    const first = scan.findings.find(item => item.severity === 'block')
    throw new PackError(
      'scan_failed',
      first === undefined ? '任务包未通过静态检查' : `${first.path}：${first.message}`,
      first?.path,
    )
  }

  const detail = files.find(file => file.path === `${SHARE_DIR}/task-detail.md`)
  if (detail === undefined) throw new PackError('missing_file', `缺少 ${SHARE_DIR}/task-detail.md`)
  if (detail.content.length > MAX_DETAIL_CHARS) {
    throw new PackError('detail_too_large', `任务详情不能超过 ${String(MAX_DETAIL_CHARS)} 字`, detail.path)
  }

  const schemaFile = files.find(file => file.path === `${SHARE_DIR}/task-schema.json`)
  if (schemaFile === undefined) throw new PackError('missing_file', `缺少 ${SHARE_DIR}/task-schema.json`)
  const schema = parseJsonObject(schemaFile.content, schemaFile.path)
  const properties = schema['properties']
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
    throw new PackError('invalid_schema', '报告 Schema 至少需要一个字段', schemaFile.path)
  }
  if (Object.keys(properties).length === 0) {
    throw new PackError('invalid_schema', '报告 Schema 至少需要一个字段', schemaFile.path)
  }

  const summary = typeof schema['x-summary'] === 'string' ? schema['x-summary'].trim() : ''
  if (summary.length < 8 || summary.length > 60) {
    throw new PackError('invalid_summary', 'Schema 缺少合法的 x-summary（8-60 字），先重新生成契约', schemaFile.path)
  }
  const rawTags = Array.isArray(schema['x-tags']) ? schema['x-tags'] : []
  const tags = rawTags
    .filter((tag): tag is string => typeof tag === 'string')
    .map(tag => tag.trim())
    .filter(Boolean)
    .slice(0, 5)
  if (tags.length === 0) {
    throw new PackError('invalid_tags', 'Schema 缺少 x-tags，先重新生成契约', schemaFile.path)
  }

  const displayFile = files.find(file => file.path === `${SHARE_DIR}/task-display.json`)
  if (displayFile !== undefined) parseJsonObject(displayFile.content, displayFile.path)

  const name = input.task.name.trim()
  if (name.length < 2 || name.length > 200) {
    throw new PackError('invalid_name', '任务名称长度需在 2-200 之间')
  }

  const infos: PackageFileInfo[] = files.map((file) => {
    const info = classifySharePath(file.path)
    return {
      path: file.path,
      bytes: Buffer.byteLength(file.content, 'utf8'),
      sha256: sha256(file.content),
      kind: info?.kind ?? 'detail',
      language: languageOf(file.path),
    }
  })
  const totals: PackageTotals = {
    count: files.length,
    bytes: infos.reduce((sum, file) => sum + file.bytes, 0),
    executables: files.filter(file => file.path.startsWith(`${SHARE_DIR}/${SHARE_CHARTS}/`)).length,
  }

  const taskPackage: TaskPackageV2 = {
    schemaVersion: 2,
    kind: 'atan-daily/task',
    name,
    summary,
    tags,
    defaults: defaultsOf(input.task),
    files,
    checks: {
      ...totals,
      fileCount: totals.count,
      totalBytes: totals.bytes,
      hasExecutable: totals.executables > 0,
    },
  }
  return { package: taskPackage, files: infos, totals, scan }
}

/** 解析一个 JSON 对象文件。 */
function parseJsonObject(text: string, path: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch {
    throw new PackError('invalid_json', `${path} 不是合法 JSON`, path)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PackError('invalid_json', `${path} 必须是 JSON 对象`, path)
  }
  return value as Record<string, unknown>
}

/** 任务默认参数。 */
function defaultsOf(task: TaskRecord): PackageDefaults {
  return {
    schedule: task.scheduleText ?? (task.scheduleMode === 'manual' ? '仅手动' : '每天 09:00'),
    timeZone: task.timeZone,
    historyDays: task.historyDays,
    permissionLevel: task.permissionLevel,
    ...task.outputFormat === undefined ? {} : { outputFormat: task.outputFormat },
    newSession: task.newSession,
  }
}

/** 把扫描结果压成页面/工具要的精简形状。 */
export function scanSummary(scan: ScanResult): { ok: boolean, block: number, warn: number, info: number, findings: ScanFinding[] } {
  return { ok: scan.ok, block: scan.block, warn: scan.warn, info: scan.info, findings: scan.findings }
}
