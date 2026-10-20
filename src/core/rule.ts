/**
 * Task content: the human/agent-facing rule document.
 *
 * `meta/rule.md` describes what to do, and it also owns the cache and script
 * manifests. It deliberately contains no task metadata (schedule, timezone,
 * enabled, session, last-run summary). Those live in `task-list.jsonl`, which
 * is the single authority for metadata.
 *
 * The document is rendered from `template/rule-template.md`: the task details
 * replace `{{DETAILS}}`, and the two manifests replace their markers. Keeping
 * the execution requirements in the template means every task starts from the
 * same rule, and the agent executing a run never has to load a separate skill.
 */

import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeAtomic } from './fs.js'

/** The placeholder shown when a task was created without details. */
export const EMPTY_DETAIL = '_创建时未填写任务细节，执行前请先补充。_'

/** The cache manifest's section heading. */
export const CACHE_HEADING = '## 缓存清单'
/** The script manifest's section heading. */
export const SCRIPT_HEADING = '## 脚本清单'
/** The section the manifests are inserted before. */
const EXECUTION_HEADING = '## 执行规则'

/** Which manifest a section describes. */
type ManifestKind = 'cache' | 'script'

/**
 * The lines of one manifest section.
 * @param kind - cache or script.
 * @param rows - table rows, each a full `| ... |` line.
 * @returns the section's lines.
 */
function manifestLines(kind: ManifestKind, rows: readonly string[]): string[] {
  const cache = kind === 'cache'
  return [
    cache ? CACHE_HEADING : SCRIPT_HEADING,
    '',
    cache
      ? '记录 `meta/cache/` 下每份文档保存了什么、什么时候可以用到它。'
      : '记录 `meta/script/` 下每个脚本做什么、什么时候可以用到它。优先使用 Python 脚本。',
    '',
    cache ? '| 文件名 | 存储内容 | 可用场景 |' : '| 脚本名 | 功能 | 可用场景 |',
    '|---|---|---|',
    ...rows,
  ]
}

/**
 * Render one manifest section.
 * @param kind - cache or script.
 * @param rows - table rows.
 * @returns the section, ending with a newline.
 */
export function renderManifestSection(kind: ManifestKind, rows: readonly string[] = []): string {
  return `${manifestLines(kind, rows).join('\n')}\n`
}

/** 模板随插件发布；core 位于 `lib/core/`，所以模板在上一层目录的 `template/`。 */
const TEMPLATE_URL: URL = new URL('../../template/rule-template.md', import.meta.url)
/** Placeholder replaced by the task details. */
const DETAILS_MARKER = '{{DETAILS}}'
/** Placeholder replaced by the cache manifest section. */
const CACHE_MARKER = '{{CACHE_SECTION}}'
/** Placeholder replaced by the script manifest section. */
const SCRIPT_MARKER = '{{SCRIPT_SECTION}}'

/** The template text, read once; editing it requires a Host restart. */
let templateText: string | undefined

/**
 * Resolve the bundled template for both file-based Host and Vite/Vitest SSR.
 * @returns the absolute template path.
 */
function templatePath(): string {
  if (TEMPLATE_URL.protocol === 'file:') return fileURLToPath(TEMPLATE_URL)
  return resolve(process.cwd(), 'template/rule-template.md')
}

/**
 * Read the bundled rule template.
 * @returns the template text, with every marker verified present.
 */
function ruleTemplate(): string {
  if (templateText === undefined) {
    const path = templatePath()
    const text = readFileSync(path, 'utf8')
    for (const marker of [DETAILS_MARKER, CACHE_MARKER, SCRIPT_MARKER]) {
      if (!text.includes(marker)) throw new Error(`rule template ${path} is missing ${marker}`)
    }
    templateText = text
  }
  return templateText
}

/**
 * Render the task's rule document from the template and the task details.
 *
 * The details are substituted as a value (never as a replacement pattern), so
 * a `$` inside the details is kept literally.
 * @param details - task details.
 * @param cacheRows - rows for the cache manifest.
 * @param scriptRows - rows for the script manifest.
 * @returns the complete document.
 */
export function renderRuleContent(
  details: string,
  cacheRows: readonly string[] = [],
  scriptRows: readonly string[] = [],
): string {
  const sections: Record<string, string> = {
    [DETAILS_MARKER]: normalizeDetail(details),
    [CACHE_MARKER]: renderManifestSection('cache', cacheRows).trimEnd(),
    [SCRIPT_MARKER]: renderManifestSection('script', scriptRows).trimEnd(),
  }
  // One pass over the template only: markers that appear inside the user's
  // details are inserted as text and must never be expanded a second time.
  const rendered = ruleTemplate().replace(/\{\{(?:DETAILS|CACHE_SECTION|SCRIPT_SECTION)\}\}/gu, marker => sections[marker] ?? marker)
  return `${rendered.trimEnd()}\n`
}

/**
 * Read the table rows of one manifest section.
 * @param text - the rule document.
 * @param heading - the section heading.
 * @returns the rows, without the header and separator.
 */
export function parseManifestRows(text: string, heading: string): string[] {
  const start = text.search(new RegExp(`^${escapeRegExp(heading)}$`, 'mu'))
  if (start < 0) return []
  const rest = text.slice(start + heading.length)
  const next = rest.search(/^## /mu)
  const body = next < 0 ? rest : rest.slice(0, next)
  const table = body.split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => line.startsWith('|') && !/^\|[\s:|-]+\|$/u.test(line))
  return table.slice(1)
}

/**
 * Add rows to a manifest section, inserting the section when it is missing.
 * @param text - the rule document.
 * @param kind - cache or script.
 * @param rows - rows to add.
 * @returns the updated document.
 */
export function upsertManifestSection(
  text: string,
  kind: ManifestKind,
  rows: readonly string[],
): string {
  const heading = kind === 'cache' ? CACHE_HEADING : SCRIPT_HEADING
  const start = text.search(new RegExp(`^${escapeRegExp(heading)}$`, 'mu'))
  const merged = [...parseManifestRows(text, heading)]
  for (const row of rows) {
    if (!merged.includes(row)) merged.push(row)
  }
  const section = renderManifestSection(kind, merged)
  if (start < 0) {
    const anchor = text.search(/^## 执行规则$/mu)
    if (anchor >= 0) return `${text.slice(0, anchor)}${section}\n${text.slice(anchor)}`
    return `${text.trimEnd()}\n\n${section}`
  }
  const after = text.slice(start + heading.length)
  const next = after.search(/^## /mu)
  const end = next < 0 ? text.length : start + heading.length + next
  return `${text.slice(0, start)}${section}\n${text.slice(end).replace(/^\n+/u, '')}`
}

/**
 * Normalize a free-form detail for placement inside the rule document.
 * @param details - the raw task detail.
 * @returns the detail as it should appear inside the rule.
 */
function normalizeDetail(details: string): string {
  const text = details.trim()
  if (text === '') return EMPTY_DETAIL
  return text.replace(/^(#{1,5})(\s)/gmu, (_match, hashes: string, space: string) => `${hashes}#${space}`)
}

/**
 * Escape a literal string for use in a regular expression.
 * @param value - the literal.
 * @returns the escaped source.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * Split a document into front-matter fields and body.
 * @param text - the document text.
 * @returns the parsed fields and the body.
 */
function readFrontMatter(text: string): { fields: Record<string, string>, body: string } {
  const lines = text.split(/\r?\n/u)
  const fields: Record<string, string> = {}
  let bodyStart = 0
  if (lines[0]?.trim() === '---') {
    for (let index = 1; index < lines.length; index += 1) {
      const line = lines[index] ?? ''
      if (line.trim() === '---') {
        bodyStart = index + 1
        break
      }
      const colon = line.indexOf(':')
      if (colon > 0) {
        const key = line.slice(0, colon).trim()
        if (key !== '') fields[key] = unquote(line.slice(colon + 1))
      }
    }
  }
  return { fields, body: lines.slice(bodyStart).join('\n') }
}

/**
 * Read one front-matter scalar.
 * @param raw - the text after `key:`.
 * @returns the decoded value.
 */
function unquote(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (typeof parsed === 'string') return parsed
    } catch {
      // A hand-edited malformed value falls through to the literal text.
    }
  }
  return trimmed
}

/**
 * Extract the `## 任务细节` section.
 * @param body - the Markdown body (front matter removed).
 * @returns the detail text.
 */
function detailsOf(body: string): string {
  const heading = body.match(/^## 任务细节[^\n]*$/mu)
  if (heading?.index === undefined) return ''
  const rest = body.slice(heading.index + heading[0].length)
  const next = rest.search(/^## /mu)
  return (next < 0 ? rest : rest.slice(0, next)).trim()
    .replace(/^(#{2,6})(\s)/gmu, (_match, hashes: string, space: string) => `${hashes.slice(1)}${space}`)
}

/**
 * Read the task details out of a content-only rule.
 * @param text - the rule document.
 * @returns the details, without the placeholder.
 */
export function parseRuleContent(text: string): string {
  const { body } = readFrontMatter(text)
  const detail = detailsOf(body)
  return detail === EMPTY_DETAIL ? '' : detail
}

/**
 * Read a task's rule content from disk.
 * @param folder - absolute task directory.
 * @returns the details, or an empty string when the file is missing.
 */
export async function readRuleContent(folder: string): Promise<string> {
  try {
    return parseRuleContent(await readFile(join(folder, 'meta', 'rule.md'), 'utf8'))
  } catch {
    return ''
  }
}

/**
 * Write a content-only rule for one task, rendered from the bundled template.
 * @param folder - absolute task directory.
 * @param details - task details.
 * @param cacheRows - rows for the cache manifest.
 * @param scriptRows - rows for the script manifest.
 */
export async function writeRuleContent(
  folder: string,
  details: string,
  cacheRows: readonly string[] = [],
  scriptRows: readonly string[] = [],
): Promise<void> {
  await writeAtomic(join(folder, 'meta', 'rule.md'), renderRuleContent(details, cacheRows, scriptRows))
}

/** Metadata recovered from a pre-v2 rule document. */
export interface LegacyRule {
  /** Whether the document had a front-matter block. */
  hasMetadata: boolean
  name?: string
  createdAt?: string
  cron?: string
  scheduleText?: string
  timeZone?: string
  enabled?: boolean
  sessionId?: string
  lastRunAt?: string
  lastStatus?: string
  lastDurationMs?: number
  lastRunId?: string
  lastError?: string
  details: string
}

/**
 * Parse the old rule format, including its front matter.
 *
 * Only the one-time migration uses this; runtime reads metadata from
 * `task-list.jsonl`.
 * @param text - the old rule document.
 * @param folderName - the task folder name, used as a name fallback.
 * @param createdAt - folder birth time, used when the rule has no createdAt.
 * @returns the recovered fields and details.
 */
export function parseLegacyRule(text: string, folderName: string, createdAt: string): LegacyRule {
  const { fields, body } = readFrontMatter(text)
  const duration = Number(fields['lastDurationMs'])
  const scheduleText = fields['schedule']?.trim()
  const cron = fields['cron']?.trim()
  const timeZone = fields['timeZone']?.trim()
  return {
    hasMetadata: text.trimStart().startsWith('---'),
    name: fields['name'] ?? folderName,
    createdAt: fields['createdAt'] ?? createdAt,
    ...cron === undefined || cron === '' ? {} : { cron },
    ...scheduleText === undefined || scheduleText === '' ? {} : { scheduleText },
    ...timeZone === undefined || timeZone === '' ? {} : { timeZone },
    enabled: fields['enabled'] !== 'false',
    ...fields['sessionId'] === undefined || fields['sessionId'] === '' ? {} : { sessionId: fields['sessionId'] },
    ...fields['lastRunAt'] === undefined || fields['lastRunAt'] === '' ? {} : { lastRunAt: fields['lastRunAt'] },
    ...fields['lastStatus'] === undefined || fields['lastStatus'] === '' ? {} : { lastStatus: fields['lastStatus'] },
    ...Number.isFinite(duration) && duration >= 0 ? { lastDurationMs: duration } : {},
    ...fields['lastRunId'] === undefined || fields['lastRunId'] === '' ? {} : { lastRunId: fields['lastRunId'] },
    ...fields['lastError'] === undefined || fields['lastError'] === '' ? {} : { lastError: fields['lastError'] },
    details: detailsOf(body),
  }
}
