/**
 * 页面组合根。
 *
 * 它只做三件事：布局、把数据 hook 与展示组件接起来、记住“哪个弹层打开”。
 * 数据读取在 `useTaskList` / `useSettings`，细节在各自的功能域组件里。
 */
import { useState } from 'react'
import type { TaskRecord } from '../../../protocol.ts'
import type { AtanDailyApi } from '../../api/tasks.ts'
import { t } from '../../i18n/index.ts'
import { Button } from '../../ui/primitives.tsx'
import { CreateTaskForm } from '../create/CreateTaskForm.tsx'
import { EditDialog } from '../edit/EditDialog.tsx'
import { HistoryDrawer } from '../history/HistoryDrawer.tsx'
import { TaskList } from '../list/TaskList.tsx'
import { useTaskList } from '../list/useTaskList.ts'
import { SettingsLine } from '../settings/SettingsLine.tsx'
import { useSettings } from '../settings/useSettings.ts'
import css from './page.module.css'

/** 页面属性。 */
export interface PageProps {
  api: AtanDailyApi
  /** 跳到某个运行会话。 */
  navigate: (sessionId: string) => void
  /** 删除前的二次确认（由宿主/测试注入）。 */
  confirm: (message: string) => boolean
}

/** 中央页面。 */
export function Page({ api, navigate, confirm }: PageProps) {
  const [listEpoch, setListEpoch] = useState<number>(0)
  const list = useTaskList(api, { onSession: navigate, confirm })
  // 目录切换后列表内容整体换了：清掉旧的搜索/页码，避免新任务被旧查询藏住。
  const settings = useSettings(api, () => {
    setListEpoch(previous => previous + 1)
    list.reload()
  })
  const [createOpen, setCreateOpen] = useState<boolean>(false)
  const [historyOf, setHistoryOf] = useState<TaskRecord | null>(null)
  const [editOf, setEditOf] = useState<TaskRecord | null>(null)

  const created = (task: TaskRecord): void => {
    list.prepend(task)
    setCreateOpen(false)
    setListEpoch(previous => previous + 1)
    list.reload()
  }

  const saved = (task: TaskRecord): void => {
    list.replace(task)
    setEditOf(null)
  }

  return (
    <section className={css.root} aria-label={t('title')} data-testid="atan-daily-page">
      <div className={css.scroll}>
        <div className={css.content}>
          <div className={css.heading}>
            <h1 className={css.title}>{t('title')}</h1>
            <Button
              variant="primary"
              disabled={createOpen}
              aria-expanded={createOpen}
              onClick={() => { setCreateOpen(true) }}
            >
              {t('add')}
            </Button>
          </div>
          <p className={css.subtitle}>{t('subtitle')}</p>

          {settings.error === ''
            ? null
            : <div className={css.settingsWarning} role="status">{`${t('settingsLoadFailed')} ${settings.error}`}</div>}

          {settings.settings === null
            ? null
            : (
              <SettingsLine
                settings={settings.settings}
                saving={settings.saving}
                note={settings.note}
                onSave={settings.save}
                onCreateDir={settings.createDir}
              />
              )}

          {createOpen
            ? <CreateTaskForm api={api} onCreated={created} onClose={() => { setCreateOpen(false) }} />
            : null}

          <TaskList
            tasks={list.tasks}
            phase={list.phase}
            error={list.error}
            autoRetries={list.autoRetries}
            resetSignal={listEpoch}
            onRetry={list.retry}
            onCreate={() => { setCreateOpen(true) }}
            onRun={list.run}
            onToggle={list.toggle}
            onOpen={list.openSession}
            onHistory={setHistoryOf}
            onEdit={setEditOf}
            onRemove={list.remove}
          />
        </div>
      </div>

      {historyOf === null
        ? null
        : (
          <HistoryDrawer
            api={api}
            task={historyOf}
            onClose={() => { setHistoryOf(null) }}
            onOpenSession={navigate}
          />
          )}

      {editOf === null
        ? null
        : (
          <EditDialog
            key={editOf.id}
            api={api}
            task={editOf}
            onClose={() => { setEditOf(null) }}
            onSaved={saved}
          />
          )}
    </section>
  )
}
