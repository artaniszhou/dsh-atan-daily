/**
 * 列表中的一行任务。
 *
 * 纯展示：数据进、回调出，不读接口、不持有状态，方便单独渲染测试。
 */
import type { TaskRecord } from '../../../protocol.ts'
import { DETAIL_PREVIEW } from '../../constants.ts'
import { t } from '../../i18n/index.ts'
import { formatDuration, formatRunTime } from '../../shared/format.ts'
import { frequencyKey, runStatusKey, runTone, taskState } from '../../shared/status.ts'
import { IconHistory, IconPlay } from '../../ui/icons.tsx'
import { Badge, Button, Switch } from '../../ui/primitives.tsx'
import css from './list.module.css'

/** 行属性。 */
export interface TaskRowProps {
  task: TaskRecord
  onRun: () => void
  onToggle: () => void
  onOpen: () => void
  onHistory: () => void
  onEdit: () => void
  onRemove: () => void
}

/** 一行任务。 */
export function TaskRow({ task, onRun, onToggle, onOpen, onHistory, onEdit, onRemove }: TaskRowProps) {
  const preview = task.details.length > DETAIL_PREVIEW
    ? `${task.details.slice(0, DETAIL_PREVIEW)}…`
    : task.details
  const schedule = task.cron === undefined
    ? t('noSchedule')
    : `${task.scheduleText ?? task.cron} · ${task.timeZone}`
  const next = task.nextRunAt === undefined || !task.enabled
    ? null
    : `${t('scheduled')} ${formatRunTime(task.nextRunAt, task.timeZone)}`
  const state = taskState(task)
  const running = task.running === true

  return (
    <li>
      <div className={css.row}>
        <div className={css.rowMain}>
          <div className={css.rowBody}>
            <div className={css.rowTitleLine}>
              <Badge tone={state.tone}>{t(state.label)}</Badge>
              <span className={css.rowTitle} title={task.name}>{task.name}</span>
            </div>
            {preview === '' ? null : <span className={css.rowSummary}>{preview}</span>}
            <span className={css.rowMeta}>
              <span>{t(frequencyKey(task.frequency))}</span>
              <span aria-hidden="true">·</span>
              <span>{schedule}</span>
              {next === null ? null : <><span aria-hidden="true">·</span><span>{next}</span></>}
            </span>
            <span className={css.rowMeta}>
              {task.lastStatus === undefined
                ? null
                : <><Badge tone={runTone(task.lastStatus)}>{t(runStatusKey(task.lastStatus))}</Badge><span aria-hidden="true">·</span></>}
              <span>{task.lastRunAt === undefined
                ? t('neverRun')
                : `${t('lastRun')} ${formatRunTime(task.lastRunAt, task.timeZone)}`}</span>
              {task.lastDurationMs === undefined
                ? null
                : <><span aria-hidden="true">·</span><span>{formatDuration(task.lastDurationMs)}</span></>}
              <span aria-hidden="true">·</span>
              <span>{task.report ?? t('noReport')}</span>
              {task.historyCount === 0
                ? null
                : <><span aria-hidden="true">·</span><span>{`${String(task.historyCount)} ${t('history')}`}</span></>}
            </span>
            {task.lastError === undefined
              ? null
              : <span className={css.rowError} title={task.lastError}>{`${t('lastError')}: ${task.lastError}`}</span>}
          </div>
        </div>
        <div className={css.rowActions}>
          <Switch
            checked={task.enabled}
            disabled={task.cron === undefined}
            label={`${task.enabled ? t('switchOn') : t('switchOff')}: ${task.name}`}
            onChange={() => { onToggle() }}
          />
          <Button
            variant="primary"
            size="sm"
            icon={<IconPlay size={14} />}
            disabled={running}
            aria-label={`${t('run')}: ${task.name}`}
            onClick={onRun}
          >
            {running ? t('running') : t('run')}
          </Button>
          <Button
            variant="quiet"
            size="sm"
            icon={<IconHistory size={14} />}
            aria-label={`${t('runs')}: ${task.name}`}
            onClick={onHistory}
          >
            {t('runs')}
          </Button>
          <Button
            variant="quiet"
            size="sm"
            aria-label={`${t('openSession')}: ${task.name}`}
            onClick={onOpen}
          >
            {t('openSession')}
          </Button>
          <Button
            variant="quiet"
            size="sm"
            aria-label={`${t('editTask')}: ${task.name}`}
            onClick={onEdit}
          >
            {t('editTask')}
          </Button>
          <Button
            variant="danger"
            size="sm"
            disabled={running}
            aria-label={`${t('remove')}: ${task.name}`}
            onClick={onRemove}
          >
            {t('remove')}
          </Button>
        </div>
      </div>
    </li>
  )
}
