/**
 * 工作目录一行：路径 + 修改/保存/取消；目录不存在时多一个“创建工作目录”。
 *
 * 只读优先：未点“修改”前路径不可编辑，避免误点改掉任务存放位置。
 */
import { useEffect, useState } from 'react'
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
  onCreateDir: () => Promise<boolean>
}

/** 工作目录设置行。 */
export function SettingsLine({ settings, saving, note, onSave, onCreateDir }: SettingsLineProps) {
  const [editing, setEditing] = useState<boolean>(false)
  const [draft, setDraft] = useState<string>(settings.workDir)

  // 外部保存成功后，草稿跟随最新路径；编辑中不打断用户输入。
  useEffect(() => {
    if (!editing) setDraft(settings.workDir)
  }, [settings.workDir, editing])

  const cancel = (): void => {
    setEditing(false)
    setDraft(settings.workDir)
  }

  const submit = (): void => {
    const next = draft.trim() === '' ? null : draft.trim()
    void onSave(next).then((ok) => { if (ok) setEditing(false) })
  }

  return (
    <div className={css.line} aria-label={t('settingsTitle')}>
      <span className={css.label}>{`${t('workDirLabel')}：`}</span>
      {editing
        ? (
          <TextInput
            id="atan-daily-workdir"
            type="text"
            autoFocus
            className={css.input}
            placeholder={t('workDirPlaceholder')}
            value={draft}
            onChange={(event) => { setDraft(event.currentTarget.value) }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit()
              if (event.key === 'Escape') cancel()
            }}
          />
          )
        : <span className={css.path} title={settings.workDir}>{settings.workDir}</span>}
      {editing
        ? (
          <>
            <Button size="sm" variant="primary" disabled={saving} onClick={submit}>{t('save')}</Button>
            <Button size="sm" variant="quiet" disabled={saving} onClick={cancel}>{t('cancel')}</Button>
          </>
          )
        : (
          <>
            <Button
              size="sm"
              variant="quiet"
              onClick={() => { setEditing(true); setDraft(settings.workDir) }}
            >
              {t('edit')}
            </Button>
            {settings.dirExists
              ? null
              : <Button size="sm" variant="quiet" disabled={saving} onClick={() => { void onCreateDir() }}>{t('createDir')}</Button>}
          </>
          )}
      {note === '' ? null : <span className={css.note}>{note}</span>}
    </div>
  )
}
