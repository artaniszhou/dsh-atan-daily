/**
 * 展示覆盖：类型、解析、校验、合并。
 *
 * 覆盖文件是**补丁**，不是一套完整展示规则：只有写出来的键才生效，没写的全部
 * 继承「内置主题 ⊕ 契约 x-theme」。因此这里的每个字段都是可选的。
 *
 * 三条硬约束：
 * 1. 结构类键（图型、字段绑定、块顺序）不属于这里，出现即忽略并警告；
 * 2. 坏文件不能挡住出报告：解析失败只返回警告，调用方按「没有覆盖」处理；
 * 3. 合并是纯函数：没有覆盖时返回的主题与默认逐字节一致。
 */

import type { Theme } from '../theme.js'
import { resolveTheme } from '../theme.js'
import type { ChartStyle } from '../chart.js'

/** 覆盖文件名。 */
export const DISPLAY_FILE = 'task-display.json'

/** 覆盖格式版本。 */
export const DISPLAY_VERSION = 1

/** 字号阶的名字，与 `Theme.fontSize` 顺序一致。 */
export const TEXT_NAMES = ['2xs', 'xs', 'sm', 'base', 'lg', 'xl', '2xl'] as const

/** 主题里可被覆盖的颜色键。 */
export const COLOR_KEYS = [
  'paper', 'surface', 'surfaceAlt', 'ink', 'body', 'muted', 'border', 'accent',
  'accentSoft', 'trust', 'success', 'warning', 'danger', 'warnSoft', 'codeBg', 'tableHeadBg',
] as const

/** 主题里可被覆盖的字体键。 */
export const FONT_KEYS = ['serif', 'sans', 'mono'] as const

/** 允许出现在覆盖里的颜色名。 */
export type ColorName = typeof COLOR_KEYS[number]

/** 允许出现的字体名。 */
export type FontName = typeof FONT_KEYS[number]

/** 令牌补丁。 */
export interface DisplayTokens {
  /** 全局字号缩放，最后统一相乘。 */
  fontScale?: number
  /** 逐档字号绝对覆盖。 */
  text?: Partial<Record<typeof TEXT_NAMES[number], number>>
  /** 行高覆盖。 */
  leading?: { tight?: number, normal?: number }
  /** 间距阶整体替换，必须 8 项。 */
  space?: number[]
  /** 版心宽度，例如 `820px`。 */
  width?: string
  /** 段落最大行长，例如 `50em`。 */
  measure?: string
  /** 圆角。 */
  radius?: { sm?: number, md?: number }
  /** 语义颜色覆盖。 */
  color?: Partial<Record<ColorName, string>>
  /** 字体栈覆盖。 */
  font?: Partial<Record<FontName, string>>
  /** 图表色板整体替换。 */
  chart?: string[]
}

/** 图表外观补丁。 */
export interface DisplayChart {
  /** 图表高度（viewBox 单位）。 */
  height?: number
  /** 图表内部宽度（viewBox 宽），默认 720。 */
  width?: number
  /** 图内文字整体缩放。 */
  fontScale?: number
  /** 坐标轴文字字号。 */
  axisFontSize?: number
  /** 数据标签字号。 */
  labelFontSize?: number
  /** 图例字号。 */
  legendFontSize?: number
  /** 主数值（仪表盘）字号。 */
  valueFontSize?: number
  /** 散点 / 地图点径范围。 */
  pointSize?: { min?: number, max?: number }
  /** 柱宽上限。 */
  barMaxWidth?: number
  /** 折线宽度。 */
  lineWidth?: number
  /** 是否显示图例。 */
  legend?: boolean
  /** 图表下方的数据表。 */
  table?: { show?: boolean, columns?: string[] }
}

/** 单个块的外观补丁。 */
export interface DisplayBlock {
  /** 块内字号；会按比例缩放该块的整个字号阶。 */
  fontSize?: number
  /** 行高。 */
  lineHeight?: number
  /** 语义色名或 `#rrggbb`。 */
  color?: string
  /** 对齐方式。 */
  align?: 'left' | 'center' | 'right'
  /** 段落行长覆盖，`em` 或 `px`。 */
  maxWidth?: string
  /** 上外边距（px）。 */
  marginTop?: number
  /** 下外边距（px）。 */
  marginBottom?: number
  /** 内边距（px）。 */
  padding?: number
  /** 背景色（语义名或十六进制）。 */
  background?: string
  /** 是否显示边框。 */
  border?: boolean
  /** 表格密度。 */
  density?: 'normal' | 'compact'
  /** 表格列宽，键为列名。 */
  columnWidths?: Record<string, string>
  /** 表头底色。 */
  headBackground?: string
  /** 指标卡列数。 */
  columns?: number
  /** 图表外观（仅 chart 块有效）。 */
  chart?: DisplayChart
}

/** 覆盖文件。 */
export interface DisplaySpec {
  version: number
  /** 覆盖整体主题名。 */
  theme?: string
  tokens?: DisplayTokens
  chart?: DisplayChart
  /** 以块 key（`chart#3`）定位。 */
  blocks?: Record<string, DisplayBlock>
  /** 以 `kind:title=…` / `kind:tone=…` 定位，用于契约变动后重新绑定。 */
  selectors?: Record<string, DisplayBlock>
}

/** 解析结果。 */
export type DisplayParse =
  | { ok: true, spec: DisplaySpec, warnings: string[] }
  | { ok: false, warnings: string[] }

/** 结构类禁用键：出现即忽略。 */
const FORBIDDEN_KEYS = new Set([
  'component', 'children', 'ratio', 'order', 'source', 'x', 'y', 'fields',
  'bind', 'series', 'type', 'columns', 'sort', 'limit', 'text', 'title', 'cite', 'items',
])

/** 判断普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 有限数字。 */
function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 收敛到范围。 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** 字符串。 */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** 颜色：语义名或十六进制。 */
function colorOf(value: unknown): string | undefined {
  const text = str(value)
  if (text === undefined) return undefined
  if ((COLOR_KEYS as readonly string[]).includes(text)) return text
  if (/^#[0-9a-fA-F]{3}$|^#[0-9a-fA-F]{6}$/u.test(text)) return text
  return undefined
}

/** 字体栈：不允许能拼出第二条规则的字符。 */
function fontOf(value: unknown): string | undefined {
  const text = str(value)
  if (text === undefined) return undefined
  if (/[;{}<>]|@import|url\(/iu.test(text)) return undefined
  return text.slice(0, 240)
}

/**
 * 解析覆盖文件。
 * @param raw - 文件原文。
 * @returns 成功时给出规整后的规格与警告；失败时只给警告（调用方按无覆盖处理）。
 */
export function parseDisplay(raw: string): DisplayParse {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return { ok: false, warnings: [`${DISPLAY_FILE} 不是合法 JSON，已忽略`] }
  }
  if (!isRecord(value)) return { ok: false, warnings: [`${DISPLAY_FILE} 必须是 JSON 对象，已忽略`] }

  const warnings: string[] = []
  const versionValue = num(value['version'])
  if (versionValue === undefined) {
    warnings.push(`${DISPLAY_FILE} 缺少 version，按 1 处理`)
  } else if (versionValue > DISPLAY_VERSION) {
    return { ok: false, warnings: [`${DISPLAY_FILE} 版本 ${String(versionValue)} 高于当前支持的 ${String(DISPLAY_VERSION)}，已忽略`] }
  }

  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      warnings.push(`${DISPLAY_FILE} 的 ${key} 属于契约，已忽略`)
    }
  }

  const spec: DisplaySpec = { version: DISPLAY_VERSION }
  const theme = str(value['theme'])
  if (theme !== undefined) spec.theme = theme

  const tokens = parseTokens(value['tokens'], warnings)
  if (tokens !== undefined) spec.tokens = tokens
  const chart = parseChart(value['chart'], warnings, 'chart')
  if (chart !== undefined) spec.chart = chart
  const blocks = parseBlocks(value['blocks'], warnings, 'blocks')
  if (blocks !== undefined) spec.blocks = blocks
  const selectors = parseBlocks(value['selectors'], warnings, 'selectors')
  if (selectors !== undefined) spec.selectors = selectors

  return { ok: true, spec, warnings }
}

/** 解析令牌。 */
function parseTokens(value: unknown, warnings: string[]): DisplayTokens | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) {
    warnings.push('tokens 必须是对象，已忽略')
    return undefined
  }
  const tokens: DisplayTokens = {}

  const fontScale = num(value['fontScale'])
  if (fontScale !== undefined) {
    if (fontScale < 0.5 || fontScale > 2.5) warnings.push('tokens.fontScale 超出 0.5–2.5，已收敛')
    tokens.fontScale = Math.round(clamp(fontScale, 0.5, 2.5) * 1000) / 1000
  }

  if (isRecord(value['text'])) {
    const text: Partial<Record<typeof TEXT_NAMES[number], number>> = {}
    for (const name of TEXT_NAMES) {
      const size = num(value['text'][name])
      if (size === undefined) continue
      if (size < 6 || size > 72) warnings.push(`tokens.text.${name} 超出 6–72，已收敛`)
      text[name] = Math.round(clamp(size, 6, 72) * 10) / 10
    }
    if (Object.keys(text).length > 0) tokens.text = text
  }

  if (isRecord(value['leading'])) {
    const leading: { tight?: number, normal?: number } = {}
    const tight = num(value['leading']['tight'])
    const normal = num(value['leading']['normal'])
    if (tight !== undefined) leading.tight = clamp(tight, 1, 3)
    if (normal !== undefined) leading.normal = clamp(normal, 1, 3)
    if (Object.keys(leading).length > 0) tokens.leading = leading
  }

  if (Array.isArray(value['space'])) {
    const space = value['space'].filter((item): item is number => typeof item === 'number' && Number.isFinite(item))
    if (space.length !== 8) warnings.push('tokens.space 需要 8 项，已忽略')
    else tokens.space = space.map(item => clamp(item, 0, 96))
  }

  const width = str(value['width'])
  if (width !== undefined) {
    if (/^\d+(\.\d+)?(px|mm|em)$/u.test(width)) tokens.width = width
    else warnings.push('tokens.width 需要 px/mm/em 单位，已忽略')
  }
  const measure = str(value['measure'])
  if (measure !== undefined) {
    if (/^\d+(\.\d+)?(em|px|ch)$/u.test(measure)) tokens.measure = measure
    else warnings.push('tokens.measure 需要 em/px/ch 单位，已忽略')
  }

  if (isRecord(value['radius'])) {
    const radius: { sm?: number, md?: number } = {}
    const sm = num(value['radius']['sm'])
    const md = num(value['radius']['md'])
    if (sm !== undefined) radius.sm = clamp(sm, 0, 24)
    if (md !== undefined) radius.md = clamp(md, 0, 24)
    if (Object.keys(radius).length > 0) tokens.radius = radius
  }

  if (isRecord(value['color'])) {
    const color: Partial<Record<ColorName, string>> = {}
    for (const key of COLOR_KEYS) {
      const parsed = colorOf(value['color'][key])
      if (parsed !== undefined) color[key] = parsed
    }
    if (Object.keys(color).length > 0) tokens.color = color
  }

  if (isRecord(value['font'])) {
    const font: Partial<Record<FontName, string>> = {}
    for (const key of FONT_KEYS) {
      const parsed = fontOf(value['font'][key])
      if (parsed !== undefined) font[key] = parsed
    }
    if (Object.keys(font).length > 0) tokens.font = font
  }

  if (Array.isArray(value['chart'])) {
    const colors = value['chart'].map(colorOf).filter((item): item is string => item !== undefined)
    if (colors.length === 0) warnings.push('tokens.chart 没有可用颜色，已忽略')
    else if (colors.length > 12) warnings.push('tokens.chart 最多 12 色，已截断')
    else tokens.chart = colors
  }

  return Object.keys(tokens).length === 0 ? undefined : tokens
}

/** 解析图表补丁。 */
function parseChart(value: unknown, warnings: string[], path: string): DisplayChart | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) {
    warnings.push(`${path} 必须是对象，已忽略`)
    return undefined
  }
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) warnings.push(`${path}.${key} 属于契约，已忽略`)
  }
  const chart: DisplayChart = {}
  const height = num(value['height'])
  if (height !== undefined) chart.height = clamp(height, 60, 1200)
  const width = num(value['width'])
  if (width !== undefined) chart.width = clamp(width, 320, 1200)
  const fontScale = num(value['fontScale'])
  if (fontScale !== undefined) chart.fontScale = clamp(fontScale, 0.5, 2.5)
  for (const key of ['axisFontSize', 'labelFontSize', 'legendFontSize', 'valueFontSize'] as const) {
    const size = num(value[key])
    if (size !== undefined) chart[key] = clamp(size, 6, 48)
  }
  if (isRecord(value['pointSize'])) {
    const min = num(value['pointSize']['min'])
    const max = num(value['pointSize']['max'])
    if (min !== undefined || max !== undefined) {
      const low = clamp(min ?? 2, 1, 60)
      const high = clamp(max ?? 24, low, 60)
      chart.pointSize = { min: low, max: high }
    }
  }
  const barMaxWidth = num(value['barMaxWidth'])
  if (barMaxWidth !== undefined) chart.barMaxWidth = clamp(barMaxWidth, 2, 120)
  const lineWidth = num(value['lineWidth'])
  if (lineWidth !== undefined) chart.lineWidth = clamp(lineWidth, 0.5, 12)
  if (typeof value['legend'] === 'boolean') chart.legend = value['legend']
  if (isRecord(value['table'])) {
    const table: { show?: boolean, columns?: string[] } = {}
    if (typeof value['table']['show'] === 'boolean') table.show = value['table']['show']
    if (Array.isArray(value['table']['columns'])) {
      const columns = value['table']['columns'].filter((item): item is string => typeof item === 'string')
      if (columns.length > 0) table.columns = columns
    }
    if (Object.keys(table).length > 0) chart.table = table
  }
  return Object.keys(chart).length === 0 ? undefined : chart
}

/** 解析块补丁集合。 */
function parseBlocks(value: unknown, warnings: string[], path: string): Record<string, DisplayBlock> | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) {
    warnings.push(`${path} 必须是对象，已忽略`)
    return undefined
  }
  const blocks: Record<string, DisplayBlock> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (!isRecord(raw)) {
      warnings.push(`${path}.${key} 必须是对象，已忽略`)
      continue
    }
    const block = parseBlock(raw, warnings, `${path}.${key}`)
    if (block !== undefined) blocks[key] = block
  }
  return Object.keys(blocks).length === 0 ? undefined : blocks
}

/** 解析单个块补丁。 */
function parseBlock(value: Record<string, unknown>, warnings: string[], path: string): DisplayBlock | undefined {
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) warnings.push(`${path}.${key} 属于契约，已忽略`)
  }
  const block: DisplayBlock = {}
  const fontSize = num(value['fontSize'])
  if (fontSize !== undefined) block.fontSize = clamp(fontSize, 6, 72)
  const lineHeight = num(value['lineHeight'])
  if (lineHeight !== undefined) block.lineHeight = clamp(lineHeight, 1, 3)
  const color = colorOf(value['color'])
  if (color !== undefined) block.color = color
  const align = str(value['align'])
  if (align === 'left' || align === 'center' || align === 'right') block.align = align
  const maxWidth = str(value['maxWidth'])
  if (maxWidth !== undefined && /^\d+(\.\d+)?(em|px|ch)$/u.test(maxWidth)) block.maxWidth = maxWidth
  const marginTop = num(value['marginTop'])
  if (marginTop !== undefined) block.marginTop = clamp(marginTop, 0, 120)
  const marginBottom = num(value['marginBottom'])
  if (marginBottom !== undefined) block.marginBottom = clamp(marginBottom, 0, 120)
  const padding = num(value['padding'])
  if (padding !== undefined) block.padding = clamp(padding, 0, 80)
  const background = colorOf(value['background'])
  if (background !== undefined) block.background = background
  if (typeof value['border'] === 'boolean') block.border = value['border']
  const density = str(value['density'])
  if (density === 'normal' || density === 'compact') block.density = density
  if (isRecord(value['columnWidths'])) {
    const widths: Record<string, string> = {}
    for (const [column, widthValue] of Object.entries(value['columnWidths'])) {
      const width = str(widthValue)
      if (width !== undefined && /^\d+(\.\d+)?(px|%|em|ch)$/u.test(width)) widths[column] = width
    }
    if (Object.keys(widths).length > 0) block.columnWidths = widths
  }
  const headBackground = colorOf(value['headBackground'])
  if (headBackground !== undefined) block.headBackground = headBackground
  const columns = num(value['columns'])
  if (columns !== undefined) block.columns = Math.round(clamp(columns, 1, 4))
  const chart = parseChart(value['chart'], warnings, `${path}.chart`)
  if (chart !== undefined) block.chart = chart
  return Object.keys(block).length === 0 ? undefined : block
}

/**
 * 把令牌补丁应用到主题。
 * @param theme - 基础主题。
 * @param tokens - 令牌补丁。
 * @returns 新主题；没有补丁时原样返回。
 */
export function applyTokens(theme: Theme, tokens: DisplayTokens | undefined): Theme {
  if (tokens === undefined) return theme
  const fontSize = theme.fontSize.map((value, index) => {
    const name = TEXT_NAMES[index]
    const absolute = name === undefined ? undefined : tokens.text?.[name]
    const base = absolute ?? value
    return Math.round(base * (tokens.fontScale ?? 1) * 10) / 10
  }) as unknown as Theme['fontSize']

  const colors = { ...theme }
  if (tokens.color !== undefined) {
    for (const key of COLOR_KEYS) {
      const value = tokens.color[key]
      if (value !== undefined) colors[key] = resolveColorName(value, theme)
    }
  }
  return {
    ...colors,
    fontSerif: tokens.font?.serif ?? theme.fontSerif,
    fontSans: tokens.font?.sans ?? theme.fontSans,
    fontMono: tokens.font?.mono ?? theme.fontMono,
    fontSize,
    leading: {
      tight: tokens.leading?.tight ?? theme.leading.tight,
      normal: tokens.leading?.normal ?? theme.leading.normal,
    },
    space: (tokens.space ?? [...theme.space]) as unknown as Theme['space'],
    radius: {
      sm: tokens.radius?.sm ?? theme.radius.sm,
      md: tokens.radius?.md ?? theme.radius.md,
    },
    contentWidth: tokens.width ?? theme.contentWidth,
    measure: tokens.measure ?? theme.measure,
    chart: tokens.chart ?? theme.chart,
  }
}

/**
 * 把覆盖里的主题名与令牌合成为最终主题。
 * @param themeName - 契约或运行数据里的主题名。
 * @param display - 覆盖规格。
 * @returns 最终主题。
 */
export function resolveDisplayTheme(themeName: string | undefined, display: DisplaySpec | undefined): Theme {
  const name = display?.theme ?? themeName
  return applyTokens(resolveTheme(name), display?.tokens)
}

/**
 * 语义色名转实际颜色；十六进制原样返回。
 * @param value - 语义名或十六进制。
 * @param theme - 主题。
 * @returns CSS 颜色。
 */
export function resolveColorName(value: string, theme: Theme): string {
  if (value.startsWith('#')) return value
  const key = value as ColorName
  return COLOR_KEYS.includes(key) ? theme[key] : value
}

/**
 * 合并两个块补丁：后者覆盖前者，`chart` 与 `table` 等对象继续深合并。
 * @param base - 低优先级补丁。
 * @param patch - 高优先级补丁。
 * @returns 合并结果。
 */
export function mergeBlockSpec(base: DisplayBlock | undefined, patch: DisplayBlock | undefined): DisplayBlock | undefined {
  if (base === undefined) return patch
  if (patch === undefined) return base
  return {
    ...base,
    ...patch,
    ...base.chart === undefined && patch.chart === undefined ? {} : {
      chart: {
        ...base.chart,
        ...patch.chart,
        ...base.chart?.table === undefined && patch.chart?.table === undefined ? {} : {
          table: { ...base.chart?.table, ...patch.chart?.table },
        },
        ...base.chart?.pointSize === undefined && patch.chart?.pointSize === undefined ? {} : {
          pointSize: { ...base.chart?.pointSize, ...patch.chart?.pointSize },
        },
      },
    },
  }
}

/**
 * 深合并一份覆盖补丁：对象递归、数组整体替换、`null` 删除该项。
 * @param base - 当前覆盖。
 * @param patch - 新补丁。
 * @returns 合并后的覆盖。
 */
export function mergeDisplay(base: DisplaySpec, patch: DisplaySpec): DisplaySpec {
  const merge = (left: unknown, right: unknown): unknown => {
    if (right === null) return undefined
    if (Array.isArray(right)) return [...right]
    if (isRecord(left) && isRecord(right)) {
      const result: Record<string, unknown> = { ...left }
      for (const [key, value] of Object.entries(right)) {
        const merged = merge(left[key], value)
        if (merged === undefined) delete result[key]
        else result[key] = merged
      }
      return result
    }
    return right
  }
  const merged = merge(base, patch) as DisplaySpec
  return { ...merged, version: patch.version ?? base.version ?? DISPLAY_VERSION }
}

/**
 * 找出所有命中的 `selectors` 补丁。
 * @param display - 覆盖规格。
 * @param kind - 块类型。
 * @param title - 块标题（可能没有）。
 * @param tone - 提示语气（可能没有）。
 * @returns 按书写顺序合并后的补丁。
 */
export function selectorSpec(
  display: DisplaySpec | undefined,
  kind: string,
  title: string | undefined,
  tone: string | undefined,
): DisplayBlock | undefined {
  if (display?.selectors === undefined) return undefined
  let merged: DisplayBlock | undefined
  for (const [selector, patch] of Object.entries(display.selectors)) {
    const [head, ...rest] = selector.split(':')
    if (head !== kind) continue
    const condition = rest.join(':').trim()
    const equal = condition.indexOf('=')
    if (equal === -1) continue
    const field = condition.slice(0, equal).trim()
    const expected = condition.slice(equal + 1).trim()
    if (field === 'title' && title === expected) merged = mergeBlockSpec(merged, patch)
    if (field === 'tone' && tone === expected) merged = mergeBlockSpec(merged, patch)
  }
  return merged
}

/**
 * 解析某个块最终生效的外观补丁：`selectors` 先合并，`blocks[key]` 最后覆盖。
 * @param display - 覆盖规格。
 * @param key - 块 key。
 * @param kind - 块类型。
 * @param title - 块标题。
 * @param tone - 语气。
 * @returns 补丁；没有任何命中时为 undefined。
 */
export function blockSpec(
  display: DisplaySpec | undefined,
  key: string | undefined,
  kind: string,
  title?: string,
  tone?: string,
): DisplayBlock | undefined {
  if (display === undefined) return undefined
  const bySelector = selectorSpec(display, kind, title, tone)
  const byKey = key === undefined ? undefined : display.blocks?.[key]
  return mergeBlockSpec(bySelector, byKey)
}

/**
 * 计算某个块最终生效的图表外观。
 * @param display - 覆盖规格。
 * @param spec - 块补丁。
 * @returns 图表外观；没有时返回 undefined。
 */
export function chartStyleOf(display: DisplaySpec | undefined, spec: DisplayBlock | undefined): ChartStyle | undefined {
  if (display?.chart === undefined && spec?.chart === undefined) return undefined
  const base = display?.chart ?? {}
  const patch = spec?.chart ?? {}
  return {
    ...base,
    ...patch,
    ...base.pointSize === undefined && patch.pointSize === undefined ? {} : {
      pointSize: { ...base.pointSize, ...patch.pointSize },
    },
    ...base.table === undefined && patch.table === undefined ? {} : {
      table: { ...base.table, ...patch.table },
    },
  }
}

/** 深拷贝补丁。 */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** 去掉空对象与 undefined。 */
function compact<T extends Record<string, unknown>>(value: T): T {
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue
    if (isRecord(item) && Object.keys(item).length === 0) continue
    result[key] = item
  }
  return result as T
}

/**
 * 稀疏化：删掉与默认值相同的项。
 *
 * 只处理能明确比较的标量；对象继续递归，数组整体比较。空的 `blocks` 条目会被删掉。
 * @param display - 原始规格。
 * @param theme - 基础主题（未应用覆盖）。
 * @param baseChart - 默认图表外观。
 * @returns 稀疏后的规格；完全没有差异时返回 undefined。
 */
export function pruneDisplay(display: DisplaySpec, theme: Theme, baseChart?: DisplayChart): DisplaySpec | undefined {
  const spec = clone(display)
  delete spec.blocks
  delete spec.selectors

  if (spec.tokens !== undefined) {
    const tokens = spec.tokens
    if (tokens.fontScale === 1) delete tokens.fontScale
    if (tokens.text !== undefined) {
      for (const [index, name] of TEXT_NAMES.entries()) {
        if (tokens.text[name] === theme.fontSize[index]) delete tokens.text[name]
      }
      if (Object.keys(tokens.text).length === 0) delete tokens.text
    }
    if (tokens.width === theme.contentWidth) delete tokens.width
    if (tokens.measure === theme.measure) delete tokens.measure
    if (tokens.leading !== undefined) {
      if (tokens.leading.tight === theme.leading.tight) delete tokens.leading.tight
      if (tokens.leading.normal === theme.leading.normal) delete tokens.leading.normal
      if (Object.keys(tokens.leading).length === 0) delete tokens.leading
    }
    if (tokens.radius !== undefined) {
      if (tokens.radius.sm === theme.radius.sm) delete tokens.radius.sm
      if (tokens.radius.md === theme.radius.md) delete tokens.radius.md
      if (Object.keys(tokens.radius).length === 0) delete tokens.radius
    }
    if (tokens.space !== undefined && tokens.space.every((value, index) => value === theme.space[index])) delete tokens.space
    if (tokens.chart !== undefined && tokens.chart.length === theme.chart.length
      && tokens.chart.every((value, index) => value === theme.chart[index])) delete tokens.chart
    if (tokens.color !== undefined) {
      for (const key of COLOR_KEYS) {
        if (tokens.color[key] === theme[key]) delete tokens.color[key]
      }
      if (Object.keys(tokens.color).length === 0) delete tokens.color
    }
    if (tokens.font !== undefined) {
      if (tokens.font.serif === theme.fontSerif) delete tokens.font.serif
      if (tokens.font.sans === theme.fontSans) delete tokens.font.sans
      if (tokens.font.mono === theme.fontMono) delete tokens.font.mono
      if (Object.keys(tokens.font).length === 0) delete tokens.font
    }
    if (Object.keys(tokens).length === 0) delete spec.tokens
  }

  if (spec.chart !== undefined) {
    const chart = spec.chart
    if (chart.fontScale === 1) delete chart.fontScale
    if (chart.height !== undefined && chart.height === baseChart?.height) delete chart.height
    if (chart.width !== undefined && chart.width === 720) delete chart.width
    if (chart.table?.show === true) delete chart.table.show
    if (chart.table !== undefined && Object.keys(chart.table).length === 0) delete chart.table
    if (Object.keys(chart).length === 0) delete spec.chart
  }

  const blocks: Record<string, DisplayBlock> = {}
  for (const [key, value] of Object.entries(display.blocks ?? {})) {
    const cleaned = pruneBlock(value, theme)
    if (cleaned !== undefined) blocks[key] = cleaned
  }
  if (Object.keys(blocks).length > 0) spec.blocks = blocks
  const selectors: Record<string, DisplayBlock> = {}
  for (const [key, value] of Object.entries(display.selectors ?? {})) {
    const cleaned = pruneBlock(value, theme)
    if (cleaned !== undefined) selectors[key] = cleaned
  }
  if (Object.keys(selectors).length > 0) spec.selectors = selectors

  const final = compact(spec as unknown as Record<string, unknown>) as unknown as DisplaySpec
  delete final.theme
  if (display.theme !== undefined) final.theme = display.theme
  const meaningful = Object.keys(final).filter(key => key !== 'version' && key !== 'theme')
  if (meaningful.length === 0 && display.theme === undefined) return undefined
  return final
}

/** 稀疏化单个块补丁。 */
function pruneBlock(block: DisplayBlock, _theme: Theme): DisplayBlock | undefined {
  const spec = clone(block)
  if (spec.chart !== undefined) {
    if (spec.chart.fontScale === 1) delete spec.chart.fontScale
    if (spec.chart.table?.show === true) delete spec.chart.table.show
    if (spec.chart.table !== undefined && Object.keys(spec.chart.table).length === 0) delete spec.chart.table
    if (Object.keys(spec.chart).length === 0) delete spec.chart
  }
  return Object.keys(spec).length === 0 ? undefined : spec
}
