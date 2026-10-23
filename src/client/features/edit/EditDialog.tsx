/**
 * 编辑弹窗：调度时间、时区、历史保留天数。
 *
 * 一个输入框承载时间，三个单选只决定它怎么被解析；“仅手动”等价于清空输入，
 * 不再用隐藏 tab 的方式表达。保存前先做与 Host 一致的本地校验。
 */
import { useState } from 'react'
import { HISTORY_DAYS_MAX, type TaskRecord } from '../../../protocol.ts'
import { hostErrorText } from '../../api/errors.ts'
import type { AtanDailyApi } from '../../api/tasks.ts'
import { t } from '../../i18n/index.ts'
import { Dialog } from '../../ui/dialog.tsx'
import { Button, Field, TextInput } from '../../ui/primitives.tsx'
import { isValidTimeZone, TimeZoneField } from '../../ui/timezone-field.tsx'
import { draftOf, parseHistoryDays, schedulePatch } from './schedule.ts'
import css from './edit.module.css'

/** 编辑弹窗属性。 */
export interface EditDialogProps {
  api: AtanDailyApi
  task: TaskRecord
  onClose: () => void
  onSaved: (task: TaskRecord) => void
}

/** 编辑弹窗。 */
export function EditDialog({ api, task, onClose, onSaved }: EditDialogProps) {
  const initial = draftOf(task)
  const [mode, setMode] = useState(initial.mode)
  const [value, setValue] = useState<string>(initial.value)
  const [zone, setZone] = useState<string>(task.timeZone)
  const [days, setDays] = useState<string>(String(task.historyDays ?? 7))
  const [saving, setSaving] = useState<boolean>(false)
  const [error, setError] = useState<string>('')

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
    void api.patchTask(task.id, {
      schedule: scheduleResult.schedule,
      timeZone: zone.trim(),
      historyDays: daysResult.days,
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

  return (
    <Dialog
      title={t('editTitle')}
      subtitle={task.name}
      closeLabel={t('runsClose')}
      onClose={onClose}
      footer={(
        <>
          <Button variant="quiet" disabled={saving} onClick={onClose}>{t('cancel')}</Button>
          <Button variant="primary" disabled={saving} onClick={save}>
            {saving ? t('loading') : t('save')}
          </Button>
        </>
      )}
    >
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

      {error === '' ? null : <p className={css.formError} role="alert">{error}</p>}
    </Dialog>
  )
}
