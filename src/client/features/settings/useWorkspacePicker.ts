/**
 * 「选择工作区」的数据层：列表与目录地址校验。
 *
 * 组件只负责展示；所有请求都在这里收口，失败统一转成可显示的文案。
 */
import { useCallback, useEffect, useState } from 'react'
import type { WorkspaceCheckResult, WorkspaceOption } from '../../../protocol.ts'
import { hostErrorText } from '../../api/errors.ts'
import type { AtanDailyApi } from '../../api/tasks.ts'
import { t } from '../../i18n/index.ts'

/** 选择器数据层。 */
export interface WorkspacePickerController {
  workspaces: WorkspaceOption[]
  loading: boolean
  error: string
  reload: () => void
  check: (path: string) => Promise<WorkspaceCheckResult | null>
}

/**
 * 读取工作区列表并提供校验动作。
 * @param api - host 端点集合。
 * @returns 列表状态与校验函数。
 */
export function useWorkspacePicker(api: AtanDailyApi): WorkspacePickerController {
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([])
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string>('')

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      setWorkspaces(await api.listWorkspaces())
      setError('')
    } catch (failure: unknown) {
      setError(`${t('workspaceLoadFailed')} ${hostErrorText(failure, t)}`)
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => {
    void load()
  }, [load])

  const check = useCallback(async (path: string): Promise<WorkspaceCheckResult | null> => {
    try {
      return await api.checkWorkspace(path)
    } catch {
      return null
    }
  }, [api])

  return {
    workspaces,
    loading,
    error,
    reload: () => { void load() },
    check,
  }
}
