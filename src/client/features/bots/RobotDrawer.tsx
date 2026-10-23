/**
 * 机器人管理抽屉。
 *
 * 三种视图：列表、选平台、扫码。它们在一个抽屉里切换，不叠模态——
 * 扫码时要看着倒计时，多一层遮罩只会让 Esc 语义变含糊。
 */
import { useEffect, useState } from 'react'
import type { BotView, ProvisionView } from '../../../protocol.ts'
import { t } from '../../i18n/index.ts'
import { Dialog } from '../../ui/dialog.tsx'
import { Badge, Button, cx, Field, Notice, SkeletonList, TextInput } from '../../ui/primitives.tsx'
import { DingtalkGlyph, FeishuGlyph, QqGlyph, WecomGlyph } from '../../ui/brand-icons.tsx'
import type { BotsController } from './useBots.ts'
import css from './bots.module.css'

/** 抽屉属性。 */
export interface RobotDrawerProps {
  bots: BotsController
  onClose: () => void
}

/** 视图。 */
type View = 'list' | 'pick' | 'scan'

/** 把剩余毫秒格式化成 mm:ss。 */
function formatRemaining(milliseconds: number): string {
  const total = Math.max(0, Math.ceil(milliseconds / 1000))
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

/** 只接受 PNG data URL，长度上限 2 MB。 */
function safeQr(value: string | undefined): string | undefined {
  return value !== undefined && value.length <= 2 * 1024 * 1024 && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/u.test(value)
    ? value
    : undefined
}

/** 飞书 / Lark 开发者后台：应用所有者在这里删除应用。 */
function consoleUrl(domain: BotView['domain']): string {
  return domain === 'lark' ? 'https://open.larksuite.com/app' : 'https://open.feishu.cn/app'
}

/** 飞书 / Lark 管理后台：企业管理员在这里停用应用（已发布的应用要先停用才能删）。 */
function adminUrl(domain: BotView['domain']): string {
  return domain === 'lark' ? 'https://www.larksuite.com/admin' : 'https://www.feishu.cn/admin'
}

/** 卡片状态：只看"有没有发出去过"。 */
function statusOf(bot: BotView): { tone: 'ok' | 'warn' | 'danger', text: string } {
  if (bot.lastSend === null) return { tone: 'warn', text: t('botsStatusPending') }
  return bot.lastSend.ok
    ? { tone: 'ok', text: t('botsStatusOk') }
    : { tone: 'danger', text: t('botsStatusFailed') }
}

/** 二维码区域的文案。 */
function scanStatus(provision: ProvisionView): string {
  if (provision.state === 'saving' || provision.state === 'scanned') return t('botsScanStatusSaving')
  if (provision.state === 'connected') return t('botsScanStatusConnecting')
  if (provision.error !== undefined) return provision.error.message
  return t('botsScanStatusWaiting')
}

/** 机器人管理抽屉。 */
export function RobotDrawer({ bots, onClose }: RobotDrawerProps) {
  const [view, setView] = useState<View>(bots.provisioning === null ? 'list' : 'scan')
  const [name, setName] = useState<string>(() => t('botsNameDefault'))
  const [confirming, setConfirming] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [now, setNow] = useState<number>(() => Date.now())

  // 扫码时每秒刷新倒计时；其他视图不需要定时器。
  useEffect(() => {
    if (view !== 'scan') return undefined
    const timer = window.setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { window.clearInterval(timer) }
  }, [view])

  // 接入成功：回到列表并给一次确认，不自动关抽屉（用户常要接着改别名）。
  useEffect(() => {
    if (!bots.justConnected) return undefined
    bots.acknowledge()
    setView('list')
    setNotice(t('botsStatusOk'))
    const timer = window.setTimeout(() => { setNotice('') }, 4000)
    return () => { window.clearTimeout(timer) }
  }, [bots.justConnected])

  // 扫码失败/过期：留在扫码视图展示原因，用户可重新生成。
  const provision = bots.provisioning
  const qr = safeQr(provision?.qrCodeDataUrl)
  const remaining = provision?.expiresAt === undefined ? 0 : provision.expiresAt - now

  let body
  if (view === 'scan') {
    // 二维码一旦生成，飞书侧的应用名就定了；此时锁住输入框，避免"改了但没生效"。
    const locked = provision !== null && !['expired', 'failed', 'cancelled'].includes(provision.state)
    body = (
      <div className={css.scan}>
        <Button size="sm" variant="quiet" onClick={() => { setView(bots.bots.length === 0 ? 'pick' : 'list') }}>
          {`← ${t('botsBack')}`}
        </Button>
        <h3 className={css.scanTitle}>{t('botsScanTitle')}</h3>
        <Field className={css.nameField} label={t('botsNameLabel')} hint={t('botsNameHint')} htmlFor="atan-bot-name">
          <TextInput
            id="atan-bot-name"
            value={name}
            maxLength={24}
            disabled={locked}
            placeholder={t('botsNamePlaceholder')}
            onChange={(event) => { setName(event.target.value) }}
          />
        </Field>
        {qr === undefined
          ? (
            <div className={css.scanIntro}>
              <p className={css.scanIntroHint}>
                {bots.error !== ''
                  ? bots.error
                  : provision?.error?.message ?? t('botsScanBefore')}
              </p>
              <Button
                variant="primary"
                size="sm"
                disabled={bots.busy}
                onClick={() => {
                  const trimmed = name.trim()
                  void bots.begin(trimmed === '' ? undefined : trimmed)
                }}
              >
                {t('botsScanGenerate')}
              </Button>
            </div>
            )
          : (
            <>
              <div className={css.qrPlate}>
                <img className={css.qrImage} src={qr} width={200} height={200} alt={t('botsScanWaiting')} />
              </div>
              <p className={css.scanHint}>{t('botsScanWaiting')}</p>
              {provision?.expiresAt === undefined
                ? null
                : (
                  <p className={cx(css.countdown, remaining <= 30_000 && css.countdownWarn)}>
                    {remaining <= 30_000
                      ? `${t('botsScanExpiring')} · ${formatRemaining(remaining)}`
                      : t('botsScanExpiresIn', { time: formatRemaining(remaining) })}
                  </p>
                  )}
              <p className={css.scanStatus} role="status">
                {provision === null ? t('botsScanStatusWaiting') : scanStatus(provision)}
              </p>
              {bots.error === '' ? null : <p className={css.errorDetail}>{bots.error}</p>}
              <div className={css.scanActions}>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={bots.busy}
                  onClick={() => {
                    const trimmed = name.trim()
                    void bots.begin(trimmed === '' ? undefined : trimmed)
                  }}
                >
                  {t('botsScanRegenerate')}
                </Button>
                <Button size="sm" variant="quiet" onClick={() => { void bots.cancel().then(() => { setView('list') }) }}>
                  {t('botsScanCancel')}
                </Button>
              </div>
            </>
            )}
      </div>
    )
  } else if (view === 'pick') {
    const platforms = [
      { key: 'feishu', enabled: true, label: t('botsPlatformFeishu'), desc: t('botsFeishuDesc'), icon: <FeishuGlyph size={30} /> },
      { key: 'dingtalk', enabled: false, label: t('botsPlatformDingtalk'), desc: t('botsSoonDesc'), icon: <DingtalkGlyph size={30} /> },
      { key: 'wecom', enabled: false, label: t('botsPlatformWecom'), desc: t('botsSoonDesc'), icon: <WecomGlyph size={30} /> },
      { key: 'qq', enabled: false, label: t('botsPlatformQq'), desc: t('botsSoonDesc'), icon: <QqGlyph size={30} /> },
    ] as const
    body = (
      <div className={css.pick}>
        <Button size="sm" variant="quiet" onClick={() => { setView('list') }}>{`← ${t('botsBack')}`}</Button>
        <div className={css.rows}>
          {platforms.map(platform => platform.enabled
            ? (
              <button
                key={platform.key}
                type="button"
                className={css.platformRow}
                disabled={bots.busy}
                onClick={() => { setView('scan') }}
              >
                <span className={css.platformIcon}>{platform.icon}</span>
                <span className={css.platformText}>
                  <span className={css.platformName}>{platform.label}</span>
                  <span className={css.platformDesc}>{platform.desc}</span>
                </span>
                <span className={css.platformChevron} aria-hidden="true">›</span>
              </button>
              )
            : (
              <div key={platform.key} className={css.platformRowSoon} aria-disabled="true">
                <span className={css.platformIcon}>{platform.icon}</span>
                <span className={css.platformText}>
                  <span className={css.platformName}>{platform.label}</span>
                  <span className={css.platformDesc}>{platform.desc}</span>
                </span>
                <span className={css.soonBadge}>{t('botsPlatformSoon')}</span>
              </div>
              ))}
        </div>
      </div>
    )
  } else if (bots.phase === 'loading') {
    body = <SkeletonList label={t('bots')} />
  } else if (bots.phase === 'failed') {
    body = (
      <Notice kind="error">
        <span>{t('botsLoadFailed')}</span>
        {bots.error === '' ? null : <span className={css.errorDetail}>{bots.error}</span>}
        <Button size="sm" variant="quiet" onClick={bots.reload}>{t('retry')}</Button>
      </Notice>
    )
  } else if (bots.bots.length === 0) {
    body = (
      <Notice kind="empty">
        <span className={css.emptyTitle}>{t('botsEmpty')}</span>
        <span>{t('botsEmptyHint')}</span>
        <Button variant="primary" size="sm" disabled={bots.busy} onClick={() => { setView('pick') }}>
          {t('botsAdd')}
        </Button>
      </Notice>
    )
  } else {
    body = (
      <div className={css.list}>
        {notice === '' ? null : <Notice kind="status">{notice}</Notice>}
        {bots.error === '' ? null : <Notice kind="error">{bots.error}</Notice>}
        {bots.bots.map(bot => {
          const status = statusOf(bot)
          return (
            <article key={bot.botId} className={css.card}>
              <div className={css.cardHead}>
                <span className={css.brand}><FeishuGlyph size={24} /></span>
                <div className={css.cardText}>
                  <span className={css.cardName} title={bot.name}>{bot.name}</span>
                  <span className={css.cardMeta}>
                    {bot.appIdMasked}
                    {bot.lastSend === null
                      ? ` · ${t('botsLastSendNever')}`
                      : ` · ${bot.lastSend.ok ? t('botsLastSendOk') : t('botsLastSendFailed')}`}
                  </span>
                </div>
                <Badge tone={status.tone}>{status.text}</Badge>
              </div>

              <div className={css.actions}>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => { setConfirming(bot.botId) }}
                >
                  {t('botsRemove')}
                </Button>
              </div>

              {confirming === bot.botId
                ? (
                  <div className={css.confirm}>
                    <p className={css.confirmText}>{t('botsRemoveKeep')}</p>
                    <ol className={css.removeSteps}>
                      <li>
                        <div className={css.removeStep}>
                          <span className={css.removeStepTitle}>{t('botsRemoveDisableTitle')}</span>
                          <span>{t('botsRemoveDisablePath', { name: bot.name })}</span>
                          <a
                            className={css.removeLink}
                            href={adminUrl(bot.domain)}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {t('botsRemoveDisableOpen')}
                          </a>
                        </div>
                      </li>
                      <li>
                        <div className={css.removeStep}>
                          <span className={css.removeStepTitle}>{t('botsRemoveDeleteTitle')}</span>
                          <span>{t('botsRemoveDeletePath', { name: bot.name })}</span>
                          <a
                            className={css.removeLink}
                            href={consoleUrl(bot.domain)}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {t('botsRemoveDeleteOpen')}
                          </a>
                        </div>
                      </li>
                    </ol>
                    <p className={css.removeNote}>{t('botsRemoveNote')}</p>
                    <div className={css.confirmActions}>
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={bots.busy}
                        onClick={() => { void bots.remove(bot.botId).then(() => { setConfirming(null) }) }}
                      >
                        {t('botsRemoveAction')}
                      </Button>
                      <Button size="sm" variant="quiet" onClick={() => { setConfirming(null) }}>{t('cancel')}</Button>
                    </div>
                  </div>
                  )
                : null}
            </article>
          )
        })}
      </div>
    )
  }

  return (
    <Dialog
      variant="drawer"
      title={t('bots')}
      subtitle={t('botsSubtitle')}
      closeLabel={t('runsClose')}
      onClose={onClose}
      footer={view === 'list' && bots.bots.length > 0
        ? (
          <Button variant="primary" size="sm" disabled={bots.busy} onClick={() => { setView('pick') }}>
            {t('botsAdd')}
          </Button>
          )
        : undefined}
    >
      {body}
    </Dialog>
  )
}
