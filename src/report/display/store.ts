/**
 * 展示覆盖的落盘：读取与稀疏写入。
 *
 * 覆盖文件在 `.share/`（随任务上传），草稿在 `.meta/display/`（只在本机）。
 * 写入永远走原子替换：写坏一个样式文件不该让下一轮出不了报告。
 */

import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { writeAtomic } from '../../core/fs.js'
import { metaDirOf } from '../../core/documents.js'
import type { DisplaySpec } from './spec.js'
import { DISPLAY_FILE, parseDisplay } from './spec.js'

/** 草稿目录（`.meta/display`）。 */
export function displayDirOf(folder: string): string {
  return join(metaDirOf(folder), 'display')
}

/** 覆盖文件（`.share/task-display.json`）。 */
export function displayFileOf(folder: string): string {
  return join(folder, '.share', DISPLAY_FILE)
}

/** 读取结果。 */
export interface DisplayState {
  /** 是否存在文件。 */
  present: boolean
  /** 解析成功时的规格。 */
  spec?: DisplaySpec
  /** 原文，用于哈希。 */
  raw?: string
  /** 解析与校验提示。 */
  warnings: string[]
}

/**
 * 读取覆盖文件。
 * @param folder - 任务目录。
 * @returns 状态；文件不存在时 `present: false`，不是错误。
 */
export async function readDisplay(folder: string): Promise<DisplayState> {
  let raw: string
  try {
    raw = await readFile(displayFileOf(folder), 'utf8')
  } catch {
    return { present: false, warnings: [] }
  }
  const parsed = parseDisplay(raw)
  if (!parsed.ok) return { present: true, raw, warnings: parsed.warnings }
  return { present: true, raw, spec: parsed.spec, warnings: parsed.warnings }
}

/**
 * 写入覆盖；空规格等价于重置。
 * @param folder - 任务目录。
 * @param spec - 稀疏后的规格；undefined 表示删除文件。
 */
export async function writeDisplay(folder: string, spec: DisplaySpec | undefined): Promise<void> {
  if (spec === undefined) {
    await rm(displayFileOf(folder), { force: true })
    return
  }
  await writeAtomic(displayFileOf(folder), `${JSON.stringify(spec, null, 2)}\n`)
}
