/**
 * 新建任务表单。
 *
 * Host 负责根据名称、详情与时间说法生成任务目录与规则文档；这里只收集输入。
 * 时区复用编辑弹窗的同一个选择器，避免“新建填自由文本、编辑用组合框”的割裂。
 */
import { useEffect, useId, useRef, useState } from 'react'
import type { TaskRecord } from '../../../protocol.ts'
import { hostErrorText } from '../../api/errors.ts'
import type { AtanDailyApi } from '../../api/tasks.ts'
import { t } from '../../i18n/index.ts'
import { Button, Field, TextArea, TextInput } from '../../ui/primitives.tsx'
import { isValidTimeZone, TimeZoneField } from '../../ui/timezone-field.tsx'
import css from '../create/create.module.css'

/** 表单属性。 */
export interface CreateTaskFormProps {
  api: AtanDailyApi
  onCreated: (task: TaskRecord) => void
  onClose: () => void
}

/** 浏览器本地时区。 */
function browserZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

/** 新建任务表单。 */
export function CreateTaskForm({ api, onCreated, onClose }: CreateTaskFormProps) {
  const [name, setName] = useState<string>('')
  const [details, setDetails] = useState<string>('')
  const [schedule, setSchedule] = useState<string>('')
  const [zone, setZone] = useState<string>(browserZone)
  const [error, setError] = useState<string>('')
  const [saving, setSaving] = useState<boolean>(false)
  const nameRef = useRef<HTMLInputElement | null>(null)
  const nameId = useId()
  const detailsId = useId()
  const scheduleId = useId()

  // 打开即把光标放进名称框。
  useEffect(() => {
    const handle = window.setTimeout(() => { nameRef.current?.focus() }, 0)
    return () => { window.clearTimeout(handle) }
  }, [])

  const submit = (): void => {
    if (saving) return
    const trimmed = name.trim()
    if (trimmed === '') {
      setError(t('nameRequired'))
      return
    }
    const timeZone = zone.trim() === '' ? browserZone() : zone.trim()
    if (!isValidTimeZone(timeZone)) {
      setError(t('timeZoneInvalid'))
      return
    }
    setSaving(true)
    setError('')
    void api.createTask({
      name: trimmed,
      details,
      schedule: schedule.trim(),
      timeZone,
    }).then(task => {
      onCreated(task)
    }).catch((failure: unknown) => {
      setError(hostErrorText(failure, t))
    }).finally(() => {
      setSaving(false)
    })
  }

  return (
    <form
      className={css.form}
      aria-label={t('createTitle')}
      onSubmit={(event) => { event.preventDefault(); submit() }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.stopPropagation()
        if (!saving) onClose()
      }}
    >
      <Field label={t('nameLabel')} htmlFor={nameId}>
        <TextInput
          id={nameId}
          ref={nameRef}
          type="text"
          value={name}
          placeholder={t('namePlaceholder')}
          onChange={(event) => { setName(event.currentTarget.value); setError('') }}
        />
      </Field>
      <Field label={t('cronLabel')} htmlFor={scheduleId}>
        <TextInput
          id={scheduleId}
          type="text"
          value={schedule}
          placeholder={t('cronPlaceholder')}
          onChange={(event) => { setSchedule(event.currentTarget.value) }}
        />
      </Field>
      <Field label={t('tzLabel')}>
        <TimeZoneField value={zone} disabled={saving} onChange={setZone} />
      </Field>
      <Field label={t('detailsLabel')} htmlFor={detailsId} className={css.fullField}>
        <TextArea
          id={detailsId}
          value={details}
          rows={6}
          placeholder={t('detailsPlaceholder')}
          onChange={(event) => { setDetails(event.currentTarget.value) }}
        />
      </Field>
      {error === '' ? null : <span className={css.formError} role="alert">{error}</span>}
      <span className={css.formActions}>
        <Button type="submit" variant="primary" disabled={saving}>
          {saving ? t('creating') : t('create')}
        </Button>
        <Button type="button" variant="quiet" disabled={saving} onClick={onClose}>{t('cancel')}</Button>
      </span>
    </form>
  )
}
