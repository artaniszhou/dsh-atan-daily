/**
 * 展示覆盖的人读差异。
 *
 * 只用于草稿预览与提交摘要：把两份 `DisplaySpec` 展平成 `path → 标量`，再按
 * 已知键位翻成人话。不参与渲染，也不改变覆盖语义。
 */

import type { DisplaySpec } from '../../protocol.js'
import type { DisplayChange } from '../../protocol.js'

/** 判断普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 把覆盖展平成 path → 标量。 */
function flatten(value: unknown, prefix: string, out: Map<string, unknown>): void {
  if (value === undefined || value === null) return
  if (Array.isArray(value)) {
    out.set(prefix, JSON.stringify(value))
    return
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) flatten(item, prefix === '' ? key : `${prefix}.${key}`, out)
    return
  }
  out.set(prefix, value)
}

/** 变更项的人话标签。 */
function labelOf(path: string): string {
  const exact: Record<string, string> = {
    theme: '主题',
    'tokens.fontScale': '全局字号缩放',
    'tokens.width': '版心宽度',
    'tokens.measure': '段落行长',
    'tokens.space': '间距阶',
    'tokens.chart': '图表色板',
    'chart.height': '图表默认高度',
    'chart.width': '图表内部宽度',
    'chart.fontScale': '图内字号缩放',
    'chart.axisFontSize': '坐标轴字号',
    'chart.labelFontSize': '数据标签字号',
    'chart.legendFontSize': '图例字号',
    'chart.valueFontSize': '主数值字号',
    'chart.pointSize.min': '圆点最小直径',
    'chart.pointSize.max': '圆点最大直径',
    'chart.barMaxWidth': '柱宽上限',
    'chart.lineWidth': '折线宽度',
    'chart.legend': '图例',
    'chart.table.show': '图表数据表',
    'chart.table.columns': '数据表列',
  }
  if (exact[path] !== undefined) return exact[path]
  if (path.startsWith('tokens.text.')) return `字号 ${path.slice('tokens.text.'.length)}`
  if (path.startsWith('tokens.color.')) return `颜色 ${path.slice('tokens.color.'.length)}`
  if (path.startsWith('tokens.font.')) return `字体 ${path.slice('tokens.font.'.length)}`
  if (path.startsWith('tokens.leading.')) return `行高 ${path.slice('tokens.leading.'.length)}`
  if (path.startsWith('blocks.')) {
    const [key, ...rest] = path.slice('blocks.'.length).split('.')
    const inner = rest.join('.')
    const innerLabel = inner === 'chart.height' ? '图表高度'
      : inner === 'chart.fontScale' ? '图内字号'
        : inner === 'chart.table.show' ? '图表数据表'
          : labelOf(inner)
    return `块 ${key ?? ''} · ${innerLabel}`
  }
  if (path.startsWith('selectors.')) {
    const [key, ...rest] = path.slice('selectors.'.length).split('.')
    return `按「${key ?? ''}」匹配 · ${labelOf(rest.join('.'))}`
  }
  return path
}

/** 值的人话表达。 */
function valueText(path: string, value: unknown): string {
  if (typeof value === 'boolean') {
    if (path.endsWith('.show') || path.endsWith('.legend') || path.endsWith('.border')) return value ? '显示' : '隐藏'
    return value ? '开' : '关'
  }
  if (typeof value === 'number') {
    if (path.includes('fontScale')) return `×${String(value)}`
    if (/height|width|FontSize|pointSize|barMaxWidth|lineWidth|space|padding|margin/iu.test(path)) return `${String(value)}px`
    return String(value)
  }
  return String(value)
}

/**
 * 比较两份覆盖，给出人读变更清单。
 * @param before - 当前生效。
 * @param after - 提案。
 * @returns 最多 20 条。
 */
export function changesBetween(before: DisplaySpec | undefined, after: DisplaySpec | undefined): DisplayChange[] {
  const left = new Map<string, unknown>()
  const right = new Map<string, unknown>()
  flatten(before ?? {}, '', left)
  flatten(after ?? {}, '', right)
  const paths = [...new Set([...left.keys(), ...right.keys()])].filter(path => path !== 'version').sort()
  const changes: DisplayChange[] = []
  for (const path of paths) {
    const a = JSON.stringify(left.get(path) ?? null)
    const b = JSON.stringify(right.get(path) ?? null)
    if (a === b) continue
    const from = left.has(path) ? valueText(path, left.get(path)) : '默认'
    const to = right.has(path) ? valueText(path, right.get(path)) : '默认'
    changes.push({ label: labelOf(path), from, to })
    if (changes.length >= 20) break
  }
  return changes
}
