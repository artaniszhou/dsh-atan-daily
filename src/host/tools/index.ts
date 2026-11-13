/**
 * 插件内工具：生成流水线 + 清单 + 一次性脚本 + 草稿修改。
 *
 * 工具前缀统一 `atan_daily_`；全部在同进程执行，参数只允许本地任务目录，
 * 命令只来自 `task-pipeline.json` 或 `.meta/script/`。
 */

import { createHash, randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { defineTool } from './define.js'
import type { TaskRecord } from '../../protocol.js'
import type { TaskRepository } from '../repository.js'
import { buildDirOf, SHARE_DIR, TASK_DETAIL_NAME } from '../../core/documents.js'
import { listRunRecords } from '../../core/runs.js'
import { loadContract } from '../../report/contract.js'
import { readDisplay } from '../../report/display/store.js'
import { renderRunReport } from '../../report/render/run.js'
import { check, formatIssues } from '../../report/validate.js'
import type { TaskManifest } from '../manifest.js'
import {
  manifestFile,
  readManifest,
  validateManifest,
  writeManifest,
  writeManifestAndDropIndex,
} from '../manifest.js'
import { registerTuneTools } from './tune.js'
import type { ToolContext, ToolDeps } from './types.js'
import { PackError, buildTaskPackage, scanSummary, type BuildResult } from '../task-pack.js'

/** 命令执行结果。 */
interface CommandResult {
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
}

/** 截断长输出。 */
function clip(text: string, max = 8000): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…（截断 ${String(text.length - max)} 字）`
}

/**
 * 收集子进程输出，等它结束或超时。
 * @param child - 已启动的子进程。
 * @param timeoutMs - 超时毫秒。
 * @returns 退出码与输出。
 */
function collect(child: ChildProcess, timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: 1, stdout, stderr: `${stderr}\n${error.message}`, timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, stdout, stderr, timedOut })
    })
  })
}

/** 跑一条 shell 命令（只给 task-pipeline.json 里声明的 fetch/build 用）。 */
function runCommand(command: string, cwd: string, timeoutMs: number): Promise<CommandResult> {
  return collect(spawn(command, { cwd, shell: true, windowsHide: true }), timeoutMs)
}

/**
 * 跑一个可执行文件，参数按数组逐个传入，不经过 shell。
 * @param file - 可执行文件（`python` / `node`）。
 * @param argv - 参数数组；每个元素原样作为 argv 传给子进程。
 * @param cwd - 工作目录。
 * @param timeoutMs - 超时毫秒。
 * @returns 退出码与输出。
 */
function runFile(
  file: string,
  argv: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<CommandResult> {
  return collect(spawn(file, [...argv], { cwd, shell: false, windowsHide: true }), timeoutMs)
}

/** 渲染工具结果。 */
function text(value: string): Array<Record<string, unknown>> {
  return [{ type: 'text', text: value }]
}

/** 成功结果。 */
function ok(data: Record<string, unknown>): string {
  return JSON.stringify({ ok: true, ...data }, null, 2)
}

/** 预期失败。 */
function fail(code: string, message: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ok: false, code, error: message, ...extra }, null, 2)
}

/** 解析 JSON 字符串参数。 */
function parseJson(value: string | undefined, what: string): unknown {
  if (value === undefined || value.trim() === '') return undefined
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new Error(`${what} 不是合法 JSON`)
  }
}

/** 找任务：先按 id，再按名称/目录名。 */
async function resolveTask(repo: TaskRepository, key: string): Promise<TaskRecord | undefined> {
  const direct = await repo.read(key)
  if (direct !== undefined) return direct
  const tasks = await repo.list()
  return tasks.find(task => task.name === key || basename(task.folder) === key)
}

/** 明细 hash（与 skill 的规范化一致）。 */
async function detailHash(folder: string): Promise<string | undefined> {
  try {
    const raw = await readFile(join(folder, SHARE_DIR, TASK_DETAIL_NAME), 'utf8')
    const normalized = `${raw.replace(/^\uFEFF/u, '').replaceAll(/\r\n?/gu, '\n').trim()}\n`
    return `sha256:${createHash('sha256').update(normalized, 'utf8').digest('hex')}`
  } catch {
    return undefined
  }
}

/** 生成一个工具用的 runId。 */
function newRunId(): string {
  return `tool-${new Date().toISOString().replaceAll(/[-:.TZ]/gu, '')}-${randomUUID().slice(0, 8)}`
}

/** 准备 build 目录。 */
async function ensureBuildDir(folder: string, runId?: string): Promise<{ runId: string, buildDir: string }> {
  const id = runId ?? newRunId()
  const buildDir = buildDirOf(folder, id)
  await mkdir(buildDir, { recursive: true })
  return { runId: id, buildDir }
}

/** 命令模板变量。 */
function templateVars(buildDir: string, runId: string, pluginVersion: string): Record<string, string> {
  return {
    '{buildDir}': `"${buildDir}"`,
    '{runId}': runId,
    '{pluginVersion}': pluginVersion,
  }
}

/** 应用模板。 */
function applyTemplate(command: string, vars: Record<string, string>): string {
  let result = command
  for (const [key, value] of Object.entries(vars)) result = result.replaceAll(key, value)
  return result
}

/** 文件是否存在。 */
async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/** 最近一轮。 */
async function latestRun(folder: string): Promise<{ runId: string, report: string } | undefined> {
  const runs = await listRunRecords(folder, { limit: 1 })
  const run = runs[0]
  if (run === undefined || run.report === null) return undefined
  return { runId: run.runId, report: run.report }
}

/** 清单摘要。 */
function manifestSummary(manifest: TaskManifest | undefined): Record<string, unknown> | null {
  if (manifest === undefined) return null
  return {
    pipeline: manifest.pipeline,
    scripts: manifest.scripts.length,
    cache: manifest.cache.length,
    updatedAt: manifest.updatedAt,
  }
}

/**
 * 注册生成类工具。
 * @param ctx - 提供 tools 的宿主上下文。
 * @param deps - 任务仓库与版本。
 */
export function registerAtanTools(ctx: ToolContext, deps: ToolDeps): void {
  const { repository, pluginVersion } = deps

  ctx.tools.register(toolTaskContext())
  ctx.tools.register(toolTaskManifest())
  ctx.tools.register(toolCollect())
  ctx.tools.register(toolBuildReport())
  ctx.tools.register(toolRender())
  ctx.tools.register(toolScript())
  ctx.tools.register(toolPackage())
  registerTuneTools(ctx, deps)

  function toolTaskContext() {
    return defineToolLike({
      name: 'atan_daily_task_context',
      description: '读取一个阿碳日报任务的上下文：明细 hash、契约修订/hash、task-pipeline.json 清单、最近运行与上一期报告摘要。生成前先调用它。',
      parameters: {
        task: { type: 'string', required: true, description: '任务 id 或任务名称' },
      },
      async execute(args: { task: string }) {
        const task = await resolveTask(repository, args.task)
        if (task === undefined) return fail('not_found', `找不到任务：${args.task}`)
        const [contract, manifestState, run, display] = await Promise.all([
          loadContract(task.folder),
          readManifest(task.folder),
          latestRun(task.folder),
          readDisplay(task.folder),
        ])
        const hash = await detailHash(task.folder)
        const schemaHash = contract.ok ? contract.contract.hash : undefined
        const declaredHash = contract.ok && typeof contract.contract.schema['x-detail-hash'] === 'string'
          ? contract.contract.schema['x-detail-hash']
          : undefined
        return ok({
          task: { id: task.taskId, name: task.name, folder: task.folder, outputFormat: task.outputFormat },
          detail: {
            hash: hash ?? null,
            declaredHash: declaredHash ?? null,
            changed: hash !== undefined && declaredHash !== undefined ? hash !== declaredHash : null,
          },
          schema: contract.ok
            ? { revision: contract.contract.revision, hash: contract.contract.hash }
            : { available: false, error: contract.message },
          manifest: {
            needsBootstrap: manifestState.needsBootstrap,
            source: manifestState.source,
            summary: manifestSummary(manifestState.manifest),
            warnings: manifestState.warnings,
          },
          display: { present: display.present, warnings: display.warnings },
          latestRun: run ?? null,
        })
      },
    })
  }

  function toolTaskManifest() {
    return defineToolLike({
      name: 'atan_daily_task_manifest',
      description: '读取或更新任务的 .meta/task-pipeline.json：pipeline（fetch/build 命令）、scripts（脚本清单）、cache（缓存清单）。首次运行或脚本/缓存变化后调用；不要手写 JSON。',
      parameters: {
        task: { type: 'string', required: true, description: '任务 id 或任务名称' },
        action: {
          type: 'string',
          required: true,
          enum: ['read', 'bootstrap', 'migrate', 'upsert_script', 'remove_script', 'upsert_cache', 'remove_cache', 'set_pipeline'],
          description: '清单操作',
        },
        payload: { type: 'string', description: 'JSON 字符串：bootstrap 传完整清单；其它 action 传对应条目' },
        reason: { type: 'string', description: 'set_pipeline 等变更的原因，写入 history' },
        deleteIndex: { type: 'boolean', description: 'bootstrap/migrate 后是否删除旧 .meta/index.md' },
      },
      async execute(args: { task: string, action: string, payload?: string, reason?: string, deleteIndex?: boolean }) {
        const task = await resolveTask(repository, args.task)
        if (task === undefined) return fail('not_found', `找不到任务：${args.task}`)
        const state = await readManifest(task.folder)
        if (args.action === 'read') {
          return ok({ source: state.source, needsBootstrap: state.needsBootstrap, manifest: state.manifest ?? null, warnings: state.warnings })
        }
        if (args.action === 'bootstrap' || args.action === 'migrate') {
          let manifest: TaskManifest
          if (args.action === 'migrate') {
            if (state.source !== 'index' || state.manifest === undefined) {
              return fail('invalid_state', '没有可迁移的 .meta/index.md')
            }
            manifest = state.manifest
          } else {
            const parsed = parseJson(args.payload, 'payload')
            if (typeof parsed !== 'object' || parsed === null) return fail('invalid_input', 'bootstrap 需要完整清单 JSON')
            manifest = parsed as TaskManifest
          }
          const checked = await validateManifest(task.folder, manifest)
          if (checked.errors.length > 0) return fail('invalid_manifest', checked.errors.join('；'), { warnings: checked.warnings })
          if (args.deleteIndex === true) await writeManifestAndDropIndex(task.folder, manifest)
          else await writeManifest(task.folder, manifest)
          return ok({ written: manifestFile(task.folder), warnings: checked.warnings })
        }

        if (state.manifest === undefined) return fail('needs_bootstrap', '还没有 task-pipeline.json，先 bootstrap')

        const manifest = JSON.parse(JSON.stringify(state.manifest)) as TaskManifest
        const payload = parseJson(args.payload, 'payload')
        const touch = (action: string): void => {
          const history = manifest.history ?? []
          history.push({ at: new Date().toISOString(), action, ...args.reason === undefined ? {} : { reason: args.reason } })
          manifest.history = history
          manifest.updatedAt = new Date().toISOString()
        }

        if (args.action === 'upsert_script') {
          if (typeof payload !== 'object' || payload === null) return fail('invalid_input', '需要 { path, purpose, scenario }')
          const entry = payload as { path?: string, purpose?: string, scenario?: string }
          if (entry.path === undefined) return fail('invalid_input', '缺少 path')
          const script = { path: entry.path, purpose: entry.purpose ?? '', scenario: entry.scenario ?? '' }
          manifest.scripts = [...manifest.scripts.filter(item => item.path !== script.path), script]
          touch('upsert_script')
        } else if (args.action === 'remove_script') {
          const path = typeof payload === 'object' && payload !== null && typeof (payload as { path?: string }).path === 'string'
            ? (payload as { path: string }).path
            : undefined
          if (path === undefined) return fail('invalid_input', '需要 { path }')
          manifest.scripts = manifest.scripts.filter(item => item.path !== path)
          touch('remove_script')
        } else if (args.action === 'upsert_cache') {
          if (typeof payload !== 'object' || payload === null) return fail('invalid_input', '需要 { path, content, scenario, asOf? }')
          const entry = payload as { path?: string, content?: string, scenario?: string, asOf?: string }
          if (entry.path === undefined) return fail('invalid_input', '缺少 path')
          const item = {
            path: entry.path,
            content: entry.content ?? '',
            scenario: entry.scenario ?? '',
            ...entry.asOf === undefined ? {} : { asOf: entry.asOf },
          }
          manifest.cache = [...manifest.cache.filter(row => row.path !== item.path), item]
          touch('upsert_cache')
        } else if (args.action === 'remove_cache') {
          const path = typeof payload === 'object' && payload !== null && typeof (payload as { path?: string }).path === 'string'
            ? (payload as { path: string }).path
            : undefined
          if (path === undefined) return fail('invalid_input', '需要 { path }')
          manifest.cache = manifest.cache.filter(item => item.path !== path)
          touch('remove_cache')
        } else if (args.action === 'set_pipeline') {
          if (typeof payload !== 'object' || payload === null) return fail('invalid_input', '需要 { fetch?, build? }')
          const patch = payload as { fetch?: TaskManifest['pipeline']['fetch'], build?: TaskManifest['pipeline']['build'] }
          manifest.pipeline = {
            fetch: patch.fetch ?? manifest.pipeline.fetch,
            build: patch.build ?? manifest.pipeline.build,
          }
          touch('set_pipeline')
        } else {
          return fail('invalid_input', `未知 action：${args.action}`)
        }

        const checked = await validateManifest(task.folder, manifest)
        if (checked.errors.length > 0) return fail('invalid_manifest', checked.errors.join('；'), { warnings: checked.warnings })
        await writeManifest(task.folder, manifest)
        return ok({ written: manifestFile(task.folder), warnings: checked.warnings })
      },
    })
  }

  function toolCollect() {
    return defineToolLike({
      name: 'atan_daily_collect',
      description: '按 task-pipeline.json 的 pipeline.fetch 执行取数，返回 runId、buildDir、原始文件与命令输出摘要。',
      parameters: {
        task: { type: 'string', required: true, description: '任务 id 或任务名称' },
        runId: { type: 'string', description: '沿用已有 runId；省略时新建 tool-<时间> 目录' },
      },
      async execute(args: { task: string, runId?: string }) {
        const task = await resolveTask(repository, args.task)
        if (task === undefined) return fail('not_found', `找不到任务：${args.task}`)
        const state = await readManifest(task.folder)
        const step = state.manifest?.pipeline.fetch
        if (step === undefined || step.run.trim() === '') {
          return fail('needs_bootstrap', '还没有可用的 fetch 命令，先 bootstrap')
        }
        const { runId, buildDir } = await ensureBuildDir(task.folder, args.runId)
        const command = applyTemplate(step.run, templateVars(buildDir, runId, pluginVersion))
        const result = await runCommand(command, task.folder, step.timeoutMs ?? 120000)
        if (result.code !== 0) {
          return fail('command_failed', `取数命令失败（exit ${String(result.code)}）`, {
            runId,
            buildDir,
            stdout: clip(result.stdout),
            stderr: clip(result.stderr),
            timedOut: result.timedOut,
          })
        }
        const artifact = step.artifact === undefined ? undefined : join(buildDir, step.artifact)
        return ok({
          runId,
          buildDir,
          artifact: artifact !== undefined && await fileExists(artifact) ? artifact : null,
          stdout: clip(result.stdout),
          stderr: clip(result.stderr),
        })
      },
    })
  }

  function toolBuildReport() {
    return defineToolLike({
      name: 'atan_daily_build_report',
      description: '按 task-pipeline.json 的 pipeline.build 组装 report.json，并用契约校验 data；返回问题清单。',
      parameters: {
        task: { type: 'string', required: true, description: '任务 id 或任务名称' },
        runId: { type: 'string', required: true, description: 'collect 返回的 runId' },
      },
      async execute(args: { task: string, runId: string }) {
        const task = await resolveTask(repository, args.task)
        if (task === undefined) return fail('not_found', `找不到任务：${args.task}`)
        const state = await readManifest(task.folder)
        const step = state.manifest?.pipeline.build
        if (step === undefined || step.run.trim() === '') {
          return fail('needs_bootstrap', '还没有可用的 build 命令，先 bootstrap')
        }
        const buildDir = buildDirOf(task.folder, args.runId)
        const command = applyTemplate(step.run, templateVars(buildDir, args.runId, pluginVersion))
        const result = await runCommand(command, task.folder, step.timeoutMs ?? 120000)
        if (result.code !== 0) {
          return fail('command_failed', `组装命令失败（exit ${String(result.code)}）`, {
            stdout: clip(result.stdout),
            stderr: clip(result.stderr),
            timedOut: result.timedOut,
          })
        }
        const reportPath = join(buildDir, 'report.json')
        if (!await fileExists(reportPath)) return fail('missing_report', `没有生成 ${reportPath}`)
        const contract = await loadContract(task.folder)
        if (!contract.ok) return fail('invalid_contract', contract.message)
        let doc: { data?: unknown }
        try {
          doc = JSON.parse(await readFile(reportPath, 'utf8')) as { data?: unknown }
        } catch (error: unknown) {
          return fail('invalid_report', `report.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
        }
        const checked = check(contract.contract.schema, doc.data, { maxIssues: 30 })
        return ok({
          reportPath,
          valid: checked.ok,
          issues: checked.ok ? [] : formatIssues(checked.issues, 20),
          warnings: checked.warnings,
          stdout: clip(result.stdout),
        })
      },
    })
  }

  function toolRender() {
    return defineToolLike({
      name: 'atan_daily_render',
      description: '把一轮 report.json 渲染成最终 PNG/PDF，返回文件与警告。',
      parameters: {
        task: { type: 'string', required: true, description: '任务 id 或任务名称' },
        runId: { type: 'string', required: true, description: '本轮 runId' },
      },
      async execute(args: { task: string, runId: string }) {
        const task = await resolveTask(repository, args.task)
        if (task === undefined) return fail('not_found', `找不到任务：${args.task}`)
        const buildDir = buildDirOf(task.folder, args.runId)
        const stamp = new Date().toISOString().replaceAll(/[-:.TZ]/gu, '').slice(0, 15)
        const base = `${task.name}-${stamp}`
        const result = await renderRunReport({ folder: task.folder, base, buildDir, format: task.outputFormat })
        if (!result.ok) return fail('render_failed', result.error ?? '渲染失败', { warnings: result.warnings })
        return ok({ base, files: result.files, warnings: result.warnings, truncated: result.truncated === true })
      },
    })
  }

  function toolScript() {
    return defineToolLike({
      name: 'atan_daily_script',
      description: '执行 .meta/script/ 下已登记的单个脚本（python/node），捕获输出。参数按字符串数组逐个传给脚本，不经过 shell。',
      parameters: {
        task: { type: 'string', required: true, description: '任务 id 或任务名称' },
        script: { type: 'string', required: true, description: '脚本相对路径，如 .meta/script/probe.py，或 scripts/ 下的文件名' },
        args: { type: 'array', items: 'string', description: '附加参数，按数组逐个传给脚本（不经过 shell，不会被解释成命令）' },
        timeoutMs: { type: 'number', description: '超时毫秒，默认 120000' },
      },
      async execute(args: { task: string, script: string, args?: string[], timeoutMs?: number }) {
        const task = await resolveTask(repository, args.task)
        if (task === undefined) return fail('not_found', `找不到任务：${args.task}`)
        if (args.args !== undefined && !Array.isArray(args.args)) {
          return fail('invalid_input', 'args 必须是字符串数组')
        }
        const relative = args.script.startsWith('.meta/script/') ? args.script : `.meta/script/${args.script}`
        if (relative.includes('..') || !/\.(py|mjs|js)$/u.test(relative)) {
          return fail('invalid_script', `只允许 .meta/script/ 下的 .py/.mjs/.js：${relative}`)
        }
        if (!await fileExists(join(task.folder, relative))) return fail('not_found', `脚本不存在：${relative}`)
        const state = await readManifest(task.folder)
        const registered = state.manifest?.scripts.some(item => item.path === relative) === true
        if (!registered) {
          return fail('script_not_registered', '脚本未登记；先用 atan_daily_task_manifest 的 upsert_script 登记', { script: relative })
        }
        const runner = relative.endsWith('.py') ? 'python' : 'node'
        const result = await runFile(
          runner,
          [join(task.folder, relative), ...(args.args ?? [])],
          task.folder,
          args.timeoutMs ?? 120000,
        )
        if (result.code !== 0) {
          return fail('script_failed', `脚本退出码 ${String(result.code)}`, {
            script: relative,
            code: result.code,
            timedOut: result.timedOut,
            stdout: clip(result.stdout),
            stderr: clip(result.stderr),
          })
        }
        return ok({
          script: relative,
          args: args.args ?? [],
          code: result.code,
          timedOut: result.timedOut,
          stdout: clip(result.stdout),
          stderr: clip(result.stderr),
        })
      },
    })
  }

  function toolPackage() {
    return defineToolLike({
      name: 'atan_daily_package',
      description: '把任务的 .share/ 收集成上传包：list 看文件清单，scan 做静态检查，preview 返回完整 v2 包（去掉提交者）。不发起上传。',
      parameters: {
        task: { type: 'string', required: true, description: '任务 id 或任务名称' },
        action: {
          type: 'string',
          required: true,
          enum: ['list', 'scan', 'preview'],
          description: 'list=文件清单；scan=静态检查；preview=完整包',
        },
      },
      async execute(args: { task: string, action: string }) {
        const task = await resolveTask(repository, args.task)
        if (task === undefined) return fail('not_found', `找不到任务：${args.task}`)
        let built: BuildResult
        try {
          built = await buildTaskPackage({ task })
        } catch (error: unknown) {
          if (error instanceof PackError) return fail(error.code, error.message, { path: error.path ?? null })
          throw error
        }
        const base = {
          task: { id: task.taskId, name: task.name },
          files: built.files,
          totals: built.totals,
          scan: scanSummary(built.scan),
        }
        if (args.action === 'list' || args.action === 'scan') return ok(base)
        if (args.action === 'preview') return ok({ ...base, package: built.package })
        return fail('invalid_input', `未知 action：${args.action}`)
      },
    })
  }
}

/** `defineTool` 的本地别名：统一补上字符串输出与 text 渲染。 */
function defineToolLike(spec: {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute: (args: never) => Promise<string>
}): unknown {
  return defineTool(spec as never)
}
