/**
 * 渲染计划：把「契约 + 本轮数据」翻译成与格式无关的块树。
 *
 * 契约 v2 的版式是 `x-blocks`：一组显示组件，用 `source` / `fields` 绑定数据。
 * 这一层不产出任何 HTML 字符串，只管四件事：
 * 1. 按 `x-blocks` 的顺序与嵌套关系生成块树；
 * 2. 把每个块绑定的字段值格式化（单位、缺失、对齐）；
 * 3. 把 `heading`（1–2 级）切成版面分区，其余块留在分区里；
 * 4. 把「缺失」登记成结构化的单元格标记，并收集渲染期问题。
 *
 * 这样 md、html、pdf 三个渲染器共用同一棵块树，格式差异只留在各自的渲染器里。
 */

import { join } from 'node:path'
import type { AxisSpec, ChartSpec, GraphData, GraphLink, GraphNode, SeriesSpec, TreeNode } from './chart.js'
import { seriesKeys } from './chart.js'
import { asMapName } from './map.js'
import { SERIES, SERIES_TYPES, SINGLE_SERIES } from './series.js'
import type { SeriesType } from './series.js'

/** 提示语气。 */
export type Tone = 'info' | 'ok' | 'warn' | 'err'

/** 键值行。 */
export interface KvRow {
  label: string
  value: string
  /** 值缺失时为 true，渲染器据此上缺失样式。 */
  missing: boolean
}

/** 指标卡。 */
export interface MetricCard {
  label: string
  value: string
  delta?: string
  tone?: Tone
  note?: string
}

/** 表格列。 */
export interface Column {
  key: string
  label: string
  align: 'left' | 'right'
  unit?: string
}

/** 表格单元格。 */
export interface Cell {
  text: string
  /** 缺失单元格：渲染成「缺失 / 待确认」，不参与排序与合计。 */
  missing: boolean
  /** 数值列右对齐。 */
  numeric: boolean
  /** 原始值：图表要数字，不能被格式化后的字符串污染。 */
  raw: number | string | null
}

/** 时间线条目。 */
export interface TimelineItem {
  at: string
  title: string
  detail?: string
}

/** 表格块；同时充当图表的数据表。 */
export interface TableBlock {
  kind: 'table'
  id: string
  title?: string
  columns: Column[]
  rows: Cell[][]
  folded: boolean
  note?: string
}

/** 图表块：SVG 由 HTML 渲染器按主题现画，计划层只带数据与声明。 */
export interface ChartBlock {
  kind: 'chart'
  id: string
  title?: string
  spec: ChartSpec
  table: TableBlock
}

/** 标题块：1–2 级切分区，3 级是分区内的小节。 */
export interface HeadingBlock {
  kind: 'heading'
  id: string
  level: number
  text: string
}

/** 段落块。 */
export interface ParagraphBlock {
  kind: 'paragraph'
  id: string
  text: string
}

/** 清单块。 */
export interface ListBlock {
  kind: 'list'
  id: string
  ordered: boolean
  items: string[]
}

/** 引用块。 */
export interface QuoteBlock {
  kind: 'quote'
  id: string
  text: string
  cite?: string
}

/** 提示块。 */
export interface NoteBlock {
  kind: 'note'
  id: string
  tone: Tone
  text: string
}

/** 分隔线。 */
export interface DividerBlock {
  kind: 'divider'
  id: string
}

/** 键值块。 */
export interface KvBlock {
  kind: 'kv'
  id: string
  rows: KvRow[]
}

/** 指标块。 */
export interface MetricsBlock {
  kind: 'metrics'
  id: string
  items: MetricCard[]
}

/** 时间线块。 */
export interface TimelineBlock {
  kind: 'timeline'
  id: string
  items: TimelineItem[]
}

/** 分栏容器：`children` 与 `ratio` 一一对应，每栏是一组块。 */
export interface ColumnsBlock {
  kind: 'columns'
  id: string
  ratio: number[]
  children: Block[][]
}

/** 卡片容器：给一组块套一个标题与边框。 */
export interface CardBlock {
  kind: 'card'
  id: string
  title?: string
  children: Block[]
}

/** 一个可渲染的块。`key` 是稳定标识（`chart#3`），用于展示覆盖与面板定位。 */
export type Block = (
  | HeadingBlock
  | ParagraphBlock
  | ListBlock
  | QuoteBlock
  | NoteBlock
  | DividerBlock
  | KvBlock
  | MetricsBlock
  | TableBlock
  | ChartBlock
  | TimelineBlock
  | ColumnsBlock
  | CardBlock
  | { kind: 'raw', id: string, label: string, json: string }
) & { key?: string }

/** 一个分区。没有标题的分区就是报告主体。 */
export interface PlanSection {
  id: string
  title?: string
  blocks: Block[]
}

/** 数据来源条目。 */
export interface SourceItem {
  label: string
  value: string
  asOf?: string
}

/** 缺失登记。 */
export interface MissingItem {
  path: string
  reason: string
}

/** 本轮报告文档（`report.json`）。 */
export interface ReportDoc {
  schemaVersion?: string
  reportId?: string
  title?: string
  subtitle?: string
  generatedAt?: string
  dataAsOf?: string
  /** 主题名；覆盖契约的 `x-theme`，缺省用 `default`。 */
  theme?: string
  task?: { id?: string, name?: string }
  summary?: { lead?: string, metrics?: MetricCard[] }
  /** 必须通过契约校验的数据本体。 */
  data: Record<string, unknown>
  notes?: (string | { anchor?: string, tone?: Tone, text: string })[]
  sources?: SourceItem[]
  actions?: (string | { text: string })[]
  missing?: MissingItem[]
  meta?: Record<string, unknown>
}

/** 渲染计划。 */
export interface RenderPlan {
  title: string
  subtitle?: string
  /** 页眉小字：任务名 · 日期。 */
  eyebrow: string
  /** 结论先行的一句话。 */
  lead?: string
  /** 数据截止与生成时间。 */
  meta: string[]
  sections: PlanSection[]
  sources: SourceItem[]
  missing: MissingItem[]
  actions: string[]
  footer: string[]
  /** 渲染期发现的问题：缺失未登记、块绑定错误等。 */
  warnings: string[]
}

/** 计划选项。 */
export interface PlanOptions {
  /** 缺失单元格的文案，默认「缺失 / 待确认」。 */
  missingText?: string
  /** 表格折叠阈值，契约没写 `foldAbove` 时使用；默认不折叠。 */
  defaultFoldAbove?: number
  /** 单表最多渲染多少行，防止异常数据把报告撑爆；默认 500。 */
  maxRows?: number
  /** 任务目录；自定义图形需要它来解析脚本路径。 */
  folder?: string
}

/** 缺省文案。 */
const DEFAULT_MISSING_TEXT = '缺失 / 待确认'

/** 数字格式化：最多两位小数，千分位。 */
const NUMBER = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 })
/** 整数格式化。 */
const INTEGER = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 })
/**
 * 金额：**固定两位小数**，千分位。
 *
 * 报表口径写「保留两位小数」时，`6,674.5` 会被当成写错；`Intl` 的默认只裁不补，
 * 所以金额单独用一个最小位数也是 2 的格式化器。
 */
const MONEY = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** 中文单位前面留一个空格（`5,800.00 元`），符号单位不留（`5.4%`）。 */
const CJK_UNIT = /^[\u3400-\u9fff]/u

/**
 * 单位后缀。
 * @param unit - 契约里的 `x-unit`。
 * @returns 直接拼在数字后面的文本。
 */
function unitSuffix(unit: string | undefined): string {
  if (unit === undefined || unit === '') return ''
  return CJK_UNIT.test(unit) ? ` ${unit}` : unit
}

/** 取字符串字段。 */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** 判断是不是普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 归一化信封里的 `notes`。
 *
 * 模型偶尔会写成字符串数组而不是 `{text}` 对象；这里两种都接受，读不出文字的
 * 直接丢掉，绝不让一个格式偏差把整份报告打崩。
 * @param value - 原始 `notes`。
 * @returns 可渲染的提示列表。
 */
function normalizeNotes(value: unknown): { tone: Tone, text: string }[] {
  if (!Array.isArray(value)) return []
  const notes: { tone: Tone, text: string }[] = []
  for (const item of value) {
    if (typeof item === 'string') {
      const text = item.trim()
      if (text !== '') notes.push({ tone: 'info', text })
      continue
    }
    if (!isRecord(item)) continue
    const text = str(item['text'])
    if (text === undefined) continue
    const tone = str(item['tone'])
    notes.push({
      tone: tone === 'ok' || tone === 'warn' || tone === 'err' || tone === 'info' ? tone : 'info',
      text,
    })
  }
  return notes
}

/** 归一化 `sources`：只保留至少有一个非空字符串字段的条目。 */
function normalizeSources(value: unknown): SourceItem[] {
  if (!Array.isArray(value)) return []
  const sources: SourceItem[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const label = typeof item['label'] === 'string' ? item['label'].trim() : ''
    const sourceValue = typeof item['value'] === 'string' ? item['value'].trim() : ''
    if (label === '' && sourceValue === '') continue
    const asOf = str(item['asOf'])
    sources.push({ label, value: sourceValue, ...asOf === undefined ? {} : { asOf } })
  }
  return sources
}

/** 归一化 `actions`：字符串或 `{text}` 都接受。 */
function normalizeActions(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const actions: string[] = []
  for (const item of value) {
    const text = typeof item === 'string'
      ? item.trim()
      : isRecord(item) && typeof item['text'] === 'string' ? item['text'].trim() : ''
    if (text !== '') actions.push(text)
  }
  return actions
}

/** 归一化 `missing`：只保留 path 与 reason 都是字符串的条目。 */
function normalizeMissing(value: unknown): MissingItem[] {
  if (!Array.isArray(value)) return []
  const missing: MissingItem[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const path = typeof item['path'] === 'string' ? item['path'].trim() : ''
    const reason = typeof item['reason'] === 'string' ? item['reason'].trim() : ''
    if (path === '') continue
    missing.push({ path, reason })
  }
  return missing
}

/** 取对象的 properties。 */
function propertiesOf(node: unknown): Record<string, unknown> | undefined {
  if (!isRecord(node)) return undefined
  const properties = node['properties']
  return isRecord(properties) ? properties : undefined
}

/** 取数组节点的 items。 */
function itemsOf(node: unknown): Record<string, unknown> | undefined {
  if (!isRecord(node)) return undefined
  const items = node['items']
  return isRecord(items) ? items : undefined
}

/** 节点声明的类型集合。 */
function typesOf(node: Record<string, unknown>): string[] {
  const declared = node['type']
  if (Array.isArray(declared)) return declared.filter((item): item is string => typeof item === 'string')
  return typeof declared === 'string' ? [declared] : []
}

/** 契约节点里的标题：`x-label` 优先，退回 JSON Schema 的 `title`。 */
function titleOf(node: Record<string, unknown> | undefined): string | undefined {
  if (node === undefined) return undefined
  return str(node['x-label']) ?? str(node['title'])
}

/**
 * 格式化一个标量。
 * @param value - 原始值。
 * @param node - 字段的契约节点，用于取 `x-format` 与 `x-unit`。
 * @param missingText - 缺失文案。
 * @returns 展示文本、是否缺失、是否按数值右对齐。
 */
export function formatValue(
  value: unknown,
  node: Record<string, unknown> | undefined,
  missingText = DEFAULT_MISSING_TEXT,
): { text: string, missing: boolean, numeric: boolean } {
  if (value === null || value === undefined) return { text: missingText, missing: true, numeric: false }
  const unit = node === undefined ? undefined : str(node['x-unit'])
  const format = node === undefined ? undefined : str(node['x-format'])
  if (typeof value === 'number' && Number.isFinite(value)) {
    switch (format) {
      case 'percent':
        return { text: `${NUMBER.format(value)}%`, missing: false, numeric: true }
      case 'integer':
      case 'count':
        return { text: `${INTEGER.format(value)}${unitSuffix(unit)}`, missing: false, numeric: true }
      case 'money':
        // 金额固定两位小数：口径写「保留两位」时，`6,674.5` 是错的。
        return { text: `${MONEY.format(value)}${unitSuffix(unit)}`, missing: false, numeric: true }
      case 'ratio':
        return { text: `${value.toFixed(2)}${unitSuffix(unit)}`, missing: false, numeric: true }
      default:
        return { text: `${NUMBER.format(value)}${unitSuffix(unit)}`, missing: false, numeric: true }
    }
  }
  if (typeof value === 'boolean') return { text: value ? '是' : '否', missing: false, numeric: false }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed === ''
      ? { text: missingText, missing: true, numeric: false }
      : { text: trimmed, missing: false, numeric: false }
  }
  return { text: JSON.stringify(value), missing: false, numeric: false }
}

/** 契约里声明的表格列。 */
function columnsOf(itemNode: Record<string, unknown> | undefined, keys: string[]): Column[] {
  const itemProperties = propertiesOf(itemNode)
  return keys.map((key) => {
    const child = itemProperties?.[key]
    const childNode = isRecord(child) ? child : undefined
    const numeric = childNode !== undefined && typesOf(childNode).some(t => t === 'number' || t === 'integer')
    const unit = childNode === undefined ? undefined : str(childNode['x-unit'])
    return {
      key,
      label: titleOf(childNode) ?? key,
      align: numeric ? 'right' : 'left',
      ...unit === undefined ? {} : { unit },
    }
  })
}

/** 把任意值收敛成单元格能承载的原始值。 */
function rawOf(value: unknown): number | string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') return value
  if (typeof value === 'boolean') return value ? '是' : '否'
  return null
}

/**
 * 比较两个单元格的原始值。
 *
 * 数字比大小，字符串按中文排序（数字段按数值比较，`第2期` 排在 `第10期` 前），
 * 缺失值一律排最后：缺失不是 0，不能混进排序里。
 * @param left - 左单元格。
 * @param right - 右单元格。
 * @returns 比较结果。
 */
function compareCells(left: Cell, right: Cell): number {
  const a = left.raw
  const b = right.raw
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b), 'zh-CN', { numeric: true })
}

/**
 * 按契约声明排序表格行。
 * @param cells - 行数据。
 * @param columns - 列定义。
 * @param sort - `-field` 降序，`+field` 或 `field` 升序。
 * @param id - 块 id，用于警告文案。
 * @param warnings - 警告收集器。
 * @returns 排好序的行；声明不合法时原样返回。
 */
function sortCells(
  cells: Cell[][],
  columns: Column[],
  sort: string | undefined,
  id: string,
  warnings: string[],
): Cell[][] {
  if (sort === undefined) return cells
  const spec = sort.trim()
  if (spec === '') return cells
  const descending = spec.startsWith('-')
  const key = spec.replace(/^[+-]/u, '').trim()
  const index = columns.findIndex(column => column.key === key)
  if (index === -1) {
    warnings.push(`${id}：sort 指向不存在的列 ${key}，已按数据原顺序展示`)
    return cells
  }
  const factor = descending ? -1 : 1
  // 缺失值永远排最后：升序降序都不该把「没有数据」顶到前面。
  const present = cells.filter(cell => cell[index]?.raw !== null)
  const missing = cells.filter(cell => cell[index]?.raw === null)
  present.sort((left, right) => factor * compareCells(left[index]!, right[index]!))
  return [...present, ...missing]
}

/** 归一化缺失路径，便于和 `missing[]` 比对。 */
function normalizePath(value: string): string {
  return value.trim()
    .replace(/^\$/u, '')
    .replace(/^\./u, '')
    .replace(/^data\./u, '')
    .replace(/\s+/gu, '')
}

/** 收集数据里显式写成 `null` 的位置。 */
function collectNullPaths(
  node: Record<string, unknown> | undefined,
  value: unknown,
  path: string,
  out: string[],
): void {
  if (value === null) {
    out.push(normalizePath(path))
    return
  }
  // 键不存在 ≠ 缺失：可选字段没写是正常情况，只有显式的 null 才算缺失；
  // 必填字段漏写由契约校验（required）负责，不在这里重复告警。
  if (value === undefined) return
  if (node === undefined) return
  const properties = propertiesOf(node)
  if (properties !== undefined && typeof value === 'object' && value !== null && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(properties)) {
      const childNode = isRecord(child) ? child : undefined
      collectNullPaths(childNode, (value as Record<string, unknown>)[key], `${path}.${key}`, out)
    }
    return
  }
  const items = itemsOf(node)
  if (items !== undefined && Array.isArray(value)) {
    value.forEach((item, index) => {
      const properties = propertiesOf(items)
      if (properties === undefined) return
      for (const [key, child] of Object.entries(properties)) {
        const childNode = isRecord(child) ? child : undefined
        collectNullPaths(childNode, (item as Record<string, unknown>)[key], `${path}[${String(index)}].${key}`, out)
      }
    })
  }
}

/** 构建块树时的累积状态。 */
interface BuildContext {
  data: Record<string, unknown>
  properties: Record<string, unknown>
  options: Required<Omit<PlanOptions, 'folder'>>
  warnings: string[]
  /** 已被块引用的字段。 */
  used: Set<string>
  /** 块 id 自增序号。 */
  seq: number
  /** 每个组件已出现的次数，用于稳定 key。 */
  counts: Map<string, number>
  /** 任务目录。 */
  folder?: string
}

/**
 * 生成块 id。
 * @param ctx - 构建上下文。
 * @param prefix - 组件名。
 * @returns 形如 `table-3` 的稳定 id。
 */
function nextId(ctx: BuildContext, prefix: string): string {
  ctx.seq += 1
  return `${prefix}-${String(ctx.seq)}`
}

/**
 * 生成稳定 key：组件名 + 同组件出现序号。
 *
 * 必须在「块是否成功构建」之前调用，这样即使某个块被跳过，后面的 key 也不会
 * 和契约目录（`outlineOf`）错位。
 * @param ctx - 构建上下文。
 * @param component - 组件名。
 * @returns 形如 `chart#3` 的 key。
 */
function nextKey(ctx: BuildContext, component: string): string {
  const next = (ctx.counts.get(component) ?? 0) + 1
  ctx.counts.set(component, next)
  return `${component}#${String(next)}`
}

/** 绑定一个数组字段；绑定失败时记警告并返回 undefined。 */
function bindArray(
  ctx: BuildContext,
  spec: Record<string, unknown>,
  component: string,
): { source: string, node: Record<string, unknown> | undefined, rows: unknown[] } | undefined {
  const source = str(spec['source'])
  if (source === undefined) {
    ctx.warnings.push(`${component} 缺少 source，已跳过`)
    return undefined
  }
  const node = ctx.properties[source]
  if (node === undefined) {
    ctx.warnings.push(`${component} 的 source 不存在：${source}`)
    return undefined
  }
  const value = ctx.data[source]
  if (!Array.isArray(value)) {
    ctx.warnings.push(`${component} 的 ${source} 不是数组，已跳过`)
    return undefined
  }
  ctx.used.add(source)
  return { source, node: isRecord(node) ? node : undefined, rows: value }
}

/** 键值块：`fields` 里的字段按顺序成行；对象字段展开成多行。 */
function kvBlock(id: string, spec: Record<string, unknown>, ctx: BuildContext): Block | undefined {
  const fields = Array.isArray(spec['fields'])
    ? spec['fields'].filter((item): item is string => typeof item === 'string')
    : []
  if (fields.length === 0) {
    ctx.warnings.push('kv 缺少 fields：要展示的字段名列表')
    return undefined
  }
  const rows: KvRow[] = []
  for (const field of fields) {
    const node = ctx.properties[field]
    if (node === undefined) {
      ctx.warnings.push(`kv 引用了不存在的字段 ${field}`)
      continue
    }
    ctx.used.add(field)
    const nodeObject = isRecord(node) ? node : undefined
    const value = ctx.data[field]
    if (nodeObject !== undefined && typesOf(nodeObject).includes('object') && isRecord(value)) {
      const sub = propertiesOf(nodeObject) ?? {}
      for (const [key, child] of Object.entries(sub)) {
        const childNode = isRecord(child) ? child : undefined
        const formatted = formatValue(value[key], childNode, ctx.options.missingText)
        rows.push({ label: titleOf(childNode) ?? key, value: formatted.text, missing: formatted.missing })
      }
      continue
    }
    const formatted = formatValue(value, nodeObject, ctx.options.missingText)
    rows.push({ label: titleOf(nodeObject) ?? field, value: formatted.text, missing: formatted.missing })
  }
  return rows.length === 0 ? undefined : { kind: 'kv', id, rows }
}

/** 指标块。 */
function metricsBlock(id: string, spec: Record<string, unknown>, ctx: BuildContext): Block | undefined {
  const bound = bindArray(ctx, spec, 'metrics')
  if (bound === undefined) return undefined
  const itemProperties = propertiesOf(itemsOf(bound.node))
  const items: MetricCard[] = []
  for (const row of bound.rows) {
    const record = isRecord(row) ? row : {}
    const valueNode = itemProperties?.['value']
    const valueSchema = isRecord(valueNode) ? valueNode : undefined
    // 同一组指标的单位与格式经常不同（股息率 %、家数 家、金额 亿元），
    // 所以允许元素各自带 unit / format 覆盖 schema 上的声明。
    const unit = str(record['unit'])
    const format = str(record['format'])
    const effective = unit === undefined && format === undefined
      ? valueSchema
      : {
          ...valueSchema ?? {},
          ...unit === undefined ? {} : { 'x-unit': unit },
          ...format === undefined ? {} : { 'x-format': format },
        }
    const formatted = formatValue(record['value'], effective, ctx.options.missingText)
    const tone = str(record['tone'])
    items.push({
      label: str(record['label']) ?? '—',
      value: formatted.text,
      ...str(record['delta']) === undefined ? {} : { delta: str(record['delta']) ?? '' },
      ...str(record['note']) === undefined ? {} : { note: str(record['note']) ?? '' },
      ...tone === 'ok' || tone === 'warn' || tone === 'err' || tone === 'info' ? { tone } : {},
    })
  }
  return items.length === 0 ? undefined : { kind: 'metrics', id, items }
}

/** 表格块：列白名单、排序、折叠、行上限。 */
function makeTableBlock(
  id: string,
  arrayNode: Record<string, unknown> | undefined,
  keys: string[],
  rows: unknown[],
  ctx: BuildContext,
  opts: { title?: string, sort?: string, foldAbove?: number, limit?: number },
): TableBlock {
  const itemNode = itemsOf(arrayNode)
  const columns = columnsOf(itemNode, keys)
  const itemProperties = propertiesOf(itemNode)
  const cells: Cell[][] = []
  for (const row of rows) {
    const record = isRecord(row) ? row : {}
    const line = columns.map((column) => {
      const child = itemProperties?.[column.key]
      const childNode = isRecord(child) ? child : undefined
      const formatted = formatValue(record[column.key], childNode, ctx.options.missingText)
      // 对齐来自列定义，不来自值：数值列里的「缺失」也要保持右对齐。
      return {
        text: formatted.text,
        missing: formatted.missing,
        numeric: column.align === 'right',
        raw: rawOf(record[column.key]),
      }
    })
    cells.push(line)
  }
  const ordered = sortCells(cells, columns, opts.sort, id, ctx.warnings)
  const foldAbove = opts.foldAbove ?? ctx.options.defaultFoldAbove
  const limit = opts.limit ?? ctx.options.maxRows
  return {
    kind: 'table',
    id,
    ...opts.title === undefined ? {} : { title: opts.title },
    columns,
    rows: ordered.slice(0, limit),
    folded: foldAbove !== undefined && Number.isFinite(foldAbove) && ordered.length > foldAbove,
  }
}

/** 表格块。 */
function tableBlock(id: string, spec: Record<string, unknown>, ctx: BuildContext): Block | undefined {
  const bound = bindArray(ctx, spec, 'table')
  if (bound === undefined) return undefined
  const keys = Array.isArray(spec['columns'])
    ? spec['columns'].filter((item): item is string => typeof item === 'string')
    : []
  if (keys.length === 0) {
    ctx.warnings.push(`table ${bound.source} 缺少 columns，已跳过`)
    return undefined
  }
  return makeTableBlock(id, bound.node, keys, bound.rows, ctx, {
    ...str(spec['title']) === undefined ? {} : { title: str(spec['title']) ?? '' },
    ...str(spec['sort']) === undefined ? {} : { sort: str(spec['sort']) ?? '' },
    ...typeof spec['foldAbove'] === 'number' ? { foldAbove: spec['foldAbove'] } : {},
    ...typeof spec['limit'] === 'number' ? { limit: spec['limit'] } : {},
  })
}

/** 时间线块。 */
function timelineBlock(id: string, spec: Record<string, unknown>, ctx: BuildContext): Block | undefined {
  const bound = bindArray(ctx, spec, 'timeline')
  if (bound === undefined) return undefined
  const items: TimelineItem[] = []
  for (const row of bound.rows) {
    if (!isRecord(row)) continue
    items.push({
      at: str(row['at']) ?? str(row['date']) ?? '—',
      title: str(row['title']) ?? '—',
      ...str(row['detail']) === undefined ? {} : { detail: str(row['detail']) ?? '' },
    })
  }
  return items.length === 0 ? undefined : { kind: 'timeline', id, items }
}

/** 清单块：静态条目或绑定数组字段。 */
function listBlock(id: string, spec: Record<string, unknown>, ctx: BuildContext): Block | undefined {
  const ordered = spec['ordered'] === true
  const source = str(spec['source'])
  let items: string[] = []
  if (source !== undefined) {
    const value = ctx.data[source]
    if (!Array.isArray(value)) {
      ctx.warnings.push(`list 的 ${source} 不是数组，已跳过`)
      return undefined
    }
    ctx.used.add(source)
    items = value.map((row) => {
      if (typeof row === 'string') return row
      if (isRecord(row)) return str(row['text']) ?? JSON.stringify(row)
      return String(row)
    })
  } else if (Array.isArray(spec['items'])) {
    items = spec['items'].filter((item): item is string => typeof item === 'string')
  }
  if (items.length === 0) {
    ctx.warnings.push('list 既没有 items 也没有可用的 source，已跳过')
    return undefined
  }
  return { kind: 'list', id, ordered, items }
}

/** 把嵌套数据转成树节点。 */
function buildTree(items: unknown[], depth = 0): TreeNode[] {
  const nodes: TreeNode[] = []
  for (const item of items) {
    if (!isRecord(item) || depth > 8) continue
    const name = str(item['name']) ?? '—'
    const value = rawOf(item['value'])
    const children = Array.isArray(item['children']) ? buildTree(item['children'], depth + 1) : []
    nodes.push({
      name,
      ...typeof value === 'number' ? { value } : {},
      ...children.length === 0 ? {} : { children },
    })
  }
  return nodes
}

/** 把树拍平成「父 / 子」路径行，供数据表使用。 */
function flattenTree(items: unknown[], prefix = '', depth = 0): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = []
  for (const item of items) {
    if (!isRecord(item) || depth > 8) continue
    const name = str(item['name']) ?? '—'
    const path = prefix === '' ? name : `${prefix} / ${name}`
    const value = rawOf(item['value'])
    if (typeof value === 'number') rows.push({ name: path, value })
    const children = Array.isArray(item['children']) ? item['children'] : []
    if (children.length > 0) rows.push(...flattenTree(children, path, depth + 1))
  }
  return rows
}

/** 图表块：系列 + 折线数据表。 */
function chartBlock(id: string, spec: Record<string, unknown>, ctx: BuildContext): Block | undefined {
  const bound = bindArray(ctx, spec, 'chart')
  if (bound === undefined) return undefined
  const shape = str(bound.node?.['x-shape'])
  const isTree = shape === 'tree'
  const itemProperties = propertiesOf(itemsOf(bound.node))
  const series: SeriesSpec[] = []
  const rawSeries = Array.isArray(spec['series']) ? spec['series'] : []
  for (const item of rawSeries) {
    if (!isRecord(item)) continue
    const type = str(item['type']) as SeriesType | undefined
    if (type === undefined) {
      ctx.warnings.push('chart 的系列缺少 type，已跳过该系列')
      continue
    }
    if (!SERIES_TYPES.includes(type)) {
      ctx.warnings.push(`chart 的系列类型不支持：${type}`)
      continue
    }
    const y = str(item['y'])
    const fields = Array.isArray(item['fields'])
      ? item['fields'].filter((key): key is string => typeof key === 'string')
      : []
    const value = str(item['value'])
    if (SERIES[type].binding !== 'links' && SERIES[type].binding !== 'node'
      && SERIES[type].binding !== 'script' && !isTree
      && y === undefined && fields.length === 0) {
      ctx.warnings.push(`chart 的 ${type} 系列缺少 y 或 fields，已跳过该系列`)
      continue
    }
    for (const key of [...y === undefined ? [] : [y], ...fields, ...value === undefined ? [] : [value]]) {
      if (itemProperties !== undefined && !(key in itemProperties)) {
        ctx.warnings.push(`chart 的系列字段 ${key} 不在 ${bound.source}.items.properties 里`)
      }
    }
    const yAxisIndex = typeof item['yAxisIndex'] === 'number' ? item['yAxisIndex'] : undefined
    const tone = str(item['tone'])
    const rose = str(item['rose'])
    const labelPosition = str(item['labelPosition'])
    const sort = str(item['sort'])
    series.push({
      type,
      ...y === undefined ? {} : { y },
      ...fields.length === 0 ? {} : { fields },
      ...value === undefined ? {} : { value },
      ...str(item['name']) === undefined ? {} : { name: str(item['name']) ?? '' },
      ...yAxisIndex === undefined ? {} : { yAxisIndex },
      ...item['stack'] === true ? { stack: true } : {},
      ...item['smooth'] === true ? { smooth: true } : {},
      ...tone === 'ok' || tone === 'warn' || tone === 'err' || tone === 'info' ? { tone } : {},
      ...typeof item['min'] === 'number' ? { min: item['min'] } : {},
      ...typeof item['max'] === 'number' ? { max: item['max'] } : {},
      ...item['donut'] === false ? { donut: false } : {},
      ...rose === 'radius' || rose === 'area' ? { rose } : {},
      ...labelPosition === 'inside' || labelPosition === 'outside' || labelPosition === 'none' ? { labelPosition } : {},
      ...item['showValue'] === true ? { showValue: true } : {},
      ...item['step'] === true ? { step: true } : {},
      ...str(item['size']) === undefined ? {} : { size: str(item['size']) ?? '' },
      ...item['filled'] === false ? { filled: false } : {},
      ...sort === 'ascending' || sort === 'descending' ? { sort } : {},
      ...typeof item['gap'] === 'number' ? { gap: item['gap'] } : {},
      ...item['layout'] === 'circular' || item['layout'] === 'none' ? { layout: item['layout'] } : {},
      ...str(item['script']) === undefined ? {} : { script: str(item['script']) ?? '' },
    })
  }
  if (series.length === 0) {
    ctx.warnings.push(`chart ${bound.source} 没有可用的系列，已跳过`)
    return undefined
  }
  if (series.length > 1 && SINGLE_SERIES.includes(series[0]!.type)) {
    ctx.warnings.push(`chart ${bound.source} 的 ${series[0]!.type} 只支持单系列，多余的系列已忽略`)
  }

  // 自定义图形：脚本相对 `.share/` 解析成绝对路径（随任务上传）
  let customScript: string | undefined
  if (series[0]?.type === 'custom') {
    const script = series[0].script
    if (script === undefined) {
      ctx.warnings.push('custom 系列缺少 script，已跳过')
      return undefined
    }
    if (ctx.folder === undefined) {
      ctx.warnings.push('自定义图形需要任务目录才能解析脚本，已跳过')
      return undefined
    }
    customScript = join(ctx.folder, '.share', script)
  }
  const x = str(spec['x'])
  const sizeKey = series[0]?.size
  const tree = isTree ? buildTree(bound.rows) : undefined
  const flatRows = tree === undefined ? bound.rows : flattenTree(bound.rows)
  const mapName = asMapName(str(spec['map']))
  const mapFields = mapName === undefined ? [] : series[0]?.fields ?? []
  const keyList = tree !== undefined
    ? ['name', 'value']
    : [
        ...x === undefined ? [] : [x],
        ...series.flatMap(item => seriesKeys(item)),
        ...sizeKey === undefined ? [] : [sizeKey],
        ...mapFields,
      ]
  const keys = [...new Set(keyList)]
  if (!isTree && mapName === undefined) chartFitWarnings(series, x, keys, bound.rows, bound.source, ctx)
  const table = makeTableBlock(`${id}-data`, bound.node, keys, flatRows, ctx, {})

  // 地图：fields = [经度, 纬度, 权重]，x 为地点名
  let mapPoints: { name?: string, value: [number, number, number] }[] | undefined
  if (mapName !== undefined) {
    const [lngKey, latKey, weightKey] = mapFields
    if (lngKey === undefined || latKey === undefined || weightKey === undefined) {
      ctx.warnings.push(`chart ${bound.source} 的地图需要 fields: [经度, 纬度, 权重]`)
      return undefined
    }
    mapPoints = []
    for (const row of bound.rows) {
      if (!isRecord(row)) continue
      const lng = rawOf(row[lngKey])
      const lat = rawOf(row[latKey])
      if (typeof lng !== 'number' || typeof lat !== 'number') continue
      const weight = rawOf(row[weightKey])
      const name = x === undefined ? undefined : str(row[x])
      mapPoints.push({
        ...name === undefined ? {} : { name },
        value: [lng, lat, typeof weight === 'number' ? weight : 1],
      })
    }
    if (mapPoints.length === 0) {
      ctx.warnings.push(`chart ${bound.source} 的地图没有可用坐标`)
      return undefined
    }
  }

  // 关系图：节点来自 source，边来自块级 links 字段
  let graphData: GraphData | undefined
  if (series[0]?.type === 'graph') {
    const coordX = series[0].fields?.[0]
    const coordY = series[0].fields?.[1]
    const nodes: GraphNode[] = []
    for (const row of bound.rows) {
      if (!isRecord(row)) continue
      const name = x === undefined ? undefined : str(row[x])
      if (name === undefined) continue
      const size = sizeKey === undefined ? undefined : rawOf(row[sizeKey])
      const px = coordX === undefined ? undefined : rawOf(row[coordX])
      const py = coordY === undefined ? undefined : rawOf(row[coordY])
      nodes.push({
        name,
        ...typeof size === 'number' ? { value: size } : {},
        ...typeof px === 'number' ? { x: px } : {},
        ...typeof py === 'number' ? { y: py } : {},
      })
    }
    const linksKey = str(spec['links'])
    const links: GraphLink[] = []
    if (linksKey !== undefined) {
      ctx.used.add(linksKey)
      const rawLinks = ctx.data[linksKey]
      if (Array.isArray(rawLinks)) {
        for (const link of rawLinks) {
          if (!isRecord(link)) continue
          const source = str(link['source'])
          const target = str(link['target'])
          if (source === undefined || target === undefined) continue
          const value = rawOf(link['value'])
          links.push({ source, target, ...typeof value === 'number' ? { value } : {} })
        }
      }
    }
    graphData = { nodes, links }
  }

  const yAxes: AxisSpec[] = Array.isArray(spec['yAxes'])
    ? spec['yAxes'].filter(isRecord).map((axis) => {
        const position = str(axis['position'])
        return {
          ...str(axis['unit']) === undefined ? {} : { unit: str(axis['unit']) ?? '' },
          ...position === 'left' || position === 'right' ? { position } : {},
        }
      })
    : []
  const chartSpec: ChartSpec = {
    series,
    ...x === undefined ? {} : { x },
    ...str(spec['unit']) === undefined ? {} : { unit: str(spec['unit']) ?? '' },
    ...str(spec['title']) === undefined ? {} : { title: str(spec['title']) ?? '' },
    ...typeof spec['height'] === 'number' ? { height: spec['height'] } : {},
    ...typeof spec['legend'] === 'boolean' ? { legend: spec['legend'] } : {},
    ...yAxes.length === 0 ? {} : { yAxes },
    ...graphData === undefined ? {} : { graph: graphData },
    ...tree === undefined ? {} : { tree },
    ...mapName === undefined ? {} : { map: mapName },
    ...mapPoints === undefined ? {} : { mapPoints },
    ...customScript === undefined ? {} : { custom: { script: customScript, rows: bound.rows, columns: table.columns } },
  }
  const title = str(spec['title'])
  return {
    kind: 'chart',
    id,
    ...title === undefined ? {} : { title },
    spec: chartSpec,
    table,
  }
}

/**
 * 图表与数据的适配检查：只加警告，不改图型。
 *
 * 图型是契约里定死的（跨期要可比），这里不替模型做选择，只在「这么画会失真或
 * 出空图」时提醒一句，让下一轮能改契约或改脚本。
 * @param series - 本轮系列。
 * @param x - 横轴字段。
 * @param keys - 数据表列（x + 系列字段）。
 * @param rows - 原始数据行。
 * @param source - 字段名，用于警告文案。
 * @param ctx - 构建上下文。
 */
function chartFitWarnings(
  series: SeriesSpec[],
  x: string | undefined,
  keys: string[],
  rows: unknown[],
  source: string,
  ctx: BuildContext,
): void {
  const first = series[0]
  if (first === undefined) return
  const fieldValue = (row: unknown, key: string): number | string | null => {
    if (!isRecord(row) || !keys.includes(key)) return null
    return rawOf(row[key])
  }
  const xValue = (row: unknown): number | string | null => {
    if (x === undefined) return null
    return isRecord(row) ? rawOf(row[x]) : null
  }

  if (first.type === 'pie' || first.type === 'funnel' || first.type === 'treemap' || first.type === 'sunburst') {
    if (first.y === undefined) return
    const usable = rows.filter((row) => {
      const value = fieldValue(row, first.y!)
      return typeof value === 'number' && value > 0
    }).length
    if (rows.length > 8) {
      ctx.warnings.push(`${source}：${first.type} 有 ${String(rows.length)} 个切片，建议只取前 8 或改用表格`)
    }
    if (usable < rows.length) {
      ctx.warnings.push(`${source}：${first.type} 有 ${String(rows.length - usable)} 条值 ≤ 0 或缺失，会被丢弃，占比会失真`)
    }
    return
  }

  if (first.type === 'parallel') {
    const fields = first.fields ?? []
    if (fields.length < 2) ctx.warnings.push(`${source}：平行坐标至少需要 2 个维度`)
    return
  }

  if (first.type === 'themeRiver') {
    if (x === undefined) {
      ctx.warnings.push(`${source}：主题河流需要 x 作为时间轴`)
      return
    }
    const dated = rows.every((row) => {
      const value = xValue(row)
      return value !== null && !Number.isNaN(Date.parse(String(value)))
    })
    if (!dated) {
      ctx.warnings.push(`${source}：主题河流的 x 不是日期，横轴会退化成序号，建议改用 date 字段`)
    }
    return
  }

  if (first.type === 'scatter' || first.type === 'effectScatter') {
    if (first.y === undefined || x === undefined) return
    const points = rows.filter(row =>
      typeof fieldValue(row, x) === 'number' && typeof fieldValue(row, first.y!) === 'number').length
    if (rows.length > 0 && points === 0) {
      ctx.warnings.push(`${source}：散点的 x 或 y 不是数值，图会是空的`)
    } else if (points < rows.length) {
      ctx.warnings.push(`${source}：散点有 ${String(rows.length - points)} 行缺少数值，会被跳过`)
    }
    return
  }

  if (first.type === 'gauge') {
    if (rows.length > 1) {
      ctx.warnings.push(`${source}：仪表盘只取第一行，其余 ${String(rows.length - 1)} 行被忽略`)
    }
    return
  }

  if (first.type === 'bar' && rows.length > 20) {
    ctx.warnings.push(`${source}：柱状图有 ${String(rows.length)} 个类别，标签会挤，建议改表格或只取前 20`)
    return
  }

  if (first.type === 'radar') {
    const fields = first.fields ?? []
    if (fields.length < 3) ctx.warnings.push(`${source}：雷达图至少需要 3 个维度`)
    return
  }

  if ((first.type === 'line' || first.type === 'area') && x !== undefined) {
    const labels = rows.map((row) => {
      const value = xValue(row)
      return value === null ? '' : String(value)
    })
    // 只对「日期型 / 数值型」横轴检查顺序：类别轴按业务排序（如按股息率降序）是合法的。
    const ordered = labels.every(value => /^\d{4}-\d{2}(-\d{2})?$/u.test(value) || /^-?\d+(\.\d+)?$/u.test(value))
    if (ordered && labels.some((value, index) => index > 0 && labels[index - 1]! > value)) {
      ctx.warnings.push(`${source}：折线的 x 不是递增顺序，线条会来回折返（建议在脚本里排序）`)
    }
  }
}

/** 分栏容器。 */
function columnsBlock(id: string, spec: Record<string, unknown>, ctx: BuildContext): Block | undefined {
  const ratio = Array.isArray(spec['ratio'])
    ? spec['ratio'].filter((item): item is number => typeof item === 'number' && item > 0)
    : []
  const rawChildren = Array.isArray(spec['children']) ? spec['children'] : []
  if (ratio.length < 2 || ratio.length !== rawChildren.length) {
    ctx.warnings.push('columns 的 ratio 与 children 数量必须一致且至少两栏，已跳过')
    return undefined
  }
  const children: Block[][] = []
  for (const column of rawChildren) {
    if (!Array.isArray(column)) {
      ctx.warnings.push('columns 的每个 child 必须是一组块（数组），已跳过')
      return undefined
    }
    const blocks: Block[] = []
    for (const raw of column) {
      const child = isRecord(raw) ? buildBlock(raw, ctx) : undefined
      if (child !== undefined) blocks.push(child)
    }
    children.push(blocks)
  }
  return { kind: 'columns', id, ratio, children }
}

/** 卡片容器。 */
function cardBlock(id: string, spec: Record<string, unknown>, ctx: BuildContext): Block | undefined {
  const rawChildren = Array.isArray(spec['children']) ? spec['children'] : []
  const children: Block[] = []
  for (const raw of rawChildren) {
    const child = isRecord(raw) ? buildBlock(raw, ctx) : undefined
    if (child !== undefined) children.push(child)
  }
  if (children.length === 0) {
    ctx.warnings.push('card 没有可渲染的子块，已跳过')
    return undefined
  }
  const title = str(spec['title'])
  return { kind: 'card', id, ...title === undefined ? {} : { title }, children }
}

/**
 * 把一个块声明翻译成块。
 * @param spec - `x-blocks` 里的一个元素。
 * @param ctx - 构建上下文。
 * @returns 块；声明不可用时返回 undefined，并把原因记进警告。
 */
function buildBlock(spec: Record<string, unknown>, ctx: BuildContext): Block | undefined {
  const component = str(spec['component'])
  if (component === undefined) {
    ctx.warnings.push('块缺少 component，已跳过')
    return undefined
  }
  // 先分配 key 再构建：即使这个块因为数据问题被跳过，后面的 key 也不会错位。
  const key = nextKey(ctx, component)
  const id = nextId(ctx, component)
  const block = buildComponent(component, id, spec, ctx)
  return block === undefined ? undefined : { ...block, key }
}

/** 按组件名构建块；key 由调用方统一附加。 */
function buildComponent(
  component: string,
  id: string,
  spec: Record<string, unknown>,
  ctx: BuildContext,
): Block | undefined {
  switch (component) {
    case 'heading': {
      const text = str(spec['text'])
      if (text === undefined) {
        ctx.warnings.push('heading 缺少 text，已跳过')
        return undefined
      }
      const declared = typeof spec['level'] === 'number' ? spec['level'] : 2
      return { kind: 'heading', id, level: Math.min(3, Math.max(1, Math.round(declared))), text }
    }
    case 'paragraph': {
      const text = str(spec['text'])
      if (text === undefined) {
        ctx.warnings.push('paragraph 缺少 text，已跳过')
        return undefined
      }
      return { kind: 'paragraph', id, text }
    }
    case 'quote': {
      const text = str(spec['text'])
      if (text === undefined) {
        ctx.warnings.push('quote 缺少 text，已跳过')
        return undefined
      }
      return { kind: 'quote', id, text, ...str(spec['cite']) === undefined ? {} : { cite: str(spec['cite']) ?? '' } }
    }
    case 'note': {
      const text = str(spec['text'])
      if (text === undefined) {
        ctx.warnings.push('note 缺少 text，已跳过')
        return undefined
      }
      const tone = str(spec['tone'])
      return {
        kind: 'note',
        id,
        tone: tone === 'ok' || tone === 'warn' || tone === 'err' || tone === 'info' ? tone : 'info',
        text,
      }
    }
    case 'divider':
      return { kind: 'divider', id }
    case 'list':
      return listBlock(id, spec, ctx)
    case 'kv':
      return kvBlock(id, spec, ctx)
    case 'metrics':
      return metricsBlock(id, spec, ctx)
    case 'table':
      return tableBlock(id, spec, ctx)
    case 'timeline':
      return timelineBlock(id, spec, ctx)
    case 'chart':
      return chartBlock(id, spec, ctx)
    case 'columns':
      return columnsBlock(id, spec, ctx)
    case 'card':
      return cardBlock(id, spec, ctx)
    default:
      ctx.warnings.push(`未知的显示组件 ${component}，已跳过`)
      return undefined
  }
}

/**
 * 把顶层块按 `heading`（1–2 级）切成分区。
 * @param blocks - 顶层块。
 * @returns 分区列表；第一个标题之前的内容进无标题主区。
 */
function groupSections(blocks: Block[]): PlanSection[] {
  const sections: PlanSection[] = []
  let current: PlanSection | undefined
  for (const block of blocks) {
    if (block.kind === 'heading' && block.level <= 2) {
      current = { id: block.id, title: block.text, blocks: [] }
      sections.push(current)
      continue
    }
    if (current === undefined) {
      current = { id: 'main', blocks: [] }
      sections.push(current)
    }
    current.blocks.push(block)
  }
  return sections
}

/**
 * 组装渲染计划。
 * @param schema - 契约对象（已通过校验）。
 * @param doc - 本轮报告文档。
 * @param options - 缺失文案、折叠阈值等。
 * @returns 与格式无关的块树。
 */
export function buildPlan(
  schema: Record<string, unknown>,
  doc: ReportDoc,
  options: PlanOptions = {},
): RenderPlan {
  const resolved: Required<Omit<PlanOptions, 'folder'>> = {
    missingText: options.missingText ?? DEFAULT_MISSING_TEXT,
    defaultFoldAbove: options.defaultFoldAbove ?? Number.POSITIVE_INFINITY,
    maxRows: options.maxRows ?? 500,
  }
  const warnings: string[] = []
  const data = isRecord(doc.data) ? doc.data : {}
  const properties = propertiesOf(schema) ?? {}
  const ctx: BuildContext = {
    data,
    properties,
    options: resolved,
    warnings,
    used: new Set(),
    seq: 0,
    counts: new Map(),
    folder: options.folder,
  }

  const blocks: Block[] = []
  const specs = Array.isArray(schema['x-blocks']) ? schema['x-blocks'] : []
  for (const raw of specs) {
    if (!isRecord(raw)) continue
    const block = buildBlock(raw, ctx)
    if (block !== undefined) blocks.push(block)
  }

  const sections = groupSections(blocks)

  // notes：契约里已有 note 块，信封里的 notes 一律进「补充说明」，不再按 anchor 挂靠。
  const notes = normalizeNotes(doc.notes)
  if (notes.length > 0) {
    sections.push({
      id: 'notes',
      title: '补充说明',
      blocks: notes.map((note, index) => ({
        kind: 'note' as const,
        id: `note-${String(index)}`,
        tone: note.tone,
        text: note.text,
      })),
    })
  }

  if (sections.every(section => section.blocks.length === 0)) {
    sections.push({
      id: 'raw',
      title: '原始数据',
      blocks: [{ kind: 'raw', id: 'raw', label: '契约里没有可呈现的块', json: JSON.stringify(data, null, 2) }],
    })
    warnings.push('契约没有声明任何可呈现的块，已按原始数据展示')
  }

  // 缺失：数据里的 null 必须逐条出现在 missing[] 里。
  const nullPaths: string[] = []
  for (const [key, node] of Object.entries(properties)) {
    collectNullPaths(isRecord(node) ? node : undefined, data[key], key, nullPaths)
  }
  const declared = new Set(normalizeMissing(doc.missing).map(item => normalizePath(item.path)))
  for (const path of nullPaths) {
    if (!declared.has(path)) warnings.push(`缺失未在 missing[] 登记：${path}`)
  }

  // 密度：块太多时 PNG 很容易顶到高度上限，提前提示而不是悄悄截断。
  if (blocks.length > 12) {
    warnings.push(`本报告有 ${String(blocks.length)} 个块，PNG 可能过长，建议合并或折叠`)
  }
  for (const key of Object.keys(properties)) {
    if (!ctx.used.has(key)) warnings.push(`字段 ${key} 没有被任何块引用，报告里不会出现`)
  }

  const actions = normalizeActions(doc.actions)

  const meta: string[] = []
  if (str(doc.dataAsOf) !== undefined) meta.push(`数据截止 ${String(doc.dataAsOf)}`)
  if (str(doc.generatedAt) !== undefined) meta.push(`生成于 ${String(doc.generatedAt)}`)

  const footer: string[] = []
  const version = doc.meta === undefined ? undefined : str(doc.meta['pluginVersion'])
  if (version !== undefined) footer.push(`阿碳日报 ${version}`)
  const runId = doc.meta === undefined ? undefined : str(doc.meta['runId'])
  if (runId !== undefined) footer.push(`运行 ${runId}`)

  const taskName = str(doc.task?.name)
  const date = str(doc.dataAsOf) ?? str(doc.generatedAt)?.slice(0, 10) ?? ''
  const subtitle = str(doc.subtitle)
  const lead = doc.summary === undefined ? undefined : str(doc.summary.lead)

  return {
    title: str(doc.title) ?? str(schema['title']) ?? '报告',
    ...subtitle === undefined ? {} : { subtitle },
    eyebrow: [taskName, date].filter((part): part is string => part !== undefined && part !== '').join(' · '),
    ...lead === undefined ? {} : { lead },
    meta,
    sections,
    sources: normalizeSources(doc.sources),
    missing: normalizeMissing(doc.missing),
    actions,
    footer,
    warnings,
  }
}

/**
 * 构造「回退报告」：契约不可用或数据不合规时，仍然出一份能看懂的原始数据报告。
 *
 * 原则是「报告照出」：版式可以降级，数据和原因必须留在纸面上。回退报告不带
 * 任何图表与表格，只放一条警告和原始 JSON，避免把不合规的数据排版成看起来
 * 正常的报表。
 * @param doc - 本轮报告文档。
 * @param reason - 回退原因，写进报告顶部与渲染警告。
 * @returns 一个最小可渲染计划。
 */
export function fallbackPlan(doc: ReportDoc, reason: string): RenderPlan {
  const meta: string[] = []
  if (str(doc.dataAsOf) !== undefined) meta.push(`数据截止 ${String(doc.dataAsOf)}`)
  if (str(doc.generatedAt) !== undefined) meta.push(`生成于 ${String(doc.generatedAt)}`)
  const footer: string[] = []
  const version = doc.meta === undefined ? undefined : str(doc.meta['pluginVersion'])
  if (version !== undefined) footer.push(`阿碳日报 ${version}`)
  const runId = doc.meta === undefined ? undefined : str(doc.meta['runId'])
  if (runId !== undefined) footer.push(`运行 ${runId}`)
  const subtitle = str(doc.subtitle)
  const actions = normalizeActions(doc.actions)

  return {
    title: str(doc.title) ?? '报告',
    ...subtitle === undefined ? {} : { subtitle },
    eyebrow: [str(doc.task?.name), str(doc.dataAsOf)]
      .filter((part): part is string => part !== undefined && part !== '')
      .join(' · '),
    meta,
    sections: [{
      id: 'raw',
      title: '原始数据',
      blocks: [
        { kind: 'note', id: 'fallback-reason', tone: 'warn', text: reason },
        {
          kind: 'raw',
          id: 'raw',
          label: '本轮未经契约校验的数据',
          json: JSON.stringify(doc.data ?? {}, null, 2),
        },
      ],
    }],
    sources: normalizeSources(doc.sources),
    missing: normalizeMissing(doc.missing),
    actions,
    footer,
    warnings: [reason],
  }
}
