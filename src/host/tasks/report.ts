/**
 * 报告基名的选择。
 *
 * 新一轮的基名写在任务根目录；撞名时追加 `-2`、`-3`，绝不覆盖旧报告。
 * `history/` 里已归档的基名也参与判重：同一秒重跑时，上一轮可能已经被归档，
 * 否则会生成与历史同名的基名，让「最新报告」的排序变得含糊。
 */

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { TaskRecord } from '../../protocol.js'
import { HISTORY_DIR } from '../config.js'
import { reportBaseAt, reportBaseOf } from '../naming.js'

/**
 * 列出任务根与归档目录里已经用掉的报告基名。
 * @param folder - 任务目录。
 * @returns 基名集合；读不到的目录按空处理。
 */
async function usedReportBases(folder: string): Promise<Set<string>> {
  const [root, archived] = await Promise.all([
    readdir(folder).catch(() => [] as string[]),
    readdir(join(folder, HISTORY_DIR)).catch(() => [] as string[]),
  ])
  const bases = new Set<string>()
  for (const name of [...root, ...archived]) {
    const base = reportBaseOf(name)
    if (base !== undefined) bases.add(base)
  }
  return bases
}

/**
 * 为本次运行挑一个报告基名。
 * @param task - 任务视图。
 * @param at - 运行开始的瞬间（可注入，便于测试）。
 * @returns 报告基名（不含扩展名）。
 */
export async function nextReportBase(task: TaskRecord, at: Date = new Date()): Promise<string> {
  const used = await usedReportBases(task.folder)
  const base = reportBaseAt(at, task.timeZone, task.name)
  let candidate = base
  let suffix = 2
  while (used.has(candidate)) {
    candidate = `${base}-${String(suffix)}`
    suffix += 1
  }
  return candidate
}
