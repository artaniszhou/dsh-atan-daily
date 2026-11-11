/**
 * 一轮运行的渲染入口：`.meta/build/<runId>/report.json` → 中间件 HTML +
 * 任务根下的最终 PDF/PNG。
 *
 * 放在 Host 侧、由插件在会话结束后调用，模型不参与排版。三条处置原则：
 *
 * 1. **数据优先**：渲染失败不改变「本轮采集成功」；JSON 始终保留在 build 里。
 * 2. **契约坏了也不藏**：契约读不到或数据不合规时，不渲染最终文档，返回原因。
 * 3. **最终格式二选一**：用户选 PDF 就只出 PDF，选 PNG 就只出 PNG；PNG 过长
 *    截断，不自动改 PDF。
 *
 * 展示覆盖（`.share/task-display.json`）只影响外观：不存在时走默认，存在时
 * 与主题合并。
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OutputFormat } from '../../protocol.js'
import { checkContract, loadContract } from '../contract.js'
import { buildPlan, fallbackPlan } from '../present.js'
import type { RenderPlan, ReportDoc } from '../present.js'
import { renderHtml } from './html.js'
import { resolveDisplayTheme, parseDisplay } from '../display/spec.js'
import type { DisplaySpec } from '../display/spec.js'
import { readDisplay } from '../display/store.js'
import { renderPdf } from './pdf.js'
import { renderPng } from './png.js'
import { check, formatIssues } from '../validate.js'

/** 一次渲染的输入。 */
export interface RenderRunInput {
  /** 任务目录。 */
  folder: string
  /** 报告基名（不含扩展名）。 */
  base: string
  /** 本轮中间件目录（`.meta/build/<runId>`）。 */
  buildDir: string
  /** 用户选择的最终文档格式。 */
  format: OutputFormat
}

/** 一次渲染的结果。 */
export interface RenderRunResult {
  ok: boolean
  /** 实际写出的文件名（相对任务目录或 build 目录）。 */
  files: string[]
  /** 渲染期提示：缺失未登记、图表降级、PNG 截断等。 */
  warnings: string[]
  /** 失败原因，可直接进日志。 */
  error?: string
  /** 最终文档是否被截断（仅 PNG）。 */
  truncated?: boolean
}

/**
 * 渲染一轮报告。
 * @param input - 任务目录、基名、build 目录与最终格式。
 * @returns 写出的文件与提示；失败时给出原因。
 */
export async function renderRunReport(input: RenderRunInput): Promise<RenderRunResult> {
  const { folder, base, buildDir, format } = input
  const dataPath = join(buildDir, 'report.json')

  let raw: string
  try {
    raw = await readFile(dataPath, 'utf8')
  } catch {
    return { ok: false, files: [], warnings: [], error: `本轮没有数据文件：${dataPath}` }
  }

  let doc: ReportDoc
  try {
    doc = JSON.parse(raw) as ReportDoc
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, files: [], warnings: [], error: `数据文件不是合法 JSON：${detail}` }
  }

  const displayState = await readDisplay(folder)
  const display = displayState.spec
  const warnings: string[] = [...displayState.warnings]

  // 契约不可用、数据不合规时不再「什么都不出」：按回退模式渲染一份原始数据报告，
  // 让这一轮仍然有文档可看、可推送，原因写在报告顶部与渲染警告里。
  let plan: RenderPlan
  let themeName = doc.theme
  const loaded = await loadContract(folder)
  if (!loaded.ok) {
    plan = fallbackPlan(doc, `契约不可用，已按原始数据展示：${loaded.message}`)
    warnings.push(loaded.message)
  } else {
    const declared = loaded.contract.schema['x-theme']
    if (themeName === undefined && typeof declared === 'string') themeName = declared
    const dataCheck = check(loaded.contract.schema, doc.data, { maxIssues: 30 })
    if (!dataCheck.ok) {
      const detail = formatIssues(dataCheck.issues, 6).join('\n')
      plan = fallbackPlan(doc, `数据不符合契约，已按原始数据展示：\n${detail}`)
      warnings.push(...dataCheck.warnings)
    } else {
      plan = buildPlan(loaded.contract.schema, doc, { folder })
      warnings.push(...plan.warnings, ...dataCheck.warnings)
    }
  }

  const theme = resolveDisplayTheme(themeName, display)
  const htmlPath = join(buildDir, 'report.html')
  let renderDisplay = display
  let html: string
  try {
    html = renderHtml(plan, theme, { display })
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    warnings.push(`渲染失败，已按原始数据展示：${detail}`)
    plan = fallbackPlan(doc, `渲染失败，已按原始数据展示：${detail}`)
    renderDisplay = undefined
    html = renderHtml(plan, theme)
  }
  await writeFile(htmlPath, html, 'utf8')
  const files: string[] = ['report.html']

  // 打印/截图用展开态：折叠会把长表整段丢掉。
  const printDir = await mkdtemp(join(tmpdir(), 'atan-print-'))
  const printPath = join(printDir, `${base}.print.html`)
  try {
    await writeFile(printPath, renderHtml(plan, theme, { expandDetails: true, display: renderDisplay }), 'utf8')
    if (format === 'pdf') {
      const pdfPath = join(folder, `${base}.pdf`)
      const pdf = await renderPdf(printPath, pdfPath)
      if (pdf.ok) {
        files.push(`${base}.pdf`)
        return { ok: true, files, warnings }
      }
      warnings.push(`PDF 未生成：${pdf.message}`)
      return { ok: true, files, warnings }
    }

    const pngPath = join(folder, `${base}.png`)
    const png = await renderPng(printPath, pngPath)
    if (png.ok) {
      files.push(`${base}.png`)
      if (png.truncated) warnings.push('PNG 超过高度上限，底部内容已截断')
      return { ok: true, files, warnings, truncated: png.truncated }
    }
    warnings.push(`PNG 未生成：${png.message}`)
    return { ok: true, files, warnings }
  } finally {
    await rm(printDir, { recursive: true, force: true })
  }
}

/** 预览输入。 */
export interface PreviewInput {
  folder: string
  buildDir: string
  /** 覆盖当前契约的提案契约；不传时用当前契约。 */
  schema?: Record<string, unknown>
  /** 覆盖规格；不传时视为没有覆盖。 */
  display?: DisplaySpec
}

/** 预览结果。 */
export interface PreviewResult {
  ok: boolean
  html?: string
  warnings: string[]
  error?: string
}

/**
 * 用指定契约与覆盖渲染一份预览 HTML（不落盘、不出图）。
 * @param input - 任务目录、build 目录、可选契约与覆盖。
 * @returns HTML 与警告。
 */
export async function renderPreview(input: PreviewInput): Promise<PreviewResult> {
  const dataPath = join(input.buildDir, 'report.json')
  let doc: ReportDoc
  try {
    doc = JSON.parse(await readFile(dataPath, 'utf8')) as ReportDoc
  } catch (error: unknown) {
    return { ok: false, warnings: [], error: `读不到本轮数据：${error instanceof Error ? error.message : String(error)}` }
  }

  let schema: Record<string, unknown>
  let warnings: string[] = []
  if (input.schema !== undefined) {
    const checked = checkContract(input.schema)
    if (!checked.ok) {
      return {
        ok: false,
        warnings: [],
        error: checked.findings.filter(item => item.level === 'error').map(item => `${item.path}：${item.message}`).join('\n'),
      }
    }
    schema = input.schema
  } else {
    const loaded = await loadContract(input.folder)
    if (!loaded.ok) return { ok: false, warnings: [], error: loaded.message }
    schema = loaded.contract.schema
  }

  const declared = schema['x-theme']
  const themeName = input.display?.theme ?? (typeof declared === 'string' ? declared : undefined)
  const theme = resolveDisplayTheme(themeName, input.display)

  const dataCheck = check(schema, doc.data, { maxIssues: 30 })
  const plan = dataCheck.ok
    ? buildPlan(schema, doc, { folder: input.folder })
    : fallbackPlan(doc, `数据不符合契约，已按原始数据展示：\n${formatIssues(dataCheck.issues, 6).join('\n')}`)
  warnings = [...(dataCheck.ok ? plan.warnings : []), ...dataCheck.warnings]
  try {
    const html = renderHtml(plan, theme, { display: input.display, preview: true, expandDetails: true })
    return { ok: true, html, warnings }
  } catch (error: unknown) {
    return {
      ok: false,
      warnings,
      error: `预览渲染失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

