import { describe, expect, it } from 'vitest'
import { frequencyKey, runStatusKey, runTone, taskState, triggerKey } from '../src/client/shared/status.ts'
import { task } from './fixtures.ts'

describe('taskState', () => {
  it('执行中优先', () => {
    expect(taskState(task({ running: true }))).toEqual({ label: 'statusRunning', tone: 'accent' })
  })

  it('没有 cron 表示未设时间', () => {
    expect(taskState(task({ cron: undefined }))).toEqual({ label: 'statusUnset', tone: 'idle' })
  })

  it('启用与停用', () => {
    expect(taskState(task({ enabled: true }))).toEqual({ label: 'statusEnabled', tone: 'ok' })
    expect(taskState(task({ enabled: false }))).toEqual({ label: 'statusPaused', tone: 'idle' })
  })
})

describe('runTone', () => {
  it('按状态映射语义色', () => {
    expect(runTone('ok')).toBe('ok')
    expect(runTone('failed')).toBe('danger')
    expect(runTone('timeout')).toBe('danger')
    expect(runTone('running')).toBe('accent')
    expect(runTone('interrupted')).toBe('idle')
    expect(runTone('cancelled')).toBe('neutral')
  })
})

describe('文案键', () => {
  it('状态、触发与节奏都有键', () => {
    expect(runStatusKey('ok')).toBe('runStatus.ok')
    expect(runStatusKey('skipped')).toBe('runStatus.skipped')
    expect(triggerKey('manual')).toBe('trigger.manual')
    expect(frequencyKey('on-demand')).toBe('frequency.on-demand')
  })
})
