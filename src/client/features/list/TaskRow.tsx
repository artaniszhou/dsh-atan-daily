/**
 * 列表中的一行任务。
 *
 * 数据进、回调出；没有本地状态。推送不在这里表达——目标机器人统一由右下角的
 * 「推送管理」维护：卡片只展示目标图标和入口，开关在抽屉里。
 */
import type { BotView, TaskRecord } from '../../../protocol.ts'
import { DETAIL_PREVIEW } from '../../constants.ts'
import { t } from '../../i18n/index.ts'
import { formatDuration, formatRunTime } from '../../shared/format.ts'
import { frequencyKey, runStatusKey, runTone, taskState } from '../../shared/status.ts'
import { FeishuGlyph } from '../../ui/brand-icons.tsx'
import { IconHistory, IconPlay, IconRobot } from '../../ui/icons.tsx'
import { Badge, Button, Switch, cx } from '../../ui/primitives.tsx'
import css from './list.module.css'

/** 卡片右下角最多展示几个机器人图标。 */
const MAX_ICONS = 5

/** 行属性。 */
export interface TaskRowProps {
  task: TaskRecord
  /** 全部机器人；行内的推送图标据此解析名字与平台。 */
  bots: BotView[]
  onRun: () => void
  onToggle: () => void
  onOpen: () => void
  onHistory: () => void
  onEdit: () => void
  onRemove: () => void
  /** 打开「推送机器人」抽屉。 */
  onManagePush: () => void
}

/** 一行任务。 */
export function TaskRow({
  task, bots, onRun, onToggle, onOpen, onHistory, onEdit, onRemove, onManagePush,
}: TaskRowProps) {
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

  const targets = task.pushBotIds
    .map(id => bots.find(bot => bot.botId === id))
    .filter((bot): bot is BotView => bot !== undefined)
  const missing = task.pushBotIds.length - targets.length
  const shown = targets.slice(0, MAX_ICONS)
  /** 选过目标但总开关是关的：图标保留但压暗，读屏补一句“已暂停”。 */
  const pushPaused = !task.pushEnabled && task.pushBotIds.length > 0
  const targetNames = targets.map(bot => bot.name).join('、')

  return (
    <li className={css.rowItem}>
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

        {/* 卡片右下角：目标机器人图标 + 入口；开关在抽屉里。 */}
        <div className={css.pushBar}>
          {targets.length === 0
            ? null
            : (
              <span
                className={cx(css.pushIcons, pushPaused && css.pushIconsPaused)}
                role="img"
                aria-label={pushPaused ? `${targetNames} · ${t('pushPaused')}` : targetNames}
              >
                {shown.map(bot => (
                  <span key={bot.botId} className={css.pushIcon} title={bot.name}>
                    {bot.channel === 'feishu' ? <FeishuGlyph size={14} /> : null}
                  </span>
                ))}
              </span>
              )}
          {missing > 0 ? <span className={css.pushMissing} title={t('pushMissingBots')}>!</span> : null}
          <button
            type="button"
            className={css.pushManage}
            aria-haspopup="dialog"
            title={t('pushManageHint')}
            onClick={onManagePush}
          >
            <IconRobot size={14} />
            {t('pushManage')}
          </button>
        </div>
      </div>
    </li>
  )
}
