/**
 * 报告主题：一套完整的设计令牌。
 *
 * 主题只给「值」，不给结构。HTML 渲染器把所有尺寸与颜色写成 `var(--…)`，
 * 换主题 = 换一份令牌，不需要动渲染代码，也不允许任何块自带样式。
 *
 * 令牌分六组：颜色、字体、字号阶、行高、间距阶、圆角与版心。字号阶与间距阶
 * 都按固定比例取值（约 1.15–1.25），这样版式节奏才稳定，而不是每个组件各写
 * 一个像素值。
 */

/** 一套报告主题。 */
export interface Theme {
  /** 页面底色。 */
  paper: string
  /** 卡片与表格底色。 */
  surface: string
  /** 次级表面：表头、代码块。 */
  surfaceAlt: string
  /** 标题与主文字。 */
  ink: string
  /** 正文文字。 */
  body: string
  /** 次要文字：脚注、来源、日期、坐标轴。 */
  muted: string
  /** 分隔线与边框。 */
  border: string
  /** 强调色：结论、编号、链接。 */
  accent: string
  /** 强调色的低透明度底：编号徽标、折叠条。 */
  accentSoft: string
  /** 结构色：章节标题。 */
  trust: string
  /** 正向提示。 */
  success: string
  /** 风险提示。 */
  warning: string
  /** 错误提示。 */
  danger: string
  /** 风险提示的底色。 */
  warnSoft: string
  /** 行内代码底色。 */
  codeBg: string
  /** 表头底色。 */
  tableHeadBg: string

  /** 标题字体栈。 */
  fontSerif: string
  /** 正文字体栈。 */
  fontSans: string
  /** 等宽字体栈。 */
  fontMono: string

  /**
   * 字号阶，单位 px，依次为
   * `2xs`(脚注) / `xs`(说明) / `sm`(表格) / `base`(正文) / `lg`(副标题) / `xl`(h2) / `2xl`(h1)。
   */
  fontSize: readonly [number, number, number, number, number, number, number]
  /** 行高：标题用 `tight`，正文用 `normal`。 */
  leading: { tight: number, normal: number }

  /** 间距阶，单位 px，依次为 `space-1` … `space-8`。 */
  space: readonly [number, number, number, number, number, number, number, number]
  /** 圆角：`sm` 用于徽标与代码，`md` 用于卡片与表格。 */
  radius: { sm: number, md: number }

  /** 版心宽度：A4 宽度（210mm）在 96dpi 下约 794px。 */
  contentWidth: string
  /** 段落最大行长（`em`，随字号缩放）。 */
  measure: string

  /** 图表色板：多序列按顺序取色，不随机。 */
  chart: readonly string[]
}

/** 间距与字号的令牌名，供 `themeCss` 生成变量。 */
const TEXT_NAMES = ['2xs', 'xs', 'sm', 'base', 'lg', 'xl', '2xl'] as const

/**
 * 把主题渲染成 CSS 变量。
 * @param theme - 主题令牌。
 * @returns `:root { … }` 形式的 CSS 片段。
 */
export function themeCss(theme: Theme): string {
  const lines: string[] = [':root {']
  const push = (name: string, value: string | number): void => {
    lines.push(`  --${name}: ${String(value)};`)
  }

  push('paper', theme.paper)
  push('surface', theme.surface)
  push('surface-2', theme.surfaceAlt)
  push('ink', theme.ink)
  push('body-text', theme.body)
  push('muted', theme.muted)
  push('border', theme.border)
  push('accent', theme.accent)
  push('accent-soft', theme.accentSoft)
  push('trust', theme.trust)
  push('success', theme.success)
  push('warning', theme.warning)
  push('danger', theme.danger)
  push('warn-soft', theme.warnSoft)
  push('code-bg', theme.codeBg)
  push('table-head-bg', theme.tableHeadBg)

  push('font-serif', theme.fontSerif)
  push('font-sans', theme.fontSans)
  push('font-mono', theme.fontMono)

  TEXT_NAMES.forEach((name, index) => {
    const size = theme.fontSize[index]
    if (size !== undefined) push(`text-${name}`, `${String(size)}px`)
  })
  push('leading-tight', theme.leading.tight)
  push('leading-normal', theme.leading.normal)

  theme.space.forEach((value, index) => {
    push(`space-${String(index + 1)}`, `${String(value)}px`)
  })
  push('radius-sm', `${String(theme.radius.sm)}px`)
  push('radius-md', `${String(theme.radius.md)}px`)
  push('width', theme.contentWidth)
  push('measure', theme.measure)

  theme.chart.forEach((color, index) => {
    push(`chart-${String(index + 1)}`, color)
  })

  lines.push('}')
  return lines.join('\n')
}

export { defaultTheme } from './themes/default.js'
export { THEMES, resolveTheme } from './themes/index.js'
