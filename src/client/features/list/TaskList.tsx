/**
 * 列表区域：统计条 + 搜索 + 任务行 + 分页。
 *
 * 它只负责“怎么显示”和本地的搜索/翻页状态；数据从 `useTaskList` 传入，
 * 行操作原样回抛给页面。推送入口在每张卡片的右下角，见 `TaskRow`。
 */
import { useEffect, useState, type ReactNode } from 'react'
import type { BotView, TaskRecord } from '../../../protocol.ts'
import { AUTO_RETRY_LIMIT, PAGE_SIZE } from '../../constants.ts'
import { t } from '../../i18n/index.ts'
import { IconEmpty } from '../../ui/icons.tsx'
import { Button, SkeletonList } from '../../ui/primitives.tsx'
import { filterTasks, paginate, taskStats } from './derive.ts'
import { Pager } from './Pager.tsx'
import { SearchBar } from './SearchBar.tsx'
import { StatsBar } from './StatsBar.tsx'
import { TaskRow } from './TaskRow.tsx'
import type { ListPhase } from './useTaskList.ts'
import css from './list.module.css'

/** 列表属性。 */
export interface TaskListProps {
  tasks: TaskRecord[]
  phase: ListPhase
  error: string
  autoRetries: number
  /**
   * 重新计数的信号：目录切换或新建成功后 +1，列表借此清掉旧的搜索与页码，
   * 避免新内容被上一轮查询藏住。
   */
  resetSignal: number
  onRetry: () => void
  onCreate: () => void
  onRun: (task: TaskRecord) => void
  onToggle: (task: TaskRecord) => void
  onOpen: (task: TaskRecord) => void
  onHistory: (task: TaskRecord) => void
  onEdit: (task: TaskRecord) => void
  onRemove: (task: TaskRecord) => void
  /** 全部机器人；任务卡片右下角的图标据此解析。 */
  bots: BotView[]
  /** 打开某个任务的「推送机器人」抽屉。 */
  onManagePush: (task: TaskRecord) => void
}

/** 列表区域。 */
export function TaskList(props: TaskListProps) {
  const {
    tasks, phase, error, autoRetries, resetSignal, onRetry, onCreate,
    onRun, onToggle, onOpen, onHistory, onEdit, onRemove,
    bots, onManagePush,
  } = props
  /** 搜索词；变化时回到第一页。 */
  const [search, setSearch] = useState<string>('')
  /** 用户选择的页码；越界由 `paginate` 钳制，不再用 effect 回写。 */
  const [page, setPage] = useState<number>(1)

  // 目录切换/新建成功：旧的筛选条件不再适用，回到干净的列表。
  useEffect(() => {
    setSearch('')
    setPage(1)
  }, [resetSignal])

  const filtered = filterTasks(tasks, search)
  const paged = paginate(filtered, page, PAGE_SIZE)
  const stats = taskStats(tasks)

  const changeSearch = (next: string): void => {
    setSearch(next)
    setPage(1)
  }

  let body: ReactNode
  if (phase === 'loading') {
    body = <SkeletonList label={t('loading')} />
  } else if (phase === 'failed') {
    body = (
      <div className={css.empty} role="alert">
        <span className={css.emptyTitle}>{t('loadFailed')}</span>
        {error === '' ? null : <span className={css.loadError}>{error}</span>}
        {autoRetries >= 1 && autoRetries < AUTO_RETRY_LIMIT ? <span>{t('autoRetrying')}</span> : null}
        <Button size="sm" variant="quiet" onClick={onRetry}>{t('retry')}</Button>
      </div>
    )
  } else if (tasks.length === 0) {
    body = (
      <div className={css.empty}>
        <span className={css.emptyIcon}><IconEmpty /></span>
        <span className={css.emptyTitle}>{t('emptyTitle')}</span>
        <span>{t('emptyHint')}</span>
        <Button size="sm" variant="primary" onClick={onCreate}>{t('emptyAction')}</Button>
      </div>
    )
  } else if (filtered.length === 0) {
    body = (
      <div className={css.empty}>
        <span className={css.emptyTitle}>{t('searchEmptyTitle')}</span>
        <span>{t('searchEmptyHint')}</span>
        <Button size="sm" variant="quiet" onClick={() => { changeSearch('') }}>{t('searchShowAll')}</Button>
      </div>
    )
  } else {
    body = (
      <ul id="atan-daily-task-list" className={css.list} aria-label={t('listLabel')}>
        {paged.visible.map(task => (
          <TaskRow
            key={task.id}
            task={task}
            bots={bots}
            onRun={() => { onRun(task) }}
            onToggle={() => { onToggle(task) }}
            onOpen={() => { onOpen(task) }}
            onHistory={() => { onHistory(task) }}
            onEdit={() => { onEdit(task) }}
            onRemove={() => { onRemove(task) }}
            onManagePush={() => { onManagePush(task) }}
          />
        ))}
      </ul>
    )
  }

  return (
    <>
      {phase === 'ready' && tasks.length > 0 ? <StatsBar stats={stats} /> : null}
      {phase === 'ready' && tasks.length > 0
        ? (
          <SearchBar
            value={search}
            total={tasks.length}
            matching={filtered.length}
            onChange={changeSearch}
          />
          )
        : null}
      {body}
      {phase === 'ready' && paged.pages > 1
        ? <Pager page={paged.page} pages={paged.pages} onChange={setPage} />
        : null}
    </>
  )
}
