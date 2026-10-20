import { describe, expect, it } from 'vitest'
import { formatDuration, formatRunTime } from '../src/client/shared/format.ts'

describe('formatDuration', () => {
  it('小于一分钟显示秒', () => {
    expect(formatDuration(0)).toBe('0s')
    expect(formatDuration(8_400)).toBe('8s')
  })

  it('分钟与小时补齐两位', () => {
    expect(formatDuration(61_000)).toBe('1m01s')
    expect(formatDuration(3_600_000)).toBe('1h00m')
    expect(formatDuration(3_930_000)).toBe('1h05m')
  })

  it('未知时长显示破折号', () => {
    expect(formatDuration(null)).toBe('—')
    expect(formatDuration(undefined)).toBe('—')
  })
})

describe('formatRunTime', () => {
  it('按任务时区解释 UTC 时间', () => {
    expect(formatRunTime('2026-10-18T01:00:00.000Z', 'Asia/Shanghai')).toBe('2026-10-18 09:00')
  })

  it('跨日也能算对', () => {
    expect(formatRunTime('2026-10-18T17:30:00.000Z', 'Asia/Shanghai')).toBe('2026-10-19 01:30')
  })

  it('非法时间原样返回', () => {
    expect(formatRunTime('not-a-date')).toBe('not-a-date')
  })

  it('非法时区回退到本地时钟（不抛错）', () => {
    expect(formatRunTime('2026-10-18T01:00:00.000Z', 'Not/AZone')).toMatch(/^2026-10-18 /)
  })
})
