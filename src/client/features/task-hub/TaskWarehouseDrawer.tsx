/**
 * 任务仓库抽屉：只读已上架任务，加载时复制成本地任务。
 */
import { useEffect, useMemo, useState } from 'react'
import type { TaskRecord } from '../../../protocol.ts'
import { hostErrorText } from '../../api/errors.ts'
import type { AtanDailyApi } from '../../api/tasks.ts'
import type { TaskHubRemoteTask } from '../../api/task-hub.ts'
import { t } from '../../i18n/index.ts'
import { formatVersion } from '../../shared/format.ts'
import { Dialog } from '../../ui/dialog.tsx'
import { Button, Notice, SkeletonList, TextInput } from '../../ui/primitives.tsx'
import { TaskDetailView } from './TaskDetailView.tsx'
import css from './task-hub.module.css'

export interface TaskWarehouseDrawerProps {
  api: AtanDailyApi
  onClose: () => void
  onLoaded: (task: TaskRecord) => void
}

export function TaskWarehouseDrawer({ api, onClose, onLoaded }: TaskWarehouseDrawerProps) {
  const [phase, setPhase] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [items, setItems] = useState<TaskHubRemoteTask[]>([])
  const [error, setError] = useState('')
  const [q, setQ] = useState('')
  const [selected, setSelected] = useState<TaskHubRemoteTask | null>(null)
  const [detailOf, setDetailOf] = useState<TaskHubRemoteTask | null>(null)
  const [name, setName] = useState('')
  const [schedule, setSchedule] = useState('')
  const [timeZone, setTimeZone] = useState('')
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState<Set<string>>(() => new Set())

  const load = async (): Promise<void> => {
    setPhase('loading')
    setError('')
    try {
      const data = await api.listTaskWarehouse({ page: 1, pageSize: 100 })
      setItems(data.items)
      setPhase('ready')
    } catch (failure: unknown) {
      setError(hostErrorText(failure, t))
      setPhase('failed')
    }
  }

  useEffect(() => {
    void load()
    // 只在打开时读一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const filtered = useMemo(() => items.filter(task => {
    const text = `${task.name} ${task.summary}`.toLowerCase()
    return q.trim() === '' || text.includes(q.trim().toLowerCase())
  }), [items, q])

  const openLoad = (task: TaskHubRemoteTask): void => {
    setSelected(task)
    setName(task.name)
    setSchedule('')
    setTimeZone('')
    setError('')
  }

  const submitLoad = async (): Promise<void> => {
    if (selected === null) return
    setBusy(true)
    setError('')
    try {
      const task = await api.loadRemoteTask({
        publicId: selected.publicId,
        name: name.trim() === '' ? undefined : name.trim(),
        schedule: schedule.trim() === '' ? undefined : schedule.trim(),
        timeZone: timeZone.trim() === '' ? undefined : timeZone.trim(),
      })
      setLoaded(previous => new Set(previous).add(selected.publicId))
      onLoaded(task)
      onClose()
    } catch (failure: unknown) {
      setError(hostErrorText(failure, t))
    } finally {
      setBusy(false)
    }
  }

  const body = detailOf !== null
    ? (
      <TaskDetailView
        api={api}
        publicId={detailOf.publicId}
        onBack={() => { setDetailOf(null) }}
      />
      )
    : selected === null
    ? (
      <>
        <div className={css.whSearch}>
          <TextInput
            value={q}
            placeholder="搜索任务名称或简介"
            aria-label="搜索任务"
            onChange={(event) => { setQ(event.currentTarget.value) }}
          />
        </div>
        <div className={css.whMeta}><span>{items.length} 个任务</span></div>
        {phase === 'loading' ? <SkeletonList label="任务仓库" /> : null}
        {phase === 'failed' ? (
          <Notice kind="error">
            <span>{error}</span>
            <Button size="sm" variant="quiet" onClick={() => { void load() }}>{t('retry')}</Button>
          </Notice>
        ) : null}
        {phase === 'ready' && filtered.length === 0 ? (
          <Notice kind="empty">没有匹配的任务，试试清空搜索。</Notice>
        ) : null}
        {phase === 'ready' ? (
          <div className={css.taskList}>
            {filtered.map(task => (
              <article key={task.publicId} className={css.taskCard}>
                <div className={css.taskTop}>
                  <span className={css.taskName} title={task.name}>{task.name}</span>
                </div>
                <p className={css.taskSummary}>{task.summary}</p>
                <div className={css.taskFoot}>
                  <span className={css.taskBy}>
                    {task.loadCount} 次加载 · {formatVersion(task.version)}
                  </span>
                  <span className={css.taskActions}>
                    <Button size="sm" variant="quiet" onClick={() => { setDetailOf(task) }}>任务详情</Button>
                    {loaded.has(task.publicId)
                      ? <span className={css.loaded}>✓ 已加载</span>
                      : <Button size="sm" variant="quiet" onClick={() => { openLoad(task) }}>加载</Button>}
                  </span>
                </div>
              </article>
            ))}
          </div>
        ) : null}
      </>
      )
    : (
      <div className={css.loadForm}>
        <button type="button" className={css.back} onClick={() => { setSelected(null); setError('') }}>← 返回任务仓库</button>
        <div className={css.summary}>
          <h4>{selected.name}</h4>
          <p>{selected.summary}</p>
          <div className={css.kv}><span>版本</span><b>{formatVersion(selected.version)}</b></div>
          <div className={css.kv}><span>加载量</span><b>{selected.loadCount}</b></div>
        </div>
        <div className={css.fieldGrid}>
          <div>
            <div className={css.label}><span>任务名称</span></div>
            <TextInput value={name} maxLength={40} onChange={(event) => { setName(event.currentTarget.value) }} />
            <div className={css.fileMeta}>同名会提示冲突，请换个名称；本地任务不会被覆盖。</div>
          </div>
          <div className={css.fieldRow}>
            <div>
              <div className={css.label}><span>执行时间</span><em>可留空</em></div>
              <TextInput value={schedule} placeholder="沿用任务默认" onChange={(event) => { setSchedule(event.currentTarget.value) }} />
            </div>
            <div>
              <div className={css.label}><span>时区</span><em>可留空</em></div>
              <TextInput value={timeZone} placeholder="沿用任务默认" onChange={(event) => { setTimeZone(event.currentTarget.value) }} />
            </div>
          </div>
          <div className={css.note}>只复制任务详情、报告 Schema、外观覆盖与自定义图形脚本；缓存、取数脚本、历史报告不会带过来。</div>
        </div>
        {error === '' ? null : <div className={css.error} role="alert">{error}</div>}
        <div className={css.formActions}>
          <Button size="sm" variant="quiet" onClick={() => { setSelected(null); setError('') }}>{t('cancel')}</Button>
          <Button size="sm" variant="primary" disabled={busy} onClick={() => { void submitLoad() }}>{busy ? t('loading') : '加载任务'}</Button>
        </div>
      </div>
      )

  return (
    <Dialog
      variant="drawer"
      title="任务仓库"
      subtitle="选择一个任务加载，加载后成为你自己的任务"
      closeLabel={t('runsClose')}
      onClose={onClose}
    >
      {body}
    </Dialog>
  )
}
