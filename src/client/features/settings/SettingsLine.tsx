/**
 * 设置区两行：工作目录 + 任务仓库地址。
 *
 * 目录不再通过文本框手改：点击「选择目录」会调用宿主的目录选择器
 * （本地宿主是操作系统原生目录框，远程宿主是宿主的目录浏览框），
 * 选中后先显示候选路径，确认保存才切换并注册 Workspace。
 *
 * 任务仓库地址是上传任务、任务仓库与任务详情用的后端地址；页面保存的值
 * 覆盖 `cordis.patch.yml` 的 `serverBaseUrl`，留空表示回到 yaml 默认值。
 */
import { useState } from 'react'
import type { SettingsView } from '../../../protocol.ts'
import { t } from '../../i18n/index.ts'
import { Button, TextInput } from '../../ui/primitives.tsx'
import css from './settings.module.css'

/** 设置行属性。 */
export interface SettingsLineProps {
  settings: SettingsView
  saving: boolean
  note: string
  onSave: (workDir: string | null) => Promise<boolean>
  /** 保存任务仓库地址；null 表示清除覆盖。 */
  onSaveServerUrl: (serverBaseUrl: string | null) => Promise<boolean>
  onCreateDir: () => Promise<boolean>
  /** 打开宿主的目录选择器；取消时返回 null。 */
  onPick: () => Promise<string | null>
}

/** 工作目录与任务仓库地址设置区。 */
export function SettingsLine({ settings, saving, note, onSave, onSaveServerUrl, onCreateDir, onPick }: SettingsLineProps) {
  /** 已选中、尚未保存的候选路径；null 表示没有待确认的修改。 */
  const [draft, setDraft] = useState<string | null>(null)
  const [picking, setPicking] = useState<boolean>(false)
  const [pickError, setPickError] = useState<string>('')
  /** 地址行是否处于编辑态，以及未保存的草稿。 */
  const [urlEditing, setUrlEditing] = useState<boolean>(false)
  const [urlDraft, setUrlDraft] = useState<string>('')

  /** 打开目录选择器；只记录候选路径，不直接保存。 */
  const choose = async (): Promise<void> => {
    if (picking || saving) return
    setPicking(true)
    setPickError('')
    try {
      const picked = await onPick()
      if (picked === null) return
      const target = picked.trim()
      if (target === '') return
      setDraft(target)
    } catch (error: unknown) {
      setPickError(error instanceof Error ? error.message : String(error))
    } finally {
      setPicking(false)
    }
  }

  /** 保存候选路径；与原路径相同则直接放弃候选。 */
  const apply = async (): Promise<void> => {
    if (draft === null || saving) return
    if (draft === settings.workDir) {
      setDraft(null)
      return
    }
    const ok = await onSave(draft)
    if (ok) setDraft(null)
  }

  /** 放弃候选，保留原路径。 */
  const cancel = (): void => {
    setDraft(null)
    setPickError('')
  }

  /** 进入地址编辑态；草稿取自当前生效值。 */
  const startUrlEdit = (): void => {
    setUrlDraft(settings.serverBaseUrl)
    setUrlEditing(true)
  }

  /** 保存地址；清空表示回到 yaml 默认值。 */
  const applyUrl = async (): Promise<void> => {
    if (saving) return
    const next = urlDraft.trim()
    const ok = await onSaveServerUrl(next === '' ? null : next)
    if (ok) setUrlEditing(false)
  }

  const configured = settings.workDirConfigured
  const shown = draft ?? (configured ? settings.workDir : t('workDirUnset'))
  const urlPlaceholder = settings.defaultServerBaseUrl === '' ? 'http://10.0.0.12:8080' : settings.defaultServerBaseUrl

  /** 未配置时一键采用宿主给的平台建议目录；只有点了才会建目录。 */
  const useSuggested = async (): Promise<void> => {
    if (saving || settings.suggestedWorkDir === '') return
    await onSave(settings.suggestedWorkDir)
  }

  return (
    <>
      <div className={css.line} aria-label={t('settingsTitle')}>
        <span className={css.label}>{`${t('workDirLabel')}：`}</span>
        <span className={css.path} title={shown}>{shown}</span>
        {draft === null
          ? (
            <>
              {configured
                ? null
                : (
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={saving || picking || settings.suggestedWorkDir === ''}
                    onClick={() => { void useSuggested() }}
                  >
                    {t('useSuggestedDir')}
                  </Button>
                  )}
              <Button
                size="sm"
                variant="quiet"
                disabled={saving || picking}
                onClick={() => { void choose() }}
              >
                {picking ? t('pickingDir') : t('pickDir')}
              </Button>
              {!configured || settings.dirExists
                ? null
                : <Button size="sm" variant="quiet" disabled={saving || picking} onClick={() => { void onCreateDir() }}>{t('createDir')}</Button>}
            </>
            )
          : (
            <>
              <Button size="sm" variant="primary" disabled={saving} onClick={() => { void apply() }}>{t('save')}</Button>
              <Button size="sm" variant="quiet" disabled={saving} onClick={cancel}>{t('cancel')}</Button>
            </>
            )}
        {pickError === ''
          ? null
          : <span className={css.error} role="alert">{`${t('pickDirFailed')} ${pickError}`}</span>}
      </div>

      <div className={css.line} aria-label={t('serverUrlLabel')}>
        <span className={css.label}>{`${t('serverUrlLabel')}：`}</span>
        {urlEditing
          ? (
            <>
              <TextInput
                className={css.input}
                value={urlDraft}
                placeholder={urlPlaceholder}
                aria-label={t('serverUrlLabel')}
                disabled={saving}
                autoFocus
                onChange={(event) => { setUrlDraft(event.target.value) }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    void applyUrl()
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    setUrlEditing(false)
                  }
                }}
              />
              <Button size="sm" variant="primary" disabled={saving} onClick={() => { void applyUrl() }}>{t('save')}</Button>
              <Button size="sm" variant="quiet" disabled={saving} onClick={() => { setUrlEditing(false) }}>{t('cancel')}</Button>
            </>
            )
          : (
            <>
              <span className={css.path} title={settings.serverBaseUrl}>
                {settings.serverBaseUrl === '' ? t('serverUrlEmpty') : settings.serverBaseUrl}
              </span>
              <Button size="sm" variant="quiet" disabled={saving} onClick={startUrlEdit}>{t('modify')}</Button>
            </>
            )}
      </div>

      {note === '' ? null : <div className={css.status} role="status">{note}</div>}
    </>
  )
}
