import { describe, expect, it } from 'vitest'
import { parseCron } from '../../src/core/cron.js'
import {
  compareReportNames,
  folderNameOf,
  frequencyOf,
  latestReportName,
  reportNameOf,
} from '../../src/host/naming.js'

describe('folderNameOf', () => {
  it('replaces Windows-forbidden characters and collapses whitespace', () => {
    expect(folderNameOf('a/b:c*d?')).toBe('a b c d')
    expect(folderNameOf('  a   b. ')).toBe('a b')
  })

  it('avoids Windows device names', () => {
    expect(folderNameOf('CON')).toBe('CON_')
    expect(folderNameOf('com1')).toBe('com1_')
  })

  it('rejects a name with no usable characters', () => {
    expect(() => folderNameOf('...')).toThrow(/不能用作目录名/)
  })

  it('truncates by code point so surrogate pairs stay intact', () => {
    const name = folderNameOf('a'.repeat(95) + '😀b')
    expect([...name]).toHaveLength(96)
    expect(name.length).toBe(97)
    // No dangling high surrogate at the end.
    expect(/[\uD800-\uDBFF]$/u.test(name)).toBe(false)
  })
})

describe('reportNameOf', () => {
  it('renders the instant in the task time zone', () => {
    expect(reportNameOf(new Date('2026-10-18T01:00:00Z'), 'Asia/Shanghai')).toBe('2026-10-18-090000.md')
  })

  it('uses the earlier repeated local time in a fall-back zone', () => {
    expect(reportNameOf(new Date('2026-11-01T05:30:00Z'), 'America/New_York')).toBe('2026-11-01-013000.md')
  })
})

describe('frequencyOf', () => {
  it('classifies daily, hourly and cross-midnight hourly rules', () => {
    expect(frequencyOf(parseCron('0 9 * * *'))).toBe('daily')
    expect(frequencyOf(parseCron('*/30 9 * * *'))).toBe('hourly')
    expect(frequencyOf(parseCron('0 23,0 * * *'))).toBe('hourly')
    expect(frequencyOf(parseCron('0 9,10 * * *'))).toBe('hourly')
    expect(frequencyOf(undefined)).toBe('on-demand')
  })
})

describe('latestReportName', () => {
  it('orders by fixed-width timestamp, then numeric suffix', () => {
    const names = [
      '2026-10-18-090000.md',
      '2026-10-18-090000-2.md',
      '2026-10-18-090000-10.md',
      'notes.md',
    ]
    expect([...names].sort(compareReportNames)).toEqual([
      'notes.md',
      '2026-10-18-090000.md',
      '2026-10-18-090000-2.md',
      '2026-10-18-090000-10.md',
    ])
    expect(latestReportName(names)).toBe('2026-10-18-090000-10.md')
  })

  it('returns undefined when there is no report', () => {
    expect(latestReportName([])).toBeUndefined()
    expect(latestReportName(['notes.md'])).toBeUndefined()
  })
})
