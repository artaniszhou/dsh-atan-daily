/**
 * 弹层外壳：编辑弹窗（居中）与运行历史（右侧抽屉）共用一套行为。
 *
 * 收口的动机：改造前两个弹层各自写了一遍遮罩点击、Esc 关闭、打开时聚焦关闭键，
 * 任何一处调整都要改两遍。这里只保留一份。
 *
 * 键盘行为在文档层接管，而不是绑在弹层卡片上：焦点一旦离开卡片（Tab 走到背景），
 * 绑在卡片上的 Esc 就再也收不到事件，弹层会「关不掉」。所以这里同时做两件事：
 *  - Esc 在文档层关闭，输入控件自己消费过的 Esc（`defaultPrevented`）不重复处理；
 *  - Tab / Shift+Tab 在弹层内循环，焦点不会落到背后的页面上。
 */
import { useEffect, useRef, type MouseEvent, type ReactNode, type RefObject } from 'react'
import { IconClose } from './icons.tsx'
import { cx, IconButton } from './primitives.tsx'
import css from './kit.module.css'

/** 弹层内可聚焦元素的候选选择器。 */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

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
 * 弹层行为：打开后焦点落在关闭键，Esc 关闭，点遮罩关闭，Tab 在层内循环。
 * @param onClose - 关闭回调。
 * @returns 关闭键 ref、卡片 ref 与遮罩点击处理器。
 */
export function useDialog(onClose: () => void): {
  closeRef: RefObject<HTMLButtonElement>
  cardRef: RefObject<HTMLElement>
  onOverlayClick: (event: MouseEvent<HTMLDivElement>) => void
} {
  const closeRef = useRef<HTMLButtonElement>(null)
  const cardRef = useRef<HTMLElement>(null)

  // 打开后把焦点移进弹层，Esc/Tab 从层内开始。
  useEffect(() => {
    const handle = window.setTimeout(() => { closeRef.current?.focus() }, 0)
    return () => { window.clearTimeout(handle) }
  }, [])

  // 文档级键盘接管：Esc 关闭 + Tab 圈定焦点。卸载即解绑，不会残留到下一个弹层。
  useEffect(() => {
    const handle = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        // 表单/时区列表已经处理过这次 Esc，交给它们自己关，不再叠一层。
        if (event.defaultPrevented) return
        event.stopPropagation()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const card = cardRef.current
      if (card === null) return
      const focusable = [...card.querySelectorAll<HTMLElement>(FOCUSABLE)]
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (first === undefined || last === undefined) {
        event.preventDefault()
        card.focus()
        return
      }
      // 焦点已经跑到背景：先拉回层内，别让它继续往后走。
      if (!card.contains(document.activeElement)) {
        event.preventDefault()
        first.focus()
        return
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
        return
      }
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handle)
    return () => { document.removeEventListener('keydown', handle) }
  }, [onClose])

  const onOverlayClick = (event: MouseEvent<HTMLDivElement>): void => {
    // 只有点在遮罩本身才关闭；点卡片内部不冒泡关闭。
    if (event.target === event.currentTarget) onClose()
  }

  return { closeRef, cardRef, onOverlayClick }
}

/** 通用弹层。 */
export function Dialog({ variant = 'modal', title, subtitle, closeLabel, onClose, children, footer }: DialogProps) {
  const { closeRef, cardRef, onOverlayClick } = useDialog(onClose)
  return (
    <div className={cx(css.overlay, variant === 'drawer' && css.overlayDrawer)} onClick={onOverlayClick}>
      <section
        ref={cardRef}
        tabIndex={-1}
        className={cx(css.card, variant === 'drawer' ? css.drawerCard : css.modalCard)}
        role="dialog"
        aria-modal="true"
        aria-label={title}
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
