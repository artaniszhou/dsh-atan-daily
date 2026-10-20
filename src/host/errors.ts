/**
 * 统一错误模型：路由只抛 {@link AppError}，由 `http/server.ts` 统一映射。
 *
 * 成功响应形状不变；失败响应保留旧的 `error` 字符串，并新增 `code`。
 */

/** 可分支的错误码。 */
export type AppErrorCode =
  | 'invalid_input'
  | 'invalid_path'
  | 'not_found'
  | 'conflict'
  | 'already_running'
  | 'run_failed'
  | 'internal'

/** 失败响应体；`error` 保持字符串，旧 Client 不受影响。 */
export interface ErrorBody {
  ok: false
  code: AppErrorCode
  error: string
}

/** 带状态码的领域错误。 */
export class AppError extends Error {
  /**
   * @param code - 稳定错误码。
   * @param status - HTTP 状态码。
   * @param message - 人可读原因。
   */
  constructor(
    readonly code: AppErrorCode,
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

/**
 * 把任意抛出值归一为 AppError。
 *
 * `fs` 的 `ENOENT`/`EEXIST` 在这里统一映射，路由层不再各自判断。
 * @param error - 捕获到的值。
 * @returns 归一后的错误。
 */
export function appErrorOf(error: unknown): AppError {
  if (error instanceof AppError) return error
  const code = (error as { code?: unknown }).code
  const message = error instanceof Error ? error.message : String(error)
  if (code === 'ENOENT') return new AppError('not_found', 404, message)
  if (code === 'EEXIST') return new AppError('conflict', 409, message)
  return new AppError('internal', 500, message)
}

/**
 * 构造失败响应体。
 * @param error - 任意抛出值。
 * @returns 统一的失败体。
 */
export function errorBodyOf(error: unknown): ErrorBody {
  const appError = appErrorOf(error)
  return { ok: false, code: appError.code, error: appError.message }
}
