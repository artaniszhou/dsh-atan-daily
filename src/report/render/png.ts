/**
 * PNG：把已经渲染好的 HTML 交给本机 Chromium 截成一张长图。
 *
 * 复用 PDF 的浏览器查找逻辑，不把 Chromium 打进插件；Node 侧只用
 * `puppeteer-core` 通过 CDP 控制系统 Chrome/Edge。
 *
 * A4 基准：CSS 宽度 794px（A4 210mm @96dpi），2x 输出宽度 1588px。
 * 输出高度上限 20000px；超过就截断，不自动改 PDF。
 */

import { existsSync, statSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import puppeteer from 'puppeteer-core'
import type { Browser } from 'puppeteer-core'
import { findBrowser } from './pdf.js'

/** A4 内容宽度（CSS px）。 */
export const PNG_WIDTH_CSS = 794
/** 设备像素比；2x 输出约 1588px 宽。 */
export const PNG_SCALE = 2
/** 输出高度上限（设备像素）；约 9 页 A4。 */
export const PNG_MAX_OUTPUT_HEIGHT = 20_000
/** CSS 高度上限。 */
const PNG_MAX_CSS_HEIGHT = PNG_MAX_OUTPUT_HEIGHT / PNG_SCALE

/** PNG 结果。 */
export type PngResult =
  | { ok: true, path: string, bytes: number, width: number, height: number, truncated: boolean }
  | { ok: false, code: 'no_browser' | 'failed', message: string }

/**
 * 用系统 Chrome/Edge 把 HTML 截成长图。
 * @param htmlPath - 已渲染的 HTML 绝对路径。
 * @param pngPath - 目标 PNG 绝对路径。
 * @param timeoutMs - 整体超时，默认 60 秒。
 * @returns 成功时给出尺寸与是否截断；失败给出可展示的原因。
 */
export async function renderPng(htmlPath: string, pngPath: string, timeoutMs = 60_000): Promise<PngResult> {
  const browserPath = findBrowser()
  if (browserPath === undefined) {
    return {
      ok: false,
      code: 'no_browser',
      message: '没有找到 Chrome 或 Edge，无法生成 PNG（可设 ATAN_CHROME 指定路径）',
    }
  }

  let browser: Browser | undefined
  try {
    browser = await puppeteer.launch({
      executablePath: browserPath,
      headless: true,
      timeout: timeoutMs,
      args: [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
      ],
    })
    const page = await browser.newPage()
    await page.setViewport({ width: PNG_WIDTH_CSS, height: 1123, deviceScaleFactor: PNG_SCALE })
    await page.emulateMediaType('screen')
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load', timeout: timeoutMs })
    await page.evaluate('document.fonts.ready')

    const rawHeight = await page.evaluate('document.documentElement.scrollHeight')
    const contentHeight = typeof rawHeight === 'number' && Number.isFinite(rawHeight) ? rawHeight : 0
    const cssHeight = Math.max(1, Math.min(contentHeight, PNG_MAX_CSS_HEIGHT))
    const truncated = contentHeight > PNG_MAX_CSS_HEIGHT

    await page.setViewport({ width: PNG_WIDTH_CSS, height: cssHeight, deviceScaleFactor: PNG_SCALE })
    await page.screenshot({
      path: pngPath,
      type: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: PNG_WIDTH_CSS, height: cssHeight },
    })

    if (!existsSync(pngPath)) {
      return { ok: false, code: 'failed', message: '截图进程结束了，但没有生成 PNG' }
    }
    const bytes = statSync(pngPath).size
    if (bytes < 1024) {
      return { ok: false, code: 'failed', message: `PNG 只有 ${String(bytes)} 字节，可能截图失败` }
    }
    return {
      ok: true,
      path: pngPath,
      bytes,
      width: PNG_WIDTH_CSS * PNG_SCALE,
      height: Math.round(cssHeight * PNG_SCALE),
      truncated,
    }
  } catch (error: unknown) {
    return {
      ok: false,
      code: 'failed',
      message: error instanceof Error ? error.message : String(error),
    }
  } finally {
    if (browser !== undefined) await browser.close().catch(() => {})
  }
}
