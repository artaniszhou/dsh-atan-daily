/**
 * 语义令牌的 TS 侧入口。
 *
 * 颜色只用于**动态**场景（状态点、状态色文字）；静态样式一律在 CSS Module
 * 里直接写 `var(--dsw-*)`。组件不允许出现十六进制或 rgba 字面量。
 */
import type { Tone } from '../shared/status.ts'

/** 页面会用到的语义令牌。 */
export const T = {
  ink: 'var(--dsw-alias-label-primary)',
  ink2: 'var(--dsw-alias-label-secondary)',
  ink3: 'var(--dsw-alias-label-tertiary)',
  accent: 'var(--dsw-alias-state-business-primary)',
  ok: 'var(--dsw-alias-state-success-primary)',
  danger: 'var(--dsw-alias-state-error-primary)',
  warn: 'var(--dsw-alias-state-warn-primary)',
  idle: 'var(--dsw-alias-state-idle-primary)',
} as const

/** 语义色调 → CSS 颜色。 */
const TONE_COLORS: Record<Tone, string> = {
  ok: T.ok,
  danger: T.danger,
  warn: T.warn,
  idle: T.idle,
  accent: T.accent,
  neutral: T.ink2,
}

/**
 * 取色调对应的颜色。
 * @param tone - 语义色调。
 * @returns CSS 颜色值。
 */
export function toneColor(tone: Tone): string {
  return TONE_COLORS[tone]
}
