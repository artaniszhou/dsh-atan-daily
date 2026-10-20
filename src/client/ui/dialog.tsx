/**
 * 弹层外壳：编辑弹窗（居中）与运行历史（右侧抽屉）共用一套行为。
 *
 * 收口的动机：改造前两个弹层各自写了一遍遮罩点击、Esc 关闭、打开时聚焦关闭键，
 * 任何一处调整都要改两遍。这里只保留一份。
 */
import { useEffect, useRef, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from 'react'
import { IconClose } from './icons.tsx'
import { cx, IconButton } from './primitives.tsx'
import css from './kit.module.css'

/** 弹层属性。 */
export interface DialogProps {
  /** `modal` 居中，`drawer` 贴右侧。 */
  variant?: 'modal' | 'drawer'
  title: string
  subtitle?: string
  /** 关闭按钮的无障碍名（沿用调用方语言的“关闭”文案）。 */
  closeLabel: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
}

/**
 * 弹层行为：打开后焦点落在关闭键，Esc 关闭，点遮罩关闭。
 * @param onClose - 关闭回调。
 * @returns 关闭键 ref 与两个事件处理器。
 */
export function useDialog(onClose: () => void): {
  closeRef: RefObject<HTMLButtonElement>
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void
  onOverlayClick: (event: MouseEvent<HTMLDivElement>) => void
} {
  const closeRef = useRef<HTMLButtonElement>(null)

  // 打开后把焦点移进弹层，Esc/Tab 从层内开始。
  useEffect(() => {
    const handle = window.setTimeout(() => { closeRef.current?.focus() }, 0)
    return () => { window.clearTimeout(handle) }
  }, [])

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Escape') return
    event.stopPropagation()
    onClose()
  }

  const onOverlayClick = (event: MouseEvent<HTMLDivElement>): void => {
    // 只有点在遮罩本身才关闭；点卡片内部不冒泡关闭。
    if (event.target === event.currentTarget) onClose()
  }

  return { closeRef, onKeyDown, onOverlayClick }
}

/** 通用弹层。 */
export function Dialog({ variant = 'modal', title, subtitle, closeLabel, onClose, children, footer }: DialogProps) {
  const { closeRef, onKeyDown, onOverlayClick } = useDialog(onClose)
  return (
    <div className={cx(css.overlay, variant === 'drawer' && css.overlayDrawer)} onClick={onOverlayClick}>
      <section
        className={cx(css.card, variant === 'drawer' ? css.drawerCard : css.modalCard)}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={onKeyDown}
      >
        <div className={css.head}>
          <div className={css.headText}>
            <div className={css.dialogTitle}>{title}</div>
            {subtitle === undefined ? null : <div className={css.dialogSubtitle}>{subtitle}</div>}
          </div>
          <IconButton ref={closeRef} label={closeLabel} onClick={onClose}>
            <IconClose />
          </IconButton>
        </div>
        <div className={variant === 'drawer' ? css.drawerBody : css.body}>{children}</div>
        {footer === undefined ? null : <div className={css.foot}>{footer}</div>}
      </section>
    </div>
  )
}
