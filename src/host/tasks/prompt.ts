/**
 * 执行指令。
 *
 * 指令刻意很短：该做什么已经写在 `meta/rule.md` 里，prompt 只说任务在哪里、
 * 跟哪份文档、这次写哪个报告文件。
 */

import { join } from 'node:path'
import type { TaskRecord } from '../../protocol.js'
import { META_DIR, RULE_NAME } from '../config.js'

/**
 * 构造一次运行的执行指令。
 * @param task - 要执行的任务。
 * @param report - 本次运行必须写的报告文件名。
 * @returns prompt 文本。
 */
export function buildPrompt(task: TaskRecord, report: string): string {
  return [
    `请执行阿碳日报任务：${task.name}`,
    '',
    `任务目录：${task.folder}`,
    `任务规则：${join(task.folder, META_DIR, RULE_NAME)}`,
    '',
    '请先完整阅读任务规则，按规则执行（它定义了目标、细节、执行要求与输出约定）。',
    '',
    `本次报告写到：\`${join(task.folder, report)}\``,
    '（历次报告都保留在任务目录下；本次只写这一个文件，不要覆盖其他报告。）',
  ].join('\n')
}
