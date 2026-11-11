/**
 * 图表系列的单一事实来源。
 *
 * 类型清单、数据形状、绑定方式、是否单系列，都只在这里写一次；`chart.ts`、
 * `present.ts`、`contract.ts` 与元 schema 都从这里派生，避免「加一种类型要改
 * 四处、漏一处」。
 */

/** 支持的系列类型。 */
export type SeriesType =
  | 'line' | 'bar' | 'area'
  | 'pie' | 'funnel'
  | 'scatter' | 'effectScatter'
  | 'sparkline'
  | 'candlestick' | 'boxplot'
  | 'heatmap'
  | 'gauge'
  | 'radar'
  | 'treemap' | 'sunburst'
  | 'pictorialBar'
  | 'themeRiver'
  | 'parallel'
  | 'sankey' | 'chord'
  | 'graph'
  | 'tree'
  | 'custom'

/** 数据形状。 */
export type SeriesShape = 'flat' | 'tree' | 'link'

/** 字段绑定的形式。 */
export type SeriesBinding = 'y' | 'fields' | 'y+value' | 'links' | 'node' | 'script'

/** 一种系列的定义。 */
export interface SeriesDef {
  /** 人读的名字，用于报错与文档。 */
  label: string
  /** 数据形状；目前只实现 `flat`。 */
  shape: SeriesShape
  /** 只允许一个系列（多写的会被忽略）。 */
  single: boolean
  /** 绑定方式。 */
  binding: SeriesBinding
  /** `fields` 的固定数量；`radar` / `parallel` 用最少数量（见 MIN_FIELDS）。 */
  fields?: number
}

/** 需要「至少」多少个维度的类型。 */
export const MIN_FIELDS: Partial<Record<SeriesType, number>> = {
  radar: 3,
  parallel: 3,
}

/** 系列定义表。 */
export const SERIES: Record<SeriesType, SeriesDef> = {
  line: { label: '折线', shape: 'flat', single: false, binding: 'y' },
  bar: { label: '柱状', shape: 'flat', single: false, binding: 'y' },
  area: { label: '面积', shape: 'flat', single: false, binding: 'y' },
  pie: { label: '饼图', shape: 'flat', single: true, binding: 'y' },
  funnel: { label: '漏斗', shape: 'flat', single: true, binding: 'y' },
  scatter: { label: '散点', shape: 'flat', single: true, binding: 'y' },
  effectScatter: { label: '涟漪散点', shape: 'flat', single: true, binding: 'y' },
  sparkline: { label: '迷你线', shape: 'flat', single: true, binding: 'y' },
  candlestick: { label: 'K 线', shape: 'flat', single: false, binding: 'fields', fields: 4 },
  boxplot: { label: '箱线', shape: 'flat', single: false, binding: 'fields', fields: 5 },
  heatmap: { label: '热力图', shape: 'flat', single: true, binding: 'y+value' },
  gauge: { label: '仪表盘', shape: 'flat', single: true, binding: 'y' },
  radar: { label: '雷达', shape: 'flat', single: true, binding: 'fields' },
  treemap: { label: '矩形树图', shape: 'flat', single: true, binding: 'y' },
  sunburst: { label: '旭日图', shape: 'flat', single: true, binding: 'y' },
  pictorialBar: { label: '象形柱', shape: 'flat', single: false, binding: 'y' },
  themeRiver: { label: '主题河流', shape: 'flat', single: true, binding: 'fields', fields: 2 },
  parallel: { label: '平行坐标', shape: 'flat', single: true, binding: 'fields' },
  sankey: { label: '桑基图', shape: 'flat', single: true, binding: 'fields', fields: 3 },
  chord: { label: '弦图', shape: 'flat', single: true, binding: 'fields', fields: 3 },
  graph: { label: '关系图', shape: 'flat', single: true, binding: 'links' },
  tree: { label: '树图', shape: 'tree', single: true, binding: 'node' },
  custom: { label: '自定义图形', shape: 'flat', single: true, binding: 'script' },
}

/** 全部类型名。 */
export const SERIES_TYPES: readonly SeriesType[] = Object.keys(SERIES) as SeriesType[]

/** 单系列类型。 */
export const SINGLE_SERIES: readonly SeriesType[] = SERIES_TYPES.filter(type => SERIES[type].single)

/**
 * 判断一个字符串是不是受支持的系列类型。
 * @param value - 待判断的值。
 * @returns 是则返回类型名，否则 undefined。
 */
export function asSeriesType(value: string | undefined): SeriesType | undefined {
  if (value === undefined) return undefined
  return (SERIES_TYPES as readonly string[]).includes(value) ? value as SeriesType : undefined
}
