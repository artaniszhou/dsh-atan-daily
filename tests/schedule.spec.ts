import { describe, expect, it } from 'vitest'
import { draftOf, parseHistoryDays, schedulePatch } from '../src/client/features/edit/schedule.ts'
import { task } from './fixtures.ts'

describe('draftOf', () => {
  it('按模式取出输入框初值', () => {
    expect(draftOf(task({ scheduleMode: 'text', scheduleText: '每天 9 点' }))).toEqual({ mode: 'text', value: '每天 9 点' })
    expect(draftOf(task({ scheduleMode: 'cron', cron: '0 9 * * *', scheduleText: '每天 9 点' }))).toEqual({ mode: 'cron', value: '0 9 * * *' })
    expect(draftOf(task({ scheduleMode: 'manual' }))).toEqual({ mode: 'manual', value: '' })
  })
})

describe('schedulePatch', () => {
  it('仅手动不需要输入', () => {
    expect(schedulePatch({ mode: 'manual', value: '忽略' })).toEqual({ ok: true, schedule: { mode: 'manual' } })
  })

  it('语义模式保留用户说法', () => {
    expect(schedulePatch({ mode: 'text', value: '  每天 9 点  ' })).toEqual({
      ok: true,
      schedule: { mode: 'text', text: '每天 9 点' },
    })
  })

  it('cron 模式校验必填', () => {
    expect(schedulePatch({ mode: 'cron', value: '   ' })).toEqual({ ok: false, error: 'cronRequired' })
  })

  it('语义模式校验必填', () => {
    expect(schedulePatch({ mode: 'text', value: '' })).toEqual({ ok: false, error: 'scheduleRequired' })
  })
})

describe('parseHistoryDays', () => {
  it('接受 0 与上限', () => {
    expect(parseHistoryDays('0')).toEqual({ ok: true, days: 0 })
    expect(parseHistoryDays('3650')).toEqual({ ok: true, days: 3650 })
  })

  it('拒绝空值、负数与小数', () => {
    expect(parseHistoryDays('')).toEqual({ ok: false, error: 'historyDaysInvalid' })
    expect(parseHistoryDays('-1')).toEqual({ ok: false, error: 'historyDaysInvalid' })
    expect(parseHistoryDays('1.5')).toEqual({ ok: false, error: 'historyDaysInvalid' })
    expect(parseHistoryDays('3651')).toEqual({ ok: false, error: 'historyDaysInvalid' })
  })
})
