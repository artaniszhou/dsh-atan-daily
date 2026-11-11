/**
 * 契约修订提案：把「某一块换成什么图」翻译成新的 `x-blocks` 版本。
 *
 * 三条原则：
 * 1. **不拒绝**：数据不够也给出结论（`needs_data` / `blocked`），由人看过后决定；
 * 2. **不猜字段**：自动推断不出时明确说缺什么，允许调用方显式给 `bind`；
 * 3. **不动无关块**：只替换目标块并升 `x-revision`，其余原样保留。
 */

import { checkContract } from '../contract.js'
import type { SeriesType } from '../series.js'
import { SERIES } from '../series.js'
import { locateBlock } from './outline.js'

/** 兼容性判定。 */
export type VerdictLevel = 'exact' | 'lossy' | 'needs_data' | 'blocked'

/** 一次改图型请求。 */
export interface SchemaEdit {
  /** 块 key，例如 `chart#3`。 */
  key: string
  /** 目标图型。 */
  type: string
  /** 显式指定绑定；不传时自动推断。 */
  bind?: { x?: string, y?: string, fields?: string[] }
}

/** 提案结果。 */
export interface SchemaProposal {
  /** `exact` / `lossy` 时为 true：可以应用。 */
  ok: boolean
  /** 新契约（已升修订号）；`ok: false` 时没有。 */
  schema?: Record<string, unknown>
  /** 目标块信息。 */
  target?: { key: string, title?: string }
  /** 判定。 */
  verdict: VerdictLevel
  /** 人读结论：缺什么、会损失什么。 */
  findings: string[]
  /** 不阻断的提示。 */
  warnings: string[]
  /** 不可应用时的原因。 */
  error?: string
}

/** 一列的类型信息。 */
interface ColumnInfo {
  key: string
  numeric: boolean
  text: boolean
}

/** 判断普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 节点声明的类型集合。 */
function typesOf(node: Record<string, unknown>): string[] {
  const declared = node['type']
  if (Array.isArray(declared)) return declared.filter((item): item is string => typeof item === 'string')
  return typeof declared === 'string' ? [declared] : []
}

/** 从契约里取图表块可用的列。 */
function columnsOf(schema: Record<string, unknown>, source: string): ColumnInfo[] {
  const properties = schema['properties']
  if (!isRecord(properties)) return []
  const field = properties[source]
  if (!isRecord(field)) return []
  const items = field['items']
  if (!isRecord(items)) return []
  const itemProperties = items['properties']
  if (!isRecord(itemProperties)) return []
  const columns: ColumnInfo[] = []
  for (const [key, raw] of Object.entries(itemProperties)) {
    if (!isRecord(raw)) continue
    const types = typesOf(raw)
    columns.push({
      key,
      numeric: types.some(type => type === 'number' || type === 'integer'),
      text: types.some(type => type === 'string') || raw['format'] === 'date',
    })
  }
  return columns
}

/** 取块标题。 */
function titleOf(block: Record<string, unknown>): string | undefined {
  const title = block['title']
  return typeof title === 'string' && title.trim() !== '' ? title.trim() : undefined
}

/** 当前的系列类型。 */
function currentTypes(block: Record<string, unknown>): string {
  const series = block['series']
  if (!Array.isArray(series)) return '未声明'
  return series
    .map(item => (isRecord(item) && typeof item['type'] === 'string' ? item['type'] : ''))
    .filter(Boolean)
    .join(' + ')
}

/** 结果构造。 */
function result(
  verdict: VerdictLevel,
  findings: string[],
  extra: Partial<SchemaProposal> = {},
): SchemaProposal {
  return {
    ok: verdict === 'exact' || verdict === 'lossy',
    verdict,
    findings,
    warnings: [],
    ...extra,
  }
}

/**
 * 生成改图型提案。
 * @param schema - 当前契约。
 * @param edit - 目标块与目标图型。
 * @returns 提案；`ok` 表示可以应用。
 */
export function proposeSchemaEdit(schema: Record<string, unknown>, edit: SchemaEdit): SchemaProposal {
  const next = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>
  const located = locateBlock(next, edit.key)
  if (located === undefined) {
    return result('blocked', [`找不到块 ${edit.key}；契约可能已变化，请重新指定`], { error: '找不到目标块' })
  }
  let block = located.block
  if (block['component'] !== 'chart') {
    return result('blocked', ['只有图表块可以换图型'], { error: '目标不是图表块' })
  }
  const target = { key: edit.key, ...titleOf(block) === undefined ? {} : { title: titleOf(block) } }
  const type = edit.type as SeriesType
  if (!(type in SERIES)) {
    return result('blocked', [`不支持的图型：${edit.type}`], { target, error: '图型不存在' })
  }
  const source = block['source']
  if (typeof source !== 'string') {
    return result('blocked', ['这个图表块没有绑定数据字段，无法换图型'], { target, error: '缺少 source' })
  }
  const columns = columnsOf(next, source)
  if (columns.length === 0) {
    return result('blocked', [`字段 ${source} 没有可用的列`], { target, error: '没有列' })
  }

  let numeric = columns.filter(column => column.numeric)
  const text = columns.filter(column => column.text && !column.numeric)
  let droppedMap = false

  // 地图块：保留底图时只能用散点；换其它图型就先移除地图，再按普通图表推断。
  if (block['map'] !== undefined) {
    if (type === 'scatter' || type === 'effectScatter') {
      const existingFields = Array.isArray(block['series'])
        && isRecord((block['series'] as unknown[])[0])
        ? ((block['series'] as unknown[])[0] as Record<string, unknown>)['fields']
        : undefined
      const fields = edit.bind?.fields
        ?? (Array.isArray(existingFields) ? existingFields.filter((item): item is string => typeof item === 'string') : undefined)
        ?? [numeric[0]?.key, numeric[1]?.key, numeric[2]?.key].filter((item): item is string => item !== undefined)
      if (fields.length < 2) {
        return result('needs_data', ['地图点位需要经度与纬度两个数值列'], { target, error: '缺少坐标列' })
      }
      const findings = fields.length < 3 ? ['未提供权重列，所有点位按同一大小绘制'] : []
      return applyProposal(next, located, block, type, { type, fields }, findings, target, 'lossy')
    }
    const stripped = { ...block }
    delete stripped['map']
    block = stripped
    droppedMap = true
    numeric = numeric.filter(column => !/lng|lat|经度|纬度/iu.test(column.key))
  }

  if (type === 'custom') {
    return result('blocked', ['自定义图形需要脚本，不能在面板里直接切换'], { target, error: '需要脚本' })
  }
  if (type === 'tree') {
    const properties = next['properties']
    const shape = isRecord(properties) && isRecord(properties[source]) ? properties[source]['x-shape'] : undefined
    if (shape !== 'tree') return result('needs_data', ['树图需要字段声明为树形（`x-shape: "tree"`）'], { target, error: '数据不是树形' })
    return applyProposal(next, located, block, type, { type }, [], target, 'exact')
  }
  if (type === 'graph') {
    if (block['links'] === undefined) return result('needs_data', ['关系图需要块级 `links` 字段（边的列表）'], { target, error: '缺少边' })
    const existing = Array.isArray(block['series']) && isRecord((block['series'] as unknown[])[0])
      ? (block['series'] as unknown[])[0] as Record<string, unknown>
      : {}
    const fields = edit.bind?.fields ?? (Array.isArray(existing['fields']) ? existing['fields'] as string[] : undefined)
    return applyProposal(next, located, block, type, { type, ...fields === undefined ? {} : { fields } }, [], target, 'exact')
  }

  const x = edit.bind?.x ?? (typeof block['x'] === 'string' ? block['x'] : undefined) ?? text[0]?.key

  if (type === 'scatter' || type === 'effectScatter') {
    const numericKeys = numeric.map(column => column.key)
    const declaredX = typeof block['x'] === 'string' && numericKeys.includes(block['x']) ? block['x'] : undefined
    const scatterX = edit.bind?.x ?? declaredX ?? numericKeys[0]
    const y = edit.bind?.y ?? numericKeys.find(key => key !== scatterX)
    if (scatterX === undefined || y === undefined) {
      return result('needs_data', ['散点需要两个数值列：横轴与纵轴'], { target, error: '缺少数值列' })
    }
    return applyProposal(next, located, block, type, { type, y }, [], target, numeric.length > 2 ? 'lossy' : 'exact', scatterX)
  }

  if (type === 'heatmap') {
    const yAxis = edit.bind?.y ?? text.find(column => column.key !== x)?.key
    const value = numeric[0]?.key
    if (x === undefined || yAxis === undefined || value === undefined) {
      return result('needs_data', ['热力图需要三个列：横轴类别、纵轴类别、数值'], { target, error: '列不够' })
    }
    const findings = droppedMap ? ['已移除地图底图，改用两个分类列与数值列绘制'] : []
    return applyProposal(next, located, block, type, { type, y: yAxis, value }, findings, target, findings.length > 0 ? 'lossy' : 'exact', x)
  }

  if (type === 'pie' || type === 'funnel' || type === 'treemap' || type === 'sunburst' || type === 'gauge') {
    const y = edit.bind?.y ?? numeric[0]?.key
    if (y === undefined) return result('needs_data', [`${type} 需要一个数值列`], { target, error: '缺少数值列' })
    const findings = droppedMap ? ['已移除地图底图，改用分类列与数值列绘制'] : []
    return applyProposal(next, located, block, type, { type, y }, findings, target, findings.length > 0 ? 'lossy' : 'exact', x)
  }

  if (type === 'sankey' || type === 'chord') {
    const fields = edit.bind?.fields
      ?? [text[0]?.key, text[1]?.key, numeric[0]?.key].filter((item): item is string => item !== undefined)
    if (fields.length < 3) {
      return result('needs_data', ['桑基图/弦图需要三列：来源、去向、数值'], { target, error: '列不够' })
    }
    return applyProposal(next, located, block, type, { type, fields }, [], target, 'exact')
  }

  const needed = SERIES[type].fields ?? 1
  if (needed > 1) {
    const picked = edit.bind?.fields ?? numeric.slice(0, needed).map(column => column.key)
    if (picked.length < needed) {
      return result('needs_data', [`${SERIES[type].label}需要 ${String(needed)} 个数值列，当前只有 ${String(numeric.length)} 个`], { target, error: '列不够' })
    }
    const lossy = numeric.length > needed ? [`多余的 ${String(numeric.length - needed)} 个数值列不会展示`] : []
    if (droppedMap) lossy.push('已移除地图底图')
    return applyProposal(next, located, block, type, { type, fields: picked }, lossy, target, lossy.length > 0 ? 'lossy' : 'exact')
  }

  const y = edit.bind?.y ?? numeric[0]?.key
  if (y === undefined) {
    return result('needs_data', [`${SERIES[type].label}需要一个数值列`], { target, error: '缺少数值列' })
  }
  const lossy: string[] = []
  if (droppedMap) lossy.push('已移除地图底图，改用分类列与数值列绘制')
  if (numeric.length > 1) lossy.push(`多余的 ${String(numeric.length - 1)} 个数值列不会展示`)
  if (x === undefined) lossy.push('没有类别列，横轴会用序号代替')
  return applyProposal(next, located, block, type, { type, y }, lossy, target, lossy.length > 0 ? 'lossy' : 'exact', x)
}

/**
 * 把系列写回块、升修订号并校验。
 */
function applyProposal(
  schema: Record<string, unknown>,
  located: NonNullable<ReturnType<typeof locateBlock>>,
  block: Record<string, unknown>,
  type: SeriesType,
  series: Record<string, unknown>,
  findings: string[],
  target: { key: string, title?: string },
  verdict: VerdictLevel,
  x?: string,
): SchemaProposal {
  const previous = typeof schema['x-revision'] === 'number' ? schema['x-revision'] : 0
  const revision = previous + 1
  schema['x-revision'] = revision
  const changelog = Array.isArray(schema['x-changelog'])
    ? schema['x-changelog'].filter((item): item is string => typeof item === 'string')
    : []
  const label = target.title ?? target.key
  changelog.push(`v${String(revision)}（${new Date().toISOString().slice(0, 10)}）：按用户要求把「${label}」由 ${currentTypes(block)} 改为 ${type}`)
  schema['x-changelog'] = changelog

  const nextBlock: Record<string, unknown> = { ...block, series: [series] }
  if (x !== undefined) nextBlock['x'] = x
  located.siblings[located.index] = nextBlock

  const checked = checkContract(schema)
  if (!checked.ok) {
    const detail = checked.findings
      .filter(item => item.level === 'error')
      .slice(0, 5)
      .map(item => `${item.path}：${item.message}`)
    return {
      ok: false,
      verdict: 'blocked',
      findings: [...findings, ...detail],
      warnings: checked.warnings,
      target,
      error: '新契约未通过校验',
    }
  }
  return {
    ok: verdict === 'exact' || verdict === 'lossy',
    verdict,
    findings,
    warnings: checked.warnings,
    target,
    schema,
  }
}
