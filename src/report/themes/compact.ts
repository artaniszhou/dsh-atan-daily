/**
 * 紧凑主题：冷灰底、蓝色强调，适合长表与信息密度高的日报。
 *
 * 与默认主题的差别只在令牌：版心更宽、字号阶更低、间距更紧、颜色更中性。
 * 用来验证「换主题不改一行渲染代码」。
 */

import type { Theme } from '../theme.js'

/** 紧凑主题。 */
export const compactTheme: Theme = {
  paper: '#FBFBFC',
  surface: '#FFFFFF',
  surfaceAlt: '#F3F4F6',
  ink: '#111827',
  body: '#1F2937',
  muted: '#6B7280',
  border: '#E5E7EB',
  accent: '#1D4ED8',
  accentSoft: 'rgba(29, 78, 216, 0.08)',
  trust: '#0F172A',
  success: '#15803D',
  warning: '#B45309',
  danger: '#B91C1C',
  warnSoft: 'rgba(180, 83, 9, 0.07)',
  codeBg: 'rgba(17, 24, 39, 0.05)',
  tableHeadBg: '#F3F4F6',

  fontSerif: '"Source Han Serif SC", "Noto Serif CJK SC", "Songti SC", STSong, SimSun, Georgia, serif',
  fontSans: '"Source Han Sans SC", "Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
  fontMono: '"SF Mono", "JetBrains Mono", Menlo, Consolas, "Cascadia Mono", monospace',

  fontSize: [10.5, 11.5, 12.5, 14, 16, 19, 24],
  leading: { tight: 1.2, normal: 1.55 },

  space: [3, 6, 9, 12, 18, 26, 32, 44],
  radius: { sm: 3, md: 4 },

  contentWidth: '860px',
  measure: '52em',

  chart: ['#1D4ED8', '#B91C1C', '#15803D', '#B45309', '#6B7280', '#7C3AED', '#0E7490', '#4B5563'],
}
