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

/** 任务仓库。 */
export function IconInbox({ size = 16 }: IconProps) {
  return (
    <StrokeIcon size={size}>
      <path d="M4 13h4l1.5 3h5l1.5-3h4" />
      <path d="M5.5 4.5h13L21 13v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5z" />
    </StrokeIcon>
  )
}

/** 机器人（「机器人管理」入口）。 */
export function IconRobot({ size = 16 }: IconProps) {
  return (
    <StrokeIcon size={size}>
      <rect x={4.5} y={8} width={15} height={10.5} rx={2.5} />
      <path d="M12 8V5.6" />
      <circle cx={12} cy={4.4} r={1.1} />
      <path d="M9.4 12.6h.01M14.6 12.6h.01" />
      <path d="M9.8 15.4h4.4" />
    </StrokeIcon>
  )
}

/** 推送（任务行开关前缀）。 */
export function IconSend({ size = 16 }: IconProps) {
  return (
    <StrokeIcon size={size}>
      <path d="M20.5 3.5 3.5 9.8l6.3 2.4 2.4 6.3 8.3-15Z" />
      <path d="M20.5 3.5 9.8 12.1" />
    </StrokeIcon>
  )
}

/** 联系作者（对话气泡）。 */
export function IconMessage({ size = 16 }: IconProps) {
  return (
    <StrokeIcon size={size}>
      <path d="M20 12.5a7.5 7.5 0 0 1-10.9 6.7L4 20l1-4.6A7.5 7.5 0 1 1 20 12.5Z" />
      <path d="M8.8 11.4h6.4M8.8 14.4h4.2" />
    </StrokeIcon>
  )
}

/** 公告（喇叭）。 */
export function IconMegaphone({ size = 16 }: IconProps) {
  return (
    <StrokeIcon size={size}>
      <path d="M4 10.4v3.2a1 1 0 0 0 1 1h2l4 3.1V6.3L7 9.4H5a1 1 0 0 0-1 1Z" />
      <path d="M15 8.6a4.3 4.3 0 0 1 0 6.8" />
      <path d="M17.9 6a7.9 7.9 0 0 1 0 12" />
      <path d="M8 14.6V18a1 1 0 0 0 1 1h1.4" />
    </StrokeIcon>
  )
}

/** 侧栏入口：两个叠起来的消息气泡。 */export function PanelIcon({ size }: { size: number }) {
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
