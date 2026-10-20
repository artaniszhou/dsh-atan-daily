/**
 * 调度输入的纯逻辑：任务 → 草稿、草稿 → 补丁、保留天数校验。
 *
 * 与 Host 的校验保持一致，但错误以文案键返回，界面不需要猜字符串。
 */
import { HISTORY_DAYS_MAX, type ScheduleMode, type TaskRecord, type TaskSchedulePatch } from '../../../protocol.ts'
import type { CopyKey } from '../../i18n/index.ts'

/** 编辑弹窗里的调度草稿。 */
export interface ScheduleDraft {
  mode: ScheduleMode
  value: string
}

/** 调度校验失败。 */
export interface ScheduleFailure {
  ok: false
  error: CopyKey
}

/** 调度校验成功。 */
export interface ScheduleSuccess {
  ok: true
  schedule: TaskSchedulePatch
}

/**
 * 从任务读出编辑弹窗的初始草稿。
 * @param task - 任务。
 * @returns 模式与输入框里的文字。
 */
export function draftOf(task: TaskRecord): ScheduleDraft {
  const mode = task.scheduleMode ?? 'manual'
  if (mode === 'text') return { mode, value: task.scheduleText ?? '' }
  if (mode === 'cron') return { mode, value: task.cron ?? '' }
  return { mode: 'manual', value: '' }
}

/**
 * 把草稿转成 PATCH 的 schedule 字段。
 * @param draft - 草稿。
 * @returns 成功时的补丁，或缺失必填项时的文案键。
 */
export function schedulePatch(draft: ScheduleDraft): ScheduleSuccess | ScheduleFailure {
  const text = draft.value.trim()
  if (draft.mode === 'manual') return { ok: true, schedule: { mode: 'manual' } }
  if (text === '') return { ok: false, error: draft.mode === 'cron' ? 'cronRequired' : 'scheduleRequired' }
  if (draft.mode === 'cron') return { ok: true, schedule: { mode: 'cron', cron: text } }
  return { ok: true, schedule: { mode: 'text', text } }
}

/** 保留天数校验结果。 */
export type HistoryDaysResult = { ok: true, days: number } | { ok: false, error: CopyKey }

/**
 * 校验“历史保留天数”输入。
 * @param raw - 输入框原文。
 * @returns 合法的整数天数，或错误文案键。
 */
export function parseHistoryDays(raw: string): HistoryDaysResult {
  if (raw.trim() === '') return { ok: false, error: 'historyDaysInvalid' }
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0 || value > HISTORY_DAYS_MAX) {
    return { ok: false, error: 'historyDaysInvalid' }
  }
  return { ok: true, days: value }
}
