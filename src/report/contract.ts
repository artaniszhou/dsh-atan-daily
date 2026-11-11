/**
 * 任务级报告契约：读取、校验、修订号、快照与人话说明。
 *
 * 契约放在任务目录的 `.share/task-schema.json`，是 JSON Schema（数据定义）加
 * `x-blocks`（显示组件 → 数据）的块树。它由首轮会话生成；之后每次运行先按明细
 * hash 判断是否需要修订，再由插件按块树渲染。
 *
 * 三条约束贯穿本文件：
 * 1. **契约坏了不能挡住出报告** —— 调用方拿到 `ok: false` 时回退成原始数据报告。
 * 2. **一个任务只有一份当前契约** —— 写入即覆盖 `.share/task-schema.json`，不保留历史版本。
 * 3. **错误信息要能被模型直接执行** —— 路径用 `$.x-blocks[2].source` 这种写法，
 *    每条都带修复建议。
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeAtomic } from '../core/fs.js'
import { shareDirOf } from '../core/documents.js'
import { check, formatIssues } from './validate.js'
import type { Issue } from './validate.js'
import { MIN_FIELDS, SERIES, SERIES_TYPES } from './series.js'
import type { SeriesType } from './series.js'

/** 契约文件名。 */
export const CONTRACT_NAME = 'task-schema.json'

/** 元 schema 的位置：包根下的 `schema/report-meta.schema.json`。 */
const META_SCHEMA_URL: URL = new URL('../../schema/report-meta.schema.json', import.meta.url)

/** 一条契约写法问题。 */
export interface LintFinding {
  /** `error` 会让本轮按「契约无效」处理；`warn` 只提示。 */
  level: 'error' | 'warn'
  /** 契约内部的位置，例如 `$.x-blocks[2].source`。 */
  path: string
  /** 一句话说明与改法。 */
  message: string
  /** 可执行的修复线索，例如可用字段清单。 */
  hint?: string
}

/** 契约校验结果。 */
export interface ContractCheck {
  /** 结构与写法都通过时为 true。 */
  ok: boolean
  /** 结构性问题（不符合元 schema）。 */
  issues: Issue[]
  /** 写法问题（语义、块绑定）。 */
  findings: LintFinding[]
  /** 不阻断的提示，例如不支持的写法。 */
  warnings: string[]
}

/** 读取成功的契约。 */
export interface LoadedContract {
  /** 契约原文。 */
  raw: string
  /** 解析后的对象。 */
  schema: Record<string, unknown>
  /** `x-revision`。 */
  revision: number
  /** 原文的 sha256，写进 `report.json` 便于追溯。 */
  hash: string
  /** 不阻断的写法提示。 */
  warnings: string[]
}

/** 读取结果。 */
export type ContractLoad =
  | { ok: true, contract: LoadedContract }
  | { ok: false, code: 'missing' | 'unreadable' | 'invalid', message: string, issues: Issue[], findings: LintFinding[] }

/** 缓存的元 schema；进程内只读一次。 */
let cachedMetaSchema: Record<string, unknown> | undefined

/** 可用的显示组件。 */
const COMPONENTS: readonly string[] = [
  'heading', 'paragraph', 'list', 'quote', 'note', 'divider',
  'kv', 'metrics', 'table', 'timeline', 'chart',
  'columns', 'card',
]

/**
 * 契约目录：`<任务目录>/.share`。
 * @param taskFolder - 任务目录的绝对路径。
 * @returns 目录绝对路径。
 */
export function contractDir(taskFolder: string): string {
  return shareDirOf(taskFolder)
}

/**
 * 契约文件：`<任务目录>/.share/task-schema.json`。
 * @param taskFolder - 任务目录的绝对路径。
 * @returns 文件绝对路径。
 */
export function contractFile(taskFolder: string): string {
  return join(contractDir(taskFolder), CONTRACT_NAME)
}

/**
 * 读元 schema（只读一次）。
 * @returns 元 schema 对象。
 * @throws 包里缺文件或不是合法 JSON 时抛出；这是打包错误，不该静默。
 */
export function metaSchema(): Record<string, unknown> {
  if (cachedMetaSchema !== undefined) return cachedMetaSchema
  const path = META_SCHEMA_URL.protocol === 'file:'
    ? fileURLToPath(META_SCHEMA_URL)
    : join(process.cwd(), 'schema', 'report-meta.schema.json')
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`meta schema ${path} is not an object`)
  }
  cachedMetaSchema = parsed as Record<string, unknown>
  return cachedMetaSchema
}

/**
 * 契约原文的 sha256。
 * @param raw - 契约原文（UTF-8）。
 * @returns 64 位小写十六进制。
 */
export function contractHash(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex')
}

/** 从契约里取修订号；取不到时按 1 处理。 */
function revisionOf(schema: Record<string, unknown>): number {
  const value = schema['x-revision']
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 1
}

/** 判断是不是普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 取字符串。 */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
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

/** 取节点声明的类型集合。 */
function typesOf(node: Record<string, unknown>): string[] {
  const declared = node['type']
  if (Array.isArray(declared)) return declared.filter((item): item is string => typeof item === 'string')
  return typeof declared === 'string' ? [declared] : []
}

/** 校验器不执行、但语法合法的关键字；出现时提示「已忽略」。 */
const UNSUPPORTED_KEYWORDS: readonly string[] = [
  'allOf', 'not', 'patternProperties', 'prefixItems', 'contains',
  'if', 'then', 'else', 'dependentRequired', 'dependentSchemas',
  'unevaluatedProperties', 'propertyNames', 'multipleOf',
]

/** 契约遍历时的累积状态。 */
interface LintState {
  findings: LintFinding[]
  /** 顶层数据字段。 */
  properties: Record<string, unknown>
  /** 已被块引用过的字段。 */
  used: Set<string>
  /** 块总数。 */
  blocks: number
}

/**
 * 记一条 error。
 * @param state - 累积状态。
 * @param path - 契约内部位置。
 * @param message - 说明。
 * @param hint - 修复线索。
 */
function error(state: LintState, path: string, message: string, hint?: string): void {
  state.findings.push({ level: 'error', path, message, ...hint === undefined ? {} : { hint } })
}

/**
 * 记一条 warn。
 * @param state - 累积状态。
 * @param path - 契约内部位置。
 * @param message - 说明。
 */
function warn(state: LintState, path: string, message: string): void {
  state.findings.push({ level: 'warn', path, message })
}

/**
 * 遍历数据 schema 节点做语义检查。
 *
 * 只检查「写法」：required 与 properties 是否一致、数组有没有 items、数值有没有
 * 单位或格式。呈现方式不在这里，见 {@link lintBlock}。
 * @param node - 当前节点。
 * @param path - 当前位置（契约内部路径）。
 * @param state - 收集器。
 * @param depth - 递归深度。
 */
function lintNode(node: unknown, path: string, state: LintState, depth = 0): void {
  if (!isRecord(node) || depth > 12) return
  const record = node

  for (const key of Object.keys(record)) {
    if (UNSUPPORTED_KEYWORDS.includes(key)) {
      warn(state, path, `不支持的写法 ${key}：渲染器与校验器都会忽略它，改用受支持的子集`)
    }
  }
  if (record['x-present'] !== undefined) {
    error(
      state,
      `${path}.x-present`,
      'x-present 是契约 v1 的写法，已废弃：呈现方式写进 x-blocks，数据字段只保留类型与 x-label / x-unit / x-format',
    )
  }

  const required = Array.isArray(record['required'])
    ? record['required'].filter((item): item is string => typeof item === 'string')
    : []
  const properties = propertiesOf(record)
  for (const key of required) {
    if (properties === undefined || !(key in properties)) {
      error(state, `${path}.required`, `必填字段 ${key} 没有在 properties 里声明；要么补声明，要么从 required 里去掉`)
    }
  }

  const types = typesOf(record)
  const items = record['items']
  if (types.includes('array') && items === undefined) {
    error(state, path, '数组缺少 items，渲染器无法推导表格列；补上 items 的属性定义')
  }
  if ((types.includes('number') || types.includes('integer'))
    && record['x-unit'] === undefined && record['x-format'] === undefined) {
    warn(state, path, '数值字段没有声明 x-unit 或 x-format，报告里会只显示裸数字')
  }

  if (properties !== undefined) {
    for (const [key, child] of Object.entries(properties)) {
      lintNode(child, `${path}.properties.${key}`, state, depth + 1)
    }
  }
  if (Array.isArray(items)) {
    items.forEach((child, index) => { lintNode(child, `${path}.items[${String(index)}]`, state, depth + 1) })
  } else if (items !== undefined) {
    lintNode(items, `${path}.items`, state, depth + 1)
  }
  const definitions = record['$defs']
  if (isRecord(definitions)) {
    for (const [key, child] of Object.entries(definitions)) {
      lintNode(child, `${path}.$defs.${key}`, state, depth + 1)
    }
  }
}

/**
 * 校验一个数据字段的绑定。
 * @param block - 块声明。
 * @param path - 块路径。
 * @param state - 收集器。
 * @returns 字段节点与 items.properties；没绑定或字段不存在时为 undefined。
 */
function sourceOf(
  block: Record<string, unknown>,
  path: string,
  state: LintState,
): { source: string, node: Record<string, unknown>, itemProperties: Record<string, unknown> | undefined } | undefined {
  const source = str(block['source'])
  if (source === undefined) {
    error(state, path, '缺少 source：用 source 指定这个块绑定哪个顶层字段')
    return undefined
  }
  const node = state.properties[source]
  if (!isRecord(node)) {
    error(state, `${path}.source`, `source 指向的字段不存在：${source}`, `可用字段：${Object.keys(state.properties).join('、')}`)
    return undefined
  }
  state.used.add(source)
  if (!typesOf(node).includes('array')) {
    error(state, `${path}.source`, `${source} 必须是数组字段，这个组件按行读取数据`)
  }
  const itemProperties = propertiesOf(itemsOf(node))
  return { source, node, itemProperties }
}

/**
 * 校验一个块及其子块。
 * @param raw - 块声明。
 * @param path - 块路径。
 * @param state - 收集器。
 */
function lintBlock(raw: unknown, path: string, state: LintState): void {
  if (!isRecord(raw)) {
    error(state, path, '块必须是对象')
    return
  }
  state.blocks += 1
  const component = str(raw['component'])
  if (component === undefined) {
    error(state, path, '块缺少 component', `可用组件：${COMPONENTS.join('、')}`)
    return
  }
  if (!COMPONENTS.includes(component)) {
    error(state, `${path}.component`, `未知的显示组件：${component}`, `可用组件：${COMPONENTS.join('、')}`)
    return
  }

  switch (component) {
    case 'heading': {
      if (str(raw['text']) === undefined) error(state, path, 'heading 需要 text')
      const level = raw['level']
      if (level !== undefined && (typeof level !== 'number' || level < 1 || level > 3)) {
        error(state, `${path}.level`, 'level 只能是 1、2、3')
      }
      break
    }
    case 'paragraph':
    case 'quote':
    case 'note': {
      if (str(raw['text']) === undefined) error(state, path, `${component} 需要 text`)
      break
    }
    case 'divider':
      break
    case 'list': {
      const hasItems = Array.isArray(raw['items']) && raw['items'].length > 0
      const hasSource = str(raw['source']) !== undefined
      if (!hasItems && !hasSource) error(state, path, 'list 需要 items 或 source 之一')
      if (hasSource) sourceOf(raw, path, state)
      break
    }
    case 'kv': {
      const fields = Array.isArray(raw['fields'])
        ? raw['fields'].filter((item): item is string => typeof item === 'string')
        : []
      if (fields.length === 0) {
        error(state, path, 'kv 需要 fields：要展示的字段名数组')
        break
      }
      for (const field of fields) {
        if (!(field in state.properties)) {
          error(state, `${path}.fields`, `kv 引用了不存在的字段：${field}`, `可用字段：${Object.keys(state.properties).join('、')}`)
          continue
        }
        state.used.add(field)
      }
      break
    }
    case 'metrics': {
      const bound = sourceOf(raw, path, state)
      if (bound === undefined) break
      if (bound.itemProperties === undefined) {
        error(state, path, `${bound.source} 的 items 缺少 properties，渲染器读不到 label 与 value`)
        break
      }
      for (const key of ['label', 'value']) {
        if (!(key in bound.itemProperties)) {
          error(state, `${path}`, `${bound.source} 的元素缺少 ${key} 字段`, '指标元素形状：{ label, value, unit?, format?, delta?, tone? }')
        }
      }
      break
    }
    case 'table': {
      const bound = sourceOf(raw, path, state)
      const columns = Array.isArray(raw['columns'])
        ? raw['columns'].filter((item): item is string => typeof item === 'string')
        : []
      if (columns.length === 0) {
        error(state, path, 'table 需要 columns：只列要展示的字段，顺序即列顺序')
        break
      }
      if (bound !== undefined && bound.itemProperties !== undefined) {
        const unknown = columns.filter(column => !(column in bound.itemProperties!))
        if (unknown.length > 0) {
          error(state, `${path}.columns`, `columns 引用了不存在的字段：${unknown.join('、')}`, `可用字段：${Object.keys(bound.itemProperties).join('、')}`)
        }
      }
      const sort = str(raw['sort'])
      if (sort !== undefined) {
        const key = sort.replace(/^[+-]/u, '').trim()
        if (!columns.includes(key)) {
          error(state, `${path}.sort`, `sort 的字段 ${key} 不在 columns 里`, `可用列：${columns.join('、')}`)
        }
      }
      break
    }
    case 'timeline': {
      sourceOf(raw, path, state)
      break
    }
    case 'chart': {
      const bound = sourceOf(raw, path, state)
      const series = Array.isArray(raw['series']) ? raw['series'].filter(isRecord) : []
      if (series.length === 0) {
        error(state, path, 'chart 需要 series：至少一个系列，每个系列写 type 与 y（多字段类型写 fields）')
        break
      }
      const axes = Array.isArray(raw['yAxes']) ? raw['yAxes'].filter(isRecord) : []
      const xField = str(raw['x'])
      const isTreeShape = bound?.node?.['x-shape'] === 'tree'
      const blockMap = str(raw['map'])
      const isMapSeries = blockMap !== undefined
      series.forEach((item, index) => {
        const at = `${path}.series[${String(index)}]`
        const declared = str(item['type'])
        const def = declared === undefined ? undefined : SERIES[declared as SeriesType]
        if (declared === undefined || def === undefined) {
          error(state, at, `不支持的系列类型 ${declared ?? '(空)'}`, `可用类型：${SERIES_TYPES.join('、')}`)
          return
        }
        const type = declared as SeriesType
        const y = str(item['y'])
        const fields = Array.isArray(item['fields'])
          ? item['fields'].filter((key): key is string => typeof key === 'string')
          : []
        const value = str(item['value'])

        // —— 绑定形式：y / fields / y+value ——
        if (def.binding === 'fields') {
          if (def.fields !== undefined && fields.length !== def.fields) {
            error(state, `${at}.fields`, `${type} 需要 ${String(def.fields)} 个字段`)
          } else if (def.fields === undefined && fields.length < (MIN_FIELDS[type] ?? 1)) {
            error(state, `${at}.fields`, `${type} 至少需要 ${String(MIN_FIELDS[type] ?? 1)} 个维度（fields）`)
          }
        } else if (def.binding === 'y+value') {
          if (y === undefined) error(state, `${at}.y`, `${type} 需要 y：纵轴类别字段`)
          if (value === undefined) error(state, `${at}.value`, `${type} 需要 value：数值字段`)
        } else if (def.binding === 'links') {          const linksField = str(raw['links'])
          if (linksField === undefined) {
            error(state, path, `${type} 需要块级 links：边数组的字段名`)
          } else {
            const linksNode = state.properties[linksField]
            if (!isRecord(linksNode)) {
              error(state, `${path}.links`, `links 指向的字段不存在：${linksField}`, `可用字段：${Object.keys(state.properties).join('、')}`)
            } else {
              state.used.add(linksField)
              if (!typesOf(linksNode).includes('array')) {
                error(state, `${path}.links`, `links 字段必须是数组：${linksField}`)
              }
            }
          }
          const layout = str(item['layout']) ?? 'circular'
          if (layout !== 'circular' && layout !== 'none') {
            error(state, `${at}.layout`, 'graph 只支持 circular / none；force 每次渲染位置都不同，已禁用')
          }
          if (layout === 'none' && fields.length !== 2) {
            error(state, `${at}.fields`, 'graph 用 none 布局时需要 fields: [x, y] 两个坐标字段')
          }
        } else if (def.binding === 'script') {
          const script = str(item['script'])
          if (script === undefined) {
            error(state, `${at}.script`, `${type} 需要 script：相对 .share/ 的脚本路径`)
          } else if (!/^charts\/[\w.-]+\.mjs$/u.test(script)) {
            error(state, `${at}.script`, 'script 必须写在 .share/charts/ 下，扩展名 .mjs', '例如 charts/flow.mjs')
          }
        } else if (def.binding === 'node') {
          if (!isTreeShape) {
            error(state, at, `${type} 需要数据字段带 "x-shape": "tree"（元素含 name / value / children）`)
          }
        } else if (y === undefined && !isTreeShape && !isMapSeries) {
          error(state, `${at}.y`, `系列缺少 y：纵轴字段名（${type}）`)
        }

        const keys = [...y === undefined ? [] : [y], ...fields, ...value === undefined ? [] : [value]]
        if (bound !== undefined && bound.itemProperties !== undefined) {
          const unknown = keys.filter(key => !(key in bound.itemProperties!))
          if (unknown.length > 0) {
            error(state, at, `系列字段 ${unknown.join('、')} 不在 ${bound.source}.items.properties 里`, `可用字段：${Object.keys(bound.itemProperties).join('、')}`)
          }

          // —— 图型与字段类型的适配：只拦「必然出错」的组合 ——
          const namesOf = (key: string): string[] => {
            const child = bound.itemProperties?.[key]
            return isRecord(child) ? typesOf(child) : []
          }
          const isNumeric = (key: string): boolean => {
            const names = namesOf(key)
            return names.includes('number') || names.includes('integer')
          }
          if ((type === 'scatter' || type === 'effectScatter') && !isMapSeries) {
            if (xField !== undefined && !isNumeric(xField)) {
              error(state, `${path}.x`, `散点的 x 必须是数值字段；用期次、名称这类字符串会让点全部丢失（当前 x=${xField}）`)
            }
          }
          if (type === 'pie' || type === 'funnel' || type === 'treemap' || type === 'sunburst' || type === 'gauge') {
            if (y !== undefined && !isNumeric(y)) {
              error(state, `${at}.y`, `${type} 的 y 必须是数值字段（当前 ${y} 不是数值）`)
            }
            if (y !== undefined && namesOf(y).includes('null')) {
              warn(state, `${at}.y`, `${type} 的值可能为 null，这些行会被丢弃或显示为空`)
            }
          }
          if (type === 'heatmap' && value !== undefined && !isNumeric(value)) {
            error(state, `${at}.value`, 'heatmap 的 value 必须是数值字段')
          }
          if (type === 'radar' || type === 'parallel') {
            const nonNumeric = fields.filter(key => !isNumeric(key))
            if (nonNumeric.length > 0) {
              error(state, `${at}.fields`, `${type} 的维度必须是数值字段：${nonNumeric.join('、')}`)
            }
          }
          if (type === 'themeRiver') {
            const valueKey = fields[1]
            if (valueKey !== undefined && !isNumeric(valueKey)) {
              error(state, `${at}.fields`, `themeRiver 的第二个字段必须是数值：${valueKey} 不是数值`)
            }
          }
          if (type === 'candlestick' || type === 'boxplot') {
            const nonNumeric = fields.filter(key => !isNumeric(key))
            if (nonNumeric.length > 0) {
              error(state, `${at}.fields`, `${type} 的字段必须是数值：${nonNumeric.join('、')}`)
            }
          }
        }
        const axisIndex = item['yAxisIndex']
        if (typeof axisIndex === 'number' && axisIndex >= Math.max(1, axes.length)) {
          error(state, `${at}.yAxisIndex`, `yAxisIndex 超出 yAxes 数量（${String(Math.max(1, axes.length))}）`)
        }
        if (index === 0 && def.single && series.length > 1) {
          warn(state, `${path}.series`, `${type} 只支持单系列，多余的系列会被忽略`)
        }
      })

      // 地图：块级 map 指定底图，series.fields = [经度, 纬度, 权重]
      const mapName = str(raw['map'])
      if (mapName !== undefined) {
        if (mapName !== 'china' && mapName !== 'world') {
          error(state, `${path}.map`, 'map 只支持 china / world')
        }
        const first = series[0]
        const mapFields = first !== undefined && Array.isArray(first['fields'])
          ? first['fields'].filter((key): key is string => typeof key === 'string')
          : []
        if (mapFields.length !== 3) {
          error(state, path, '地图的 series 需要 fields: [经度, 纬度, 权重]')
        }
      }
      break
    }
    case 'columns': {
      const ratio = Array.isArray(raw['ratio']) ? raw['ratio'] : []
      const children = Array.isArray(raw['children']) ? raw['children'] : []
      if (ratio.length < 2) {
        error(state, `${path}.ratio`, 'columns 至少需要两个比例值')
      }
      if (ratio.length !== children.length) {
        error(state, path, `columns 的 ratio（${String(ratio.length)} 个）与 children（${String(children.length)} 栏）数量必须一致`)
      }
      children.forEach((column, index) => {
        if (!Array.isArray(column)) {
          error(state, `${path}.children[${String(index)}]`, 'columns 的每一栏必须是一组块（数组）')
          return
        }
        column.forEach((child, childIndex) => {
          lintBlock(child, `${path}.children[${String(index)}][${String(childIndex)}]`, state)
        })
      })
      break
    }
    case 'card': {
      const children = Array.isArray(raw['children']) ? raw['children'] : []
      if (children.length === 0) error(state, path, 'card 需要 children：至少一个子块')
      children.forEach((child, index) => {
        lintBlock(child, `${path}.children[${String(index)}]`, state)
      })
      break
    }
  }
}

/**
 * 语义检查一份契约。
 * @param schema - 契约对象。
 * @param findings - 输出数组，由调用方提供以便与其他检查合并。
 */
export function lintContract(schema: Record<string, unknown>, findings: LintFinding[] = []): LintFinding[] {
  const state: LintState = {
    findings,
    properties: propertiesOf(schema) ?? {},
    used: new Set(),
    blocks: 0,
  }
  // 老契约只给一条可执行的提示：没有 x-blocks 时逐字段报 x-present 已废弃只会刷屏。
  if (!Array.isArray(schema['x-blocks']) && isRecord(schema['properties'])) {
    error(
      state,
      '$.x-blocks',
      '这是契约 v1（字段驱动、没有 x-blocks），v2 已不再支持：按 SKILL §5.1 重建契约，并把 x-revision +1',
    )
    return findings
  }
  lintNode(schema, '$', state)
  const blocks = schema['x-blocks']
  if (Array.isArray(blocks)) {
    if (blocks.length === 0) {
      error(state, '$.x-blocks', 'x-blocks 不能为空：报告至少要有标题或一个数据块')
    }
    blocks.forEach((block, index) => { lintBlock(block, `$.x-blocks[${String(index)}]`, state) })
    for (const key of Object.keys(state.properties)) {
      if (!state.used.has(key)) {
        warn(state, '$.properties', `字段 ${key} 没有被任何块引用，报告里不会出现`)
      }
    }
    if (state.blocks > 12) {
      warn(state, '$.x-blocks', `共 ${String(state.blocks)} 个块，PNG 可能过长，建议合并或折叠`)
    }
  }
  const required = schema['required']
  if (!Array.isArray(required) || required.length === 0) {
    warn(state, '$.required', '没有必填字段：某一期整段数据缺失时，报告也不会提示')
  }
  return findings
}

/**
 * 校验一份契约（对象形态）。
 * @param value - 已解析的契约。
 * @returns 结构问题、写法问题与提示。
 */
export function checkContract(value: unknown): ContractCheck {
  const structural = check(metaSchema(), value, { maxIssues: 40, structural: true })
  const findings: LintFinding[] = []
  if (isRecord(value)) lintContract(value, findings)
  const broken = findings.some(finding => finding.level === 'error')
  return {
    ok: structural.ok && !broken,
    issues: structural.issues,
    findings,
    warnings: structural.warnings,
  }
}

/**
 * 从任务目录读取并校验契约。
 * @param taskFolder - 任务目录的绝对路径。
 * @returns 成功时给出契约内容与 hash；失败时给出可展示的原因。
 */
export async function loadContract(taskFolder: string): Promise<ContractLoad> {
  const path = contractFile(taskFolder)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      return { ok: false, code: 'missing', message: `还没有数据契约：${path}`, issues: [], findings: [] }
    }
    return {
      ok: false,
      code: 'unreadable',
      message: `读不到数据契约（${code ?? 'unknown'}）：${path}`,
      issues: [],
      findings: [],
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      code: 'invalid',
      message: `契约不是合法 JSON：${detail}`,
      issues: [{ path: '$', keyword: 'json', message: detail }],
      findings: [],
    }
  }

  const result = checkContract(parsed)
  if (!result.ok) {
    return {
      ok: false,
      code: 'invalid',
      message: contractProblemText(result),
      issues: result.issues,
      findings: result.findings,
    }
  }
  const schema = parsed as Record<string, unknown>
  return {
    ok: true,
    contract: {
      raw,
      schema,
      revision: revisionOf(schema),
      hash: contractHash(raw),
      warnings: [...result.warnings],
    },
  }
}

/**
 * 把校验结果拼成一段可直接放进报告的说明。
 * @param result - 契约校验结果。
 * @returns 多行文本，最多列 6 条。
 */
export function contractProblemText(result: ContractCheck): string {
  const parts: string[] = []
  const issues = formatIssues(result.issues, 6)
  if (issues.length > 0) parts.push(...issues)
  const errors = result.findings.filter(finding => finding.level === 'error').slice(0, 6)
  for (const finding of errors) {
    parts.push(`- ${finding.path}：${finding.message}${finding.hint === undefined ? '' : `（${finding.hint}）`}`)
  }
  return parts.length === 0 ? '契约校验未通过' : parts.join('\n')
}

/**
 * 写入契约。
 *
 * 先校验再落盘：中途失败时，`.share/task-schema.json` 仍是上一版可用的契约，
 * 不会出现「写坏了的正式文件」。
 * @param taskFolder - 任务目录的绝对路径。
 * @param raw - 契约原文。
 * @returns 修订号、hash 与写入的路径。
 * @throws 契约不合法或写盘失败时抛出。
 */
export async function writeContract(
  taskFolder: string,
  raw: string,
): Promise<{ revision: number, hash: string, file: string }> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`契约不是合法 JSON：${detail}`)
  }
  const result = checkContract(parsed)
  if (!result.ok) throw new Error(contractProblemText(result))

  const schema = parsed as Record<string, unknown>
  const revision = revisionOf(schema)
  const file = contractFile(taskFolder)
  await writeAtomic(file, raw)
  return { revision, hash: contractHash(raw), file }
}

/** 一行字段说明。 */
interface FieldRow {
  name: string
  type: string
  unit: string
  note: string
}

/** 把类型声明渲染成人读的样子。 */
function typeText(record: Record<string, unknown>): string {
  const names = typesOf(record)
  if (names.length === 0) return '—'
  const format = typeof record['format'] === 'string' ? `（${record['format']}）` : ''
  const enumValues = Array.isArray(record['enum']) ? record['enum'] : undefined
  const base = names.join(' | ') + format
  return enumValues === undefined ? base : `${base} 枚举 ${String(enumValues.length)} 种`
}

/** 递归收集字段行。 */
function collectRows(schema: Record<string, unknown>, rows: FieldRow[], prefix: string, depth: number): void {
  if (depth > 8) return
  const properties = propertiesOf(schema)
  if (properties === undefined) return
  for (const [key, raw] of Object.entries(properties)) {
    if (!isRecord(raw)) continue
    const names = typesOf(raw)
    const isArray = names.includes('array')
    const name = prefix === '' ? key : `${prefix}.${key}`
    const note = typeof raw['description'] === 'string'
      ? raw['description']
      : typeof raw['x-label'] === 'string' ? raw['x-label'] : ''
    rows.push({
      name: isArray ? `${name}[]` : name,
      type: typeText(raw),
      unit: typeof raw['x-unit'] === 'string' ? raw['x-unit'] : '—',
      note,
    })
    if (isArray) {
      const items = itemsOf(raw)
      if (items !== undefined) {
        // 下游字段带上 `[]`，否则 `banks.name` 和 `banks[3].name` 分不清。
        collectRows(items, rows, `${name}[]`, depth + 1)
      }
    }
  }
}

/**
 * 把一个值渲染成不会撑破 Markdown 表格的单元格。
 *
 * 类型里会出现 `number | null`，竖线直接写进表格会把列拆错，所以统一替换。
 * @param text - 原始文本。
 * @returns 单行、无竖线的文本。
 */
function cell(text: string): string {
  return text.replaceAll('|', '/').replaceAll(/\s+/gu, ' ').trim() || '—'
}

/** 一行块说明。 */
interface BlockRow {
  depth: number
  component: string
  binding: string
  note: string
}

/** 把块树展开成可读的表格行。 */
function collectBlocks(raw: unknown, rows: BlockRow[], depth: number): void {
  if (!Array.isArray(raw)) return
  for (const item of raw) {
    if (!isRecord(item)) continue
    const component = str(item['component']) ?? '—'
    const source = str(item['source'])
    const fields = Array.isArray(item['fields']) ? item['fields'].filter(isString).join('、') : ''
    const binding = source ?? (fields === '' ? '—' : fields)
    const parts: string[] = []
    const text = str(item['text'])
    if (text !== undefined) parts.push(text)
    const columns = Array.isArray(item['columns']) ? item['columns'].filter(isString) : []
    if (columns.length > 0) parts.push(`列：${columns.join('、')}`)
    const series = Array.isArray(item['series']) ? item['series'].filter(isRecord) : []
    if (series.length > 0) {
      parts.push(
        `系列：${series
          .map((entry) => {
            const type = str(entry['type']) ?? '?'
            const y = str(entry['y']) ?? '?'
            return `${type}(${y})`
          })
          .join('、')}`,
      )
    }
    const ratio = Array.isArray(item['ratio']) ? item['ratio'] : []
    if (ratio.length > 0) parts.push(`比例：${ratio.map(String).join(':')}`)
    rows.push({ depth, component, binding, note: parts.join('；') })
    collectBlocks(item['children'], rows, depth + 1)
  }
}

/** `isString` 的类型守卫。 */
function isString(value: unknown): value is string {
  return typeof value === 'string'
}

/**
 * 把契约渲染成人话版的字段表与块表，供终端查看与用户审阅。
 * @param schema - 契约对象。
 * @param maxRows - 字段表最多渲染多少行，默认 80。
 * @returns Markdown 文本；契约没有字段时给出提示。
 */
export function explainContract(schema: Record<string, unknown>, maxRows = 80): string {
  const rows: FieldRow[] = []
  collectRows(schema, rows, '', 0)
  const revision = revisionOf(schema)
  const title = typeof schema['title'] === 'string' ? schema['title'] : '数据契约'
  const required = Array.isArray(schema['required']) ? schema['required'].length : 0
  const blockRows: BlockRow[] = []
  collectBlocks(schema['x-blocks'], blockRows, 0)
  const lines = [
    `# ${title}`,
    '',
    `修订 v${String(revision)} · ${String(rows.length)} 个字段 · ${String(required)} 个必填 · ${String(blockRows.length)} 个块`,
    '',
  ]
  if (rows.length === 0) {
    lines.push('契约里还没有字段。')
    return lines.join('\n')
  }
  lines.push('| 字段 | 类型 | 单位 | 说明 |')
  lines.push('| --- | --- | --- | --- |')
  for (const row of rows.slice(0, maxRows)) {
    lines.push(`| \`${cell(row.name)}\` | ${cell(row.type)} | ${cell(row.unit)} | ${cell(row.note)} |`)
  }
  if (rows.length > maxRows) lines.push(`| … | | | 还有 ${String(rows.length - maxRows)} 行 |`)

  if (blockRows.length > 0) {
    lines.push('', '## 版面（x-blocks）', '')
    lines.push('| # | 组件 | 绑定 | 说明 |')
    lines.push('| --- | --- | --- | --- |')
    blockRows.forEach((row, index) => {
      const component = `${'  '.repeat(row.depth)}${row.component}`
      lines.push(`| ${String(index + 1)} | \`${cell(component)}\` | \`${cell(row.binding)}\` | ${cell(row.note)} |`)
    })
  }

  const findings = lintContract(schema)
  if (findings.length > 0) {
    lines.push('', '## 需要注意', '')
    for (const finding of findings) {
      const hint = finding.hint === undefined ? '' : `（${finding.hint}）`
      lines.push(`- ${finding.level === 'error' ? '[错误]' : '[提示]'} ${finding.path}：${finding.message}${hint}`)
    }
  }
  return lines.join('\n')
}
