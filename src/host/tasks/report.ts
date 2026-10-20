/**
 * 报告文件名选择。
 *
 * 报告直接留在任务根目录；节奏推导出的名字通常唯一，撞名时追加数字后缀，
 * 保证旧报告永远不会被覆盖。
 */

import { readdir } from 'node:fs/promises'
import type { TaskRecord } from '../../protocol.js'
import { reportNameOf, REPORT_SUFFIX } from '../naming.js'

/**
 * 为本次运行挑一个报告文件名。
 * @param task - 任务视图。
 * @param at - 运行开始的瞬间（可注入，便于测试）。
 * @returns 报告文件名。
 */
export async function nextReportName(task: TaskRecord, at: Date = new Date()): Promise<string> {
  let names: string[] = []
  try {
    names = (await readdir(task.folder)).filter(name => name.endsWith(REPORT_SUFFIX))
  } catch {
    names = []
  }
  const base = reportNameOf(at, task.timeZone)
  let candidate = base
  let suffix = 2
  while (names.includes(candidate)) {
    candidate = base.replace(/\.md$/u, `-${String(suffix)}.md`)
    suffix += 1
  }
  return candidate
}
