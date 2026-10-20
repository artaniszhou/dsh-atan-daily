/**
 * 状态语义的唯一来源。
 *
 * 行首的“调度状态”和“最近一次运行结果”是两个维度，颜色不能互相抢：
 *  - `taskState` 回答“它会不会跑”（运行中/已启用/已停用/未设时间）；
 *  - `runTone` 回答“上次跑得怎么样”（成功/失败/超时/中断）。
 */
import type { Frequency, RunStatus, TaskRecord } from '../../protocol.ts'
import type { CopyKey } from '../i18n/index.ts'

/** 语义色调；具体颜色由 `ui/tokens.ts` 映射。 */
export type Tone = 'ok' | 'danger' | 'warn' | 'idle' | 'accent' | 'neutral'

/** 运行状态 → 文案键。 */
const RUN_STATUS_KEYS: Record<RunStatus, CopyKey> = {
  running: 'runStatus.running',
  ok: 'runStatus.ok',
  failed: 'runStatus.failed',
  timeout: 'runStatus.timeout',
  cancelled: 'runStatus.cancelled',
  interrupted: 'runStatus.interrupted',
  skipped: 'runStatus.skipped',
}

/** 触发方式 → 文案键。 */
const TRIGGER_KEYS = {
  schedule: 'trigger.schedule',
  manual: 'trigger.manual',
} as const satisfies Record<'schedule' | 'manual', CopyKey>

/** 报告节奏 → 文案键。 */
const FREQUENCY_KEYS = {
  daily: 'frequency.daily',
  hourly: 'frequency.hourly',
  'on-demand': 'frequency.on-demand',
} as const satisfies Record<Frequency, CopyKey>

/**
 * 报告节奏对应的文案键。
 * @param frequency - 报告节奏。
 * @returns 文案键。
 */
export function frequencyKey(frequency: Frequency): CopyKey {
  return FREQUENCY_KEYS[frequency]
}

/**
 * 运行状态对应的文案键。
 * @param status - 运行状态。
 * @returns 文案键。
 */
export function runStatusKey(status: RunStatus): CopyKey {
  return RUN_STATUS_KEYS[status]
}

/**
 * 触发方式对应的文案键。
 * @param trigger - 触发方式。
 * @returns 文案键。
 */
export function triggerKey(trigger: 'schedule' | 'manual'): CopyKey {
  return TRIGGER_KEYS[trigger]
}

/**
 * 运行状态对应的色调。
 * @param status - 运行状态。
 * @returns 语义色调。
 */
export function runTone(status: RunStatus): Tone {
  if (status === 'ok') return 'ok'
  if (status === 'failed' || status === 'timeout') return 'danger'
  if (status === 'running') return 'accent'
  if (status === 'interrupted') return 'idle'
  return 'neutral'
}

/** 行首调度状态的展示形状。 */
export interface TaskStateView {
  label: CopyKey
  tone: Tone
}

/**
 * 一个任务当前的调度状态。
 * @param task - 任务。
 * @returns 文案键与色调。
 */
export function taskState(task: TaskRecord): TaskStateView {
  if (task.running === true) return { label: 'statusRunning', tone: 'accent' }
  if (task.cron === undefined) return { label: 'statusUnset', tone: 'idle' }
  if (task.enabled) return { label: 'statusEnabled', tone: 'ok' }
  return { label: 'statusPaused', tone: 'idle' }
}
