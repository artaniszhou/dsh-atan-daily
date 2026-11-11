/**
 * PDF：把已经渲染好的 HTML 交给本机 Chromium 内核打印。
 *
 * 不引 PDF 库。中文 PDF 需要嵌入中文字体，任何一个纯 JS 方案都要带几十 MB
 * 字体文件；交给浏览器打印，字体由系统提供，体积与维护成本都是零。
 *
 * 用 `puppeteer-core` 而不是命令行 `--print-to-pdf`，是为了能：
 * 1. 等 `document.fonts.ready`（中文字体加载完再排版，避免页面宽度抖动）；
 * 2. 由浏览器注入页码（`pageNumber` / `totalPages`），命令行做不到；
 * 3. 与 PNG 共用同一套浏览器查找与错误处理。
 *
 * 引擎顺序：`ATAN_CHROME` 环境变量 → 系统 Chrome → 系统 Edge → Linux 常见路径。
 * 找不到时返回 `no_browser`，调用方把 PDF 标记为不可用，不影响 HTML。
 */

import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import puppeteer from 'puppeteer-core'
import type { Browser } from 'puppeteer-core'

/** PDF 结果。 */
export type PdfResult =
  | { ok: true, path: string, bytes: number }
  | { ok: false, code: 'no_browser' | 'failed', message: string }

/** 页脚：左侧报告标题（浏览器注入 `<title>`），右侧页码。 */
const FOOTER_TEMPLATE = `
<div style="width:100%;padding:0 16mm;font-size:9px;color:#6B6A64;font-family:'PingFang SC','Microsoft YaHei',system-ui,sans-serif;display:flex;justify-content:space-between;align-items:center;">
  <span class="title" style="overflow:hidden;white-space:nowrap;text-overflow:ellipsis;max-width:70%;"></span>
  <span>第 <span class="pageNumber"></span> 页 / 共 <span class="totalPages"></span> 页</span>
</div>`

/** 候选浏览器路径；按顺序取第一个存在的。 */
function candidates(): string[] {
  const fromEnv = process.env['ATAN_CHROME']
  const list: string[] = fromEnv === undefined || fromEnv.trim() === '' ? [] : [fromEnv.trim()]
  if (process.platform === 'win32') {
    const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files'
    const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    list.push(
      join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    )
    return list
  }
  if (process.platform === 'darwin') {
    list.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    )
    return list
  }
  list.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium')
  return list
}

/**
 * 找一个可用的 Chromium 内核。
 * @returns 可执行文件路径；找不到时 undefined。
 */
export function findBrowser(): string | undefined {
  return candidates().find(path => existsSync(path))
}

/**
 * 当前宿主是否有可用于渲染的浏览器。
 * @returns true 表示 Chrome/Edge 可用。
 */
export function browserAvailable(): boolean {
  return findBrowser() !== undefined
}

/**
 * 把 HTML 打成 PDF。
 * @param htmlPath - 已渲染的 HTML 绝对路径。
 * @param pdfPath - 目标 PDF 绝对路径。
 * @param timeoutMs - 打印超时，默认 60 秒。
 * @returns 成功时给出字节数；失败给出可展示的原因。
 */
export async function renderPdf(htmlPath: string, pdfPath: string, timeoutMs = 60_000): Promise<PdfResult> {
  const browserPath = findBrowser()
  if (browserPath === undefined) {
    return {
      ok: false,
      code: 'no_browser',
      message: '没有找到 Chrome 或 Edge，无法生成 PDF（可设 ATAN_CHROME 指定路径）',
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
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
      ],
    })
    const page = await browser.newPage()
    await page.emulateMediaType('print')
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load', timeout: timeoutMs })
    // 中文字体就绪后再分页，避免换行位置与浏览器手动打印不一致。
    await page.evaluate('document.fonts.ready')
    await page.pdf({
      path: pdfPath,
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate: FOOTER_TEMPLATE,
      // 页眉页脚占的是页边距，所以边距由打印参数给，不再依赖 CSS 的 @page。
      margin: { top: '16mm', bottom: '18mm', left: '16mm', right: '16mm' },
    })

    if (!existsSync(pdfPath)) {
      return { ok: false, code: 'failed', message: '打印进程结束了，但没有生成 PDF' }
    }
    const bytes = statSync(pdfPath).size
    if (bytes < 1024) {
      return { ok: false, code: 'failed', message: `PDF 只有 ${String(bytes)} 字节，可能打印失败` }
    }
    return { ok: true, path: pdfPath, bytes }
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
