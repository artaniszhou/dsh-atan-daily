/**
 * 任务列表的唯一数据所有者。
 *
 * 改造前，页面里 22 个 state、8 处刷新、7 处静默 `catch` 混在一起；这里把
 * “读、轮询、增删改、失败态”收进一个 hook：
 *  - 初始化失败 → `failed` + 错误详情 + 有界退避重试；
 *  - 轮询失败 → 保留上一屏，不清空；
 *  - 行操作失败 → 只把错误写回该行，并且**一定有可见文案**；
 *  - 刷新只有 `reload` 一个入口。
 */
import { useCallback, useEffect, useState } from 'react'
import type { TaskRecord } from '../../../protocol.ts'
import { hostErrorText } from '../../api/errors.ts'
import type { AtanDailyApi, CreateTaskInput } from '../../api/tasks.ts'
import {
  AUTO_RETRY_BASE_MS,
  AUTO_RETRY_LIMIT,
  AUTO_RETRY_MAX_MS,
  POLL_INTERVAL_MS,
} from '../../constants.ts'
import { t } from '../../i18n/index.ts'
import { usePolling } from '../../shared/usePolling.ts'

/** 列表的加载阶段。 */
export type ListPhase = 'loading' | 'ready' | 'failed'

/** 创建与删除需要的外部能力。 */
export interface TaskListOptions {
  /** 跳到某个运行会话。 */
  onSession: (sessionId: string) => void
  /** 删除前的二次确认。 */
  confirm: (message: string) => boolean
}

/** 列表控制器。 */
export interface TaskListController {
  tasks: TaskRecord[]
  phase: ListPhase
  error: string
  autoRetries: number
  /** 静默重拉（操作之后、轮询兜底）。 */
  reload: () => void
  /** 手动重试：重置退避预算并显示加载态。 */
  retry: () => void
  create: (input: CreateTaskInput) => Promise<TaskRecord>
  run: (task: TaskRecord) => void
  toggle: (task: TaskRecord) => void
  remove: (task: TaskRecord) => void
  openSession: (task: TaskRecord) => void
  /** 新建成功后插入到列表头。 */
  prepend: (task: TaskRecord) => void
  /** 编辑成功后替换同 id 的行。 */
  replace: (task: TaskRecord) => void
}

/**
 * 读取并操作任务列表。
 * @param api - host 端点集合。
 * @param options - 跳转与确认回调。
 * @returns 列表状态与动作。
 */
export function useTaskList(api: AtanDailyApi, options: TaskListOptions): TaskListController {
  const { onSession, confirm } = options
  const [tasks, setTasks] = useState<TaskRecord[]>([])
  const [phase, setPhase] = useState<ListPhase>('loading')
  const [error, setError] = useState<string>('')
  const [autoRetries, setAutoRetries] = useState<number>(0)

  const load = useCallback(async (silent: boolean): Promise<void> => {
    if (!silent) {
      setPhase('loading')
      setError('')
    }
    try {
      const next = await api.listTasks()
      setTasks(next)
      setPhase('ready')
      setError('')
      setAutoRetries(0)
    } catch (failure: unknown) {
      setError(hostErrorText(failure, t))
      if (!silent) setPhase('failed')
    }
  }, [api])

  useEffect(() => {
    void load(false)
  }, [load])

  // Host 可能正在重启：失败后按指数退避重试，共 8 次；成功即清零。
  useEffect(() => {
    if (phase !== 'failed' || autoRetries >= AUTO_RETRY_LIMIT) return
    const delay = Math.min(AUTO_RETRY_MAX_MS, AUTO_RETRY_BASE_MS * 2 ** autoRetries)
    const handle = window.setTimeout(() => {
      setAutoRetries(previous => previous + 1)
      void load(true)
    }, delay)
    return () => { window.clearTimeout(handle) }
  }, [phase, autoRetries, load])

  // 有任务在跑时保持轮询；失败只保留上一屏。
  const poll = useCallback(async (): Promise<void> => {
    try {
      setTasks(await api.listTasks())
    } catch {
      // 轮询是后台行为，不打断当前视图。
    }
  }, [api])
  usePolling(tasks.some(task => task.running === true), poll, { intervalMs: POLL_INTERVAL_MS })

  const mark = useCallback((id: string, patch: Partial<TaskRecord>): void => {
    setTasks(previous => previous.map(task => (task.id === id ? { ...task, ...patch } : task)))
  }, [])

  const run = useCallback((task: TaskRecord): void => {
    // 先乐观置为执行中，Host 返回后再以服务端数据为准。
    mark(task.id, { running: true, lastError: undefined })
    void api.runTask(task.id).then(async (sessionId) => {
      if (sessionId !== undefined) onSession(sessionId)
      try {
        setTasks(await api.listTasks())
      } catch (failure: unknown) {
        // 关键：刷新失败必须落回错误态，否则这一行会永远停在“执行中”。
        mark(task.id, { running: false, lastError: hostErrorText(failure, t) })
      }
    }).catch((failure: unknown) => {
      mark(task.id, { running: false, lastError: hostErrorText(failure, t) })
    })
  }, [api, mark, onSession])

  const toggle = useCallback((task: TaskRecord): void => {
    const enabled = !task.enabled
    mark(task.id, { enabled })
    void api.patchTask(task.id, { enabled }).then((updated) => {
      setTasks(previous => previous.map(item => (item.id === updated.id ? updated : item)))
    }).catch((failure: unknown) => {
      mark(task.id, { enabled: task.enabled, lastError: hostErrorText(failure, t) })
    })
  }, [api, mark])

  const remove = useCallback((task: TaskRecord): void => {
    if (!confirm(`${t('removeConfirm')}\n\n${task.name}`)) return
    void api.deleteTask(task.id).then(() => {
      setTasks(previous => previous.filter(item => item.id !== task.id))
    }).catch((failure: unknown) => {
      mark(task.id, { lastError: hostErrorText(failure, t) })
    })
  }, [api, confirm, mark])

  const openSession = useCallback((task: TaskRecord): void => {
    void api.openSession(task.id).then((sessionId) => {
      if (sessionId !== undefined) onSession(sessionId)
    }).catch((failure: unknown) => {
      mark(task.id, { lastError: `${t('openFailed')} ${hostErrorText(failure, t)}` })
    })
  }, [api, mark, onSession])

  return {
    tasks,
    phase,
    error,
    autoRetries,
    reload: () => { void load(true) },
    retry: () => { setAutoRetries(0); void load(false) },
    create: input => api.createTask(input),
    run,
    toggle,
    remove,
    openSession,
    prepend: task => { setTasks(previous => [task, ...previous]) },
    replace: task => { setTasks(previous => previous.map(item => (item.id === task.id ? task : item))) },
  }
}
