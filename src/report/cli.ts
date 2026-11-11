/**
 * 契约与渲染的命令行入口。
 *
 * 三个子命令，覆盖「写契约 → 核对数据 → 出报告」这条链：
 * - `explain <契约文件|任务目录>`：把人话字段表打到终端，用于审阅契约。
 * - `check <契约> <数据>`：按契约校验一份数据，报错可直接回灌给模型。
 * - `render <契约> <report.json> --out <目录>`：产出单文件 HTML。
 *
 * 参数简写成 `<目标>`：以 `.json` 结尾当作契约文件，否则当作任务目录，
 * 从 `<任务目录>/.share/task-schema.json` 读。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import { checkContract, contractFile, explainContract } from './contract.js'
import { buildPlan } from './present.js'
import type { ReportDoc } from './present.js'
import { renderHtml } from './render/html.js'
import { resolveTheme } from './theme.js'
import { renderPdf } from './render/pdf.js'
import { check, formatIssues } from './validate.js'

/** 用法说明。 */
const USAGE = `用法：
  atan-report explain <契约文件|任务目录>
  atan-report check   <契约文件|任务目录> <数据文件>
  atan-report render  <契约文件|任务目录> <report.json> [--out <输出目录>] [--pdf]

说明：
  目标以 .json 结尾时当作契约文件，否则当作任务目录（读 .share/task-schema.json）。
  check 的第二个参数既可以是纯数据，也可以是带 data 字段的 report.json。
  --pdf 会再调本机 Chrome/Edge 打印一份 A4 PDF。`

/** 打印用法并退出。 */
function usage(code: number): never {
  const stream = code === 0 ? process.stdout : process.stderr
  stream.write(`${USAGE}\n`)
  process.exit(code)
}

/** 读 JSON 文件，失败时给出可读错误。 */
async function readJson(path: string): Promise<unknown> {
  const raw = await readFile(path, 'utf8')
  try {
    return JSON.parse(raw)
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`${path} 不是合法 JSON：${detail}`)
  }
}

/**
 * 解析契约目标。
 * @param target - 契约文件或任务目录。
 * @returns 契约对象与来源路径。
 */
async function loadSchemaTarget(target: string): Promise<{ schema: Record<string, unknown>, path: string }> {
  const path = extname(target) === '.json' ? target : contractFile(target)
  const parsed = await readJson(path)
  const result = checkContract(parsed)
  if (!result.ok) {
    const lines = [contractProblem(result)]
    process.stderr.write(`${path} 契约不合法：\n${lines.join('\n')}\n`)
    process.exit(1)
  }
  return { schema: parsed as Record<string, unknown>, path }
}

/** 把校验结果拼成文本（与 contract.ts 的同名逻辑保持一致的最小实现）。 */
function contractProblem(result: ReturnType<typeof checkContract>): string {
  const parts = formatIssues(result.issues, 8)
  for (const finding of result.findings.filter(item => item.level === 'error').slice(0, 8)) {
    parts.push(`- ${finding.path}：${finding.message}${finding.hint === undefined ? '' : `（${finding.hint}）`}`)
  }
  return parts.join('\n')
}

/** 判断一个对象是不是 report.json（带 data 字段）。 */
function isReportDoc(value: unknown): value is ReportDoc {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && typeof (value as Record<string, unknown>)['data'] === 'object'
    && (value as Record<string, unknown>)['data'] !== null
}

/** `explain` 子命令。 */
async function commandExplain(target: string): Promise<void> {
  const { schema, path } = await loadSchemaTarget(target)
  process.stdout.write(`${explainContract(schema)}\n`)
  process.stdout.write(`\n（契约：${path}）\n`)
}

/** `check` 子命令。 */
async function commandCheck(target: string, dataPath: string): Promise<void> {
  const { schema } = await loadSchemaTarget(target)
  const parsed = await readJson(dataPath)
  const data = isReportDoc(parsed) ? parsed.data : parsed
  const result = check(schema, data, { maxIssues: 30 })
  if (result.warnings.length > 0) {
    for (const warning of result.warnings) process.stderr.write(`提示：${warning}\n`)
  }
  if (result.ok) {
    process.stdout.write(`数据符合契约：${dataPath}\n`)
    return
  }
  process.stderr.write(`数据不符合契约：${dataPath}\n`)
  for (const line of formatIssues(result.issues, 20)) process.stderr.write(`${line}\n`)
  process.exit(1)
}

/** `render` 子命令。 */
async function commandRender(
  target: string,
  reportPath: string,
  outDir: string | undefined,
  wantsPdf: boolean,
): Promise<void> {
  const { schema } = await loadSchemaTarget(target)
  const parsed = await readJson(reportPath)
  const doc: ReportDoc = isReportDoc(parsed) ? parsed : { data: parsed as Record<string, unknown> }

  const dataCheck = check(schema, doc.data, { maxIssues: 30 })
  if (!dataCheck.ok) {
    process.stderr.write('数据不符合契约，未渲染：\n')
    for (const line of formatIssues(dataCheck.issues, 20)) process.stderr.write(`${line}\n`)
    process.exit(1)
  }

  const plan = buildPlan(schema, doc, { folder: extname(target) === '.json' ? dirname(target) : target })
  const theme = resolveTheme(doc.theme)
  const html = renderHtml(plan, theme)
  const folder = outDir ?? dirname(reportPath)
  const base = basename(reportPath, extname(reportPath))
  const outPath = join(folder, `${base}.html`)
  await mkdir(folder, { recursive: true })
  await writeFile(outPath, html, 'utf8')

  process.stdout.write(`渲染完成：${outPath}\n`)
  process.stdout.write(`  ${String(plan.sections.length)} 个分区 · ${String(countBlocks(plan))} 个块 · ${String(Buffer.byteLength(html, 'utf8'))} 字节\n`)
  for (const warning of plan.warnings) process.stdout.write(`  警告：${warning}\n`)
  for (const warning of dataCheck.warnings) process.stdout.write(`  提示：${warning}\n`)

  if (!wantsPdf) return
  // 打印用展开态：PDF 是归档件，折叠会把长表整段丢掉。
  const printDir = await mkdtemp(join(tmpdir(), 'atan-print-'))
  const printPath = join(printDir, `${base}.print.html`)
  const pdfPath = join(folder, `${base}.pdf`)
  try {
    await writeFile(printPath, renderHtml(plan, theme, { expandDetails: true }), 'utf8')
    const pdf = await renderPdf(printPath, pdfPath)
    if (pdf.ok) {
      process.stdout.write(`PDF 完成：${pdf.path}（${String(Math.round(pdf.bytes / 1024))} KB）\n`)
      return
    }
    process.stderr.write(`PDF 未生成（${pdf.code}）：${pdf.message}\n`)
    // PDF 失败不算整体失败：HTML 已经写好了。
  } finally {
    await rm(printDir, { recursive: true, force: true })
  }
}

/** 数一数计划里有多少块，用于渲染后的摘要输出。 */
function countBlocks(plan: ReturnType<typeof buildPlan>): number {
  return plan.sections.reduce((total, section) => total + section.blocks.length, 0)
}

/** 入口。 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const command = argv[0]
  if (command === undefined || command === '--help' || command === '-h') usage(command === undefined ? 1 : 0)

  if (command === 'explain') {
    const target = argv[1]
    if (target === undefined) usage(1)
    await commandExplain(target)
    return
  }
  if (command === 'check') {
    const [target, dataPath] = [argv[1], argv[2]]
    if (target === undefined || dataPath === undefined) usage(1)
    await commandCheck(target, dataPath)
    return
  }
  if (command === 'render') {
    const [target, reportPath] = [argv[1], argv[2]]
    if (target === undefined || reportPath === undefined) usage(1)
    const outIndex = argv.indexOf('--out')
    const outDir = outIndex === -1 ? undefined : argv[outIndex + 1]
    await commandRender(target, reportPath, outDir, argv.includes('--pdf'))
    return
  }
  usage(1)
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
