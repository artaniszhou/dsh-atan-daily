/**
 * 报告归档：每次运行开始前，把任务根目录里的最终文档**整组**移进与 `.meta/`
 * 同级的 `history/`。
 *
 * 任务根目录永远只保留最新一轮，更早的按原文件名存放在 `history/` 下。一轮是
 * 一组同基名的文件（`.pdf` 或 `.png`），所以归档的单位是**基名**而不是文件。
 *
 * 归档失败只记日志、绝不阻断运行——文件还在原地，下一轮会再试一次。
 */

import { mkdir, readdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { TaskRecord } from '../../protocol.js'
import { HISTORY_DIR } from '../config.js'
import { REPORT_FORMATS, reportBaseOf, reportFileName } from '../naming.js'
import type { ReportFormat } from '../naming.js'
import type { Logger } from '../ports.js'

/** 推送与展示时的格式偏好：PDF 先，PNG 后。 */
const PREFERRED: readonly ReportFormat[] = ['pdf', 'png']

/** 任务目录下的归档目录。 */
export function historyDirOf(folder: string): string {
  return join(folder, HISTORY_DIR)
}

/**
 * 是不是一个已存在的普通文件。
 * @param path - 绝对路径。
 * @returns true 表示存在且是文件。
 */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/**
 * 在归档目录里挑一个不冲突的基名。
 * @param historyDir - 归档目录。
 * @param base - 原始基名。
 * @returns 可用的基名（通常就是原名）。
 */
async function freeBase(historyDir: string, base: string): Promise<string> {
  let candidate = base
  let suffix = 2
  const taken = async (): Promise<boolean> => {
    for (const format of REPORT_FORMATS) {
      if (await isFile(join(historyDir, reportFileName(candidate, format)))) return true
    }
    return false
  }
  while (await taken()) {
    candidate = `${base}-${String(suffix)}`
    suffix += 1
  }
  return candidate
}

/**
 * 某一轮在目录里实际存在的文件。
 * @param folder - 任务目录或 history 目录。
 * @param base - 报告基名。
 * @returns 按格式偏好排序的文件名。
 */
export async function reportFilesOf(folder: string, base: string): Promise<{ format: ReportFormat, name: string, path: string }[]> {
  const found: { format: ReportFormat, name: string, path: string }[] = []
  for (const format of PREFERRED) {
    const name = reportFileName(base, format)
    const path = join(folder, name)
    if (await isFile(path)) found.push({ format, name, path })
  }
  return found
}

/**
 * 查一轮报告是否已经产出（任一格式存在即算）。
 * @param folder - 任务目录。
 * @param base - 报告基名。
 * @returns true 表示根目录里至少有 `基名.pdf` 或 `基名.png`。
 */
export async function reportExistsAt(folder: string, base: string): Promise<boolean> {
  for (const format of REPORT_FORMATS) {
    if (await isFile(join(folder, reportFileName(base, format)))) return true
  }
  return false
}

/**
 * 把任务根目录下的报告整组移进 `history/`。
 *
 * 正常情况下根目录只有上一轮那一组；历史遗留的多组也一并归档，保证根目录只留
 * 最新一轮。
 * @param task - 任务视图（只用到 `folder`）。
 * @param logger - 诊断日志；归档失败不影响运行。
 * @returns 实际归档的文件名。
 */
export async function archiveReports(task: Pick<TaskRecord, 'folder'>, logger?: Logger): Promise<string[]> {
  let entries
  try {
    entries = await readdir(task.folder, { withFileTypes: true })
  } catch {
    return []
  }
  const byBase = new Map<string, string[]>()
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const base = reportBaseOf(entry.name)
    if (base === undefined) continue
    const bucket = byBase.get(base)
    if (bucket === undefined) byBase.set(base, [entry.name])
    else bucket.push(entry.name)
  }
  if (byBase.size === 0) return []

  const historyDir = historyDirOf(task.folder)
  try {
    await mkdir(historyDir, { recursive: true })
  } catch (error: unknown) {
    logger?.warn(`could not create the history directory of ${task.folder}: ${String(error)}`)
    return []
  }

  const moved: string[] = []
  for (const [base, names] of byBase) {
    const target = await freeBase(historyDir, base)
    for (const name of names) {
      // 基名去重后，文件名里的基名部分也要跟着换。
      const suffix = name.slice(base.length)
      const renamed = `${target}${suffix}`
      try {
        await rename(join(task.folder, name), join(historyDir, renamed))
        moved.push(renamed)
      } catch (error: unknown) {
        // 跨卷沿用、权限、占用都会走到这里；文件留在原地，下次再试。
        logger?.warn(`could not archive report ${name} of ${task.folder}: ${String(error)}`)
      }
    }
  }
  return moved
}

/**
 * 找到一轮报告里最适合推送/打开的那份文件：先根目录，再 `history/`；同一处优先
 * PDF（飞书能直接预览），其次 HTML，最后 JSON。
 * @param folder - 任务目录。
 * @param base - 报告基名。
 * @returns 文件信息；两处都没有时 undefined。
 */
export async function reportPathOf(
  folder: string,
  base: string,
): Promise<{ format: ReportFormat, name: string, path: string } | undefined> {
  const root = await reportFilesOf(folder, base)
  if (root.length > 0) return root[0]
  const archived = await reportFilesOf(historyDirOf(folder), base)
  if (archived.length > 0) return archived[0]
  return undefined
}
