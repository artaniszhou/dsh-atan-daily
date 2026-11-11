/**
 * 「选择工作区」弹窗：可搜索的已注册工作区列表 + 目录地址新建。
 *
 * 规则：默认只显示「atan-daily 用过」的工作区（`hasData`），当前工作区始终显示；
 * 勾选「显示全部工作区」放开限制。地址输入只做展示，校验由 Host 按宿主平台执行。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import type { WorkspaceCheckResult, WorkspaceOption, WorkspacePathErrorCode } from '../../../protocol.ts'
import { t, type CopyKey } from '../../i18n/index.ts'
import { IconSearch } from '../../ui/icons.tsx'
import { Button, cx, TextInput } from '../../ui/primitives.tsx'
import { Dialog } from '../../ui/dialog.tsx'
import { useWorkspacePicker } from './useWorkspacePicker.ts'
import type { AtanDailyApi } from '../../api/tasks.ts'
import css from './workspace-dialog.module.css'

/** 路径错误码到文案键的唯一映射。 */
const PATH_ERROR_KEYS: Record<WorkspacePathErrorCode, CopyKey> = {
  path_empty: 'pathErrorEmpty',
  path_not_absolute: 'pathErrorNotAbsolute',
  path_not_fully_qualified: 'pathErrorNotFullyQualified',
  path_device_form: 'pathErrorDeviceForm',
  path_forbidden_char: 'pathErrorForbiddenChar',
  path_reserved_name: 'pathErrorReservedName',
  path_trailing_dot_space: 'pathErrorTrailingDotSpace',
  path_component_too_long: 'pathErrorComponentTooLong',
  path_too_long: 'pathErrorTooLong',
  path_not_a_directory: 'pathErrorNotADirectory',
  path_unreadable: 'pathErrorUnreadable',
  path_in_settings_root: 'pathErrorInSettingsRoot',
}

/** 校验状态：未输入 / 进行中 / 结果。 */
type CheckState = 'idle' | 'checking' | WorkspaceCheckResult

/** 弹窗属性。 */
export interface WorkspaceDialogProps {
  api: AtanDailyApi
  /** 宿主平台，只用于选占位符。 */
  hostPlatform: 'win32' | 'darwin' | 'linux' | 'other'
  /** 是否有请求在飞行中（保存）。 */
  saving: boolean
  /** 是否显示全部工作区（页面会话内记住，开关在弹窗标题行）。 */
  showAll: boolean
  onShowAllChange: (showAll: boolean) => void
  /** 应用一个路径；返回是否成功。 */
  onApply: (path: string) => Promise<boolean>
  onClose: () => void
}

/** 查询是否命中标题或路径。 */
function matches(option: WorkspaceOption, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (needle === '') return true
  return option.title.toLowerCase().includes(needle) || option.path.toLowerCase().includes(needle)
}

/** 已注册工作区 + 目录地址新建。 */
export function WorkspaceDialog({
  api,
  hostPlatform,
  saving,
  showAll,
  onShowAllChange,
  onApply,
  onClose,
}: WorkspaceDialogProps) {
  const picker = useWorkspacePicker(api)
  const { workspaces, loading, error: listError, reload, check: checkPath } = picker
  const [query, setQuery] = useState<string>('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [pathDraft, setPathDraft] = useState<string>('')
  const [checkState, setCheckState] = useState<CheckState>('idle')
  const [applyError, setApplyError] = useState<string>('')
  const [highlight, setHighlight] = useState<number>(0)
  const searchRef = useRef<HTMLInputElement>(null)
  const checkSeq = useRef<number>(0)

  // Dialog 打开时会把焦点移到关闭键；这里稍后抢回搜索框。
  useEffect(() => {
    const timer = window.setTimeout(() => { searchRef.current?.focus() }, 30)
    return () => { window.clearTimeout(timer) }
  }, [])

  // 地址校验：停顿 300ms，改输入会作废上一次结果。
  useEffect(() => {
    if (selectedId !== null) {
      setCheckState('idle')
      return
    }
    const text = pathDraft.trim()
    if (text === '') {
      setCheckState('idle')
      return
    }
    const seq = checkSeq.current + 1
    checkSeq.current = seq
    setCheckState('checking')
    const timer = window.setTimeout(() => {
      void checkPath(text).then((result) => {
        if (checkSeq.current !== seq) return
        setCheckState(result ?? 'idle')
      })
    }, 300)
    return () => { window.clearTimeout(timer) }
  }, [pathDraft, selectedId, checkPath])

  const scoped = useMemo(
    () => workspaces.filter(option => showAll || option.hasData || option.current),
    [workspaces, showAll],
  )
  const filtered = useMemo(
    () => scoped.filter(option => matches(option, query)),
    [scoped, query],
  )
  const selected = selectedId === null
    ? null
    : workspaces.find(option => option.id === selectedId) ?? null

  useEffect(() => {
    if (highlight >= filtered.length) setHighlight(0)
  }, [filtered.length, highlight])

  // 高亮项保持可见（列表自身滚动，不带动弹窗）。
  useEffect(() => {
    const node = document.getElementById(`atan-daily-workspace-${String(highlight)}`)
    node?.scrollIntoView({ block: 'nearest' })
  }, [highlight, filtered.length, showAll])

  /** 选中一行：回填地址并清掉地址校验态。 */
  const selectRow = (option: WorkspaceOption, index: number): void => {
    setSelectedId(option.id)
    setPathDraft(option.path)
    setHighlight(index)
    setApplyError('')
  }

  /** 清掉选中态；地址由用户自己输入。 */
  const editDraft = (next: string): void => {
    setPathDraft(next)
    setSelectedId(null)
    setApplyError('')
  }

  /** 当前可应用的路径。 */
  const target = selected?.path
    ?? (checkState !== 'idle' && checkState !== 'checking' && checkState.ok ? checkState.normalized : undefined)
  const checking = checkState === 'checking'
  const failed = checkState !== 'idle' && checkState !== 'checking' && !checkState.ok
  const canApply = !saving && !checking && !failed && target !== undefined

  /** 应用当前目标；失败时留在弹窗内。 */
  const apply = async (path?: string): Promise<void> => {
    const next = path ?? target
    if (next === undefined || saving) return
    setApplyError('')
    const ok = await onApply(next)
    if (!ok) {
      setApplyError(t('workspaceApplyFailed'))
      return
    }
    onClose()
  }

  /** 键盘：↑↓ 移动、Enter 应用、Esc 先清搜索。 */
  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (filtered.length > 0) setHighlight(previous => (previous + 1) % filtered.length)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (filtered.length > 0) setHighlight(previous => (previous - 1 + filtered.length) % filtered.length)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const row = filtered[highlight]
      if (row !== undefined) {
        selectRow(row, highlight)
        void apply(row.path)
      }
      return
    }
    if (event.key === 'Escape' && query !== '') {
      // 清空搜索而不是关弹窗；清空后再按一次由 Dialog 关闭。
      event.preventDefault()
      setQuery('')
    }
  }

  /** 校验状态的展示文字。 */
  const checkText = (): string => {
    if (checking) return t('workspaceChecking')
    if (checkState === 'idle') return ''
    if (!checkState.ok) {
      const base = t(PATH_ERROR_KEYS[checkState.code])
      return checkState.detail === undefined ? base : `${base}（${checkState.detail}）`
    }
    if (checkState.isCurrent || checkState.alreadyWorkspace) return t('workspaceSwitchTo')
    return checkState.willCreate ? t('workspaceWillCreate') : t('workspaceExisting')
  }

  const placeholder = hostPlatform === 'win32'
    ? t('workspacePathPlaceholderWin')
    : t('workspacePathPlaceholderPosix')
  const applyLabel = selected !== null || (checkState !== 'idle' && checkState !== 'checking' && checkState.ok && !checkState.willCreate)
    ? t('workspaceSwitch')
    : t('workspaceCreateAndSwitch')

  /** 列表主体：加载 / 错误 / 空态 / 行。 */
  const body = (): ReactNode => {
    if (loading) return <div className={css.status} role="status">{t('workspaceLoading')}</div>
    if (listError !== '') {
      return (
        <div className={css.status} role="alert">
          {listError}
          <Button size="sm" variant="quiet" onClick={reload}>{t('retry')}</Button>
        </div>
      )
    }
    if (scoped.length === 0) {
      return (
        <div className={css.status}>
          <strong>{showAll ? t('workspaceEmptyAll') : t('workspaceEmptyUsed')}</strong>
          <span>{t('workspaceEmptyHint')}</span>
        </div>
      )
    }
    if (filtered.length === 0) return <div className={css.status}>{t('workspaceNoMatch')}</div>
    return filtered.map((option, index) => {
      const isSelected = option.id === selectedId
      return (
        <button
          key={option.id}
          id={`atan-daily-workspace-${String(index)}`}
          type="button"
          role="option"
          aria-selected={isSelected}
          className={cx(css.row, isSelected && css.rowSelected, index === highlight && css.rowHighlight)}
          onMouseEnter={() => { setHighlight(index) }}
          onClick={() => { selectRow(option, index) }}
          onDoubleClick={() => { selectRow(option, index); void apply(option.path) }}
        >
          <span className={css.rowMain}>
            <span className={css.rowTitle}>{option.title}</span>
            <span className={css.rowPath} title={option.path}>{option.path}</span>
          </span>
          {option.current ? <span className={css.badge}>{t('workspaceCurrent')}</span> : null}
        </button>
      )
    })
  }

  return (
    <Dialog
      title={t('workspacePickerTitle')}
      headerExtra={(
        <label className={css.scope}>
          <input
            type="checkbox"
            checked={showAll}
            onChange={(event) => { onShowAllChange(event.currentTarget.checked); setHighlight(0) }}
          />
          <span>{t('workspaceShowAll')}</span>
        </label>
      )}
      closeLabel={t('runsClose')}
      onClose={onClose}
      footer={(
        <>
          <span className={css.switchHint}>{t('workspaceSwitchHint')}</span>
          <span className={css.footerSpacer} />
          <Button variant="quiet" disabled={saving} onClick={onClose}>{t('cancel')}</Button>
          <Button variant="primary" disabled={!canApply} onClick={() => { void apply() }}>{applyLabel}</Button>
        </>
      )}
    >
      <div className={css.search} role="search">
        <span className={css.searchIcon} aria-hidden="true"><IconSearch /></span>
        <TextInput
          ref={searchRef}
          type="search"
          className={css.searchInput}
          value={query}
          placeholder={t('workspaceSearchPlaceholder')}
          aria-label={t('workspaceSearchLabel')}
          aria-controls="atan-daily-workspace-list"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => { setQuery(event.currentTarget.value); setHighlight(0) }}
          onKeyDown={onSearchKeyDown}
        />
        <span className={css.count} aria-live="polite">
          {`${String(filtered.length)} / ${String(scoped.length)}`}
        </span>
      </div>

      <div className={css.list} id="atan-daily-workspace-list" role="listbox" aria-label={t('workspacePickerTitle')}>
        {body()}
      </div>

      <div className={css.section}>{t('workspaceNewSection')}</div>
      <TextInput
        type="text"
        className={css.pathInput}
        value={pathDraft}
        placeholder={placeholder}
        aria-label={t('workspacePathLabel')}
        autoComplete="off"
        spellCheck={false}
        disabled={saving}
        onChange={(event) => { editDraft(event.currentTarget.value) }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            void apply()
          }
        }}
      />
      <div className={cx(css.check, failed && css.checkError)} role="status" aria-live="polite">{checkText()}</div>

      {applyError === ''
        ? null
        : <div className={css.error} role="alert">{applyError}</div>}
    </Dialog>
  )
}
