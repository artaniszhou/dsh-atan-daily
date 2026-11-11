/**
 * 每轮结束的清理：`.meta/build/` 只保留这一轮的中间件目录。
 *
 * 旧的 build 目录（report.json / report.html / 脚本产物）在运行结束后不再被读取，
 * 留着只会让每个任务长期堆积几十 MB。保留本轮是因为调展示（`report_tune` 的
 * commit）还要用它的 `report.json` 重渲染。
 */

import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { BUILD_DIR, metaDirOf } from '../../core/documents.js'
import type { Logger } from '../ports.js'

/**
 * 删除除本轮以外的 build 目录。
 * @param folder - 任务目录。
 * @param keepRunId - 本轮 runId；同名目录保留。
 * @param logger - 诊断日志；单个目录删不掉只记日志，不影响运行结果。
 * @returns 实际删掉的目录名。
 */
export async function pruneBuildDirs(folder: string, keepRunId: string, logger?: Logger): Promise<string[]> {
  const root = join(metaDirOf(folder), BUILD_DIR)
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const removed: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === keepRunId) continue
    try {
      await rm(join(root, entry.name), { recursive: true, force: true })
      removed.push(entry.name)
    } catch (error: unknown) {
      logger?.warn(`could not remove the build directory ${entry.name} of ${folder}: ${String(error)}`)
    }
  }
  return removed
}
