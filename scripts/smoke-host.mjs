/**
 * Host bundle 冒烟：验证入口 shim 能加载，并导出 apply/inject。
 *
 * 用法：`node scripts/smoke-host.mjs`（在 `npm run build:host` 之后）。
 */
import { fileURLToPath, pathToFileURL } from 'node:url'

const entry = new URL('../lib/index.js', import.meta.url)
const plugin = await import(pathToFileURL(fileURLToPath(entry)).href)

if (typeof plugin.apply !== 'function') throw new Error('lib/index.js 没有导出 apply')
if (!Array.isArray(plugin.inject)) throw new Error('lib/index.js 没有导出 inject')
for (const service of ['timer', 'sessionController', 'workspaceRegistry', 'llm']) {
  if (!plugin.inject.includes(service)) throw new Error(`inject 缺少 ${service}`)
}
console.log(`ok: exports=${Object.keys(plugin).join(',')} inject=${plugin.inject.join(',')}`)
