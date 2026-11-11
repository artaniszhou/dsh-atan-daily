/**
 * HTML 渲染器：块树 → 单个自包含 HTML 文件。
 *
 * 三条硬约束，全部由这里的实现保证，不依赖模型自觉：
 * 1. **零外部依赖**：不引用任何 http(s) 资源、不嵌字体文件、不写 `<script>`。
 *    报告在任何浏览器里双击即开，离线、可打印。
 * 2. **一切文本转义**：数据、标题、来源都走 `escapeHtml`，模板不拼接未转义内容。
 * 3. **缺失可见**：缺失单元格带 `.miss` 样式，不会被当成 0 或空白。
 *
 * 样式全部走主题令牌（`var(--…)`）：这里只描述「结构」，不写死字号、间距与颜色。
 */

import { renderChartSvg } from '../chart.js'
import { defaultTheme, themeCss } from '../theme.js'
import type { Theme } from '../theme.js'
import { blockSpec, chartStyleOf, resolveColorName, TEXT_NAMES } from '../display/spec.js'
import type { DisplayBlock, DisplaySpec } from '../display/spec.js'

/** 渲染选项。 */
export interface RenderOptions {
  /**
   * 展开所有折叠块。
   *
   * HTML 需要折叠（长表不占首屏）；PDF 是归档件，折叠会把内容整段丢掉，
   * 所以打印时用展开态另出一份，不改变落盘的 HTML。
   */
  expandDetails?: boolean
  /** 展示覆盖；不传时输出与改造前完全一致。 */
  display?: DisplaySpec
  /** 预览模式：给每个块加 `data-block` 锚点，便于面板定位（最终件不加）。 */
  preview?: boolean
}
import type {
  Block,
  Cell,
  ChartBlock,
  Column,
  KvRow,
  MetricCard,
  PlanSection,
  RenderPlan,
  TableBlock,
  TimelineItem,
} from '../present.js'

/** HTML 转义，覆盖文本与属性两种上下文。 */
function esc(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** 块的标题：用于 `selectors` 的 `title=` 匹配。 */
function titleOfBlock(block: Block): string | undefined {
  switch (block.kind) {
    case 'heading': return block.text
    case 'table': return block.title
    case 'chart': return block.title
    case 'card': return block.title
    default: return undefined
  }
}

/** 提示块的语气：用于 `selectors` 的 `tone=` 匹配。 */
function toneOfBlock(block: Block): string | undefined {
  return block.kind === 'note' ? block.tone : undefined
}

/** 块 key。 */
function keyOfBlock(block: Block): string {
  return block.key ?? block.id
}

/** 解析某个块最终生效的外观补丁。 */
function specOfBlock(block: Block, options: RenderOptions): DisplayBlock | undefined {
  if (options.display === undefined) return undefined
  return blockSpec(options.display, block.key, block.kind, titleOfBlock(block), toneOfBlock(block))
}

/** CSS 属性选择器里的值转义。 */
function cssValue(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

/** 是否需要给块加锚点：预览要，块级覆盖也要；只有全局令牌时不需要。 */
function needsAnchor(options: RenderOptions): boolean {
  if (options.preview === true) return true
  const display = options.display
  if (display === undefined) return false
  if (display.blocks !== undefined && Object.keys(display.blocks).length > 0) return true
  return display.selectors !== undefined && Object.keys(display.selectors).length > 0
}

/** 给块包一层锚点；只在有块级覆盖或预览时加，保证默认输出不变。 */
function anchor(html: string, block: Block, options: RenderOptions): string {
  if (!needsAnchor(options)) return html
  return `<div class="blk" data-block="${esc(keyOfBlock(block))}">${html}</div>`
}

/** 收集计划里的全部块（含 columns / card 的子块）。 */
function collectBlocks(plan: RenderPlan): Block[] {
  const result: Block[] = []
  const walk = (block: Block): void => {
    result.push(block)
    if (block.kind === 'columns') {
      for (const column of block.children) for (const child of column) walk(child)
    } else if (block.kind === 'card') {
      for (const child of block.children) walk(child)
    }
  }
  for (const section of plan.sections) for (const block of section.blocks) walk(block)
  return result
}

/**
 * 生成块级覆盖 CSS。
 *
 * 字号不是直接写 `font-size`，而是按比例缩放该块作用域内的 `--text-*`：
 * 这样标题、表格、指标卡会一起协调地变化，而不是只有正文变。
 * @param plan - 渲染计划。
 * @param theme - 已应用全局令牌的主题。
 * @param display - 展示覆盖。
 * @returns CSS 文本；没有覆盖时为空串。
 */
function displayCss(plan: RenderPlan, theme: Theme, display: DisplaySpec | undefined): string {
  if (display === undefined) return ''
  const rules: string[] = []
  for (const block of collectBlocks(plan)) {
    const spec = specOfBlock(block, { display })
    if (spec === undefined) continue
    const key = keyOfBlock(block)
    const selector = `[data-block="${cssValue(key)}"]`
    const decl: string[] = []

    if (spec.fontSize !== undefined) {
      const base = theme.fontSize[3] ?? 15
      const ratio = spec.fontSize / (base === 0 ? 15 : base)
      TEXT_NAMES.forEach((name, index) => {
        const size = theme.fontSize[index]
        if (size === undefined) return
        decl.push(`--text-${name}: ${String(Math.round(size * ratio * 10) / 10)}px;`)
      })
      decl.push('font-size: var(--text-base);')
    }
    if (spec.lineHeight !== undefined) {
      decl.push(`--leading-normal: ${String(spec.lineHeight)};`, `line-height: ${String(spec.lineHeight)};`)
    }
    if (spec.color !== undefined) {
      const color = resolveColorName(spec.color, theme)
      decl.push(`color: ${color};`, `--body-text: ${color};`)
    }
    if (spec.align !== undefined) decl.push(`text-align: ${spec.align};`)
    if (spec.maxWidth !== undefined) decl.push(`--measure: ${spec.maxWidth};`)
    if (spec.marginTop !== undefined) decl.push(`margin-top: ${String(spec.marginTop)}px;`)
    if (spec.marginBottom !== undefined) decl.push(`margin-bottom: ${String(spec.marginBottom)}px;`)
    if (spec.padding !== undefined) decl.push(`padding: ${String(spec.padding)}px;`)
    if (spec.background !== undefined) {
      decl.push(`background: ${resolveColorName(spec.background, theme)};`, 'border-radius: var(--radius-md);')
    }
    if (spec.border === true) decl.push('border: 1px solid var(--border); border-radius: var(--radius-md);')
    if (decl.length > 0) rules.push(`${selector} { ${decl.join(' ')} }`)

    if (spec.density === 'compact') {
      rules.push(`${selector} td, ${selector} th { padding: var(--space-1) var(--space-2); }`)
    }
    if (spec.headBackground !== undefined) {
      rules.push(`${selector} th { background: ${resolveColorName(spec.headBackground, theme)}; }`)
    }
    if (spec.columns !== undefined) {
      rules.push(`${selector} .metrics { grid-template-columns: repeat(${String(spec.columns)}, minmax(0, 1fr)); }`)
    }
  }
  if (rules.length === 0) return ''
  return `\n/* display overrides */\n${rules.join('\n')}`
}


/** 渲染键值块。 */
function renderKv(rows: KvRow[]): string {
  const items = rows
    .map(row => `<div class="kv-row"><dt>${esc(row.label)}</dt><dd${row.missing ? ' class="miss"' : ''}>${esc(row.value)}</dd></div>`)
    .join('')
  return `<dl class="kv">${items}</dl>`
}

/** 渲染指标卡。 */
function renderMetrics(items: MetricCard[]): string {
  const cards = items
    .map((item) => {
      const tone = item.tone === undefined ? '' : ` metric--${item.tone}`
      const delta = item.delta === undefined ? '' : `<p class="metric-delta">${esc(item.delta)}</p>`
      const note = item.note === undefined ? '' : `<p class="metric-note">${esc(item.note)}</p>`
      return `<div class="metric${tone}"><p class="metric-label">${esc(item.label)}</p>`
        + `<p class="metric-value">${esc(item.value)}</p>${delta}${note}</div>`
    })
    .join('')
  return `<div class="metrics">${cards}</div>`
}

/** 渲染表头。 */
function renderHead(columns: Column[]): string {
  const cells = columns
    .map(column => `<th${column.align === 'right' ? ' class="num"' : ''}>${esc(column.label)}</th>`)
    .join('')
  return `<thead><tr>${cells}</tr></thead>`
}

/** 渲染一行。 */
function renderRow(row: Cell[]): string {
  const cells = row
    .map((cell) => {
      const classes = [cell.numeric ? 'num' : '', cell.missing ? 'miss' : ''].filter(part => part !== '').join(' ')
      return `<td${classes === '' ? '' : ` class="${classes}"`}>${esc(cell.text)}</td>`
    })
    .join('')
  return `<tr>${cells}</tr>`
}

/** 渲染表格块。 */
function renderTable(block: TableBlock, options: RenderOptions, parentTitle?: string, spec?: DisplayBlock): string {
  const widths = spec?.columnWidths
  const colgroup = widths === undefined
    ? ''
    : `<colgroup>${block.columns
      .map(column => (widths[column.key] === undefined ? '<col>' : `<col style="width:${widths[column.key] ?? ''}">`))
      .join('')}</colgroup>`
  const table = `<div class="tbl"><table>${colgroup}${renderHead(block.columns)}<tbody>${block.rows.map(renderRow).join('')}</tbody></table></div>`
  const note = block.note === undefined ? '' : `<p class="tbl-note">${esc(block.note)}</p>`
  const title = block.title ?? block.id
  if (!block.folded) {
    // 不折叠时标题也要露出来：两张表头相同的明细表，没有标题就分不清。
    // 但标题与所在分区同名时不再重复一次。
    const heading = block.title === undefined || block.title === parentTitle
      ? ''
      : `<p class="tbl-title">${esc(block.title)}</p>`
    return heading + table + note
  }
  const open = options.expandDetails === true ? ' open' : ''
  return `<details class="fold"${open}><summary>${esc(title)} · ${String(block.rows.length)} 行</summary>${table}</details>${note}`
}

/**
 * 按覆盖裁剪图表下方的数据表。
 * @param table - 原始数据表。
 * @param columns - 要保留的列；不传时原样返回。
 * @returns 裁剪后的数据表。
 */
function sliceTable(table: TableBlock, columns: string[] | undefined): TableBlock {
  if (columns === undefined) return table
  const indexes = columns
    .map(key => table.columns.findIndex(column => column.key === key))
    .filter(index => index >= 0)
  if (indexes.length === 0) return table
  return {
    ...table,
    columns: indexes.map(index => table.columns[index]!),
    rows: table.rows.map(row => indexes.map(index => row[index]!)),
  }
}

/**
 * 渲染图表块：SVG 现画、数据表折叠兜底。
 *
 * 图表随容器缩放（`viewBox` + `width:100%`），手机上文字会等比缩小，
 * 所以精确数值永远留一份可展开的数据表，不让读数依赖缩放。
 * 展示覆盖可以关掉这张表，此时图注里的「见下表」也要一起省掉。
 * @param block - 图表块。
 * @param theme - 主题令牌。
 * @returns HTML 片段。
 */
function renderChartBlock(block: ChartBlock, theme: Theme, options: RenderOptions, spec?: DisplayBlock): string {
  const caption = block.title === undefined ? '' : `<figcaption>${esc(block.title)}</figcaption>`
  const open = options.expandDetails === true ? ' open' : ''
  const chartStyle = chartStyleOf(options.display, spec)
  const tableStyle = chartStyle?.table
  const showTable = tableStyle?.show !== false
  const tableBlock = sliceTable(block.table, tableStyle?.columns)
  const table = showTable
    ? `<details class="fold"${open}><summary>数据表 · ${String(tableBlock.rows.length)} 行</summary>${renderTable({ ...tableBlock, folded: false }, options)}</details>`
    : ''
  const svg = renderChartSvg(
    { spec: block.spec, columns: block.table.columns, rows: block.table.rows },
    { theme, style: chartStyle },
  )
  if (svg === undefined) {
    return `<div class="chart chart--empty">${caption}<p class="hint">本期没有可用于绘图的数据，未渲染图表。</p></div>${table}`
  }
  const hasMissing = block.table.rows.some(row => row.some(cell => cell.missing))
  const note = showTable
    ? hasMissing
      ? '<p class="chart-note">图中断点表示该期缺失，精确数值见下表。</p>'
      : '<p class="chart-note">精确数值见下表。</p>'
    : ''
  return `<figure class="chart">${svg}${caption}</figure>` + note + table
}

/** 渲染时间线。 */
function renderTimeline(items: TimelineItem[]): string {
  const rows = items
    .map(item => '<li>'
      + `<p class="tl-at">${esc(item.at)}</p>`
      + `<p class="tl-title">${esc(item.title)}</p>`
      + (item.detail === undefined ? '' : `<p class="tl-detail">${esc(item.detail)}</p>`)
      + '</li>')
    .join('')
  return `<ol class="timeline">${rows}</ol>`
}

/** 渲染单个块。 */
function renderBlock(block: Block, theme: Theme, options: RenderOptions, parentTitle?: string): string {
  const spec = specOfBlock(block, options)
  const inner = renderBlockBody(block, theme, options, spec, parentTitle)
  return anchor(inner, block, options)
}

/** 渲染块的内部结构（不含锚点包装）。 */
function renderBlockBody(
  block: Block,
  theme: Theme,
  options: RenderOptions,
  spec: DisplayBlock | undefined,
  parentTitle?: string,
): string {
  switch (block.kind) {
    case 'heading':
      return `<h3 class="sub">${esc(block.text)}</h3>`
    case 'kv':
      return renderKv(block.rows)
    case 'metrics':
      return renderMetrics(block.items)
    case 'table':
      return renderTable(block, options, parentTitle, spec)
    case 'chart':
      return renderChartBlock(block, theme, options, spec)
    case 'list': {
      const tag = block.ordered ? 'ol' : 'ul'
      return `<${tag} class="list">${block.items.map(item => `<li>${esc(item)}</li>`).join('')}</${tag}>`
    }
    case 'timeline':
      return renderTimeline(block.items)
    case 'note':
      return `<div class="note note--${block.tone}">${esc(block.text)}</div>`
    case 'paragraph':
      return `<p>${esc(block.text)}</p>`
    case 'quote': {
      const cite = block.cite === undefined ? '' : `<cite>${esc(block.cite)}</cite>`
      return `<blockquote class="quote"><p>${esc(block.text)}</p>${cite}</blockquote>`
    }
    case 'divider':
      return '<hr class="rule">'
    case 'columns':
      return `<div class="cols">${block.children
        .map((column, index) => `<div class="col" style="flex-grow:${String(block.ratio[index] ?? 1)}">${column
          .map(child => renderBlock(child, theme, options, parentTitle))
          .join('\n')}</div>`)
        .join('')}</div>`
    case 'card': {
      const title = block.title === undefined ? '' : `<h3>${esc(block.title)}</h3>`
      const body = block.children.map(child => renderBlock(child, theme, options, block.title)).join('\n')
      return `<section class="card">${title}${body}</section>`
    }
    case 'raw': {
      const open = options.expandDetails === true ? ' open' : ''
      return `<details class="fold"${open}><summary>${esc(block.label)}</summary><pre class="raw">${esc(block.json)}</pre></details>`
    }
  }
}

/** 渲染一个分区；只有带标题的分区才吃编号。 */
function renderSection(section: PlanSection, number: number | undefined, theme: Theme, options: RenderOptions): string {
  const heading = section.title === undefined || number === undefined
    ? ''
    : `<h2><span class="sec-num">${String(number).padStart(2, '0')}</span>${esc(section.title)}</h2>`
  const body = section.blocks.map(block => renderBlock(block, theme, options, section.title)).join('\n')
  return `<section class="sec">${heading}\n${body}</section>`
}

/** 渲染来源列表；只有 http(s) 才做成链接，其余一律纯文本。 */
function renderSources(plan: RenderPlan): string {
  if (plan.sources.length === 0) return ''
  const rows = plan.sources
    .map((source) => {
      const asOf = source.asOf === undefined ? '' : ` <span class="src-at">${esc(source.asOf)}</span>`
      const linked = /^https?:\/\/[^\s]+$/u.test(source.value)
        ? `<a href="${esc(source.value)}" rel="noopener noreferrer">${esc(source.value)}</a>`
        : esc(source.value)
      return `<li><span class="src-label">${esc(source.label)}</span> <span class="src-value">${linked}</span>${asOf}</li>`
    })
    .join('')
  return `<section class="sec"><h2><span class="sec-num">来源</span>数据来源</h2><ul class="src">${rows}</ul></section>`
}

/** 渲染缺失清单。 */
function renderMissing(plan: RenderPlan): string {
  if (plan.missing.length === 0) return ''
  const rows = plan.missing
    .map(item => `<li><code>${esc(item.path)}</code><span>${esc(item.reason)}</span></li>`)
    .join('')
  return `<section class="sec"><h2><span class="sec-num">缺失</span>缺失数据</h2>`
    + `<ul class="miss-list">${rows}</ul>`
    + '<p class="hint">以上数据本轮没有取到，未用 0 或估算值代替。</p></section>'
}

/** 渲染建议动作。 */
function renderActions(plan: RenderPlan): string {
  if (plan.actions.length === 0) return ''
  const rows = plan.actions.map(action => `<li>${esc(action)}</li>`).join('')
  return `<section class="sec"><h2><span class="sec-num">行动</span>建议动作</h2><ol class="list">${rows}</ol></section>`
}

/** 渲染页脚。 */
function renderFooter(plan: RenderPlan): string {
  if (plan.footer.length === 0) return ''
  return `<footer class="foot"><p>${plan.footer.map(esc).join(' · ')}</p></footer>`
}

/**
 * 组件样式。
 *
 * 只写结构与节奏，所有字号、间距、颜色都引用主题变量：换主题不需要改这里。
 * 排版规则：标题用衬线、正文用无衬线、数字一律等宽；段落有行长上限（`--measure`），
 * 表格与卡片不设上限，避免长表被压窄。
 * @returns CSS 文本。
 */
function componentCss(): string {
  return `
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--paper);
  color: var(--body-text);
  font-family: var(--font-sans);
  font-size: var(--text-base);
  line-height: var(--leading-normal);
  letter-spacing: 0.008em;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
.page { max-width: var(--width); margin: 0 auto; padding: var(--space-8) var(--space-5) calc(var(--space-8) * 2); }
h1, h2, h3 { font-family: var(--font-serif); font-weight: 600; color: var(--ink); line-height: var(--leading-tight); margin: 0; letter-spacing: -0.01em; }
h1 { font-size: var(--text-2xl); }
h2 { font-size: var(--text-xl); display: flex; align-items: baseline; gap: var(--space-2); margin-bottom: var(--space-4); }
h3 { font-size: var(--text-lg); }
p { margin: 0 0 var(--space-3); }
p, li { max-width: var(--measure); }
a { color: var(--accent); text-decoration: none; border-bottom: 1px solid var(--accent-soft); }
a:hover { border-bottom-color: var(--accent); }
code { font-family: var(--font-mono); font-size: 0.88em; background: var(--code-bg); border-radius: var(--radius-sm); padding: 1px 5px; }

.head { border-bottom: 1px solid var(--border); padding-bottom: var(--space-5); margin-bottom: var(--space-6); }
.eyebrow { font-size: var(--text-xs); letter-spacing: 0.08em; color: var(--accent); text-transform: uppercase; margin-bottom: var(--space-2); }
.sub { color: var(--muted); font-size: var(--text-lg); margin-top: var(--space-2); }
.meta { color: var(--muted); font-size: var(--text-sm); margin-top: var(--space-3); font-variant-numeric: tabular-nums; }
.lead {
  margin-top: var(--space-4);
  padding: var(--space-4) var(--space-5);
  background: var(--surface);
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  border-radius: var(--radius-md);
  font-size: var(--text-lg);
  line-height: 1.55;
  color: var(--ink);
  max-width: none;
}

.sec { margin-bottom: var(--space-7); }
.sec-num {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  font-weight: 500;
  letter-spacing: 0.04em;
  color: var(--accent);
  background: var(--accent-soft);
  border-radius: var(--radius-sm);
  padding: 2px 7px;
  flex: none;
}

.kv { margin: 0 0 var(--space-5); display: grid; gap: 2px; }
.kv-row { display: flex; gap: var(--space-4); padding: var(--space-2) 0; border-bottom: 1px dotted var(--border); }
.kv dt { flex: none; width: 132px; color: var(--muted); font-size: var(--text-sm); }
.kv dd { margin: 0; color: var(--ink); font-variant-numeric: tabular-nums; }

.metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: var(--space-3); margin-bottom: var(--space-5); }
.metric { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-md); padding: var(--space-4); }
.metric--ok { border-left: 3px solid var(--success); }
.metric--warn { border-left: 3px solid var(--warning); }
.metric--err { border-left: 3px solid var(--danger); }
.metric--info { border-left: 3px solid var(--trust); }
.metric-label { font-size: var(--text-xs); color: var(--muted); margin: 0 0 var(--space-1); max-width: none; }
.metric-value { font-family: var(--font-serif); font-size: var(--text-2xl); line-height: 1.1; color: var(--ink); margin: 0; font-variant-numeric: tabular-nums; max-width: none; }
.metric-delta { font-size: var(--text-xs); color: var(--accent); margin: var(--space-1) 0 0; max-width: none; }
.metric-note { font-size: var(--text-xs); color: var(--muted); margin: var(--space-1) 0 0; max-width: none; }

.tbl { overflow-x: auto; margin-bottom: var(--space-5); border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface); }
table { width: 100%; border-collapse: collapse; font-size: var(--text-sm); }
th, td { padding: var(--space-2) var(--space-3); text-align: left; vertical-align: top; border-bottom: 1px solid var(--border); }
th { background: var(--table-head-bg); font-weight: 600; color: var(--muted); font-size: var(--text-xs); white-space: nowrap; }
tbody tr:last-child td { border-bottom: none; }
th.num, td.num { text-align: right; font-variant-numeric: tabular-nums; }
td.miss, dd.miss { color: var(--warning); font-style: italic; }
td.miss { background: var(--warn-soft); }
.tbl-note { font-size: var(--text-xs); color: var(--muted); margin: calc(var(--space-3) * -1) 0 var(--space-5); }
.tbl-title { font-size: var(--text-sm); font-weight: 600; color: var(--ink); margin: 0 0 var(--space-2); }

.chart { margin: 0 0 var(--space-5); }
.chart svg { display: block; width: 100%; height: auto; }
.chart figcaption { margin: var(--space-2) 0 0; font-size: var(--text-xs); color: var(--muted); }
.chart--empty { padding: var(--space-4); border: 1px dashed var(--border); border-radius: var(--radius-md); }
.chart-note { font-size: var(--text-xs); color: var(--muted); margin: calc(var(--space-2) * -1) 0 var(--space-5); }

.fold { margin-bottom: var(--space-5); border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface); padding: var(--space-2) var(--space-3); }
.fold > summary { cursor: pointer; color: var(--accent); font-size: var(--text-sm); font-weight: 600; }
.fold .tbl { margin: var(--space-2) 0 var(--space-1); border: none; }
.raw { font-family: var(--font-mono); font-size: var(--text-xs); line-height: 1.5; overflow-x: auto; margin: var(--space-2) 0 var(--space-1); color: var(--body-text); }

.list { margin: 0 0 var(--space-5); padding-left: var(--space-5); }
.list li { margin-bottom: var(--space-1); }

.timeline { list-style: none; margin: 0 0 var(--space-5); padding: 0 0 0 var(--space-4); border-left: 2px solid var(--border); }
.timeline li { position: relative; padding: 0 0 var(--space-4) var(--space-4); max-width: none; }
.timeline li::before {
  content: ""; position: absolute; left: -22px; top: 6px;
  width: 8px; height: 8px; border-radius: 50%; background: var(--accent); border: 2px solid var(--paper);
}
.tl-at { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--muted); margin: 0 0 2px; }
.tl-title { font-weight: 600; color: var(--ink); margin: 0 0 2px; }
.tl-detail { color: var(--body-text); font-size: var(--text-sm); margin: 0; }

.note { padding: var(--space-3) var(--space-4); border-radius: var(--radius-md); margin-bottom: var(--space-5); font-size: var(--text-sm); border: 1px solid var(--border); background: var(--surface); }
.note--warn { border-left: 3px solid var(--warning); }
.note--err { border-left: 3px solid var(--danger); }
.note--ok { border-left: 3px solid var(--success); }
.note--info { border-left: 3px solid var(--trust); }

.quote { margin: 0 0 var(--space-5); padding: var(--space-3) var(--space-4); border-left: 3px solid var(--accent); background: var(--surface); border-radius: var(--radius-md); }
.quote p { margin: 0; font-size: var(--text-lg); line-height: 1.55; color: var(--ink); max-width: none; }
.quote cite { display: block; margin-top: var(--space-2); font-style: normal; font-size: var(--text-xs); color: var(--muted); }

.cols { display: flex; gap: var(--space-4); margin-bottom: var(--space-5); align-items: flex-start; }
.col { min-width: 0; flex-basis: 0; }
.col > :last-child { margin-bottom: 0; }

.card { border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface); padding: var(--space-4); margin-bottom: var(--space-5); }
.card > h3 { margin: 0 0 var(--space-2); font-size: var(--text-base); }
.card > :last-child { margin-bottom: 0; }
h3.sub { margin: var(--space-4) 0 var(--space-2); font-size: var(--text-base); }

hr.rule { border: none; border-top: 1px solid var(--border); margin: var(--space-5) 0; }

.src { list-style: none; margin: 0 0 var(--space-5); padding: 0; font-size: var(--text-sm); }
.src li { padding: var(--space-2) 0; border-bottom: 1px dotted var(--border); display: flex; flex-wrap: wrap; gap: 0 var(--space-2); max-width: none; }
.src-label { color: var(--ink); font-weight: 600; }
.src-value { color: var(--muted); word-break: break-all; }
.src-at { color: var(--muted); font-family: var(--font-mono); font-size: var(--text-xs); }

.miss-list { list-style: none; margin: 0 0 var(--space-2); padding: 0; font-size: var(--text-sm); }
.miss-list li { display: flex; gap: var(--space-3); padding: var(--space-2) 0; border-bottom: 1px dotted var(--border); max-width: none; }
.miss-list code { flex: none; color: var(--warning); background: var(--warn-soft); }
.hint { font-size: var(--text-xs); color: var(--muted); }

.foot { margin-top: var(--space-7); padding-top: var(--space-4); border-top: 1px solid var(--border); color: var(--muted); font-size: var(--text-xs); }

@media (max-width: 640px) {
  .page { padding: var(--space-6) var(--space-4) var(--space-8); }
  h1 { font-size: var(--text-xl); }
  h2 { font-size: var(--text-lg); }
  .kv dt { width: 96px; }
  .metrics { grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); }
  .cols { display: block; }
  .col { width: 100%; }
}

@media print {
  /* 页边距与页码由 puppeteer 的打印参数给（见 render/pdf.ts），这里只锁纸张。 */
  @page { size: A4; }
  body { background: #fff; font-size: 10.5pt; line-height: 1.55; }
  .page { max-width: none; padding: 0; }
  .sec, .metrics, .tbl, .note, .chart { break-inside: avoid; }
  thead { display: table-header-group; }
  details { break-inside: avoid; }
  details > summary { list-style: none; }
  .fold[open] > summary { display: none; }
  a { color: var(--ink); border-bottom: none; }
}`
}

/**
 * 把一个渲染计划渲染成完整的 HTML 文档。
 * @param plan - 与格式无关的块树。
 * @param theme - 主题令牌，缺省用默认主题。
 * @param options - 折叠、打印等渲染选项。
 * @returns 自包含的 HTML 文本（无外链、无脚本）。
 */
export function renderHtml(plan: RenderPlan, theme: Theme = defaultTheme, options: RenderOptions = {}): string {
  const head = [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="generator" content="atan-daily">',
    `<title>${esc(plan.title)}</title>`,
    `<style>\n${themeCss(theme)}\n${componentCss()}${displayCss(plan, theme, options.display)}\n</style>`,
    '</head>',
  ].join('\n')

  const header: string[] = ['<header class="head">']
  if (plan.eyebrow !== '') header.push(`<p class="eyebrow">${esc(plan.eyebrow)}</p>`)
  header.push(`<h1>${esc(plan.title)}</h1>`)
  if (plan.subtitle !== undefined) header.push(`<p class="sub">${esc(plan.subtitle)}</p>`)
  if (plan.lead !== undefined) header.push(`<p class="lead">${esc(plan.lead)}</p>`)
  if (plan.meta.length > 0) header.push(`<p class="meta">${plan.meta.map(esc).join(' · ')}</p>`)
  header.push('</header>')

  // 没有标题的主体分区不该占编号：编号只在有标题的分区之间递增。
  let counter = 0
  const sections = plan.sections.map((section) => {
    if (section.title === undefined) return renderSection(section, undefined, theme, options)
    counter += 1
    return renderSection(section, counter, theme, options)
  })

  const body = [
    '<body>',
    '<main class="page">',
    header.join('\n'),
    sections.join('\n'),
    renderMissing(plan),
    renderSources(plan),
    renderActions(plan),
    renderFooter(plan),
    '</main>',
    '</body>',
    '</html>',
  ].join('\n')

  return `${head}\n${body}\n`
}
