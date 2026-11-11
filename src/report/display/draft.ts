/**
 * 改动草稿：同一任务只允许一份，落盘在 `.meta/display/draft.json`。
 *
 * 草稿只在 commit/discard 时删除；它不参与正常渲染，也不随任务上传。
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  DisplayChange,
  DisplaySchemaEdit,
  DisplaySpec,
  DisplayVerdict,
} from '../../protocol.js'
import { writeAtomic } from '../../core/fs.js'
import { displayDirOf } from './store.js'

/** 草稿里的一条历史。 */
export interface DraftHistoryEntry {
  at: string
  instruction?: string
  patch: DisplaySpec
  changes: DisplayChange[]
}

/** 草稿基线。 */
export interface DraftBase {
  schemaRevision?: number
  schemaHash: string
  displayHash: string
}

/** 草稿文件。 */
export interface DraftState {
  version: 1
  draftId: string
  taskId: string
  ownerSessionId: string
  base: DraftBase
  display: DisplaySpec
  schemaEdits: DisplaySchemaEdit[]
  verdicts?: DisplayVerdict[]
  history: DraftHistoryEntry[]
  status: 'open'
  createdAt: string
  updatedAt: string
}

/** 草稿文件路径。 */
export function draftFile(folder: string): string {
  return join(displayDirOf(folder), 'draft.json')
}

/** 预览目录。 */
export function draftPreviewDir(folder: string): string {
  return join(displayDirOf(folder), 'draft', 'previews')
}

/** 某个版本的预览图路径。 */
export function previewFile(folder: string, revision: number, blockKey?: string): string {
  const suffix = blockKey === undefined ? '' : `-${blockKey.replaceAll(/[^a-zA-Z0-9#-]/gu, '_')}`
  return join(draftPreviewDir(folder), `rev${String(revision)}${suffix}.png`)
}

/** 某个版本的预览 HTML 路径；与预览图同名同序，便于按版本号对应。 */
export function previewHtmlFile(folder: string, revision: number): string {
  return join(draftPreviewDir(folder), `rev${String(revision)}.html`)
}

/** 文本哈希。 */
export function hashText(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`
}

/**
 * 读取草稿。
 * @param folder - 任务目录。
 * @returns 草稿；不存在或损坏时 undefined 并给出原因。
 */
export async function readDraft(folder: string): Promise<{ draft?: DraftState, error?: string }> {
  let raw: string
  try {
    raw = await readFile(draftFile(folder), 'utf8')
  } catch {
    return {}
  }
  try {
    const parsed = JSON.parse(raw) as DraftState
    if (parsed.version !== 1 || typeof parsed.display !== 'object') {
      return { error: '草稿格式不合法，请 discard 后重开' }
    }
    return { draft: parsed }
  } catch {
    return { error: '草稿不是合法 JSON，请 discard 后重开' }
  }
}

/**
 * 写草稿。
 * @param folder - 任务目录。
 * @param draft - 完整草稿。
 */
export async function writeDraft(folder: string, draft: DraftState): Promise<void> {
  await writeAtomic(draftFile(folder), `${JSON.stringify(draft, null, 2)}\n`)
}

/**
 * 删除草稿与全部预览。
 * @param folder - 任务目录。
 */
export async function deleteDraft(folder: string): Promise<void> {
  await rm(draftFile(folder), { force: true })
  await rm(join(displayDirOf(folder), 'draft'), { recursive: true, force: true })
}

/**
 * 确保预览目录存在。
 * @param folder - 任务目录。
 */
export async function ensurePreviewDir(folder: string): Promise<void> {
  await mkdir(draftPreviewDir(folder), { recursive: true })
}
