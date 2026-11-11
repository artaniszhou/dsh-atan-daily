/**
 * 把插件注册进宿主：侧栏入口、中央页面、文案字典、会话导航。
 *
 * 这里只做“接线”，不包含业务；`apply()` 的失败由入口统一兜底。
 */
import { PANEL_ID, PANEL_ORDER } from '../constants.ts'
import { DICTIONARIES, attachLocale, NAMESPACE, t } from '../i18n/index.ts'
import { ErrorBoundary } from '../app/failure.tsx'
import { Page } from '../features/page/Page.tsx'
import { PanelIcon } from '../ui/icons.tsx'
import type { AtanDailyApi } from '../api/tasks.ts'
import type { ClientContext } from './context.ts'

/**
 * 注册插件。
 * @param ctx - 宿主注入的 client 上下文。
 * @param api - host 端点集合。
 */
export function registerPlugin(ctx: ClientContext, api: AtanDailyApi): void {
  // 绑定翻译器：后续 `t()` 会跟随宿主语言切换。
  attachLocale(namespace => ctx.locale.bind(namespace))

  ctx.effect(
    () => ctx.locale.register(NAMESPACE, DICTIONARIES),
    'atan-daily: dictionaries',
  )

  /**
   * 打开一个运行会话并离开插件面板。
   * 两个服务都是可选的：导航失败不影响已经在 Host 上发生的运行。
   */
  const navigate = (sessionId: string): void => {
    try {
      ctx.uiWorkspace.openSession(sessionId)
      ctx.layout.selectPanel(null)
    } catch {
      // 导航是便利功能，失败时停留在任务列表即可。
    }
  }

  /** 删除前确认：优先用宿主页面的 confirm，缺失时默认确认。 */
  const confirm = (message: string): boolean => (
    typeof window.confirm === 'function' ? window.confirm(message) : true
  )

  // 侧栏入口。
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: PANEL_ORDER,
    label: () => t('nav'),
  }, PanelIcon))

  // 中央页面：数据与导航通过闭包注入，组件本身不碰全局。
  const Panel = () => (
    <ErrorBoundary>
      <Page api={api} navigate={navigate} confirm={confirm} />
    </ErrorBoundary>
  )
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
  }, Panel))
}
