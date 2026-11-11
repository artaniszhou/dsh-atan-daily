/**
 * 展示修改工具：单草稿 patch / status / takeover / commit / discard。
 *
 * 草稿落盘在 `.meta/display/draft.json`；commit 才写 `.share/task-display.json`
 * 与 `.share/task-schema.json`，成功后删除草稿与预览。
 */

import { writeFile } from 'node:fs/promises'
import { defineTool } from './define.js'
import type {
  DisplayChange,
  DisplaySchemaEdit,
  DisplaySpec,
  DisplayVerdict,
  TaskRecord,
} from '../../protocol.js'
import type { TaskRepository } from '../repository.js'
import { buildDirOf } from '../../core/documents.js'
import { listRunRecords } from '../../core/runs.js'
import { loadContract, writeContract } from '../../report/contract.js'
import { changesBetween } from '../../report/display/diff.js'
import {
  deleteDraft,
  draftPreviewDir,
  ensurePreviewDir,
  hashText,
  previewFile,
  previewHtmlFile,
  readDraft,
  writeDraft,
} from '../../report/display/draft.js'
import type { DraftBase, DraftHistoryEntry, DraftState } from '../../report/display/draft.js'
import { mergeDisplay, parseDisplay, pruneDisplay } from '../../report/display/spec.js'
import { resolveTheme } from '../../report/theme.js'
import { readDisplay, writeDisplay } from '../../report/display/store.js'
import { renderPng } from '../../report/render/png.js'
import { renderPreview, renderRunReport } from '../../report/render/run.js'
import { proposeSchemaEdit } from '../../report/schema/propose.js'
import { SERIES_TYPES } from '../../report/series.js'
import type { SeriesType } from '../../report/series.js'
import type { ToolContext, ToolDeps } from './types.js'

/** 文本结果。 */
function text(value: string): Array<Record<string, unknown>> {
  return [{ type: 'text', text: value }]
}

/** 成功。 */
function ok(data: Record<string, unknown>): string {
  return JSON.stringify({ ok: true, ...data }, null, 2)
}

/** 预期失败。 */
function fail(code: string, message: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ok: false, code, error: message, ...extra }, null, 2)
}

/** 解析 JSON 参数。 */
function parseJson(value: string | undefined, what: string): unknown {
  if (value === undefined || value.trim() === '') return undefined
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new Error(`${what} 不是合法 JSON`)
  }
}

/** 找任务。 */
async function resolveTask(repo: TaskRepository, key: string): Promise<TaskRecord | undefined> {
  const direct = await repo.read(key)
  if (direct !== undefined) return direct
  const tasks = await repo.list()
  return tasks.find(task => task.name === key || task.folder.endsWith(key))
}

/** 最近一轮。 */
async function latestRun(folder: string): Promise<{ runId: string, report: string } | undefined> {
  const runs = await listRunRecords(folder, { limit: 1 })
  const run = runs[0]
  if (run === undefined || run.report === null) return undefined
  return { runId: run.runId, report: run.report }
}

/** 报告基名。 */
function baseOf(report: string): string {
  return report.replace(/\.(png|pdf)$/u, '')
}

/** 当前基线。 */
async function currentBase(folder: string): Promise<DraftBase> {
  const [contract, display] = await Promise.all([loadContract(folder), readDisplay(folder)])
  return {
    ...contract.ok ? { schemaRevision: contract.contract.revision } : {},
    schemaHash: contract.ok ? contract.contract.hash : 'missing',
    displayHash: display.raw === undefined ? hashText('') : hashText(display.raw),
  }
}

/** 判断基线是否变化。 */
function baseChanged(a: DraftBase, b: DraftBase): boolean {
  return a.schemaHash !== b.schemaHash || a.displayHash !== b.displayHash
}

/** 合并图型改动。 */
function mergeEdits(base: DisplaySchemaEdit[], incoming: DisplaySchemaEdit[]): DisplaySchemaEdit[] {
  const map = new Map(base.map(item => [item.key, item]))
  for (const item of incoming) map.set(item.key, item)
  return [...map.values()]
}

/** 预演图型改动。 */
function buildSchema(
  schema: Record<string, unknown>,
  edits: DisplaySchemaEdit[],
): { schema?: Record<string, unknown>, verdicts: DisplayVerdict[] } {
  let current = schema
  const verdicts: DisplayVerdict[] = []
  for (const edit of edits) {
    if (!SERIES_TYPES.includes(edit.type as SeriesType)) {
      verdicts.push({ key: edit.key, verdict: 'blocked', findings: [`不支持的图型：${edit.type}`], error: '图型不存在' })
      continue
    }
    const proposal = proposeSchemaEdit(current, edit)
    verdicts.push({
      key: edit.key,
      ...proposal.target?.title === undefined ? {} : { title: proposal.target.title },
      verdict: proposal.verdict,
      findings: proposal.findings,
      ...proposal.error === undefined ? {} : { error: proposal.error },
    })
    if (proposal.ok && proposal.schema !== undefined) current = proposal.schema
  }
  return { schema: current, verdicts }
}

/**
 * 写预览：HTML 是主通道（右侧栏文档预览直接打开），PNG 仅作回退。
 * @returns HTML 路径必定带回（只要渲染成功），PNG 路径可能缺省。
 */
async function writePreview(
  folder: string,
  buildDir: string,
  schema: Record<string, unknown>,
  display: DisplaySpec,
  revision: number,
): Promise<{ path?: string, htmlPath?: string, warnings: string[], error?: string }> {
  const preview = await renderPreview({ folder, buildDir, schema, display })
  if (!preview.ok || preview.html === undefined) {
    return { warnings: preview.warnings, ...preview.error === undefined ? {} : { error: preview.error } }
  }
  await ensurePreviewDir(folder)
  const htmlPath = previewHtmlFile(folder, revision)
  const pngPath = previewFile(folder, revision)
  await writeFile(htmlPath, preview.html, 'utf8')
  const png = await renderPng(htmlPath, pngPath)
  if (!png.ok) return { htmlPath, warnings: [...preview.warnings, `预览图未生成：${png.message}`] }
  return { path: pngPath, htmlPath, warnings: preview.warnings }
}

/**
 * 预览文件的聊天内链接：绝对路径、正斜杠、尖括号包裹。
 *
 * 聊天里的文件链接点击后由侧栏按扩展名选预览器，`.html` 走文档预览；
 * 路径里的中文与空格用 `<>` 保护，避免被 Markdown 当成链接语法拆开。
 * @param path - 预览文件绝对路径。
 * @param label - 链接文字。
 * @returns 可直接粘贴进回复的 Markdown 链接。
 */
function previewLink(path: string, label: string): string {
  return `[${label}](<${path.replaceAll('\\', '/')}>)`
}

/** 注册修改工具。 */
export function registerTuneTools(ctx: ToolContext, deps: ToolDeps): void {
  ctx.tools.register(defineTool({
    name: 'atan_daily_report_tune',
    description: '修改报告展示或图型：patch 写入唯一草稿并返回改动后 HTML 预览的路径与聊天链接（用户在右侧栏打开看效果），以及变更清单；用户确认后 commit 写 task-display.json 与 task-schema.json；discard 放弃。',
    parameters: {
      task: { type: 'string', required: true, description: '任务 id 或任务名称' },
      action: { type: 'string', required: true, enum: ['patch', 'status', 'takeover', 'commit', 'discard'], description: '操作' },
      patch: { type: 'string', description: 'patch 时必填：JSON，{ display?, schemaEdits? }' },
      instruction: { type: 'string', description: '用户原话，写入草稿历史' },
      confirm: { type: 'boolean', description: 'commit 时必须为 true' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: string) => text(value),
    },
    async execute(args: {
      task: string
      action: 'patch' | 'status' | 'takeover' | 'commit' | 'discard'
      patch?: string
      instruction?: string
      confirm?: boolean
    }, exec: { agent?: { session?: { id?: string } } }) {
      const task = await resolveTask(deps.repository, args.task)
      if (task === undefined) return fail('not_found', `找不到任务：${args.task}`)
      const sessionId = exec.agent?.session?.id ?? 'unknown-session'

      if (args.action === 'status') {
        const state = await readDraft(task.folder)
        if (state.draft === undefined) return ok({ draft: null, error: state.error ?? null })
        const revision = state.draft.history.length
        const htmlPath = previewHtmlFile(task.folder, revision)
        return ok({
          draft: summaryOf(state.draft),
          preview: previewFile(task.folder, revision),
          previewHtmlPath: htmlPath,
          previewHtmlLink: previewLink(htmlPath, `报告预览 rev${String(revision)}`),
        })
      }

      if (args.action === 'discard') {
        await deleteDraft(task.folder)
        return ok({ discarded: true })
      }

      if (args.action === 'takeover') {
        const state = await readDraft(task.folder)
        if (state.draft === undefined) return fail('no_draft', '没有可接管的草稿')
        const draft = { ...state.draft, ownerSessionId: sessionId, updatedAt: new Date().toISOString() }
        await writeDraft(task.folder, draft)
        return ok({ draft: summaryOf(draft) })
      }

      if (args.action === 'commit') {
        if (args.confirm !== true) return fail('need_confirm', 'commit 需要 confirm: true')
        return await commit(task, sessionId)
      }

      return await patch(task, sessionId, args.patch, args.instruction)
    },
  }))

  /** 草稿摘要。 */
  function summaryOf(draft: DraftState): Record<string, unknown> {
    return {
      draftId: draft.draftId,
      ownerSessionId: draft.ownerSessionId,
      base: draft.base,
      display: draft.display,
      schemaEdits: draft.schemaEdits,
      changes: draft.display === undefined ? [] : changesBetween(undefined, draft.display),
      updatedAt: draft.updatedAt,
    }
  }

  /** patch。 */
  async function patch(
    task: TaskRecord,
    sessionId: string,
    rawPatch: string | undefined,
    instruction: string | undefined,
  ): Promise<string> {
    if (rawPatch === undefined) return fail('invalid_input', 'patch 需要 patch JSON')
    const state = await readDraft(task.folder)
    if (state.error !== undefined) return fail('invalid_draft', state.error)
    if (state.draft !== undefined && state.draft.ownerSessionId !== sessionId) {
      return fail('draft_busy', '已有其它会话的草稿，先 takeover 或 discard', {
        ownerSessionId: state.draft.ownerSessionId,
        updatedAt: state.draft.updatedAt,
      })
    }
    const run = await latestRun(task.folder)
    if (run === undefined) return fail('no_run', '还没有可预览的报告，先运行一次任务')
    const contract = await loadContract(task.folder)
    if (!contract.ok) return fail('invalid_contract', contract.message)

    const input = parseJson(rawPatch, 'patch')
    if (typeof input !== 'object' || input === null) return fail('invalid_input', 'patch 必须是对象')
    const record = input as Record<string, unknown>
    const displayInput = record['display'] ?? record
    const parsed = parseDisplay(JSON.stringify(displayInput))
    if (!parsed.ok) return fail('invalid_patch', parsed.warnings.join('；') || '展示补丁不合法')
    const editsInput = Array.isArray(record['schemaEdits']) ? record['schemaEdits'] : []
    const edits: DisplaySchemaEdit[] = editsInput
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map(item => ({
        key: typeof item['key'] === 'string' ? item['key'] : '',
        type: typeof item['type'] === 'string' ? item['type'] : '',
        ...typeof item['bind'] === 'object' && item['bind'] !== null ? { bind: item['bind'] as DisplaySchemaEdit['bind'] } : {},
      }))
      .filter(item => item.key !== '' && item.type !== '')
    if (edits.length !== editsInput.length) return fail('invalid_patch', 'schemaEdits 需要 { key, type }')

    const base = state.draft?.base ?? await currentBase(task.folder)
    const currentDisplay = state.draft === undefined ? await readDisplay(task.folder) : undefined
    const previous = state.draft?.display ?? currentDisplay?.spec ?? { version: 1 }
    const display = mergeDisplay(previous, parsed.spec)
    const schemaEdits = mergeEdits(state.draft?.schemaEdits ?? [], edits)
    const built = buildSchema(contract.contract.schema, schemaEdits)
    const changes = changesBetween(previous, display)
    if (changes.length === 0 && edits.length === 0) {
      return fail('no_changes', '这次 patch 没有产生改动')
    }

    const now = new Date().toISOString()
    const history: DraftHistoryEntry[] = [
      ...state.draft?.history ?? [],
      {
        at: now,
        ...instruction === undefined ? {} : { instruction },
        patch: parsed.spec,
        changes,
      },
    ]
    const revision = history.length
    const draft: DraftState = {
      version: 1,
      draftId: state.draft?.draftId ?? `draft-${now.replaceAll(/[-:.TZ]/gu, '')}`,
      taskId: task.taskId,
      ownerSessionId: sessionId,
      base,
      display,
      schemaEdits,
      verdicts: built.verdicts,
      history,
      status: 'open',
      createdAt: state.draft?.createdAt ?? now,
      updatedAt: now,
    }
    await writeDraft(task.folder, draft)
    const preview = await writePreview(
      task.folder,
      buildDirOf(task.folder, run.runId),
      built.schema ?? contract.contract.schema,
      display,
      revision,
    )
    return ok({
      draftId: draft.draftId,
      revision,
      changes,
      verdicts: built.verdicts,
      previewPath: preview.path ?? null,
      previewHtmlPath: preview.htmlPath ?? null,
      previewHtmlLink: preview.htmlPath === undefined ? null : previewLink(preview.htmlPath, `报告预览 rev${String(revision)}`),
      warnings: preview.warnings,
      ...preview.error === undefined ? {} : { previewError: preview.error },
    })
  }

  /** commit。 */
  async function commit(task: TaskRecord, sessionId: string): Promise<string> {
    const state = await readDraft(task.folder)
    if (state.draft === undefined) return fail('no_draft', state.error ?? '没有草稿')
    const draft = state.draft
    if (draft.ownerSessionId !== sessionId) {
      return fail('draft_busy', '草稿属于其它会话，先 takeover', { ownerSessionId: draft.ownerSessionId })
    }
    const base = await currentBase(task.folder)
    if (baseChanged(base, draft.base)) {
      return fail('stale', '草稿期间契约或展示已变化，请重新 patch/预览', { base: draft.base, current: base })
    }
    const contract = await loadContract(task.folder)
    if (!contract.ok) return fail('invalid_contract', contract.message)
    const built = buildSchema(contract.contract.schema, draft.schemaEdits)
    const blocked = built.verdicts.filter(item => item.verdict === 'needs_data' || item.verdict === 'blocked')
    if (blocked.length > 0) {
      return fail('schema_blocked', '图型改动未通过校验，先调整或 discard', { verdicts: built.verdicts })
    }

    const baseThemeName = draft.display.theme
      ?? (typeof contract.contract.schema['x-theme'] === 'string' ? contract.contract.schema['x-theme'] as string : undefined)
    const pruned = pruneDisplay(draft.display, resolveTheme(baseThemeName))
    await writeDisplay(task.folder, pruned)
    let revision: number | undefined
    if (draft.schemaEdits.length > 0 && built.schema !== undefined) {
      const written = await writeContract(task.folder, `${JSON.stringify(built.schema, null, 2)}\n`)
      revision = written.revision
    }
    const run = await latestRun(task.folder)
    if (run === undefined) return fail('no_run', '没有可重渲染的报告')
    const result = await renderRunReport({
      folder: task.folder,
      base: baseOf(run.report),
      buildDir: buildDirOf(task.folder, run.runId),
      format: task.outputFormat,
    })
    if (!result.ok) return fail('render_failed', result.error ?? '重渲染失败', { warnings: result.warnings })
    await deleteDraft(task.folder)
    return ok({
      files: result.files,
      warnings: result.warnings,
      schemaRevision: revision ?? null,
      changes: changesBetween(undefined, pruned ?? { version: 1 }),
    })
  }
}
