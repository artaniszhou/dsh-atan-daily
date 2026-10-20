/**
 * 日志适配：把宿主的 `ctx.logger` 包成统一前缀 + 结构化运行日志。
 *
 * 每次 `apply` 构造一个实例；不存在模块级可变单例，所以两个 profile
 * 不会互相覆盖，运行日志也都能带上 `runId`。
 */

import type { Logger, RunLogEntry } from './ports.js'

/** 宿主 logger 的最小面。 */
export interface LogSink {
  info(message: string): void
  warn(message: string): void
}

/** 日志前缀；与旧实现保持一致，便于既有的 grep 习惯。 */
const PREFIX = 'atan-daily'

/**
 * 创建一个带前缀与结构化运行日志的 logger。
 * @param sink - 宿主 logger（或测试替身）。
 * @returns 注入用的 Logger。
 */
export function createLogger(sink: LogSink): Logger {
  const format = (message: string): string => `${PREFIX}: ${message}`
  return {
    info(message: string): void {
      sink.info(format(message))
    },
    warn(message: string): void {
      sink.warn(format(message))
    },
    run(entry: RunLogEntry): void {
      const parts = [`event=${entry.event}`, `task=${JSON.stringify(entry.taskId)}`]
      if (entry.runId !== undefined && entry.runId !== '') parts.push(`runId=${entry.runId}`)
      if (entry.detail !== undefined && entry.detail !== '') parts.push(entry.detail)
      sink.warn(format(parts.join(' ')))
    },
  }
}
