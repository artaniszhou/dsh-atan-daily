/**
 * 报告归档：每次运行开始前，把任务根目录里的报告移进与 `meta/` 同级的
 * `history/`。
 *
 * 任务根目录永远只保留最新一份报告，更早的报告按原文件名存放在 `history/`
 * 下（定宽时间戳，排序规则不变）。归档失败只记日志、绝不阻断运行——报告还
 * 在原地，下一轮会再试一次。
 */

import { mkdir, readdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { TaskRecord } from '../../protocol.js'
import { HISTORY_DIR } from '../config.js'
import { isReportName } from '../naming.js'
import type { Logger } from '../ports.js'

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
 * 在归档目录里挑一个不冲突的文件名。
 * @param historyDir - 归档目录。
 * @param name - 原始报告名。
 * @returns 可用的文件名（通常就是原名）。
 */
async function freeName(historyDir: string, name: string): Promise<string> {
  let candidate = name
  let suffix = 2
  while (await isFile(join(historyDir, candidate))) {
    candidate = name.replace(/\.md$/u, `-${String(suffix)}.md`)
    suffix += 1
  }
  return candidate
}

/**
 * 把任务根目录下的报告移进 `history/`。
 *
 * 正常情况下根目录只有一份上一轮的报告；历史遗留的多份也一并归档，保证根目录
 * 只留最新。
 * @param task - 任务视图（只用到 `folder`）。
 * @param logger - 诊断日志；归档失败不影响运行。
 * @returns 实际归档的文件名（已按原名或去重后的名字）。
 */
export async function archiveReports(task: Pick<TaskRecord, 'folder'>, logger?: Logger): Promise<string[]> {
  let entries
  try {
    entries = await readdir(task.folder, { withFileTypes: true })
  } catch {
    return []
  }
  const reports = entries
    .filter(entry => entry.isFile() && isReportName(entry.name))
    .map(entry => entry.name)
    .sort()
  if (reports.length === 0) return []

  const historyDir = historyDirOf(task.folder)
  try {
    await mkdir(historyDir, { recursive: true })
  } catch (error: unknown) {
    logger?.warn(`could not create the history directory of ${task.folder}: ${String(error)}`)
    return []
  }

  const moved: string[] = []
  for (const name of reports) {
    const target = await freeName(historyDir, name)
    try {
      await rename(join(task.folder, name), join(historyDir, target))
      moved.push(target)
    } catch (error: unknown) {
      // 跨卷沿用、权限、占用都会走到这里；报告留在原地，下次再试。
      logger?.warn(`could not archive report ${name} of ${task.folder}: ${String(error)}`)
    }
  }
  return moved
}

/**
 * 找到一份报告的实际路径：先在任务根目录找，再找 `history/`。
 *
 * 运行中的任务根目录只有本次报告，已经归档的报告只存在于 `history/`；推送和
 * 其他读取路径因此不能假设报告一定在根目录。
 * @param folder - 任务目录。
 * @param report - 报告文件名。
 * @returns 绝对路径；两处都没有时 undefined。
 */
export async function reportPathOf(folder: string, report: string): Promise<string | undefined> {
  const root = join(folder, report)
  if (await isFile(root)) return root
  const archived = join(historyDirOf(folder), report)
  if (await isFile(archived)) return archived
  return undefined
}
