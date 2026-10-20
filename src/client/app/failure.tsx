/**
 * 失败兜底。
 *
 * 两层保护：
 *  1. `reportFailure` 在页面上钉一条诊断条（并写 console），保证即使 React
 *     没挂载成功也能看到“哪个阶段、什么错误”；
 *  2. `ErrorBoundary` 接住渲染异常，面板显示可重试的提示，而不是整块白屏。
 */
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { FAILURE_STRIP_MS } from '../constants.ts'
import { t } from '../i18n/index.ts'
import { Button } from '../ui/primitives.tsx'
import css from './failure.module.css'

/** 诊断条元素 id；重复报告时复用同一个节点。 */
const STRIP_ID = 'atan-daily-failure'

/** 诊断条的自动消失定时器。 */
let stripTimer: number | undefined

/**
 * 在页面上显示一条诊断信息。
 * @param phase - 出错的阶段（mount/render/sync…）。
 * @param error - 捕获到的错误。
 */
export function reportFailure(phase: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[atan-daily] ${phase} error:`, error)
  try {
    let strip = document.getElementById(STRIP_ID)
    if (strip === null) {
      strip = document.createElement('div')
      strip.id = STRIP_ID
      strip.style.cssText = [
        'position:fixed', 'left:8px', 'bottom:8px', 'z-index:2147483000',
        'max-width:70vw', 'padding:8px 12px',
        'font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace',
        'color:var(--dsw-alias-state-error-primary)', 'background:var(--dsw-alias-bg-layer-1)',
        'border:1px solid var(--dsw-alias-state-error-primary)', 'border-radius:8px',
        'white-space:pre-wrap',
      ].join(';')
      document.body.appendChild(strip)
    }
    strip.textContent = `[atan-daily] ${phase}: ${message}`
    if (stripTimer !== undefined) window.clearTimeout(stripTimer)
    stripTimer = window.setTimeout(() => { strip?.remove() }, FAILURE_STRIP_MS)
  } catch {
    // 连 DOM 都不可用：console 已经记录了。
  }
}

/** 边界属性。 */
interface BoundaryProps {
  children: ReactNode
}

/** 边界状态。 */
interface BoundaryState {
  error: Error | null
}

/** 渲染错误边界。 */
export class ErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { error: null }

  /** 子组件抛错时切到错误界面。 */
  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    reportFailure('render', error)
    if (info.componentStack !== undefined && info.componentStack !== null) {
      console.error(`[atan-daily] component stack:${info.componentStack}`)
    }
  }

  override render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <div className={css.root} role="alert">
          <span>{t('loadFailed')}</span>
          <span className={css.detail}>{this.state.error.message}</span>
          <span>
            <Button size="sm" variant="quiet" onClick={() => { this.setState({ error: null }) }}>
              {t('retry')}
            </Button>
          </span>
        </div>
      )
    }
    return this.props.children
  }
}
