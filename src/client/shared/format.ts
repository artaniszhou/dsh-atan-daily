/**
 * 时间与时长的展示格式化。
 *
 * 规则：Host 发送的是 UTC ISO 字符串；任务的时间按它自己的 IANA 时区解释，
 * 因此**绝不能截取 ISO 文本**，否则 07:00 Asia/Shanghai 会显示成 23:00。
 */

/**
 * 把毫秒时长格式化成短文本。
 * @param durationMs - 毫秒；运行中/未知时为 null。
 * @returns 例如 `8s`、`2m03s`、`1h04m`。
 */
export function formatDuration(durationMs: number | null | undefined): string {
  if (durationMs === null || durationMs === undefined) return '—'
  const seconds = Math.max(0, Math.round(durationMs / 1000))
  if (seconds < 60) return `${String(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${String(minutes)}m${String(seconds % 60).padStart(2, '0')}s`
  const hours = Math.floor(minutes / 60)
  return `${String(hours)}h${String(minutes % 60).padStart(2, '0')}m`
}

/**
 * 把版本号（epoch 毫秒）格式化成 `YYYY-MM-DD HH:mm`。
 * @param value - 服务端返回的 version。
 * @returns 展示文本。
 */
export function formatVersion(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '—'
  const date = new Date(value)
  const pad = (part: number): string => String(part).padStart(2, '0')
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * 把上传时间（yyyyMMddHHmmss）格式化成 `YYYY-MM-DD HH:mm`。
 * @param value - 服务端返回的上传时间。
 * @returns 展示文本；不是 14 位数字时原样返回。
 */
export function formatUploadedAt(value: string): string {
  return /^\d{14}$/u.test(value)
    ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)} ${value.slice(8, 10)}:${value.slice(10, 12)}`
    : value
}

/**
 * 把 ISO 时间按指定时区格式化成 `YYYY-MM-DD HH:mm`。
 * @param iso - UTC 时间；null 表示没有。
 * @param timeZone - 任务的 IANA 时区；缺省时用浏览器本地时区。
 * @returns 展示文本；非法时间/时区有回退。
 */
export function formatRunTime(iso: string | null, timeZone?: string): string {
  if (iso === null) return '—'
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      ...timeZone === undefined ? {} : { timeZone },
    }).formatToParts(at)
    const value = (type: string): string => parts.find(part => part.type === type)?.value ?? ''
    return `${value('year')}-${value('month')}-${value('day')} ${value('hour')}:${value('minute')}`
  } catch {
    // 非法 IANA 时区：回退到浏览器本地时钟。
  }
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} `
    + `${pad(at.getHours())}:${pad(at.getMinutes())}`
}
