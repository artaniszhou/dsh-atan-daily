/**
 * 任务包静态检查。
 *
 * 只做「形态」层面的确定性判断：路径、字符、体积、扩展名、危险 API。
 * 它不判断一个脚本「想做什么」，恶意性由管理端人工审核，这里只负责
 * 把明显不该传的东西挡在进入人工队列之前。
 *
 * 纯函数，不碰文件系统，规则可回归。
 */

import { checkSharePath } from './share.js'

/** 问题级别。 */
export type ScanSeverity = 'block' | 'warn' | 'info'

/** 待检查的一份文件。 */
export interface ScanFile {
  /** 相对任务目录的路径。 */
  path: string
  /** UTF-8 文本内容。 */
  content: string
}

/** 一条检查结果。 */
export interface ScanFinding {
  /** 机器可读的规则名。 */
  code: string
  severity: ScanSeverity
  /** 相对路径；体积/数量类问题为空串。 */
  path: string
  message: string
  /** 1 起的行号；字符类问题才有。 */
  line?: number
  /** 原文片段，最长 120 字符。 */
  evidence?: string
}

/** 检查结果汇总。 */
export interface ScanResult {
  ok: boolean
  block: number
  warn: number
  info: number
  totalBytes: number
  findings: ScanFinding[]
}

/** 包里文件数与体积上限。 */
export interface ScanLimits {
  maxFiles: number
  maxFileBytes: number
  maxTotalBytes: number
}

/** 默认上限；与文档 §6.3 一致。 */
export const SCAN_LIMITS: ScanLimits = {
  maxFiles: 50,
  maxFileBytes: 512 * 1024,
  maxTotalBytes: 2 * 1024 * 1024,
}

/** 文本里的密钥形态。 */
const SECRET_RULES: readonly { code: string, pattern: RegExp, message: string }[] = [
  { code: 'secret_openai', pattern: /\bsk-[A-Za-z0-9]{20,}\b/u, message: '疑似模型 API Key（sk-…）' },
  { code: 'secret_aws', pattern: /\bAKIA[0-9A-Z]{16}\b/u, message: '疑似 AWS Access Key' },
  { code: 'secret_github', pattern: /\bghp_[A-Za-z0-9]{20,}\b/u, message: '疑似 GitHub Token' },
  { code: 'secret_private_key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u, message: '疑似私钥' },
  { code: 'secret_jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./u, message: '疑似 JWT' },
]

/** 图形脚本里出现即拒绝的能力。 */
const CHART_BLOCK_RULES: readonly { code: string, pattern: RegExp, message: string }[] = [
  { code: 'chart_fs', pattern: /node:fs|\brequire\s*\(\s*['"]fs['"]/u, message: '图形脚本不允许访问文件系统' },
  { code: 'chart_process', pattern: /node:child_process|node:worker_threads|child_process/u, message: '图形脚本不允许起子进程或线程' },
  { code: 'chart_net', pattern: /node:net|node:http|node:https|node:dns|node:tls/u, message: '图形脚本不允许网络能力' },
  { code: 'chart_require', pattern: /\brequire\s*\(/u, message: '图形脚本不允许 require' },
  { code: 'chart_import', pattern: /\bimport\s*\(|\bfrom\s+['"]/u, message: '图形脚本必须单文件，不允许 import' },
  { code: 'chart_eval', pattern: /\beval\s*\(|new\s+Function\s*\(|\bFunction\s*\(/u, message: '图形脚本不允许动态执行代码' },
  { code: 'chart_builtin', pattern: /\bgetBuiltinModule\b|\b\.constructor\b/u, message: '图形脚本不允许取运行时内置模块或函数构造器' },
  { code: 'chart_fs_api', pattern: /\breadFileSync\b|\bwriteFileSync\b|\bopenSync\b/u, message: '图形脚本不允许直接调用文件 API' },
  { code: 'chart_wasm', pattern: /\bWebAssembly\b/u, message: '图形脚本不允许 WebAssembly' },
  { code: 'chart_global', pattern: /\bglobalThis\b|\bprocess\s*\.|\bBuffer\s*[.(]/u, message: '图形脚本不允许触碰进程或全局对象' },
  { code: 'chart_runtime', pattern: /\bDeno\s*\.|\bBun\s*\./u, message: '图形脚本不允许使用运行时私有 API' },
  { code: 'chart_fetch', pattern: /\bfetch\s*\(|\bXMLHttpRequest\b|\bhttps?:\/\/(?!www\.w3\.org\/2000\/svg)/u, message: '图形脚本不允许联网或引用外部地址' },
]

/** 提示词注入或越权指令的常见措辞。 */
const INJECTION_RULES: readonly { code: string, pattern: RegExp, message: string }[] = [
  { code: 'injection_ignore', pattern: /ignore\s+(?:all\s+)?(?:the\s+)?previous\s+instructions/iu, message: '疑似提示词注入：要求忽略既有指令' },
  { code: 'injection_zh', pattern: /忽略(?:上述|以上|之前|前面)[^\n]{0,12}(?:指令|要求|规则|提示)/u, message: '疑似提示词注入：要求忽略既有指令' },
  { code: 'injection_role', pattern: /你现在是|从现在起你是|system\s*prompt|系统提示词/iu, message: '疑似提示词注入：改写角色或系统提示' },
  { code: 'injection_html', pattern: /<script\b|javascript\s*:/iu, message: '疑似脚本注入片段' },
]

/** 破坏性命令或敏感路径。 */
const RISK_RULES: readonly { code: string, pattern: RegExp, message: string }[] = [
  { code: 'risk_rm', pattern: /rm\s+-rf\s+\/(?:\s|$)/u, message: '破坏性命令：rm -rf /' },
  { code: 'risk_pipe_shell', pattern: /(?:curl|wget)[^\n|]{0,80}\|\s*(?:ba)?sh\b/u, message: '远程内容直接交给 shell 执行' },
  { code: 'risk_ssh', pattern: /~\/\.ssh|\.ssh\/id_[a-z]+|\/etc\/passwd/u, message: '引用敏感凭据或系统文件' },
]

/** 外部地址（仅提示）。 */
const URL_PATTERN = /\bhttps?:\/\/[^\s'"<>）)\]]+/gu

/** 双向控制符；可让代码显示方向与真实方向不一致。 */
const BIDI = new Set([0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069])

/** 零宽与不可见字符。 */
const INVISIBLE = new Set([0x200b, 0x200c, 0x200d, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064])

/** 判断是否图形脚本。 */
function isChart(path: string): boolean {
  return path.startsWith('.share/charts/')
}

/** 计算 0 起下标所在的行号。 */
function lineAt(content: string, index: number): number {
  let line = 1
  for (let i = 0; i < index; i += 1) {
    if (content.charCodeAt(i) === 10) line += 1
  }
  return line
}

/** 生成一段可读的原文片段。 */
function evidenceAt(content: string, index: number, length = 60): string {
  const lineEnd = content.indexOf('\n', index)
  const end = lineEnd === -1 ? content.length : lineEnd
  const text = content.slice(index, Math.min(end, index + length)).trim()
  return text.length <= 120 ? text : `${text.slice(0, 120)}…`
}

/** 追加一条匹配类问题（同一规则每份文件只报一次）。 */
function matchRules(
  findings: ScanFinding[],
  file: ScanFile,
  rules: readonly { code: string, pattern: RegExp, message: string }[],
  severity: ScanSeverity,
): void {
  for (const rule of rules) {
    const match = rule.pattern.exec(file.content)
    if (match === null) continue
    findings.push({
      code: rule.code,
      severity,
      path: file.path,
      message: rule.message,
      line: lineAt(file.content, match.index),
      evidence: evidenceAt(file.content, match.index),
    })
  }
}

/**
 * 扫描字符层面的问题：每份文件最多报一条阻断 + 一条提示。
 * @param findings - 结果收集数组。
 * @param file - 待检查文件。
 */
function scanCharacters(findings: ScanFinding[], file: ScanFile): void {
  let blocked: { cp: number, line: number, index: number } | undefined
  let warned: { cp: number, line: number, index: number } | undefined
  let line = 1
  let index = 0
  while (index < file.content.length) {
    const cp = file.content.codePointAt(index)
    if (cp === undefined) break
    if (cp === 10) {
      line += 1
      index += 1
      continue
    }
    const hard = cp === 0
      || (cp < 0x20 && cp !== 9 && cp !== 13)
      || (cp >= 0x7f && cp <= 0x9f)
      || cp === 0x2028
      || cp === 0x2029
      || BIDI.has(cp)
      || (cp >= 0xfdd0 && cp <= 0xfdef)
      || (cp & 0xfffe) === 0xfffe
    if (hard && blocked === undefined) blocked = { cp, line, index }
    const soft = INVISIBLE.has(cp)
      || cp === 0x00ad
      || (cp === 0xfeff && index > 0)
    if (soft && warned === undefined) warned = { cp, line, index }
    index += cp > 0xffff ? 2 : 1
  }
  if (blocked !== undefined) {
    findings.push({
      code: 'char_illegal',
      severity: 'block',
      path: file.path,
      message: `含非法字符 U+${blocked.cp.toString(16).toUpperCase().padStart(4, '0')}`,
      line: blocked.line,
      evidence: evidenceAt(file.content, blocked.index),
    })
  }
  if (warned !== undefined) {
    findings.push({
      code: 'char_invisible',
      severity: 'warn',
      path: file.path,
      message: `含不可见字符 U+${warned.cp.toString(16).toUpperCase().padStart(4, '0')}`,
      line: warned.line,
      evidence: evidenceAt(file.content, warned.index),
    })
  }
}

/** 按级别与路径排序，阻断项优先。 */
function sortFindings(findings: ScanFinding[]): void {
  const rank: Record<ScanSeverity, number> = { block: 0, warn: 1, info: 2 }
  findings.sort((a, b) => {
    const bySeverity = rank[a.severity] - rank[b.severity]
    if (bySeverity !== 0) return bySeverity
    if (a.path !== b.path) return a.path < b.path ? -1 : 1
    return (a.line ?? 0) - (b.line ?? 0)
  })
}

/**
 * 扫描一组随包文件。
 * @param files - 打包后的文件（已归一化、已排序）。
 * @param limits - 覆盖默认上限。
 * @returns 汇总结果。
 */
export function scanFiles(files: readonly ScanFile[], limits: Partial<ScanLimits> = {}): ScanResult {
  const effective: ScanLimits = { ...SCAN_LIMITS, ...limits }
  const findings: ScanFinding[] = []
  const seen = new Map<string, string>()
  let totalBytes = 0

  if (files.length > effective.maxFiles) {
    findings.push({
      code: 'limit_files',
      severity: 'block',
      path: '',
      message: `文件数超过上限 ${String(effective.maxFiles)}，当前 ${String(files.length)}`,
    })
  }

  for (const file of files) {
    const problem = checkSharePath(file.path)
    if (problem !== undefined) {
      findings.push({ code: problem.code, severity: 'block', path: file.path, message: problem.message })
      continue
    }
    const lower = file.path.toLowerCase()
    const previous = seen.get(lower)
    if (previous !== undefined) {
      findings.push({
        code: 'path_duplicate',
        severity: 'block',
        path: file.path,
        message: `与 ${previous} 仅大小写不同，跨平台会互相覆盖`,
      })
    } else {
      seen.set(lower, file.path)
    }

    const bytes = Buffer.byteLength(file.content, 'utf8')
    totalBytes += bytes
    if (bytes > effective.maxFileBytes) {
      findings.push({
        code: 'limit_file_bytes',
        severity: 'block',
        path: file.path,
        message: `单文件超过 ${String(Math.round(effective.maxFileBytes / 1024))}KB，当前 ${String(Math.round(bytes / 1024))}KB`,
      })
    }

    scanCharacters(findings, file)
    matchRules(findings, file, SECRET_RULES, isChart(file.path) ? 'block' : 'warn')
    if (isChart(file.path)) {
      matchRules(findings, file, CHART_BLOCK_RULES, 'block')
    } else {
      matchRules(findings, file, INJECTION_RULES, 'warn')
      matchRules(findings, file, RISK_RULES, 'warn')
    }
    for (const match of file.content.matchAll(URL_PATTERN)) {
      if (isChart(file.path)) break
      findings.push({
        code: 'external_url',
        severity: 'info',
        path: file.path,
        message: `引用了外部地址：${match[0].slice(0, 80)}`,
        line: lineAt(file.content, match.index ?? 0),
      })
      break
    }
  }

  if (totalBytes > effective.maxTotalBytes) {
    findings.push({
      code: 'limit_total_bytes',
      severity: 'block',
      path: '',
      message: `整包超过 ${String(Math.round(effective.maxTotalBytes / 1024))}KB，当前 ${String(Math.round(totalBytes / 1024))}KB`,
    })
  }

  sortFindings(findings)
  const count = (severity: ScanSeverity): number => findings.filter(item => item.severity === severity).length
  return {
    ok: count('block') === 0,
    block: count('block'),
    warn: count('warn'),
    info: count('info'),
    totalBytes,
    findings,
  }
}
