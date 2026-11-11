/**
 * 编辑抽屉：任务细节、调度时间、时区、历史保留天数、权限级别与会话方式。
 *
 * 任务细节直接编辑任务根目录的 `task-detail.md`：内容太长不适合塞进列表，
 * 抽屉里给一个多行输入框，保存时只在内容变化后才提交。
 *
 * 一个输入框承载时间，三个单选只决定它怎么被解析；“仅手动”等价于清空输入，
 * 不再用隐藏 tab 的方式表达。保存前先做与 Host 一致的本地校验。
 *
 * 权限级别默认“工作区内修改”：只能读写工作区内的文件；需要跨目录读写时
 * 才切到“完全权限”。该值按任务保存，下一次执行即生效。
 *
 * 会话方式默认每次运行新建会话；关掉后复用上一次会话，适合需要跨轮次积累上下文
 * 的选题。开关按任务保存，下一次执行即生效。
 */
import { useId, useState } from 'react'
import { HISTORY_DAYS_MAX, type OutputFormat, type PermissionLevel, type TaskRecord } from '../../../protocol.ts'
import { hostErrorText } from '../../api/errors.ts'
import type { AtanDailyApi } from '../../api/tasks.ts'
import { t } from '../../i18n/index.ts'
import { Dialog } from '../../ui/dialog.tsx'
import { Button, Field, Switch, TextArea, TextInput } from '../../ui/primitives.tsx'
import { isValidTimeZone, TimeZoneField } from '../../ui/timezone-field.tsx'
import { draftOf, parseHistoryDays, schedulePatch } from './schedule.ts'
import css from './edit.module.css'

/** 编辑抽屉属性。 */
export interface EditDrawerProps {
  api: AtanDailyApi
  task: TaskRecord
  /** 当前宿主是否有 Chrome/Edge；没有时不能选 PNG。 */
  browserAvailable: boolean
  onClose: () => void
  onSaved: (task: TaskRecord) => void
  /** 把当前编辑中的内容交给上传向导。 */
  onUpload?: (task: TaskRecord, details: string) => void
}

/** 编辑抽屉。 */
export function EditDrawer({ api, task, browserAvailable, onClose, onSaved, onUpload }: EditDrawerProps) {
  const initial = draftOf(task)
  const [name, setName] = useState<string>(task.name)
  const [details, setDetails] = useState<string>(task.details)
  const [mode, setMode] = useState(initial.mode)
  const [value, setValue] = useState<string>(initial.value)
  const [zone, setZone] = useState<string>(task.timeZone)
  const [days, setDays] = useState<string>(String(task.historyDays ?? 7))
  const [permission, setPermission] = useState<PermissionLevel>(task.permissionLevel)
  const [outputFormat, setOutputFormat] = useState<OutputFormat>(
    task.outputFormat === 'png' && !browserAvailable ? 'pdf' : task.outputFormat,
  )
  const [newSession, setNewSession] = useState<boolean>(task.newSession)
  const [saving, setSaving] = useState<boolean>(false)
  const [error, setError] = useState<string>('')
  const nameFieldId = useId()
  const detailsId = useId()

  /** 切换到另一种解析方式时清空输入，避免把上一侧的文本当成新语法提交。 */
  const selectMode = (next: typeof mode): void => {
    setMode(next)
    setError('')
    if (next !== mode) setValue('')
  }

  const hint = mode === 'manual'
    ? t('scheduleEmptyHint')
    : mode === 'cron' ? t('cronHelp') : t('scheduleTextHelp')

  const save = (): void => {
    if (saving) return
    const nextName = name.trim()
    if (nextName === '') {
      setError(t('nameRequired'))
      return
    }
    const daysResult = parseHistoryDays(days)
    if (!daysResult.ok) {
      setError(t(daysResult.error))
      return
    }
    const scheduleResult = schedulePatch({ mode, value })
    if (!scheduleResult.ok) {
      setError(t(scheduleResult.error))
      return
    }
    if (!isValidTimeZone(zone)) {
      setError(t('timeZoneInvalid'))
      return
    }
    setSaving(true)
    setError('')
    void api.patchTask(task.taskId, {
      // 改名会连带把任务目录改成新名字；同名时不提交，避免白跑一次 rename。
      ...(nextName === task.name ? {} : { name: nextName }),
      // 没改动就不提交，避免把抽屉打开期间别处写入的细节覆盖掉。
      ...(details === task.details ? {} : { details }),
      schedule: scheduleResult.schedule,
      timeZone: zone.trim(),
      historyDays: daysResult.days,
      permissionLevel: permission,
      outputFormat,
      newSession,
    }).then(onSaved).catch((failure: unknown) => {
      setError(hostErrorText(failure, t))
    }).finally(() => {
      setSaving(false)
    })
  }

  const radio = (next: typeof mode, label: string) => (
    <label className={css.radioLabel}>
      <input
        type="radio"
        name="atan-daily-schedule-mode"
        className={css.radio}
        checked={mode === next}
        disabled={saving}
        onChange={() => { selectMode(next) }}
      />
      {label}
    </label>
  )

  const permissionRadio = (next: PermissionLevel, label: string) => (
    <label className={css.radioLabel}>
      <input
        type="radio"
        name="atan-daily-permission"
        className={css.radio}
        checked={permission === next}
        disabled={saving}
        onChange={() => { setPermission(next); setError('') }}
      />
      {label}
    </label>
  )

  const formatRadio = (next: OutputFormat, label: string) => (
    <label className={css.radioLabel}>
      <input
        type="radio"
        name="atan-daily-format"
        className={css.radio}
        checked={outputFormat === next}
        disabled={saving || (next === 'png' && !browserAvailable)}
        onChange={() => { setOutputFormat(next); setError('') }}
      />
      {label}
    </label>
  )

  return (
    <Dialog
      variant="drawer"
      title={t('editTitle')}
      subtitle={task.name}
      closeLabel={t('runsClose')}
      onClose={onClose}
      footer={(
        <>
          <Button variant="quiet" disabled={saving} onClick={onClose}>{t('cancel')}</Button>
          {onUpload === undefined
            ? null
            : (
              <Button
                variant="quiet"
                disabled={saving}
                onClick={() => { onUpload(task, details) }}
              >
                上传任务
              </Button>
              )}
          <Button variant="primary" disabled={saving} onClick={save}>
            {saving ? t('loading') : t('save')}
          </Button>
        </>
      )}
    >
      <div className={css.editBody}>
        {/* 名称是单行输入：说明与标题同一行，避免在名称和任务详情之间多占一行。 */}
        <div className={css.nameField}>
          <div className={css.nameHead}>
            <label className={css.nameLabel} htmlFor={nameFieldId}>{t('nameLabel')}</label>
            <span className={css.nameHint}>{t('editNameHint')}</span>
          </div>
          <TextInput
            id={nameFieldId}
            type="text"
            value={name}
            disabled={saving}
            placeholder={t('namePlaceholder')}
            aria-label={t('nameLabel')}
            onChange={(event) => { setName(event.currentTarget.value); setError('') }}
          />
        </div>

        <Field label={t('detailsLabel')} htmlFor={detailsId} hint={t('detailsEditHint')} className={css.detailsField}>
          <TextArea
            id={detailsId}
            value={details}
            rows={10}
            disabled={saving}
            placeholder={t('detailsPlaceholder')}
            onChange={(event) => { setDetails(event.currentTarget.value); setError('') }}
          />
        </Field>

        <div className={css.editField}>
          <span className={css.radioLabel}>{t('scheduleValueLabel')}</span>
          <div className={css.scheduleLine}>
            <TextInput
              type="text"
              value={value}
              disabled={saving || mode === 'manual'}
              placeholder={mode === 'manual'
                ? t('scheduleEmptyHint')
                : mode === 'cron' ? '0 7 * * *' : t('scheduleTextPlaceholder')}
              aria-label={t('scheduleValueLabel')}
              onChange={(event) => { setValue(event.currentTarget.value); setError('') }}
            />
            <div className={css.radioGroup} role="radiogroup" aria-label={t('scheduleModeLabel')}>
              {radio('text', t('scheduleModeText'))}
              {radio('cron', t('scheduleModeCron'))}
              {radio('manual', t('scheduleModeManual'))}
            </div>
          </div>
          <span className={css.radioLabel}>{hint}</span>
          {mode === 'manual'
            ? <span className={css.manualNote}>{t('scheduleManualNote')}</span>
            : null}
        </div>

        <div className={css.editRow}>
          <Field label={t('tzLabel')}>
            <TimeZoneField value={zone} disabled={saving} onChange={setZone} />
          </Field>
          <Field label={t('historyDaysLabel')} hint={`${t('historyDaysUnit')} · ${t('historyDaysHint')}`}>
            <TextInput
              type="number"
              min={0}
              max={HISTORY_DAYS_MAX}
              step={1}
              value={days}
              aria-label={t('historyDaysLabel')}
              onChange={(event) => { setDays(event.currentTarget.value); setError('') }}
            />
          </Field>
        </div>

        <div className={css.permission}>
          <span className={css.permissionTitle}>{t('formatLabel')}</span>
          <div className={css.radioGroup} role="radiogroup" aria-label={t('formatLabel')}>
            {formatRadio('pdf', t('formatPdf'))}
            {formatRadio('png', t('formatPng'))}
          </div>
          <span className={css.permissionHint}>
            {!browserAvailable
              ? t('formatPngUnavailable')
              : outputFormat === 'png' ? t('formatPngHint') : t('formatPdfHint')}
          </span>
        </div>

        <div className={css.permission}>
          <span className={css.permissionTitle}>{t('permissionLabel')}</span>
          <div className={css.radioGroup} role="radiogroup" aria-label={t('permissionLabel')}>
            {permissionRadio('workspace-write', t('permissionWorkspace'))}
            {permissionRadio('danger-full-access', t('permissionFull'))}
          </div>
          <span className={css.permissionHint}>
            {permission === 'danger-full-access' ? t('permissionFullHint') : t('permissionWorkspaceHint')}
          </span>
        </div>

        <div className={css.behavior}>
          <span className={css.behaviorText}>
            <span className={css.behaviorTitle}>{t('newSessionLabel')}</span>
            <span className={css.behaviorHint}>{t('newSessionHint')}</span>
          </span>
          <Switch
            checked={newSession}
            disabled={saving}
            label={t('newSessionLabel')}
            onChange={setNewSession}
          />
        </div>

        {error === '' ? null : <p className={css.formError} role="alert">{error}</p>}
      </div>
    </Dialog>
  )
}
