/**
 * 运行历史抽屉：每次运行的状态、耗时、报告、会话与错误。
 *
 * 数据来自 `useRunHistory`；本组件只负责绘制与两个动作（关闭、打开会话）。
 */
import { RUN_PAGE_SIZE, type RunRecord, type TaskRecord } from '../../../protocol.ts'
import type { AtanDailyApi } from '../../api/tasks.ts'
import { t } from '../../i18n/index.ts'
import { formatDuration, formatRunTime } from '../../shared/format.ts'
import { runStatusKey, runTone, triggerKey } from '../../shared/status.ts'
import { Dialog } from '../../ui/dialog.tsx'
import { Badge, Button, LinkButton, Notice } from '../../ui/primitives.tsx'
import { useRunHistory } from './useRunHistory.ts'
import css from './history.module.css'

/** 抽屉属性。 */
export interface HistoryDrawerProps {
  api: AtanDailyApi
  task: TaskRecord
  onClose: () => void
  onOpenSession: (sessionId: string) => void
}

/** 打开一个会话。 */
function openRun(run: RunRecord, onOpenSession: (sessionId: string) => void): void {
  if (run.sessionId !== null) onOpenSession(run.sessionId)
}

/** 运行历史抽屉。 */
export function HistoryDrawer({ api, task, onClose, onOpenSession }: HistoryDrawerProps) {
  const history = useRunHistory(api, task.id)

  let body
  if (history.phase === 'loading') {
    body = <Notice kind="loading">{t('runsLoading')}</Notice>
  } else if (history.phase === 'failed') {
    body = (
      <Notice kind="error">
        <span>{t('runsFailed')}</span>
        {history.error === '' ? null : <span className={css.runError}>{history.error}</span>}
        <Button size="sm" variant="quiet" onClick={history.reload}>{t('retry')}</Button>
      </Notice>
    )
  } else if (history.runs.length === 0) {
    body = <Notice kind="empty">{t('runsEmpty')}</Notice>
  } else {
    body = (
      <>
        {history.runs.map(run => (
          <div key={run.runId} className={css.runCard}>
            <div className={css.runTop}>
              <span className={css.runTime} title={run.startedAt}>
                {formatRunTime(run.startedAt, task.timeZone)}
              </span>
              <Badge tone={runTone(run.status)}>{t(runStatusKey(run.status))}</Badge>
            </div>
            <div className={css.runMeta}>
              <span>{t(triggerKey(run.trigger))}</span>
              <span aria-hidden="true">·</span>
              <span className={css.runDuration}>{formatDuration(run.durationMs)}</span>
              {run.report === null
                ? null
                : (
                  <>
                    <span aria-hidden="true">·</span>
                    <span title={run.report}>
                      {run.report}
                      {run.reportExists === false
                        ? <span className={css.missingReport}>{t('runsMissingReport')}</span>
                        : null}
                    </span>
                  </>
                  )}
              {run.sessionId === null
                ? null
                : (
                  <>
                    <span aria-hidden="true">·</span>
                    <LinkButton onClick={() => { openRun(run, onOpenSession) }}>{t('runsOpen')}</LinkButton>
                  </>
                  )}
            </div>
            {run.error === null
              ? null
              : <div className={css.runError} title={run.error.message}>{`${run.error.code}: ${run.error.message}`}</div>}
          </div>
        ))}
        {history.hasMore && history.runs.length >= RUN_PAGE_SIZE
          ? (
            <div className={css.loadMore}>
              <Button size="sm" variant="quiet" disabled={history.loadingMore} onClick={history.loadMore}>
                {history.loadingMore ? t('loading') : t('runsLoadMore')}
              </Button>
            </div>
            )
          : null}
        {history.error === '' ? null : <div className={css.runError}>{history.error}</div>}
      </>
    )
  }

  return (
    <Dialog
      variant="drawer"
      title={t('runsTitle')}
      subtitle={`${task.name} · ${t('runsRetention')}`}
      closeLabel={t('runsClose')}
      onClose={onClose}
    >
      {body}
    </Dialog>
  )
}
