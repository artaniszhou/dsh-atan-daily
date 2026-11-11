/**
 * 设置区两行：工作区 + 任务仓库地址。
 *
 * 工作区就是 DSH 的工作区：既可以从已注册工作区里选，也可以输入目录地址新建
 * （不存在时创建目录并注册为工作区）。选择与校验的细节在 `WorkspaceDialog`。
 *
 * 任务仓库地址是上传任务、任务仓库与任务详情用的后端地址；页面保存的值
 * 覆盖 `cordis.patch.yml` 的 `serverBaseUrl`，留空表示回到 yaml 默认值。
 */
import { useEffect, useRef, useState } from 'react'
import type { SettingsView } from '../../../protocol.ts'
import type { AtanDailyApi } from '../../api/tasks.ts'
import { t, type CopyKey } from '../../i18n/index.ts'
import { Button, TextInput } from '../../ui/primitives.tsx'
import { WorkspaceDialog } from './WorkspaceDialog.tsx'
import css from './settings.module.css'

/**
 * 复制一段文本。优先用 Clipboard API；HTTP 页面（非安全上下文）没有它时
 * 退回隐藏 textarea + `execCommand('copy')`。
 * @param text - 要复制的文本。
 * @returns 是否成功。
 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard !== undefined) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 落到下面的兜底。
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const copied = document.execCommand('copy')
    area.remove()
    return copied
  } catch {
    return false
  }
}

/** 建议值来源的说明文案。 */
const SOURCE_KEYS: Record<SettingsView['suggestedWorkDirSource'], CopyKey> = {
  config: 'suggestedFromConfig',
  'default-workspace': 'suggestedFromDefaultWorkspace',
  documents: 'suggestedFromDocuments',
  fallback: 'suggestedFromFallback',
}

/** 设置行属性。 */
export interface SettingsLineProps {
  api: AtanDailyApi
  settings: SettingsView
  saving: boolean
  note: string
  onSave: (workDir: string | null) => Promise<boolean>
  /** 保存任务仓库地址；null 表示清除覆盖。 */
  onSaveServerUrl: (serverBaseUrl: string | null) => Promise<boolean>
  onCreateDir: () => Promise<boolean>
}

/** 工作区与任务仓库地址设置区。 */
export function SettingsLine({ api, settings, saving, note, onSave, onSaveServerUrl, onCreateDir }: SettingsLineProps) {
  /** 选择工作区弹窗是否打开。 */
  const [pickerOpen, setPickerOpen] = useState<boolean>(false)
  /** 是否显示全部工作区；本次页面会话内记住，刷新后回到默认（只看用过的）。 */
  const [showAll, setShowAll] = useState<boolean>(false)
  /** 复制路径后的短暂提示。 */
  const [copyNotice, setCopyNotice] = useState<string>('')
  const copyTimer = useRef<number | undefined>(undefined)
  /** 任务仓库地址行是否处于编辑态，以及未保存的草稿。 */
  const [urlEditing, setUrlEditing] = useState<boolean>(false)
  const [urlDraft, setUrlDraft] = useState<string>('')

  useEffect(() => () => {
    if (copyTimer.current !== undefined) window.clearTimeout(copyTimer.current)
  }, [])

  const configured = settings.workDirConfigured
  const title = settings.workspace?.title ?? ''
  const urlPlaceholder = settings.defaultServerBaseUrl === '' ? 'http://10.0.0.12:8080' : settings.defaultServerBaseUrl

  /** 点击工作区标题：复制完整路径，并短暂提示。 */
  const copyPath = async (): Promise<void> => {
    const copied = await copyText(settings.workDir)
    setCopyNotice(copied ? t('pathCopied') : t('pathCopyFailed'))
    if (copyTimer.current !== undefined) window.clearTimeout(copyTimer.current)
    copyTimer.current = window.setTimeout(() => { setCopyNotice('') }, 1600)
  }

  /** 未配置时一键采用宿主给的平台建议工作区；只有点了才会建目录。 */
  const useSuggested = async (): Promise<void> => {
    if (saving || settings.suggestedWorkDir === '') return
    await onSave(settings.suggestedWorkDir)
  }

  /** 注册被删：把当前目录重新注册为工作区。 */
  const reRegister = async (): Promise<void> => {
    if (saving || settings.workDir === '') return
    await onSave(settings.workDir)
  }

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

  return (
    <>
      <div className={css.line} aria-label={t('settingsTitle')}>
        <span className={css.label}>{`${t('workDirLabel')}：`}</span>
        {configured
          ? (
            <button
              type="button"
              className={css.workspaceName}
              title={settings.workDir}
              aria-label={`${title === '' ? settings.workDir : title} ${t('copyWorkspacePath')}`}
              onClick={() => { void copyPath() }}
            >
              {title === '' ? settings.workDir : title}
            </button>
            )
          : <span className={css.path}>{t('workDirUnset')}</span>}
        {copyNotice === '' ? null : <span className={css.copyHint} role="status" aria-live="polite">{copyNotice}</span>}
        {configured
          ? null
          : (
            <Button
              size="sm"
              variant="primary"
              disabled={saving || settings.suggestedWorkDir === ''}
              onClick={() => { void useSuggested() }}
            >
              {t('useSuggestedDir')}
            </Button>
            )}
        <Button
          size="sm"
          variant="quiet"
          disabled={saving}
          onClick={() => { setPickerOpen(true) }}
        >
          {t('pickDir')}
        </Button>
        {settings.workspaceState === 'missing'
          ? <Button size="sm" variant="quiet" disabled={saving} onClick={() => { void onCreateDir() }}>{t('createDir')}</Button>
          : null}
      </div>

      {configured
        ? null
        : (
          <div className={css.suggestion}>
            {`${t('suggestedPrefix')}${settings.suggestedWorkDir}`}
            {settings.suggestedWorkDirSource === 'fallback' ? '' : `（${t(SOURCE_KEYS[settings.suggestedWorkDirSource])}）`}
          </div>
          )}

      {settings.workspaceState === 'missing'
        ? <div className={css.warning} role="alert">{t('workspaceMissing')}</div>
        : null}
      {settings.workspaceState === 'unregistered'
        ? (
          <div className={css.warning} role="alert">
            {t('workspaceUnregistered')}
            <Button size="sm" variant="primary" disabled={saving} onClick={() => { void reRegister() }}>{t('workspaceReRegister')}</Button>
          </div>
          )
        : null}

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

      {pickerOpen
        ? (
          <WorkspaceDialog
            api={api}
            hostPlatform={settings.hostPlatform}
            saving={saving}
            showAll={showAll}
            onShowAllChange={setShowAll}
            onApply={onSave}
            onClose={() => { setPickerOpen(false) }}
          />
          )
        : null}
    </>
  )
}
