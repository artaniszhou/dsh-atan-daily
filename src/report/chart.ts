/**
 * 图表：契约 + 表格数据 → 内联 SVG。
 *
 * 用 ECharts 的服务端渲染（`renderer: 'svg'` + `ssr: true`）在 Node 里出字符串，
 * 报告里因此没有任何 JS，打印与离线打开都可靠。
 *
 * 契约侧一个 `chart` 块是一组 `series`：每个系列自带类型与字段，多个系列即组合图，
 * `yAxisIndex` + `yAxes` 负责双轴。类型清单与数据形状在 `series.ts`，这里只做渲染。
 *
 * 三条约束：
 * 1. **随窗口缩放**：输出 `<svg viewBox="…">`，宽度交给 CSS。
 * 2. **确定性**：`animation: false` + 类名归一，同一份数据逐字节可复现。
 * 3. **缺失不造假**：`null` 原样进 series，不插值不补零。
 */

import { init } from 'echarts'
import type { Theme } from './theme.js'
import type { Column, Cell, Tone } from './present.js'
import type { SeriesType } from './series.js'
import { ensureMap } from './map.js'
import type { MapName } from './map.js'
import { renderCustomSvg } from './custom.js'

/** 一个图表系列。 */
export interface SeriesSpec {
  type: SeriesType
  /** 单值系列的纵轴字段。 */
  y?: string
  /** 多字段系列：candlestick 4、boxplot 5、radar/parallel 多、themeRiver 2。 */
  fields?: string[]
  /** heatmap 的数值字段。 */
  value?: string
  /** 图例名，缺省用字段的 `x-label`。 */
  name?: string
  /** 用第几根纵轴，0 起。 */
  yAxisIndex?: number
  /** 堆叠。 */
  stack?: boolean
  /** 平滑曲线。 */
  smooth?: boolean
  /** 语义色。 */
  tone?: Tone
  /** gauge 量程。 */
  min?: number
  max?: number
  /** pie：实心还是环形（默认环形）。 */
  donut?: boolean
  /** pie：玫瑰图。 */
  rose?: 'radius' | 'area'
  /** pie：标签位置。 */
  labelPosition?: 'inside' | 'outside' | 'none'
  /** bar / line / heatmap：是否在图形上标数值。 */
  showValue?: boolean
  /** line：阶梯线。 */
  step?: boolean
  /** scatter：用哪个字段决定点大小。 */
  size?: string
  /** radar：是否填充。 */
  filled?: boolean
  /** funnel：排序方向。 */
  sort?: 'ascending' | 'descending'
  /** funnel：块间距。 */
  gap?: number
  /** graph：布局。只允许 circular / none（force 每次位置不同）。 */
  layout?: 'circular' | 'none'
  /** custom：脚本相对路径（相对 `.meta/`）。 */
  script?: string
}

/** 关系图节点。 */
export interface GraphNode {
  name: string
  value?: number
  x?: number
  y?: number
}

/** 关系图边。 */
export interface GraphLink {
  source: string
  target: string
  value?: number
}

/** 关系图数据。 */
export interface GraphData {
  nodes: GraphNode[]
  links: GraphLink[]
}

/** 树形数据节点。 */
export interface TreeNode {
  name: string
  value?: number
  children?: TreeNode[]
}

/** 一根纵轴。 */
export interface AxisSpec {
  unit?: string
  position?: 'left' | 'right'
}

/** 契约里的图表声明。 */
export interface ChartSpec {
  series: SeriesSpec[]
  /** 横轴字段。 */
  x?: string
  /** 纵轴单位。 */
  unit?: string
  title?: string
  height?: number
  legend?: boolean
  yAxes?: AxisSpec[]
  /** 关系图数据（节点来自 source，边来自块级 links 字段）。 */
  graph?: GraphData
  /** 树形数据（字段带 x-shape: tree 时）。 */
  tree?: TreeNode[]
  /** 地图：底图名。设置后按 geo + scatter 渲染。 */
  map?: MapName
  /** 地图点位：[经度, 纬度, 权重]。 */
  mapPoints?: { name?: string, value: [number, number, number] }[]
  /** 自定义图形：脚本绝对路径与数据。 */
  custom?: { script: string, rows: unknown[], columns: Column[] }
}

/** 图表输入：与表格块同源。 */
export interface ChartInput {
  spec: ChartSpec
  columns: Column[]
  rows: Cell[][]
}

/** 渲染选项。 */
export interface ChartOptions {
  theme: Theme
  width?: number
  height?: number
  /** 展示覆盖带来的外观参数；不传时输出与改造前完全一致。 */
  style?: ChartStyle
}

/** 图表外观参数（来自展示覆盖）。 */
export interface ChartStyle {
  /** 图表高度（viewBox 单位）。 */
  height?: number
  /** 图表内部宽度（viewBox 宽），默认 720。 */
  width?: number
  /** 图内文字整体缩放，最后统一相乘。 */
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

/** 取某个字段在列里的下标。 */
function indexOf(columns: Column[], key: string | undefined): number {
  if (key === undefined) return -1
  return columns.findIndex(column => column.key === key)
}

/** 把一个单元格还原成图表能用的原始值。 */
function rawOf(cell: Cell | undefined): number | string | null {
  if (cell === undefined) return null
  const raw = cell.raw
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim()
  return null
}

/** 取一个「好看」的量程上限：1/2/5×10ⁿ。 */
function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(value))
  const normalized = value / magnitude
  const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10
  return nice * magnitude
}

/** 语义色取对应的主题色。 */
function toneColor(theme: Theme, tone: Tone): string {
  switch (tone) {
    case 'ok': return theme.success
    case 'warn': return theme.warning
    case 'err': return theme.danger
    case 'info':
    default: return theme.trust
  }
}

/** 解析 `#rgb` / `#rrggbb`。 */
function parseHex(value: string): [number, number, number] {
  const hex = value.replace('#', '')
  const full = hex.length === 3 ? hex.split('').map(char => char + char).join('') : hex
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ]
}

/** 按比例混合两个颜色。 */
function mixColor(from: string, to: string, t: number): string {
  const [ar, ag, ab] = parseHex(from)
  const [br, bg, bb] = parseHex(to)
  const channel = (a: number, b: number): string =>
    Math.round(a + (b - a) * t).toString(16).padStart(2, '0')
  return `#${channel(ar, br)}${channel(ag, bg)}${channel(ab, bb)}`
}

/** 系列绑定的字段名；用于构建数据表列与取值判空。 */
export function seriesKeys(series: SeriesSpec): string[] {
  if (series.type === 'candlestick' || series.type === 'boxplot'
    || series.type === 'radar' || series.type === 'themeRiver' || series.type === 'parallel'
    || series.type === 'sankey' || series.type === 'chord') {
    return series.fields ?? []
  }
  if (series.type === 'heatmap') {
    return [series.y, series.value].filter((key): key is string => key !== undefined)
  }
  return series.y === undefined ? [] : [series.y]
}

/** 系列的显示名：显式 name 优先，其次字段的 x-label。 */
function labelOf(series: SeriesSpec, columns: Column[]): string {
  if (series.name !== undefined) return series.name
  const key = seriesKeys(series)[0]
  const index = indexOf(columns, key)
  return columns[index]?.label ?? key ?? ''
}

/** 图例配置：统一放右上角。 */
function legendOf(spec: ChartSpec, labels: string[], theme: Theme): Record<string, unknown> {
  const show = spec.legend ?? labels.length > 1
  return {
    show,
    top: 0,
    right: 0,
    itemWidth: 10,
    itemHeight: 10,
    itemGap: 14,
    icon: 'roundRect',
    textStyle: { color: theme.muted, fontSize: 11 },
  }
}

/** 通用坐标轴样式。 */
function axisStyle(theme: Theme): Record<string, unknown> {
  return {
    axisLine: { lineStyle: { color: theme.border } },
    axisTick: { show: false },
    axisLabel: { color: theme.muted, fontSize: 11, margin: 8 },
  }
}

/** 一根纵轴。 */
function yAxisOf(
  axis: AxisSpec | undefined,
  unit: string,
  index: number,
  hasBar: boolean,
  theme: Theme,
): Record<string, unknown> {
  return {
    type: 'value',
    name: axis?.unit ?? unit,
    nameGap: 10,
    nameTextStyle: { color: theme.muted, fontSize: 11, padding: [0, 0, 0, 0] },
    position: axis?.position ?? 'left',
    scale: !hasBar,
    ...axisStyle(theme),
    axisLine: { show: false },
    splitLine: { show: index === 0, lineStyle: { color: theme.border, type: 'dashed' } },
  }
}

/** 名称 + 单值的通用数据（饼图、漏斗、树图、旭日共用）。 */
function nameValuePairs(
  columns: Column[],
  rows: Cell[][],
  xIndex: number,
  valueIndex: number,
): { name: string, value: number }[] {
  const data: { name: string, value: number }[] = []
  for (const row of rows) {
    const value = rawOf(row[valueIndex])
    if (typeof value !== 'number' || value <= 0) continue
    const name = xIndex >= 0 ? rawOf(row[xIndex]) : null
    data.push({ name: name === null ? '—' : String(name), value })
  }
  return data
}

/**
 * 组装 ECharts option。
 * @param input - 图表声明、列与行。
 * @param theme - 主题令牌。
 * @returns 可直接 `setOption` 的对象。
 */
function buildOption(input: ChartInput, theme: Theme, style?: ChartStyle): Record<string, unknown> {
  const { spec, columns, rows } = input
  const first = spec.series[0]
  if (first === undefined) return {}

  const xIndex = indexOf(columns, spec.x)
  const categories = rows.map((row) => {
    const value = xIndex >= 0 ? rawOf(row[xIndex]) : null
    return value === null ? '—' : String(value)
  })
  const labels = spec.series.map(series => labelOf(series, columns))
  const legendVisible = spec.legend ?? labels.length > 1
  const unit = spec.unit ?? spec.yAxes?.[0]?.unit ?? ''
  const topPadding = (legendVisible ? 36 : 12) + (unit === '' ? 0 : 14)
  const common: Record<string, unknown> = {
    animation: false,
    backgroundColor: 'transparent',
    color: theme.chart,
    textStyle: { fontFamily: theme.fontSans, color: theme.body, fontSize: 12 },
    grid: { left: 4, right: 12, top: topPadding, bottom: 4, containLabel: true },
    legend: legendOf(spec, labels, theme),
    aria: { enabled: true, decal: { show: false } },
  }

  // —— 地图：底图 + 事件点位 ——
  if (spec.map !== undefined) {
    if (!ensureMap(spec.map)) return {}
    const points = spec.mapPoints ?? []
    const maxWeight = Math.max(1, ...points.map(point => point.value[2]))
    const pointMin = style?.pointSize?.min ?? 6
    const pointMax = style?.pointSize?.max ?? 24
    return {
      ...common,
      grid: { show: false },
      legend: { show: false },
      geo: {
        map: spec.map,
        roam: false,
        silent: true,
        itemStyle: {
          areaColor: mixColor(theme.paper, theme.accent, 0.06),
          borderColor: theme.border,
          borderWidth: 0.6,
        },
        emphasis: { disabled: true },
        label: { show: false },
      },
      series: [{
        type: 'scatter',
        coordinateSystem: 'geo',
        symbolSize: (value: number[]) => pointMin + (Math.sqrt(Math.abs(value[2] ?? 0)) / Math.sqrt(maxWeight)) * (pointMax - pointMin),
        itemStyle: { color: theme.accent, opacity: 0.85 },
        label: { show: true, position: 'right', formatter: '{b}', color: theme.body, fontSize: 10 },
        labelLayout: { hideOverlap: true },
        data: points,
      }],
    }
  }

  // —— 热力图 ——
  if (first.type === 'heatmap') {
    const yIndex = indexOf(columns, first.y)
    const valueIndex = indexOf(columns, first.value)
    if (yIndex < 0 || valueIndex < 0) return {}
    const yValues: string[] = []
    const xValues: string[] = []
    const raw: { x: number, y: number, value: number }[] = []
    for (const row of rows) {
      const x = rawOf(row[xIndex < 0 ? -1 : xIndex])
      const y = rawOf(row[yIndex])
      const value = rawOf(row[valueIndex])
      if (typeof value !== 'number') continue
      const xLabel = x === null ? '—' : String(x)
      const yLabel = y === null ? '—' : String(y)
      if (!xValues.includes(xLabel)) xValues.push(xLabel)
      if (!yValues.includes(yLabel)) yValues.push(yLabel)
      raw.push({ x: xValues.indexOf(xLabel), y: yValues.indexOf(yLabel), value })
    }
    if (raw.length === 0) return {}
    const min = Math.min(...raw.map(point => point.value))
    const max = Math.max(...raw.map(point => point.value))
    const points = raw.map(point => ({ value: [point.x, point.y, point.value] as [number, number, number] }))
    return {
      ...common,
      grid: { left: 4, right: 12, top: 12, bottom: 8, containLabel: true },
      legend: { show: false },
      visualMap: {
        show: false,
        min,
        max,
        inRange: { color: [mixColor(theme.paper, theme.accent, 0.25), theme.accent] },
      },
      xAxis: { type: 'category', data: xValues, ...axisStyle(theme), splitLine: { show: false } },
      yAxis: {
        type: 'category',
        data: yValues,
        ...axisStyle(theme),
        axisLine: { show: false },
        splitLine: { show: false },
      },
      series: [{
        type: 'heatmap',
        data: points,
        label: {
          show: first.showValue ?? xValues.length * yValues.length <= 60,
          color: theme.ink,
          fontSize: 10,
          textBorderColor: theme.paper,
          textBorderWidth: 2,
        },
        itemStyle: { borderColor: theme.border, borderWidth: 1 },
        emphasis: { disabled: true },
      }],
    }
  }

  // —— 仪表盘 ——
  if (first.type === 'gauge') {
    const valueIndex = indexOf(columns, first.y)
    const cell = valueIndex < 0 ? undefined : rows[0]?.[valueIndex]
    const numeric = typeof cell?.raw === 'number' ? cell.raw : 0
    return {
      ...common,
      grid: { show: false },
      legend: { show: false },
      series: [{
        type: 'gauge',
        min: first.min ?? 0,
        max: first.max ?? 100,
        startAngle: 210,
        endAngle: -30,
        radius: '94%',
        center: ['50%', '56%'],
        progress: { show: true, width: 12, itemStyle: { color: theme.accent } },
        axisLine: { lineStyle: { width: 12, color: [[1, theme.border]] } },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: { show: false },
        pointer: { show: false },
        anchor: { show: false },
        detail: {
          valueAnimation: false,
          offsetCenter: [0, '12%'],
          fontSize: 28,
          color: theme.ink,
          formatter: () => cell?.text ?? '—',
        },
        data: [{ value: numeric, name: labelOf(first, columns) }],
        title: { color: theme.muted, fontSize: 12, offsetCenter: [0, '48%'] },
      }],
    }
  }

  // —— 雷达 ——
  if (first.type === 'radar') {
    const keys = first.fields ?? []
    if (keys.length < 3) return {}
    const indexes = keys.map(key => indexOf(columns, key))
    if (indexes.some(index => index < 0)) return {}
    const indicators = keys.map((key, position) => {
      const column = columns[indexes[position]!]
      const values = rows
        .map(row => rawOf(row[indexes[position]!]))
        .filter((value): value is number => typeof value === 'number')
      const peak = values.length === 0 ? 1 : Math.max(...values)
      return { name: column?.label ?? key, max: niceMax(peak * 1.1) }
    })
    const data = rows.map((row, index) => {
      const name = xIndex >= 0 ? rawOf(row[xIndex]) : null
      const color = theme.chart[index % theme.chart.length] ?? theme.accent
      return {
        name: name === null ? `#${String(index + 1)}` : String(name),
        value: keys.map((_, position) => {
          const value = rawOf(row[indexes[position]!])
          return typeof value === 'number' ? value : 0
        }),
        itemStyle: { color },
        lineStyle: { color, width: 2 },
        areaStyle: { color, opacity: first.filled === false ? 0 : 0.12 },
      }
    })
    return {
      ...common,
      legend: { ...legendOf(spec, labels, theme), show: spec.legend ?? data.length > 1 },
      radar: {
        indicator: indicators,
        radius: '64%',
        center: ['50%', '54%'],
        axisName: { color: theme.muted, fontSize: 11 },
        axisLine: { lineStyle: { color: theme.border } },
        splitLine: { lineStyle: { color: theme.border } },
        splitArea: { show: false },
      },
      series: [{ type: 'radar', symbolSize: 4, data }],
    }
  }

  // —— 树形数据：树图 / 矩形树图（多层）/ 旭日图（多层）——
  if (spec.tree !== undefined && (first.type === 'tree' || first.type === 'treemap' || first.type === 'sunburst')) {
    if (first.type === 'tree') {
      const root: TreeNode = spec.tree.length === 1
        ? spec.tree[0]!
        : { name: spec.title ?? '全部', children: spec.tree }
      return {
        ...common,
        grid: { show: false },
        legend: { show: false },
        series: [{
          type: 'tree',
          data: [root],
          left: '8%',
          right: '22%',
          top: '8%',
          bottom: '8%',
          symbolSize: 7,
          initialTreeDepth: -1,
          label: { position: 'left', fontSize: 10, color: theme.body },
          leaves: { label: { position: 'right', fontSize: 10, color: theme.body } },
          lineStyle: { color: theme.border, width: 1.5, curveness: 0.5 },
          itemStyle: { color: theme.chart[0] ?? theme.accent },
        }],
      }
    }
    return {
      ...common,
      grid: { show: false },
      legend: { show: false },
      series: [first.type === 'treemap'
        ? {
            type: 'treemap',
            left: 0,
            right: 0,
            top: 0,
            bottom: 0,
            roam: false,
            nodeClick: false,
            breadcrumb: { show: false },
            upperLabel: { show: true, height: 18, color: theme.paper, fontSize: 10 },
            levels: [
              { itemStyle: { borderWidth: 2, gapWidth: 3 }, upperLabel: { show: true, height: 18 } },
              { itemStyle: { borderWidth: 1, gapWidth: 1 }, upperLabel: { show: false } },
            ],
            itemStyle: { borderColor: theme.paper, borderWidth: 1 },
            label: { show: true, formatter: '{b}', color: theme.ink, fontSize: 10 },
            data: spec.tree,
          }
        : {
            type: 'sunburst',
            radius: ['18%', '92%'],
            center: ['50%', '50%'],
            itemStyle: { borderColor: theme.paper, borderWidth: 1 },
            label: { fontSize: 9, color: theme.ink },
            data: spec.tree,
          }],
    }
  }

  // —— 饼图 / 漏斗 / 矩形树图 / 旭日图：名称 + 单值 ——
  if (first.type === 'pie' || first.type === 'funnel' || first.type === 'treemap' || first.type === 'sunburst') {
    const valueIndex = indexOf(columns, first.y)
    if (valueIndex < 0) return {}
    const data = nameValuePairs(columns, rows, xIndex, valueIndex)
    if (data.length === 0) return {}

    if (first.type === 'treemap') {
      return {
        ...common,
        grid: { show: false },
        legend: { show: false },
        series: [{
          type: 'treemap',
          left: 0,
          right: 0,
          top: 0,
          bottom: 0,
          roam: false,
          nodeClick: false,
          breadcrumb: { show: false },
          itemStyle: { borderColor: theme.paper, borderWidth: 2, gapWidth: 2 },
          label: { show: true, formatter: '{b}', color: theme.ink, fontSize: 11 },
          data,
        }],
      }
    }

    if (first.type === 'sunburst') {
      return {
        ...common,
        grid: { show: false },
        legend: { show: false },
        series: [{
          type: 'sunburst',
          radius: ['24%', '92%'],
          center: ['50%', '50%'],
          itemStyle: { borderColor: theme.paper, borderWidth: 2 },
          label: { fontSize: 10, color: theme.ink },
          data,
        }],
      }
    }

    const labelPosition = first.labelPosition ?? 'outside'
    const label = labelPosition === 'none'
      ? { show: false }
      : first.type === 'pie'
        ? {
            show: true,
            position: labelPosition,
            color: labelPosition === 'inside' ? surfaceText(theme) : theme.body,
            fontSize: 11,
            formatter: '{b} {d}%',
          }
        : { show: true, color: theme.body, fontSize: 11, formatter: '{b} {c}' }

    return {
      ...common,
      legend: { ...legendOf(spec, labels, theme), show: spec.legend ?? false },
      series: [first.type === 'pie'
        ? {
            type: 'pie',
            // 玫瑰图默认实心；环形只在显式 donut 时使用。
            radius: first.donut === false || (first.rose !== undefined && first.donut !== true)
              ? '72%'
              : ['46%', '72%'],
            center: ['50%', '46%'],
            ...first.rose === undefined ? {} : { roseType: first.rose },
            itemStyle: { borderColor: theme.paper, borderWidth: 2 },
            label,
            labelLine: { length: 10, length2: 8, lineStyle: { color: theme.border } },
            data,
          }
        : {
            type: 'funnel',
            left: '8%',
            right: '8%',
            top: legendVisible ? 36 : 12,
            bottom: 8,
            sort: first.sort ?? 'descending',
            gap: first.gap ?? 2,
            itemStyle: { borderColor: theme.paper, borderWidth: 2 },
            label,
            data,
          }],
    }
  }

  // —— 主题河流：长表透视 ——
  if (first.type === 'themeRiver') {
    const keys = first.fields ?? []
    const categoryIndex = indexOf(columns, keys[0])
    const valueIndex = indexOf(columns, keys[1])
    if (categoryIndex < 0 || valueIndex < 0 || xIndex < 0) return {}
    const parsed = rows.map((row) => {
      const period = rawOf(row[xIndex])
      const value = rawOf(row[valueIndex])
      const name = rawOf(row[categoryIndex])
      if (typeof value !== 'number' || period === null || name === null) return undefined
      return { period: String(period), value, name: String(name) }
    }).filter((item): item is { period: string, value: number, name: string } => item !== undefined)
    if (parsed.length === 0) return {}
    const isTime = parsed.every(item => !Number.isNaN(Date.parse(item.period)))
    const order: string[] = []
    for (const item of parsed) if (!order.includes(item.period)) order.push(item.period)
    const data = parsed.map(item => [
      isTime ? item.period : order.indexOf(item.period),
      item.value,
      item.name,
    ])
    return {
      ...common,
      grid: { show: false },
      legend: { ...legendOf(spec, labels, theme), show: spec.legend ?? true },
      singleAxis: {
        type: isTime ? 'time' : 'value',
        top: 34,
        bottom: 8,
        left: 10,
        right: 10,
        splitNumber: 3,
        axisLabel: {
          show: !isTime,
          color: theme.muted,
          fontSize: 9,
          formatter: (value: number) => order[value] ?? '',
        },
        axisLine: { lineStyle: { color: theme.border } },
        splitLine: { show: false },
      },
      series: [{
        type: 'themeRiver',
        left: 10,
        right: 10,
        top: 34,
        bottom: 8,
        label: { show: false },
        itemStyle: { opacity: 0.85 },
        data,
      }],
    }
  }

  // —— 平行坐标 ——
  if (first.type === 'parallel') {
    const keys = first.fields ?? []
    if (keys.length < 2) return {}
    const indexes = keys.map(key => indexOf(columns, key))
    if (indexes.some(index => index < 0)) return {}
    const data = rows.map(row => indexes.map(index => rawOf(row[index])))
    return {
      ...common,
      grid: { show: false },
      legend: { show: false },
      parallelAxis: keys.map((key, position) => ({
        dim: position,
        name: columns[indexes[position]!]?.label ?? key,
        nameTextStyle: { color: theme.muted, fontSize: 9 },
        axisLabel: { color: theme.muted, fontSize: 9 },
        axisLine: { lineStyle: { color: theme.border } },
        splitLine: { show: false },
      })),
      parallel: {
        left: 34,
        right: 40,
        top: 28,
        bottom: 14,
        parallelAxisDefault: {
          nameTextStyle: { color: theme.muted, fontSize: 9 },
          axisLabel: { color: theme.muted, fontSize: 9 },
          axisLine: { lineStyle: { color: theme.border } },
          splitLine: { show: false },
        },
      },
      series: [{ type: 'parallel', lineStyle: { width: 2, opacity: 0.6 }, data }],
    }
  }

  // —— 迷你线 ——
  if (first.type === 'sparkline') {
    return {
      ...common,
      grid: { left: 0, right: 0, top: 4, bottom: 4 },
      legend: { show: false },
      xAxis: { type: 'category', show: false, boundaryGap: false, data: categories },
      yAxis: { type: 'value', show: false, scale: true },
      series: [{
        type: 'line',
        data: rows.map(row => rawOf(row[indexOf(columns, first.y)])),
        showSymbol: false,
        connectNulls: false,
        lineStyle: { width: 2 },
        areaStyle: { opacity: 0.08 },
      }],
    }
  }

  // —— 散点 / 涟漪散点 ——
  if (first.type === 'scatter' || first.type === 'effectScatter') {
    const yIndex = indexOf(columns, first.y)
    const sizeIndex = indexOf(columns, first.size)
    const points = rows
      .map((row) => {
        const x = xIndex >= 0 ? rawOf(row[xIndex]) : null
        const y = yIndex >= 0 ? rawOf(row[yIndex]) : null
        const size = sizeIndex >= 0 ? rawOf(row[sizeIndex]) : null
        return typeof x === 'number' && typeof y === 'number'
          ? (typeof size === 'number' ? [x, y, size] : [x, y])
          : undefined
      })
      .filter((point): point is number[] => point !== undefined)
    const base = {
      symbolSize: sizeIndex >= 0
        ? (value: number[]) => 6 + Math.min(24, Math.sqrt(Math.abs(value[2] ?? 1)) * 2)
        : 7,
      itemStyle: { color: theme.chart[0] ?? theme.accent, opacity: 0.85 },
      data: points,
    }
    return {
      ...common,
      legend: { show: false },
      xAxis: { type: 'value', ...axisStyle(theme), splitLine: { show: true, lineStyle: { color: theme.border, type: 'dashed' } } },
      yAxis: {
        type: 'value',
        ...axisStyle(theme),
        axisLine: { show: false },
        splitLine: { show: true, lineStyle: { color: theme.border, type: 'dashed' } },
      },
      series: [first.type === 'effectScatter'
        ? { type: 'effectScatter', showEffectOn: 'render', rippleEffect: { scale: 2.4, brushType: 'stroke' }, ...base }
        : { type: 'scatter', ...base }],
    }
  }

  // —— 桑基图 / 弦图：边列表 ——
  if (first.type === 'sankey' || first.type === 'chord') {
    const keys = first.fields ?? []
    const fromIndex = indexOf(columns, keys[0])
    const toIndex = indexOf(columns, keys[1])
    const valueIndex = indexOf(columns, keys[2])
    if (fromIndex < 0 || toIndex < 0 || valueIndex < 0) return {}
    const links: { source: string, target: string, value: number }[] = []
    const names: string[] = []
    for (const row of rows) {
      const source = rawOf(row[fromIndex])
      const target = rawOf(row[toIndex])
      const value = rawOf(row[valueIndex])
      if (source === null || target === null || typeof value !== 'number' || value <= 0) continue
      const from = String(source)
      const to = String(target)
      links.push({ source: from, target: to, value })
      if (!names.includes(from)) names.push(from)
      if (!names.includes(to)) names.push(to)
    }
    if (links.length === 0) return {}
    return {
      ...common,
      grid: { show: false },
      legend: { show: false },
      series: [{
        type: first.type,
        left: 8,
        // 右侧留出节点标签的位置，否则最后一列会被裁掉。
        right: 56,
        top: 12,
        bottom: 8,
        data: names.map(name => ({ name })),
        links,
        label: { color: theme.body, fontSize: 10 },
        lineStyle: {
          color: first.type === 'sankey' ? 'gradient' : 'source',
          opacity: 0.3,
          curveness: 0.5,
        },
        ...first.type === 'sankey' ? { nodeWidth: 8, nodeGap: 12 } : {},
      }],
    }
  }

  // —— 关系图：circular / none ——
  if (first.type === 'graph') {
    const graph = spec.graph ?? { nodes: [], links: [] }
    if (graph.nodes.length === 0) return {}
    const layout = first.layout ?? 'circular'
    const data = graph.nodes.map((node) => ({
      name: node.name,
      symbolSize: node.value === undefined
        ? 14
        : Math.min(30, 10 + Math.sqrt(Math.abs(node.value)) * 2),
      ...layout === 'none' && node.x !== undefined && node.y !== undefined
        ? { x: node.x, y: node.y }
        : {},
    }))
    return {
      ...common,
      grid: { show: false },
      legend: { show: false },
      series: [{
        type: 'graph',
        layout,
        circular: { rotateLabel: false },
        roam: false,
        draggable: false,
        label: { show: true, fontSize: 9, color: theme.body, position: 'right' },
        lineStyle: { color: theme.border, width: 1.2, opacity: 0.9 },
        itemStyle: { color: theme.chart[0] ?? theme.accent },
        data,
        links: graph.links,
      }],
    }
  }

  // —— 直角坐标系：折线 / 柱 / 面积 / K 线 / 箱线 / 象形柱 ——
  const axisCount = Math.max(1, ...spec.series.map(series => (series.yAxisIndex ?? 0) + 1))
  const axes = Array.from({ length: axisCount }, (_, index) => spec.yAxes?.[index])
  const barsByAxis = axes.map((_, index) => spec.series.some(series =>
    (series.yAxisIndex ?? 0) === index && (series.type === 'bar' || series.type === 'pictorialBar')))
  const maxValue = Math.max(
    1,
    ...rows.flatMap(row => row.map(cell => (typeof cell.raw === 'number' ? cell.raw : 0))),
  )
  const series = spec.series.map((item, order) => {
    const color = item.tone === undefined
      ? theme.chart[order % theme.chart.length] ?? theme.accent
      : toneColor(theme, item.tone)
    const base = {
      name: labelOf(item, columns),
      yAxisIndex: item.yAxisIndex ?? 0,
    }

    if (item.type === 'candlestick' || item.type === 'boxplot') {
      const indexes = (item.fields ?? []).map(key => indexOf(columns, key))
      const data = rows.map(row => indexes.map(index => (index < 0 ? null : rawOf(row[index]))))
      if (item.type === 'candlestick') {
        return {
          ...base,
          type: 'candlestick',
          data,
          itemStyle: {
            color: theme.danger,
            color0: theme.success,
            borderColor: theme.danger,
            borderColor0: theme.success,
          },
        }
      }
      return {
        ...base,
        type: 'boxplot',
        data,
        itemStyle: { color: theme.accent, borderColor: theme.accent },
      }
    }

    const index = indexOf(columns, item.y)
    const data = index < 0 ? [] : rows.map(row => rawOf(row[index]))
    const stack = item.stack === true ? 'total' : undefined
    const valueLabel = item.showValue === true
      ? { show: true, position: 'top', color: theme.muted, fontSize: 10 }
      : { show: false }
    const lineBase = {
      ...base,
      data,
      stack,
      itemStyle: { color },
      label: valueLabel,
    }
    if (item.type === 'bar') {
      return { ...lineBase, type: 'bar', barMaxWidth: 28, itemStyle: { ...lineBase.itemStyle, borderRadius: [2, 2, 0, 0] } }
    }
    if (item.type === 'pictorialBar') {
      return {
        ...lineBase,
        type: 'pictorialBar',
        symbol: 'roundRect',
        symbolRepeat: 'fixed',
        symbolMargin: 2,
        symbolClip: true,
        symbolSize: [14, 6],
        symbolBoundingData: maxValue,
        itemStyle: { color },
      }
    }
    if (item.type === 'area') {
      return {
        ...lineBase,
        type: 'line',
        smooth: item.smooth === true,
        step: item.step === true ? 'middle' : false,
        symbol: 'circle',
        symbolSize: 5,
        lineStyle: { width: 2 },
        areaStyle: { opacity: 0.12 },
        emphasis: { disabled: true },
      }
    }
    return {
      ...lineBase,
      type: 'line',
      smooth: item.smooth === true,
      step: item.step === true ? 'middle' : false,
      symbol: 'circle',
      symbolSize: 5,
      lineStyle: { width: 2 },
      emphasis: { disabled: true },
    }
  })

  return {
    ...common,
    xAxis: {
      type: 'category',
      boundaryGap: true,
      data: categories,
      ...axisStyle(theme),
      splitLine: { show: false },
    },
    yAxis: axes.map((axis, index) =>
      yAxisOf(axis, unit, index, barsByAxis[index] === true, theme)),
    series,
  }
}

/** 饼图内部标签在深色扇区上要用纸色。 */
function surfaceText(theme: Theme): string {
  return theme.paper
}

/**
 * 抹掉 ECharts 的全局自增类名，保证输出可复现。
 * @param svg - 原始 SVG。
 * @returns 类名稳定后的 SVG。
 */
function normalizeClasses(svg: string): string {
  const order = new Map<string, number>()
  for (const token of svg.match(/zr-cls-\d+/gu) ?? []) {
    if (!order.has(token)) order.set(token, order.size)
  }
  return svg.replaceAll(/zr-cls-(\d+)/gu, (whole) => `zr-cls-${String(order.get(whole) ?? 0)}`)
}

/**
 * 把 SSR 产出的 `<svg>` 改成随容器缩放的版本。
 */
function makeResponsive(svg: string, width: number, height: number, label: string): string {
  const stable = normalizeClasses(svg.replaceAll(/zr\d+-/gu, 'zr-'))
  const withViewBox = /viewBox="[^"]*"/u.test(stable)
    ? stable
    : stable.replace('<svg', `<svg viewBox="0 0 ${String(width)} ${String(height)}"`)
  const opening = withViewBox.slice(0, withViewBox.indexOf('>') + 1)
  const cleaned = opening
    .replace(/\swidth="[^"]*"/u, '')
    .replace(/\sheight="[^"]*"/u, '')
    .replace(/\sstyle="[^"]*"/u, '')
    .replace(/\srole="[^"]*"/u, '')
    .replace(/\saria-label="[^"]*"/u, '')
  const attrs = ` width="100%" height="auto" role="img" aria-label="${label.replaceAll('"', '&quot;')}" style="display:block;width:100%;height:auto;max-width:100%"`
  const patched = cleaned.replace(/<svg/u, `<svg${attrs}`)
  return withViewBox.replace(opening, patched)
}

/** 判断普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 取 option 里的系列数组。 */
function seriesOf(option: Record<string, unknown>): Record<string, unknown>[] {
  const series = option['series']
  if (!Array.isArray(series)) return []
  return series.filter(isRecord)
}

/** 递归把 `fontSize` 乘以缩放。 */
function scaleFonts(node: unknown, scale: number): void {
  if (Array.isArray(node)) {
    for (const item of node) scaleFonts(item, scale)
    return
  }
  if (!isRecord(node)) return
  for (const [key, value] of Object.entries(node)) {
    if (key === 'fontSize' && typeof value === 'number') {
      node[key] = Math.round(value * scale * 10) / 10
    } else {
      scaleFonts(value, scale)
    }
  }
}

/** 给一根或多根坐标轴设置标签与轴名字号。 */
function setAxisFontSize(value: unknown, size: number): void {
  for (const axis of Array.isArray(value) ? value : [value]) {
    if (!isRecord(axis)) continue
    if (isRecord(axis['axisLabel'])) axis['axisLabel']['fontSize'] = size
    if (isRecord(axis['nameTextStyle'])) axis['nameTextStyle']['fontSize'] = size
  }
}

/** 给系列的数据标签设置字号。 */
function setLabelFontSize(series: Record<string, unknown>[], size: number): void {
  for (const item of series) {
    if (isRecord(item['label'])) item['label']['fontSize'] = size
  }
}

/**
 * 把展示覆盖里的图表外观应用到 ECharts option。
 *
 * 只处理显式给出的键：只改高度时，字号、图例、线宽全部保持原样。最后统一乘
 * `fontScale`，所以「分组字号」与「整体缩放」可以叠加。
 * @param option - 已构建的 option（原地修改）。
 * @param style - 图表外观。
 */
function applyChartStyle(option: Record<string, unknown>, style: ChartStyle | undefined): void {
  if (style === undefined) return
  const series = seriesOf(option)

  if (style.axisFontSize !== undefined) {
    setAxisFontSize(option['xAxis'], style.axisFontSize)
    setAxisFontSize(option['yAxis'], style.axisFontSize)
    setAxisFontSize(option['parallelAxis'], style.axisFontSize)
    for (const item of series) {
      if (isRecord(item['axisLabel'])) item['axisLabel']['fontSize'] = style.axisFontSize
    }
  }
  if (style.labelFontSize !== undefined) setLabelFontSize(series, style.labelFontSize)
  if (style.legendFontSize !== undefined && isRecord(option['legend'])) {
    const textStyle = option['legend']['textStyle']
    if (isRecord(textStyle)) textStyle['fontSize'] = style.legendFontSize
  }
  if (style.valueFontSize !== undefined) {
    for (const item of series) {
      if (item['type'] !== 'gauge') continue
      if (isRecord(item['detail'])) item['detail']['fontSize'] = style.valueFontSize
    }
  }
  if (style.legend !== undefined && isRecord(option['legend'])) {
    option['legend']['show'] = style.legend
  }
  if (style.barMaxWidth !== undefined) {
    for (const item of series) {
      if (item['type'] === 'bar' || item['type'] === 'pictorialBar') item['barMaxWidth'] = style.barMaxWidth
    }
  }
  if (style.lineWidth !== undefined) {
    for (const item of series) {
      if (item['type'] !== 'line') continue
      const lineStyle = isRecord(item['lineStyle']) ? item['lineStyle'] : {}
      lineStyle['width'] = style.lineWidth
      item['lineStyle'] = lineStyle
    }
  }
  if (style.pointSize !== undefined) {
    const min = style.pointSize.min ?? 2
    const max = style.pointSize.max ?? 24
    for (const item of series) {
      const type = item['type']
      if (type !== 'scatter' && type !== 'effectScatter') continue
      // 地图的点径在构建时已按权重写好函数，这里不覆盖。
      if (item['coordinateSystem'] === 'geo') continue
      item['symbolSize'] = max >= min ? max : min
    }
  }
  if (style.fontScale !== undefined && style.fontScale !== 1) scaleFonts(option, style.fontScale)
}

/** 各类型的默认高度。 */
function defaultHeight(type: SeriesType | undefined, declared: number | undefined): number {
  if (type === 'sparkline') return 64
  if (type === 'gauge') return 260
  if (type === 'heatmap' || type === 'radar' || type === 'treemap' || type === 'sunburst'
    || type === 'themeRiver' || type === 'parallel' || type === 'sankey' || type === 'chord'
    || type === 'graph' || type === 'tree') return 320
  return declared ?? 280
}

/**
 * 渲染一张图。
 * @param input - 图表声明、列与行。
 * @param options - 主题、基准宽高。
 * @returns 内联 SVG；没有任何可用数值时返回 undefined。
 */
export function renderChartSvg(input: ChartInput, options: ChartOptions): string | undefined {
  const { spec, columns, rows } = input
  const style = options.style
  if (spec.custom !== undefined) {
    return renderCustomSvg(spec.custom.script, {
      rows: spec.custom.rows,
      columns: spec.custom.columns.map(column => ({ key: column.key, label: column.label, unit: column.unit })),
      theme: options.theme,
      width: options.width ?? style?.width ?? 720,
      height: options.height ?? style?.height ?? spec.height ?? 320,
    })
  }
  const first = spec.series[0]
  const keys = spec.series.flatMap(series => seriesKeys(series))
  // 关系图 / 树形图 / 地图的数据不在列里，不走「列里有数值」的判空。
  if (spec.map !== undefined) {
    if ((spec.mapPoints ?? []).length === 0) return undefined
  } else if (spec.graph !== undefined) {
    if (spec.graph.nodes.length === 0) return undefined
  } else if (spec.tree !== undefined) {
    if (spec.tree.length === 0) return undefined
  } else {
    const indexes = keys.map(key => indexOf(columns, key)).filter(index => index >= 0)
    if (indexes.length === 0) return undefined
    const hasValue = rows.some(row => indexes.some(index => typeof rawOf(row[index]) === 'number'))
    if (!hasValue) return undefined
  }

  const width = options.width ?? style?.width ?? 720
  const height = spec.map === undefined
    ? defaultHeight(first?.type, options.height ?? style?.height ?? spec.height)
    : options.height ?? style?.height ?? spec.height ?? 420
  const theme = options.theme
  const option = buildOption(input, theme, style)
  if (Object.keys(option).length === 0) return undefined
  applyChartStyle(option, style)

  const chart = init(null, null, { renderer: 'svg', ssr: true, width, height })
  try {
    chart.setOption(option)
    const svg = chart.renderToSVGString()
    const label = spec.title
      ?? (first?.type === 'graph' ? '关系图' : columns.find(column => column.key === keys[0])?.label)
      ?? '图表'
    return makeResponsive(svg, width, height, label)
  } finally {
    chart.dispose()
  }
}
