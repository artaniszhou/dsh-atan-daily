/**
 * 插件版本：`package.json` 是唯一来源，运行期读取，避免在代码里再存一份字面量。
 *
 * 构建产物 `lib/host/version.js` 与 `package.json` 在包里同级（`../../package.json`），
 * npm 安装与本地 `link:` 安装都能解析到。读不到时回退占位符，
 * 只影响展示与追溯字段，不让插件因此起不来。
 */

import { readFileSync } from 'node:fs'

/** 读不到 `package.json` 时的占位版本。 */
const FALLBACK_VERSION = '0.0.0-dev'

/**
 * 读取包版本。
 * @returns `package.json` 的 `version`；缺失或读取失败时为 {@link FALLBACK_VERSION}。
 */
function readPackageVersion(): string {
  try {
    const url = new URL('../../package.json', import.meta.url)
    const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'))
    if (typeof parsed === 'object' && parsed !== null) {
      const version = (parsed as { version?: unknown }).version
      if (typeof version === 'string' && version.length > 0) return version
    }
    console.warn(`[atan-daily] package.json 缺少 version，插件版本回退为 ${FALLBACK_VERSION}`)
  } catch (error) {
    console.warn(`[atan-daily] 读取 package.json 失败，插件版本回退为 ${FALLBACK_VERSION}`, error)
  }
  return FALLBACK_VERSION
}

/** 当前插件版本，供运行记录、报告页脚与上报使用。 */
export const PLUGIN_VERSION = readPackageVersion()
