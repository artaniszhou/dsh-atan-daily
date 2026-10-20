/**
 * A small five-field cron engine with explicit time-zone handling.
 *
 * The plugin cannot depend on the Harness schedule package's internal cron
 * module, so this file implements the same dialect it documents: five fields
 * (`minute hour day-of-month month day-of-week`), each supporting `*`, a value,
 * `a-b`, `* /n`, `a-b/n`, and comma lists. Day-of-week accepts 0-7 with both
 * 0 and 7 meaning Sunday. When both day-of-month and day-of-week are
 * restricted, a date matches if EITHER matches (Vixie semantics).
 *
 * Wall-clock times are resolved against an IANA zone through `Intl`, so no
 * timezone database dependency is needed. A local time that does not exist
 * (spring-forward gap) is skipped, and a repeated local time (fall-back)
 * resolves to the earlier instant, matching the reminder dialog's documented
 * behaviour.
 */

/** One parsed expression: the matched values of each field. */
export interface CronRule {
  /** Canonical, whitespace-normalized expression. */
  readonly expression: string
  readonly minutes: readonly number[]
  readonly hours: readonly number[]
  readonly daysOfMonth: readonly number[]
  readonly months: readonly number[]
  /** Sunday is 0; a `7` in the source is folded to 0. */
  readonly daysOfWeek: readonly number[]
  /** Whether day-of-month was `*` (a star), which changes the match rule. */
  readonly domStar: boolean
  /** Whether day-of-week was `*` (a star), which changes the match rule. */
  readonly dowStar: boolean
}

/** Ceiling on how far the search walks, matching the schedule package's four-digit-year bound. */
const MAX_SEARCH_DAYS = 366 * 5

/** Field bounds in evaluation order: minute, hour, day-of-month, month, day-of-week. */
const FIELD_LIMITS: readonly { name: string, min: number, max: number, star: boolean }[] = [
  { name: 'minute', min: 0, max: 59, star: true },
  { name: 'hour', min: 0, max: 23, star: true },
  { name: 'day-of-month', min: 1, max: 31, star: true },
  { name: 'month', min: 1, max: 12, star: true },
  { name: 'day-of-week', min: 0, max: 7, star: false },
]

/**
 * Expand one field into the values it matches.
 * @param raw - the field text.
 * @param min - smallest allowed value.
 * @param max - largest allowed value.
 * @param fieldName - field name for the error message.
 * @returns ascending unique values.
 */
function expandField(raw: string, min: number, max: number, fieldName: string): number[] {
  const values = new Set<number>()
  const fail = (detail: string): never => {
    throw new Error(`cron ${fieldName} field ${JSON.stringify(raw)} ${detail}`)
  }
  const addRange = (startText: string, endText: string | undefined, stepText: string | undefined): void => {
    if (startText !== '*' && !/^\d+$/u.test(startText)) {
      fail(`has a non-numeric bound ${JSON.stringify(startText)}`)
    }
    if (endText !== undefined && !/^\d+$/u.test(endText)) {
      fail(`has a non-numeric bound ${JSON.stringify(endText)}`)
    }
    if (stepText !== undefined && !/^\d+$/u.test(stepText)) {
      fail(`has a non-numeric step ${JSON.stringify(stepText)}`)
    }
    const start = startText === '*' ? min : Number(startText)
    // An explicit range wins; `*` means the whole field, and `a/n` means
    // "from a to the end of the field", matching standard cron semantics.
    const end = endText !== undefined
      ? Number(endText)
      : startText === '*' || stepText !== undefined ? max : start
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(start) || !Number.isInteger(end)) fail('has a non-integer bound')
    if (!Number.isInteger(step) || step <= 0) fail(`has a non-positive step ${JSON.stringify(stepText)}`)
    if (start < min || start > max || end < min || end > max) {
      fail(`is outside ${String(min)}-${String(max)}`)
    }
    if (end < start) fail('has an inverted range')
    for (let value = start; value <= end; value += step) values.add(value)
  }

  for (const element of raw.split(',')) {
    if (element === '') fail('has an empty list element')
    const slash = element.split('/')
    if (slash.length > 2) fail('has more than one step')
    const [rangeText = '', stepText] = slash
    const dash = rangeText.split('-')
    if (dash.length > 2) fail('has more than one range')
    if (dash.length === 1) addRange(rangeText === '' ? '*' : rangeText, undefined, stepText)
    else addRange(dash[0] ?? '', dash[1], stepText)
  }
  return [...values].sort((left, right) => left - right)
}

/**
 * Parse one five-field expression.
 * @param expression - the raw expression, for example `0 9 * * 1-5`.
 * @returns the parsed rule.
 * @throws when the expression is malformed.
 */
export function parseCron(expression: string): CronRule {
  const fields = expression.trim().split(/\s+/u)
  if (fields.length !== 5) {
    throw new Error(`cron expression must have five fields, got ${String(fields.length)}`)
  }
  const [minuteText = '', hourText = '', domText = '', monthText = '', dowText = ''] = fields
  const minutes = expandField(minuteText, 0, 59, 'minute')
  const hours = expandField(hourText, 0, 23, 'hour')
  const daysOfMonth = expandField(domText, 1, 31, 'day-of-month')
  const months = expandField(monthText, 1, 12, 'month')
  const daysOfWeek = expandField(dowText, 0, 7, 'day-of-week').map(value => (value === 7 ? 0 : value))
  return {
    expression: [minuteText, hourText, domText, monthText, dowText].join(' '),
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek: [...new Set(daysOfWeek)].sort((left, right) => left - right),
    domStar: domText.startsWith('*'),
    dowStar: dowText.startsWith('*'),
  }
}

/* -------------------------------------------------------------------------
 * Zone arithmetic
 * ---------------------------------------------------------------------- */

/** A civil date plus wall-clock time. */
interface Civil {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

/** One cached formatter per zone: `Intl.DateTimeFormat` construction is expensive. */
const formatters = new Map<string, Intl.DateTimeFormat>()

/**
 * Resolve (and cache) the formatter for one zone.
 * @param timeZone - IANA zone name.
 * @returns the formatter, or undefined when the zone is not recognized.
 */
function formatterFor(timeZone: string): Intl.DateTimeFormat | undefined {
  const cached = formatters.get(timeZone)
  if (cached !== undefined) return cached
  let formatter: Intl.DateTimeFormat
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    return undefined
  }
  formatters.set(timeZone, formatter)
  return formatter
}

/**
 * Read the wall-clock fields of one instant in a zone.
 * @param formatter - the zone formatter.
 * @param epochMs - the instant.
 * @returns its civil fields.
 */
function civilAt(formatter: Intl.DateTimeFormat, epochMs: number): Civil {
  const parts = formatter.formatToParts(new Date(epochMs))
  const read = (type: string): number => {
    const value = parts.find(part => part.type === type)?.value
    return value === undefined ? 0 : Number(value)
  }
  // Some engines report midnight as hour 24 with `hour12: false`.
  const hour = read('hour')
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: hour === 24 ? 0 : hour,
    minute: read('minute'),
    second: read('second'),
  }
}

/**
 * The zone's offset from UTC at one instant.
 * @param formatter - the zone formatter.
 * @param epochMs - the instant.
 * @returns milliseconds east of UTC.
 */
function offsetAt(formatter: Intl.DateTimeFormat, epochMs: number): number {
  const civil = civilAt(formatter, epochMs)
  const asUtc = Date.UTC(civil.year, civil.month - 1, civil.day, civil.hour, civil.minute, civil.second)
  return asUtc - epochMs
}

/**
 * Convert one wall-clock reading in a zone to an instant.
 *
 * Two passes settle the offset across a DST edge; a nonexistent local time
 * (spring forward) lands one hour on and is rejected by the caller's strict
 * comparison, which is how cron skips that gap.
 * @param formatter - the zone formatter.
 * @param civil - the wall-clock reading.
 * @returns the best-effort instant.
 */
function instantOf(formatter: Intl.DateTimeFormat, civil: Civil): number {
  const guess = Date.UTC(civil.year, civil.month - 1, civil.day, civil.hour, civil.minute, civil.second)
  const first = guess - offsetAt(formatter, guess)
  return guess - offsetAt(formatter, first)
}

/**
 * Step one civil date by whole days.
 * @param year - source year.
 * @param month - source month, 1-based.
 * @param day - source day.
 * @param delta - days to add (may be negative).
 * @returns the resulting civil date.
 */
function addDays(year: number, month: number, day: number, delta: number): { year: number, month: number, day: number } {
  const shifted = new Date(Date.UTC(year, month - 1, day) + delta * 86_400_000)
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  }
}

/**
 * The day of week of one civil date.
 * @param year - year.
 * @param month - month, 1-based.
 * @param day - day.
 * @returns Sunday 0 through Saturday 6.
 */
function dayOfWeek(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay()
}

/**
 * Whether one civil date satisfies the rule's date fields.
 * @param rule - the parsed rule.
 * @param year - year.
 * @param month - month, 1-based.
 * @param day - day.
 * @returns whether the date matches.
 */
function dateMatches(rule: CronRule, year: number, month: number, day: number): boolean {
  if (!rule.months.includes(month)) return false
  const dom = rule.daysOfMonth.includes(day)
  const dow = rule.daysOfWeek.includes(dayOfWeek(year, month, day))
  if (rule.domStar && rule.dowStar) return true
  if (rule.domStar) return dow
  if (rule.dowStar) return dom
  // Vixie: both restricted ⇒ either field matching is enough.
  return dom || dow
}

/**
 * Every wall-clock time the rule matches in one day, ascending.
 * @param rule - the parsed rule.
 * @returns minute-of-day values.
 */
function timesOfDay(rule: CronRule): readonly number[] {
  const values: number[] = []
  for (const hour of rule.hours) {
    for (const minute of rule.minutes) values.push(hour * 60 + minute)
  }
  return values.sort((left, right) => left - right)
}

/**
 * Resolve one wall-clock reading in a zone, but only when that reading exists.
 *
 * A reading skipped by a spring-forward transition resolves to an instant that
 * formats back to a different wall time; such a time is reported as absent so
 * the caller skips it, matching the harness reminder dialog's documented
 * "local times that do not exist are skipped" behaviour.
 * @param formatter - the zone formatter.
 * @param year - year.
 * @param month - month, 1-based.
 * @param day - day.
 * @param hour - hour.
 * @param minute - minute.
 * @returns the instant, or undefined when the wall time does not exist.
 */
function resolveWallTime(
  formatter: Intl.DateTimeFormat,
  year: number, month: number, day: number, hour: number, minute: number,
): number | undefined {
  const instant = instantOf(formatter, { year, month, day, hour, minute, second: 0 })
  const back = civilAt(formatter, instant)
  if (back.year !== year || back.month !== month || back.day !== day
    || back.hour !== hour || back.minute !== minute) return undefined
  return instant
}

/**
 * The first occurrence strictly after an instant.
 * @param rule - the parsed rule.
 * @param timeZone - IANA zone name.
 * @param afterMs - exclusive lower bound.
 * @returns the next occurrence, or undefined when none is within the search bound.
 */
export function nextOccurrence(rule: CronRule, timeZone: string, afterMs: number): number | undefined {
  const formatter = formatterFor(timeZone)
  if (formatter === undefined) return undefined
  const times = timesOfDay(rule)
  if (times.length === 0) return undefined
  const start = civilAt(formatter, afterMs)
  for (let offset = 0; offset <= MAX_SEARCH_DAYS; offset += 1) {
    const date = addDays(start.year, start.month, start.day, offset)
    if (!dateMatches(rule, date.year, date.month, date.day)) continue
    for (const minuteOfDay of times) {
      const instant = resolveWallTime(
        formatter, date.year, date.month, date.day,
        Math.floor(minuteOfDay / 60), minuteOfDay % 60,
      )
      if (instant !== undefined && instant > afterMs) return instant
    }
  }
  return undefined
}

/**
 * The most recent occurrence at or before an instant.
 *
 * Used for restart catch-up: after downtime a task runs once for the latest
 * slot it missed, never once per missed slot.
 * @param rule - the parsed rule.
 * @param timeZone - IANA zone name.
 * @param atMs - inclusive upper bound.
 * @returns the latest occurrence, or undefined when none is within the search bound.
 */
export function latestOccurrence(rule: CronRule, timeZone: string, atMs: number): number | undefined {
  const formatter = formatterFor(timeZone)
  if (formatter === undefined) return undefined
  const times = timesOfDay(rule)
  if (times.length === 0) return undefined
  const start = civilAt(formatter, atMs)
  for (let offset = 0; offset <= MAX_SEARCH_DAYS; offset += 1) {
    const date = addDays(start.year, start.month, start.day, -offset)
    if (!dateMatches(rule, date.year, date.month, date.day)) continue
    for (let index = times.length - 1; index >= 0; index -= 1) {
      const minuteOfDay = times[index]
      if (minuteOfDay === undefined) continue
      const instant = resolveWallTime(
        formatter, date.year, date.month, date.day,
        Math.floor(minuteOfDay / 60), minuteOfDay % 60,
      )
      if (instant !== undefined && instant <= atMs) return instant
    }
  }
  return undefined
}

/**
 * Whether one IANA zone name is usable.
 * @param timeZone - the candidate name.
 * @returns true when `Intl` accepts it.
 */
export function isKnownTimeZone(timeZone: string): boolean {
  return formatterFor(timeZone) !== undefined
}
