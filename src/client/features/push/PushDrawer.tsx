/**
 * 「推送机器人」抽屉：针对一个任务，一行一个机器人，右侧绿色开关决定它收不收。
 *
 * 目标与开关都写回任务自己的元数据；接入与移除机器人仍在「机器人管理」。
 * 卡片上不再放开关，任务的推送总开关放在这里：关掉只暂停，选择保留。
 */
import type { BotView, TaskRecord } from '../../../protocol.ts'
import { t } from '../../i18n/index.ts'
import { FeishuGlyph } from '../../ui/brand-icons.tsx'
import { Dialog } from '../../ui/dialog.tsx'
import { Button, Notice, Switch } from '../../ui/primitives.tsx'
import css from './push.module.css'

/** 最近一次发送结果的一行说明。 */
function lastSendText(bot: BotView): string {
  if (bot.lastSend === null) return t('botsLastSendNever')
  return bot.lastSend.ok ? t('botsLastSendOk') : t('botsLastSendFailed')
}

/** 推送机器人抽屉。 */
export function PushDrawer({ task, bots, onToggle, onToggleEnabled, onClose, onManageBots }: {
  task: TaskRecord
  bots: BotView[]
  /** 选中/取消一个机器人；是否同时打开推送由上层决定。 */
  onToggle: (botId: string, on: boolean) => void
  /** 整个任务的推送总开关：关掉保留目标，只暂停发送。 */
  onToggleEnabled: (enabled: boolean) => void
  onClose: () => void
  /** 打开「机器人管理」抽屉去接入或移除。 */
  onManageBots: () => void
}) {
  const paused = !task.pushEnabled && task.pushBotIds.length > 0

  return (
    <Dialog
      variant="drawer"
      title={t('pushBots')}
      subtitle={t('pushBotsFor', { name: task.name })}
      closeLabel={t('runsClose')}
      onClose={onClose}
    >
      {bots.length === 0
        ? (
          <Notice kind="empty">
            <span className={css.emptyTitle}>{t('pushBotsEmpty')}</span>
            <span>{t('pushBotsEmptyHint')}</span>
            <Button variant="primary" size="sm" onClick={onManageBots}>{t('pushBotsAdd')}</Button>
          </Notice>
          )
        : (
          <>
            {task.pushBotIds.length === 0
              ? null
              : (
                <div className={css.master}>
                  <span className={css.masterText}>
                    <span className={css.masterTitle}>{t('pushMaster')}</span>
                    <span className={css.masterHint}>{paused ? t('pushPausedHint') : t('pushMasterHint')}</span>
                  </span>
                  <Switch
                    tone="success"
                    checked={task.pushEnabled}
                    label={task.pushEnabled ? t('pushDisable') : t('pushEnable')}
                    onChange={onToggleEnabled}
                  />
                </div>
                )}
            <ul className={css.rows} aria-label={t('pushBots')}>
              {bots.map(bot => {
                const on = task.pushBotIds.includes(bot.botId)
                return (
                  <li key={bot.botId} className={css.row}>
                    <span className={css.glyph}><FeishuGlyph size={22} /></span>
                    <span className={css.text}>
                      <span className={css.name} title={bot.name}>{bot.name}</span>
                      <span className={css.meta}>{`${bot.appIdMasked} · ${lastSendText(bot)}`}</span>
                    </span>
                    <Switch
                      tone="success"
                      checked={on}
                      label={`${on ? t('pushDisable') : t('pushEnable')}: ${bot.name}`}
                      onChange={next => { onToggle(bot.botId, next) }}
                    />
                  </li>
                )
              })}
            </ul>
            <div className={css.manageRow}>
              <Button size="sm" variant="quiet" onClick={onManageBots}>{t('pushBotsManage')}</Button>
            </div>
          </>
          )}
    </Dialog>
  )
}
