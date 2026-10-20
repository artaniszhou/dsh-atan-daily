/**
 * 插件的全局 UI 原子。
 *
 * 收口动机：改造前，同一个“按钮/空态/错误行/开关”在页面里各写一份内联样式，
 * 90 个 `StyleMap` 里 69 个只被引用一次。这里让所有页面从同一组原子取外观，
 * 几何与颜色由 `kit.module.css` + `--dsw-*` 令牌决定。
 */
import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react'
import type { Tone } from '../shared/status.ts'
import { toneColor } from './tokens.ts'
import css from './kit.module.css'

/** 拼接 className，过滤空值。 */
export function cx(...parts: Array<string | false | undefined>): string {
  return parts.filter(part => part !== undefined && part !== false && part !== '').join(' ')
}

/** 按钮外观。 */
export type ButtonVariant = 'primary' | 'quiet' | 'danger'

/** 按钮属性。 */
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: 'md' | 'sm'
  icon?: ReactNode
}

/** 通用按钮。 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'quiet', size = 'md', icon, className, type = 'button', children, ...rest },
  ref,
) {
  return (
    <button ref={ref} type={type} className={cx(css.button, css[variant], css[size], className)} {...rest}>
      {icon === undefined ? null : <span className={css.icon}>{icon}</span>}
      {children}
    </button>
  )
})

/** 只有图标的方形按钮；`label` 同时作为无障碍名与 hover 标题。 */
export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string
  title?: string
}>(function IconButton({ label, title, className, type = 'button', children, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(css.iconButton, className)}
      aria-label={label}
      title={title ?? label}
      {...rest}
    >
      {children}
    </button>
  )
})

/** 一组“标签 + 控件”的容器。 */
export function Field({ label, htmlFor, hint, className, children }: {
  label: ReactNode
  htmlFor?: string
  hint?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <div className={cx(css.field, className)}>
      <label className={css.fieldLabel} htmlFor={htmlFor}>{label}</label>
      {children}
      {hint === undefined ? null : <span className={css.fieldHint}>{hint}</span>}
    </div>
  )
}

/** 文本链接式按钮（抽屉里的“打开”）。 */
export const LinkButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(function LinkButton(
  { className, type = 'button', children, ...rest },
  ref,
) {
  return (
    <button ref={ref} type={type} className={cx(css.linkButton, className)} {...rest}>
      {children}
    </button>
  )
})

/** 单行文本输入。 */
export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function TextInput(
  { className, ...rest },
  ref,
) {
  return <input ref={ref} className={cx(css.input, className)} {...rest} />
})

/** 多行文本输入。 */
export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function TextArea(
  { className, ...rest },
  ref,
) {
  return <textarea ref={ref} className={cx(css.textarea, className)} {...rest} />
})

/** 滑动开关；真正的 checkbox，键盘可操作。 */
export function Switch({ checked, disabled = false, label, onChange }: {
  checked: boolean
  disabled?: boolean
  label: string
  onChange: (next: boolean) => void
}) {
  return (
    <label
      className={cx(css.switch, checked && css.switchOn, disabled && css.switchDisabled)}
      title={label}
      aria-label={label}
    >
      <input
        type="checkbox"
        role="switch"
        className={css.switchInput}
        checked={checked}
        disabled={disabled}
        aria-checked={checked}
        aria-label={label}
        onChange={() => { if (!disabled) onChange(!checked) }}
      />
      <span className={cx(css.knob, checked && css.knobOn)} />
    </label>
  )
}

/** 语义色调圆点。 */
export function Dot({ tone }: { tone: Tone }) {
  return <span className={css.dot} style={{ background: toneColor(tone) }} aria-hidden="true" />
}

/** 圆点 + 文字的紧凑徽标。 */
export function Badge({ tone, children }: { tone: Tone, children: ReactNode }) {
  return <span className={css.badge}><Dot tone={tone} />{children}</span>
}

/** 空/错误/加载/状态行。 */
export function Notice({ kind, children, role }: {
  kind: 'empty' | 'error' | 'loading' | 'status'
  children: ReactNode
  role?: string
}) {
  const toneClass = kind === 'error'
    ? css.noticeError
    : kind === 'loading' || kind === 'empty' ? css.noticeMuted : css.noticeStatus
  return (
    <div className={cx(css.notice, toneClass)} role={role ?? (kind === 'error' ? 'alert' : 'status')}>
      {children}
    </div>
  )
}

/** 列表加载骨架。 */
export function SkeletonList({ label }: { label: string }) {
  return (
    <div className={css.skeletonList} role="status" aria-busy="true" aria-label={label}>
      {[0, 1, 2].map(index => (
        <div key={index} className={css.skeletonRow} aria-hidden="true">
          <div className={cx(css.skeletonBar, css.skeletonShort)} />
          <div className={cx(css.skeletonBar, css.skeletonLong)} />
        </div>
      ))}
    </div>
  )
}
