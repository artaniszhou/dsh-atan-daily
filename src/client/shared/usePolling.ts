/**
 * 条件轮询 hook。
 *
 * 约定（与参考实现一致，避免每个调用点各写一套）：
 *  - `enabled` 为真时按 `intervalMs` 拉取；`enabled`、任务身份或间隔变化会重启；
 *  - 每次运行持有**一个** `AbortSignal`；卸载/停用同时停表并 abort；
 *  - 任务在写状态前必须检查 `signal.aborted`——被 abort 的 fetch 不保证 reject；
 *  - 任务抛错不打断循环，下一拍继续；错误提示由任务自己负责。
 */
import { useEffect } from 'react'

/** 一次轮询任务；拿到本次运行独占的取消信号。 */
export type PollingTask = (signal: AbortSignal) => Promise<void>

/** 轮询选项。 */
export interface PollingOptions {
  /** 间隔毫秒数。 */
  intervalMs: number
  /**
   * 调度模式：
   *  - `fixed-interval`：固定节拍，不等待上一次完成（默认）；
   *  - `self-scheduling`：上一次完成后才排下一次，保证最多一个请求在飞。
   */
  mode?: 'fixed-interval' | 'self-scheduling'
  /** 启动时立刻执行一次。 */
  immediate?: boolean
}

/**
 * 按条件轮询。
 * @param enabled - 是否启用。
 * @param task - 每次执行的任务；请用 `useCallback` 固定身份。
 * @param options - 间隔、模式、是否立即执行。
 */
export function usePolling(enabled: boolean, task: PollingTask, options: PollingOptions): void {
  const { intervalMs, mode = 'fixed-interval', immediate = false } = options

  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()

    if (mode === 'self-scheduling') {
      let disposed = false
      let timer: number | undefined
      const tick = async (): Promise<void> => {
        if (disposed) return
        try {
          await task(controller.signal)
        } catch {
          // 一次失败保留上一次视图，下一拍重试。
        }
        if (!disposed) timer = window.setTimeout(() => { void tick() }, intervalMs)
      }
      if (immediate) void tick()
      else timer = window.setTimeout(() => { void tick() }, intervalMs)
      return () => {
        disposed = true
        if (timer !== undefined) window.clearTimeout(timer)
        controller.abort()
      }
    }

    const run = (): void => {
      task(controller.signal).catch(() => {
        // 固定节拍模式下失败不影响下一拍。
      })
    }
    if (immediate) run()
    const timer = window.setInterval(run, intervalMs)
    return () => {
      window.clearInterval(timer)
      controller.abort()
    }
  }, [enabled, task, intervalMs, mode, immediate])
}
