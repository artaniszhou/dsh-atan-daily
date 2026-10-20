/**
 * 插件用到的全部图标。
 *
 * 统一 24×24 网格、`currentColor` 描边，尺寸由参数控制；侧栏入口图标单独导出，
 * 因为它在 slot 里拿到的尺寸来自宿主。
 */
import type { ReactNode } from 'react'

/** 图标通用属性。 */
interface IconProps {
  size?: number
}

/** 一个 24×24 描边图标的外壳。 */
function StrokeIcon({ size = 16, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

/** 关闭。 */
export function IconClose({ size = 16 }: IconProps) {
  return <StrokeIcon size={size}><path d="M6 6l12 12M18 6L6 18" /></StrokeIcon>
}

/** 运行历史（时钟）。 */
export function IconHistory({ size = 16 }: IconProps) {
  return (
    <StrokeIcon size={size}>
      <circle cx={12} cy={12} r={8} />
      <path d="M12 7.5V12l3 2" />
    </StrokeIcon>
  )
}

/** 执行一次（实心三角）。 */
export function IconPlay({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M8.5 5.5v13L18 12z" fill="currentColor" />
    </svg>
  )
}

/** 空状态（插件自己的对话气泡）。 */
export function IconEmpty() {
  return (
    <svg
      width={48}
      height={48}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v6a2.5 2.5 0 0 1-2.5 2.5H9l-4 3.5v-3.5" />
    </svg>
  )
}

/** 搜索。 */
export function IconSearch() {
  return (
    <StrokeIcon size={16}>
      <circle cx={11} cy={11} r={6.5} />
      <path d="m16 16 4 4" />
    </StrokeIcon>
  )
}

/** 新增。 */
export function IconPlus() {
  return <StrokeIcon size={16}><path d="M12 5v14M5 12h14" /></StrokeIcon>
}

/** 侧栏入口：两个叠起来的消息气泡。 */
export function PanelIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v6a2.5 2.5 0 0 1-2.5 2.5H9l-4 3.5v-3.5" />
      <path d="M16 13h1.5A2.5 2.5 0 0 1 20 15.5V18h-2.5L14 20.5V18h-2" />
    </svg>
  )
}
