/**
 * Client bundle 冒烟：不依赖浏览器，验证“注册一次 + factory 可物化 + apply 可挂载”。
 *
 * 用法：`node scripts/smoke-client.mjs`（在 `npm run build:client` 之后）。
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { renderToStaticMarkup } from 'react-dom/server'

const require = createRequire(import.meta.url)
const React = require('react')
const jsxRuntime = require('react/jsx-runtime')

const styleTags = []
const documentStub = {
  head: { appendChild(node) { styleTags.push(node) } },
  body: { appendChild() {}, contains() { return true } },
  documentElement: { style: { setProperty() {}, removeProperty() {} } },
  createElement(tag) {
    return { tag, id: '', dataset: {}, style: { cssText: '' }, textContent: '', remove() {} }
  },
  getElementById() { return null },
  querySelector(selector) {
    const match = /^style\[data-plugin-css="(.+)"\]$/.exec(selector)
    if (match === null) return null
    return styleTags.some(tag => tag.dataset.pluginCss === match[1]) ? {} : null
  },
}

let registration
const windowStub = {
  __ModuleLoader__: { load(value) { registration = value } },
  setTimeout,
  clearTimeout,
  innerHeight: 800,
  location: { origin: 'http://localhost' },
  confirm() { return true },
}

const sandbox = {
  window: windowStub,
  document: documentStub,
  console,
  Intl,
  Date,
  Math,
  JSON,
  Set,
  Map,
  Promise,
  Error,
  Object,
  Array,
  String,
  Number,
  Boolean,
  RegExp,
  Symbol,
  setTimeout,
  clearTimeout,
  AbortController,
  navigator: { language: 'zh-CN' },
  fetch: () => Promise.reject(new Error('smoke: no network')),
}
vm.createContext(sandbox)
vm.runInContext(readFileSync('lib/client.js', 'utf8'), sandbox)

if (registration === undefined) throw new Error('没有注册到 __ModuleLoader__')
if (registration.id !== 'dsh-atan-daily') throw new Error(`注册 id 不对：${registration.id}`)

const plugin = registration.factory((id) => {
  if (id === 'react') return React
  if (id === 'react/jsx-runtime') return jsxRuntime
  throw new Error(`冒烟：意外的外部依赖 ${id}`)
})

if (typeof plugin.apply !== 'function') throw new Error('factory 没有导出 apply')
if (!Array.isArray(plugin.inject)) throw new Error('factory 没有导出 inject')

const registrations = []
const disposers = []
const ctx = {
  slots: {
    inject(_key, callback) {
      const dispose = callback()
      return () => { dispose() }
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  },
  locale: {
    register() { return () => {} },
    bind() { return key => key },
  },
  uiWorkspace: { openSession() {} },
  layout: { selectPanel() {} },
  effect(callback) {
    const dispose = callback()
    if (typeof dispose === 'function') disposers.push(dispose)
  },
}

plugin.apply(ctx)

const names = registrations.map(entry => entry.options.id ?? entry.options.key)
if (!names.includes('atan-daily')) throw new Error(`侧栏/页面注册缺失：${names.join(',')}`)
if (registrations.length !== 2) throw new Error(`应注册 2 个 slot，实际 ${registrations.length}`)

const page = registrations.find(entry => entry.options.name === 'main')
const html = renderToStaticMarkup(React.createElement(page.component))
if (!html.includes('atan-daily-page')) throw new Error('页面没有渲染出根节点')

if (styleTags.length === 0) throw new Error('CSS Module 没有注入样式')

console.log(`ok: id=${registration.id} exports=${Object.keys(plugin).join(',')} slots=${names.join(',')} css=${styleTags.length} html=${html.length}B`)
for (const dispose of disposers) dispose()
