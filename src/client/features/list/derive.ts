/**
 * 列表的纯派生逻辑：筛选、分页、统计。
 *
 * 不依赖 React，也不发请求；组件只负责把结果画出来，测试可以直接调用。
 */
import type { TaskRecord } from '../../../protocol.ts'

/** 分页结果。 */
export interface PageResult<T> {
  page: number
  pages: number
  visible: T[]
}

/**
 * 按名称或详情做不区分大小写的筛选。
 * @param tasks - 全部任务。
 * @param query - 搜索词；空白表示不过滤。
 * @returns 命中的任务（保持原顺序）。
 */
export function filterTasks(tasks: readonly TaskRecord[], query: string): TaskRecord[] {
  const needle = query.trim().toLocaleLowerCase()
  if (needle === '') return [...tasks]
  return tasks.filter(task =>
    task.name.toLocaleLowerCase().includes(needle)
    || task.details.toLocaleLowerCase().includes(needle))
}

/**
 * 把列表切成一页，并把越界页码钳回合法范围。
 * @param items - 全部条目。
 * @param page - 期望页码（1 起）。
 * @param size - 每页条数。
 * @returns 当前页、总页数与可见条目。
 */
export function paginate<T>(items: readonly T[], page: number, size: number): PageResult<T> {
  const pages = Math.max(1, Math.ceil(items.length / size))
  const current = Math.min(Math.max(1, page), pages)
  const start = (current - 1) * size
  return { page: current, pages, visible: items.slice(start, start + size) }
}

/** 统计条要显示的数字。 */
export interface TaskStats {
  total: number
  enabled: number
  running: number
  attention: number
}

/**
 * 统计当前工作目录下的全部任务（不随搜索/分页变化）。
 * @param tasks - 全部任务。
 * @returns 总数、已启用、执行中、异常任务数。
 */
export function taskStats(tasks: readonly TaskRecord[]): TaskStats {
  let enabled = 0
  let running = 0
  let attention = 0
  for (const task of tasks) {
    if (task.enabled) enabled += 1
    if (task.running === true) running += 1
    if (task.lastStatus === 'failed' || task.lastStatus === 'timeout' || task.lastStatus === 'interrupted') {
      attention += 1
    }
  }
  return { total: tasks.length, enabled, running, attention }
}
