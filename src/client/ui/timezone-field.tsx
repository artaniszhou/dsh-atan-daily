/**
 * 时区选择器：可输入、可过滤、可选择。
 *
 * 原生 `<select>` 不能输入，datalist 又不能跨浏览器过滤，所以这里是一个小型
 * listbox：输入即过滤，上下键移动，Enter 选中，Esc 只关列表不关弹窗。
 * 新建与编辑共用同一个控件，避免两套行为。
 */
import { useId, useState } from 'react'
import { t } from '../i18n/index.ts'
import { TextInput } from './primitives.tsx'
import css from './kit.module.css'

/** 兜底时区：`Intl.supportedValuesOf` 不可用时使用。 */
const FALLBACK_ZONES = [
  'UTC', 'Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Taipei', 'Asia/Tokyo',
  'Asia/Singapore', 'Europe/London', 'Europe/Berlin', 'America/New_York',
  'America/Los_Angeles', 'Australia/Sydney',
]

/** 已排序的完整时区表，模块级只算一次。 */
let sortedZones: string[] | undefined

/** 读取并缓存 IANA 时区列表。 */
function allZones(): string[] {
  if (sortedZones !== undefined) return sortedZones
  let supported: string[] = []
  try {
    const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
    supported = intl.supportedValuesOf?.('timeZone') ?? []
  } catch {
    supported = []
  }
  sortedZones = [...new Set([...supported, ...FALLBACK_ZONES])].sort((left, right) => left.localeCompare(right))
  return sortedZones
}

/** 时区合法性缓存；同一串文本只问一次 `Intl`。 */
const knownZones = new Map<string, boolean>()

/**
 * 判断一个字符串是不是合法的 IANA 时区。
 *
 * 用 `Intl.DateTimeFormat` 试构造而不是查列表：`supportedValuesOf` 在旧浏览器里
 * 可能缺失，而构造失败就是最直接的“这个时区不能用”。
 * @param zone - 用户输入或任务里的时区。
 * @returns 合法时为 true。
 */
export function isValidTimeZone(zone: string): boolean {
  const text = zone.trim()
  if (text === '') return false
  const cached = knownZones.get(text)
  if (cached !== undefined) return cached
  let valid = false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: text })
    valid = true
  } catch {
    valid = false
  }
  knownZones.set(text, valid)
  return valid
}

/**
 * 当前任务的时区排在最前，其余按字母序。
 *
 * 只把**合法**的当前值排到首位：用户随手输入的半截词（`Tokyo`）不该变成
 * 一个可回车选中的选项，否则提交时必然被 Host 拒绝。
 * @param current - 当前值。
 * @returns 选项列表。
 */
export function timeZoneOptions(current: string): string[] {
  const zones = allZones()
  if (!isValidTimeZone(current)) return zones
  return [current, ...zones.filter(zone => zone !== current)]
}

/** 列表被弹窗裁剪时的定位信息。 */
interface FieldRect {
  top: number
  bottom: number
  left: number
  width: number
}

/**
 * 把列表固定到输入框下方；空间不够时翻到上方。
 *
 * 弹窗主体会滚动，绝对定位会被裁剪，所以用 fixed 坐标逃出裁剪盒。
 * @param rect - 输入框的视口坐标；未测量时为 null。
 * @returns 内联样式。
 */
function comboStyle(rect: FieldRect | null): Record<string, string | number> {
  if (rect === null) return { position: 'fixed', top: 0, left: 0, width: '240px' }
  const below = window.innerHeight - rect.bottom - 16
  const above = rect.top - 16
  const up = below < 160 && above > below
  const height = Math.max(120, Math.min(232, up ? above : below))
  return {
    position: 'fixed',
    left: `${String(rect.left)}px`,
    width: `${String(rect.width)}px`,
    maxHeight: `${String(height)}px`,
    ...up
      ? { top: 'auto', bottom: `${String(window.innerHeight - rect.top + 4)}px` }
      : { top: `${String(rect.bottom + 4)}px`, bottom: 'auto' },
  }
}

/** 时区选择器属性。 */
export interface TimeZoneFieldProps {
  value: string
  disabled?: boolean
  onChange: (next: string) => void
}

/** 时区选择器。 */
export function TimeZoneField({ value, disabled = false, onChange }: TimeZoneFieldProps) {
  const [text, setText] = useState<string>(value)
  const [open, setOpen] = useState<boolean>(false)
  const [active, setActive] = useState<number>(0)
  const [rect, setRect] = useState<FieldRect | null>(null)
  const listId = useId()

  const needle = text.trim().toLocaleLowerCase()
  const matches = (needle === '' ? timeZoneOptions(value) : timeZoneOptions(value).filter(zone => zone.toLocaleLowerCase().includes(needle))).slice(0, 8)

  const choose = (zone: string): void => {
    setText(zone)
    onChange(zone)
    setOpen(false)
  }

  return (
    <div className={css.comboWrap}>
      <TextInput
        type="text"
        value={text}
        disabled={disabled}
        placeholder={t('timeZonePlaceholder')}
        aria-label={t('tzLabel')}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        autoComplete="off"
        spellCheck={false}
        onFocus={(event) => {
          setRect(event.currentTarget.getBoundingClientRect())
          setOpen(true)
        }}
        onBlur={() => { window.setTimeout(() => { setOpen(false) }, 120) }}
        onChange={(event) => {
          const next = event.currentTarget.value
          setText(next)
          onChange(next)
          setRect(event.currentTarget.getBoundingClientRect())
          setActive(0)
          setOpen(true)
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            setOpen(true)
            if (matches.length > 0) setActive(previous => (previous + 1) % matches.length)
            return
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault()
            if (matches.length > 0) setActive(previous => (previous - 1 + matches.length) % matches.length)
            return
          }
          if (event.key === 'Enter' && open) {
            const choice = matches[active]
            if (choice !== undefined) {
              event.preventDefault()
              choose(choice)
            }
            return
          }
          if (event.key === 'Escape' && open) {
            // 只关列表，弹窗保持打开。
            event.preventDefault()
            event.stopPropagation()
            setOpen(false)
          }
        }}
      />
      {open
        ? (
          <div id={listId} className={css.comboList} style={comboStyle(rect)} role="listbox" aria-label={t('tzLabel')}>
            {matches.length === 0
              ? <div className={css.comboEmpty}>{t('timeZoneNoMatch')}</div>
              : matches.map((zone, index) => (
                <button
                  key={zone}
                  type="button"
                  role="option"
                  aria-selected={zone === value}
                  className={index === active ? `${css.comboItem} ${css.comboItemActive}` : css.comboItem}
                  onMouseDown={(event) => { event.preventDefault() }}
                  onFocus={() => { setActive(index) }}
                  onClick={() => { choose(zone) }}
                >
                  {zone}
                </button>
              ))}
          </div>
          )
        : null}
    </div>
  )
}
