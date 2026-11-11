/**
 * 执行指令。
 *
 * 指令只有一行：它只交代**推不出来**的三件事——任务身份（`taskId`）、本轮
 * `runId`、本轮报告文件名——然后要求先加载 `atan-daily-run` skill。
 *
 * 具体规则（工具顺序、契约修订、清单维护、不写 html/pdf/png、结束语格式）全部
 * 只在 skill 里维护一份：指令重复一遍只会让两处慢慢走偏，也让每轮开头多出
 * 一大段模型必须读完的文本。
 */

import { basename } from 'node:path'
import type { TaskRecord } from '../../protocol.js'
import { RUN_SKILL_NAME } from '../skill.js'

/**
 * 构造一次运行的执行指令。
 * @param task - 要执行的任务。
 * @param buildDir - 本轮的中间件目录（`.meta/build/<runId>`）。
 * @param report - 本轮报告基名（不含扩展名），由插件在运行前选定。
 * @returns prompt 文本（一行）。
 */
export function buildPrompt(task: TaskRecord, buildDir: string, report: string): string {
  const runId = basename(buildDir)
  const reportFile = `${report}.${task.outputFormat}`
  return `执行阿碳日报任务《${task.name}》（taskId ${task.taskId}，runId ${runId}，本轮报告 ${reportFile}）：`
    + `先加载 \`${RUN_SKILL_NAME}\` skill，按它完成本轮 report.json。`
}
