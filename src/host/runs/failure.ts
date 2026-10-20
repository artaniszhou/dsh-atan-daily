/**
 * 运行失败：带稳定错误码与运行状态，供 `meta/runs/<runId>.json` 持久化。
 */

import type { RunError, RunStatus } from '../../protocol.js'

/** 一次运行的领域失败。 */
export class RunFailure extends Error {
  /**
   * @param code - 写进历史的稳定错误码。
   * @param message - 人可读原因。
   * @param status - 要记录的运行状态。
   */
  constructor(
    readonly code: string,
    message: string,
    readonly status: 'failed' | 'timeout' | 'cancelled' = 'failed',
  ) {
    super(message)
    this.name = 'RunFailure'
  }
}

/**
 * 把任意抛出值转成状态与有界的错误记录。
 * @param error - 捕获到的值。
 * @returns 运行记录需要的 status / error。
 */
export function runFailureOf(error: unknown): { status: RunStatus, error: RunError } {
  if (error instanceof RunFailure) {
    return { status: error.status, error: { code: error.code, message: error.message } }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { status: 'failed', error: { code: 'run_failed', message: message.slice(0, 4096) } }
}
