import { describe, expect, it } from 'vitest'
import {
  isKnownTimeZone,
  latestOccurrence,
  nextOccurrence,
  parseCron,
} from '../../src/core/cron.js'

const utc = (iso: string): number => Date.parse(iso)
const asIso = (ms: number | undefined): string | undefined => ms === undefined ? undefined : new Date(ms).toISOString()

describe('parseCron', () => {
  it('expands the documented field forms', () => {
    expect(parseCron('*/15 * * * *').minutes).toEqual([0, 15, 30, 45])
    expect(parseCron('0 9 * * 1-5').daysOfWeek).toEqual([1, 2, 3, 4, 5])
    expect(parseCron('0 9 * * 7').daysOfWeek).toEqual([0])
    expect(parseCron('0 9 1,15 * *').daysOfMonth).toEqual([1, 15])
  })

  it('expands `a/n` from a to the end of the field', () => {
    // A common way to write "every 15 minutes"; it must not collapse to [0].
    expect(parseCron('0/15 * * * *').minutes).toEqual([0, 15, 30, 45])
    expect(parseCron('5/10 * * * *').minutes).toEqual([5, 15, 25, 35, 45, 55])
  })

  it('rejects malformed or non-canonical fields', () => {
    for (const expression of [
      '*/0 * * * *',
      '0 24 * * *',
      '0 9 * * 8',
      '0 9 * *',
      '0 9 * * 1-0',
      '-1 * * * *',
      '-5 * * * *',
      '+5 * * * *',
      '0x10 * * * *',
      '1e1 * * * *',
    ]) {
      expect(() => parseCron(expression), expression).toThrow()
    }
  })
})

describe('occurrences', () => {
  it('finds the next and latest daily occurrence', () => {
    const rule = parseCron('0 9 * * *')
    expect(asIso(nextOccurrence(rule, 'UTC', utc('2026-10-20T08:00:00Z')))).toBe('2026-10-20T09:00:00.000Z')
    expect(asIso(nextOccurrence(rule, 'UTC', utc('2026-10-20T09:00:00Z')))).toBe('2026-10-21T09:00:00.000Z')
    expect(asIso(latestOccurrence(rule, 'UTC', utc('2026-10-20T10:00:00Z')))).toBe('2026-10-20T09:00:00.000Z')
  })

  it('uses Vixie OR semantics when both date fields are restricted', () => {
    const rule = parseCron('0 9 1 * 1')
    const at = nextOccurrence(rule, 'UTC', utc('2026-10-20T00:00:00Z'))
    expect(at).toBeDefined()
    const date = new Date(at as number)
    expect(date.getUTCDate() === 1 || date.getUTCDay() === 1).toBe(true)
  })

  it('skips a local time that does not exist (spring forward)', () => {
    const rule = parseCron('30 2 * * *')
    const at = nextOccurrence(rule, 'America/New_York', utc('2026-03-07T12:00:00Z'))
    // 2026-03-08 02:30 does not exist in New York.
    expect(asIso(at)).toBe('2026-03-09T06:30:00.000Z')
  })

  it('picks the earlier occurrence of a repeated local time (fall back)', () => {
    const rule = parseCron('30 1 * * *')
    const at = nextOccurrence(rule, 'America/New_York', utc('2026-11-01T00:00:00Z'))
    expect(asIso(at)).toBe('2026-11-01T05:30:00.000Z')
  })

  it('recognizes zones and rejects unknown ones', () => {
    expect(isKnownTimeZone('Asia/Shanghai')).toBe(true)
    expect(isKnownTimeZone('UTC')).toBe(true)
    expect(isKnownTimeZone('Bad/Zone')).toBe(false)
  })
})
