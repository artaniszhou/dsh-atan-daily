/**
 * 主题注册表。
 *
 * 任务在 `report.json` 信封里写 `theme`，渲染时按名字取令牌；名字不认识时
 * 退回默认主题并在渲染警告里记一条，不阻断出报告。
 */

import type { Theme } from '../theme.js'
import { compactTheme } from './compact.js'
import { defaultTheme } from './default.js'

/** 可选主题。 */
export const THEMES: Readonly<Record<string, Theme>> = {
  default: defaultTheme,
  compact: compactTheme,
}

/**
 * 按名字取主题。
 * @param name - `report.json` 里的 `theme`；空值取默认主题。
 * @returns 主题令牌。
 */
export function resolveTheme(name?: string): Theme {
  if (name === undefined || name.trim() === '') return defaultTheme
  return THEMES[name.trim()] ?? defaultTheme
}

/**
 * 判断主题名是否已注册。
 * @param name - 主题名。
 * @returns 注册过时为 true。
 */
export function hasTheme(name: string): boolean {
  return name.trim() in THEMES
}
