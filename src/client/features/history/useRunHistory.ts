/**
 * 运行历史的唯一数据所有者。
 *
 * 打开抽屉时读第一页；“加载更多”用游标向后翻页并按 runId 去重；
 * 只要还有 `running` 的记录就轮询第一页，失败时保留上一屏。
 */
import { useCallback, useEffect, useState } from 'react'
import { RUN_PAGE_SIZE, type RunRecord } from '../../../protocol.ts'
import { hostErrorText } from '../../api/errors.ts'
import type { AtanDailyApi } from '../../api/tasks.ts'
import { POLL_INTERVAL_MS } from '../../constants.ts'
import { t } from '../../i18n/index.ts'
import { usePolling } from '../../shared/usePolling.ts'

/** 运行历史的加载阶段。 */
export type HistoryPhase = 'loading' | 'ready' | 'failed'

/** 历史控制器。 */
export interface HistoryController {
  runs: RunRecord[]
  phase: HistoryPhase
  error: string
  hasMore: boolean
  loadingMore: boolean
  reload: () => void
  loadMore: () => void
}

/**
 * 读取一个任务的运行历史。
 * @param api - host 端点集合。
 * @param taskId - 任务 id。
 * @returns 历史状态与动作。
 */
export function useRunHistory(api: AtanDailyApi, taskId: string): HistoryController {
  const [runs, setRuns] = useState<RunRecord[]>([])
  const [phase, setPhase] = useState<HistoryPhase>('loading')
  const [error, setError] = useState<string>('')
  const [hasMore, setHasMore] = useState<boolean>(false)
  const [loadingMore, setLoadingMore] = useState<boolean>(false)

  const load = useCallback(async (): Promise<void> => {
    setPhase('loading')
    setError('')
    try {
      const next = await api.listRuns(taskId)
      setRuns(next)
      setHasMore(next.length === RUN_PAGE_SIZE)
      setPhase('ready')
    } catch (failure: unknown) {
      setError(hostErrorText(failure, t))
      setPhase('failed')
    }
  }, [api, taskId])

  useEffect(() => {
    void load()
  }, [load])

  // 运行中的记录仍在变化：轮询第一页。
  const poll = useCallback(async (): Promise<void> => {
    try {
      const next = await api.listRuns(taskId)
      setRuns(next)
      setHasMore(next.length === RUN_PAGE_SIZE)
    } catch {
      // 保留上一屏。
    }
  }, [api, taskId])
  usePolling(runs.some(run => run.status === 'running'), poll, { intervalMs: POLL_INTERVAL_MS })

  const loadMore = useCallback((): void => {
    const before = runs[runs.length - 1]?.startedAt
    if (before === undefined || loadingMore) return
    setLoadingMore(true)
    void api.listRuns(taskId, before).then((next) => {
      setRuns((previous) => {
        const known = new Set(previous.map(run => run.runId))
        return [...previous, ...next.filter(run => !known.has(run.runId))]
      })
      setHasMore(next.length === RUN_PAGE_SIZE)
    }).catch((failure: unknown) => {
      setError(hostErrorText(failure, t))
    }).finally(() => { setLoadingMore(false) })
  }, [api, taskId, runs, loadingMore])

  return {
    runs,
    phase,
    error,
    hasMore,
    loadingMore,
    reload: () => { void load() },
    loadMore,
  }
}
