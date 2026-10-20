/**
 * 工作目录设置的唯一数据所有者。
 *
 * 读取、保存、创建目录三个动作都在这里；组件只负责编辑态的展示。
 */
import { useCallback, useEffect, useState } from 'react'
import type { SettingsView } from '../../../protocol.ts'
import { hostErrorText } from '../../api/errors.ts'
import type { AtanDailyApi } from '../../api/tasks.ts'
import { t } from '../../i18n/index.ts'

/** 设置控制器。 */
export interface SettingsController {
  settings: SettingsView | null
  /** 读取设置失败的原因；任务列表可以独立成功。 */
  error: string
  saving: boolean
  /** 保存/创建目录后的提示（成功或失败）。 */
  note: string
  save: (workDir: string | null) => Promise<boolean>
  createDir: () => Promise<boolean>
  reload: () => void
}

/**
 * 读取并修改工作目录设置。
 * @param api - host 端点集合。
 * @param onChanged - 目录变化后的回调（页面借此重拉任务列表）。
 * @returns 设置状态与动作。
 */
export function useSettings(api: AtanDailyApi, onChanged: () => void): SettingsController {
  const [settings, setSettings] = useState<SettingsView | null>(null)
  const [error, setError] = useState<string>('')
  const [saving, setSaving] = useState<boolean>(false)
  const [note, setNote] = useState<string>('')

  const load = useCallback(async (): Promise<void> => {
    try {
      setSettings(await api.loadSettings())
      setError('')
    } catch (failure: unknown) {
      setError(hostErrorText(failure, t))
    }
  }, [api])

  useEffect(() => {
    void load()
  }, [load])

  const save = useCallback(async (workDir: string | null): Promise<boolean> => {
    if (saving) return false
    setSaving(true)
    setNote('')
    try {
      const updated = await api.saveWorkDir(workDir)
      setSettings(updated)
      setNote(updated.workspaceError === undefined
        ? t('savedWithWorkspace')
        : `${t('workspaceFailed')}：${updated.workspaceError}`)
      onChanged()
      return true
    } catch (failure: unknown) {
      setNote(`${t('saveSettingsFailed')} ${hostErrorText(failure, t)}`)
      return false
    } finally {
      setSaving(false)
    }
  }, [api, onChanged, saving])

  const createDir = useCallback(async (): Promise<boolean> => {
    if (saving) return false
    setSaving(true)
    setNote('')
    try {
      const updated = await api.createDirectory()
      setSettings(updated)
      setNote(updated.dirExists ? t('savedWithWorkspace') : t('createDirFailed'))
      return updated.dirExists
    } catch (failure: unknown) {
      setNote(`${t('createDirFailed')} ${hostErrorText(failure, t)}`)
      return false
    } finally {
      setSaving(false)
    }
  }, [api, saving])

  return {
    settings,
    error,
    saving,
    note,
    save,
    createDir,
    reload: () => { void load() },
  }
}
