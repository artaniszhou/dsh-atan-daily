/**
 * Client 侧用到的宿主服务类型。
 *
 * 只声明实际用到的成员，避免把整个 DSH Client 运行时类型带进插件。
 * `ctx.<service>` 的每个属性都必须在入口的 `inject` 里声明，否则 Cordis
 * 会在渲染路径抛错（表现为整个面板白屏）。
 */

/** 浏览器模块表的同步 require。 */
export type Require = (id: string) => unknown

/** slot 注册选项。 */
export interface SlotOptions {
  name: string
  id?: string
  key?: string
  order?: number
  label?: string | (() => string)
  /** 每次渲染交给组件的 props。 */
  inject?: () => unknown
}

/** locale 服务的窄接口。 */
export interface LocaleService {
  register: (namespace: string, dictionaries: Record<string, Record<string, string>>) => () => void
  bind: (namespace: string) => (key: string, params?: Record<string, string | number>) => string
}

/** Client 插件上下文。 */
export interface ClientContext {
  slots: {
    inject: (key: string, callback: () => () => void) => () => void
    register: (options: SlotOptions, component: unknown) => () => void
  }
  locale: LocaleService
  /** 会话导航：选中一个会话并显示它的对话。 */
  uiWorkspace: {
    openSession: (target: string) => void
  }
  /** 面板导航：`null` 表示回到对话而不是全局面板。 */
  layout: {
    selectPanel: (panelId: string | null) => void
  }
  /** 生命周期托管的副作用；返回清理函数。 */
  effect: (callback: (() => void) | void, label?: string) => void
}
