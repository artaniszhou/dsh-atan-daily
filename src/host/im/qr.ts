/**
 * 二维码生成。
 *
 * `qrcode` 是 CJS 包且不带类型，这里用 `createRequire` 惰性加载 + 局部接口，
 * 避免把它的类型（或整包）拖进 tsc 程序。生成结果按内容缓存，扫码轮询
 * 每次只读快照，不重复编码。
 */

import { createRequire } from 'node:module'

/** 只声明用到的那一个方法。 */
interface QrCodeModule {
  toDataURL: (text: string, options?: Record<string, unknown>) => Promise<string>
}

const require = createRequire(import.meta.url)
let loaded: QrCodeModule | undefined
const cache = new Map<string, Promise<string>>()
/** 缓存上限；一次扫码只会有一个二维码，留几条余量即可。 */
const CACHE_LIMIT = 8

/**
 * 惰性加载 qrcode；缺失时给出可诊断的错误。
 * @returns 模块。
 */
function qrcode(): QrCodeModule {
  if (loaded === undefined) {
    const module = require('qrcode') as QrCodeModule
    if (typeof module?.toDataURL !== 'function') throw new Error('qrcode 模块不可用')
    loaded = module
  }
  return loaded
}

/**
 * 把一段文本编码成 PNG data URL。
 *
 * 固定白底、M 级纠错、320px 宽：手机在暗色主题的抽屉里也能扫。
 * @param text - 二维码内容（飞书的授权链接）。
 * @returns `data:image/png;base64,...`
 */
export async function qrDataUrl(text: string): Promise<string> {
  const hit = cache.get(text)
  if (hit !== undefined) return await hit
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  const pending = qrcode().toDataURL(text, {
    type: 'image/png',
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 320,
  })
  cache.set(text, pending)
  try {
    return await pending
  } catch (error: unknown) {
    cache.delete(text)
    throw error
  }
}
