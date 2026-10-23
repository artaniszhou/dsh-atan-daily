/**
 * 报告文件名选择。
 *
 * 新报告写在任务根目录；撞名时追加数字后缀，保证旧报告永远不会被覆盖。
 * 归档目录 `history/` 里的名字也参与判重，避免同一秒重跑生成一个与历史报告
 * 同名的文件（两份同名报告会让「最新报告」的排序变得含糊）。
 */

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { TaskRecord } from '../../protocol.js'
import { HISTORY_DIR } from '../config.js'
import { reportNameOf, REPORT_SUFFIX } from '../naming.js'

/**
 * 列出任务根与归档目录里已经用掉的报告名。
 * @param folder - 任务目录。
 * @returns 文件名列表；读不到的目录按空处理。
 */
async function usedReportNames(folder: string): Promise<string[]> {
  const [root, archived] = await Promise.all([
    readdir(folder).catch(() => [] as string[]),
    readdir(join(folder, HISTORY_DIR)).catch(() => [] as string[]),
  ])
  return [...root, ...archived].filter(name => name.endsWith(REPORT_SUFFIX))
}

/**
 * 为本次运行挑一个报告文件名。
 * @param task - 任务视图。
 * @param at - 运行开始的瞬间（可注入，便于测试）。
 * @returns 报告文件名。
 */
export async function nextReportName(task: TaskRecord, at: Date = new Date()): Promise<string> {
  const names = await usedReportNames(task.folder)
  const base = reportNameOf(at, task.timeZone)
  let candidate = base
  let suffix = 2
  while (names.includes(candidate)) {
    candidate = base.replace(/\.md$/u, `-${String(suffix)}.md`)
    suffix += 1
  }
  return candidate
}
