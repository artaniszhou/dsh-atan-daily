import { describe, expect, it } from 'vitest'
import { parseScheduleText } from '../../src/core/schedule-text.js'

describe('parseScheduleText', () => {
  it.each([
    ['每天9点', '0 9 * * *'],
    ['每天早上8:00', '0 8 * * *'],
    ['每天下午3点半', '30 15 * * *'],
    ['每小时', '0 * * * *'],
    ['每2小时', '0 */2 * * *'],
    ['每 30 分钟', '*/30 * * * *'],
    ['每周一9点', '0 9 * * 1'],
    ['每周一到周五 8点', '0 8 * * 1,2,3,4,5'],
    ['每周一和周四 8点', '0 8 * * 1,4'],
    ['工作日 9点', '0 9 * * 1-5'],
    ['周末10点', '0 10 * * 0,6'],
    ['每月1号9点', '0 9 1 * *'],
    ['每月十五号 8点', '0 8 15 * *'],
    ['daily at 9', '0 9 * * *'],
    ['hourly', '0 * * * *'],
    ['weekdays at 9', '0 9 * * 1-5'],
    ['every monday at 9', '0 9 * * 1'],
    ['monthly on the 1st at 9', '0 9 1 * *'],
    ['每周日 7:00', '0 7 * * 0'],
  ])('normalizes %s', (text, cron) => {
    expect(parseScheduleText(text)?.cron).toBe(cron)
  })

  it('keeps a range plus an extra weekday', () => {
    expect(parseScheduleText('每周一到周五和周日 8点')?.cron).toBe('0 8 * * 0,1,2,3,4,5')
  })

  it('accepts a literal five-field expression', () => {
    expect(parseScheduleText('0 9 * * *')).toEqual({ cron: '0 9 * * *', text: '0 9 * * *' })
  })

  it('returns undefined for an empty phrase (manual only)', () => {
    expect(parseScheduleText('')).toBeUndefined()
  })

  it('throws a readable error for unknown or incomplete phrases', () => {
    expect(() => parseScheduleText('每半年')).toThrow(/无法识别/)
    expect(() => parseScheduleText('每天 9')).toThrow(/请写明时间/)
    expect(() => parseScheduleText('每周一')).toThrow(/请写明时间/)
    expect(() => parseScheduleText('每 90 分钟')).toThrow(/1 到 59/)
  })
})
