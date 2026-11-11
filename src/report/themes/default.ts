/**
 * 默认主题：暖纸底、陶土强调、墨蓝结构。
 *
 * 这套观感来自 1.2.0 的默认样式，这里把它整理成完整令牌：字号阶约 1.15–1.25
 * 比例，间距按 8pt 网格，图表色板 8 色按语义顺序取用。
 */

import type { Theme } from '../theme.js'

/** 默认主题。 */
export const defaultTheme: Theme = {
  paper: '#F5F4ED',
  surface: '#FBFAF6',
  surfaceAlt: '#F1EFE5',
  ink: '#141413',
  body: '#2B2A27',
  muted: '#6B6A64',
  border: '#E2E0D4',
  accent: '#B85235',
  accentSoft: 'rgba(184, 82, 53, 0.09)',
  trust: '#1B365D',
  success: '#2F6F4E',
  warning: '#9A5A2D',
  danger: '#A03A2B',
  warnSoft: 'rgba(154, 90, 45, 0.07)',
  codeBg: 'rgba(20, 20, 19, 0.055)',
  tableHeadBg: '#F1EFE5',

  fontSerif: '"Source Han Serif SC", "Noto Serif CJK SC", "Songti SC", STSong, SimSun, Georgia, serif',
  fontSans: '"Source Han Sans SC", "Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
  fontMono: '"SF Mono", "JetBrains Mono", Menlo, Consolas, "Cascadia Mono", monospace',

  // 2xs 脚注 / xs 说明 / sm 表格 / base 正文 / lg 副标题 / xl h2 / 2xl h1
  fontSize: [11, 12, 13, 15, 17, 21, 27],
  leading: { tight: 1.25, normal: 1.65 },

  // 4 / 8 / 12 / 16 / 22 / 32 / 40 / 56
  space: [4, 8, 12, 16, 22, 32, 40, 56],
  radius: { sm: 4, md: 6 },

  // A4 版心：210mm @96dpi ≈ 794px
  contentWidth: '794px',
  // 中文行长：约 46 个字，长段落不会一行拉到底
  measure: '46em',

  chart: ['#B85235', '#1B365D', '#2F6F4E', '#9A5A2D', '#6B6A64', '#7A5C8E', '#2A6F7F', '#8C6B4F'],
}
