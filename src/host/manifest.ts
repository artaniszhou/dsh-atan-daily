/**
 * 任务清单：`.meta/task-pipeline.json`。
 *
 * 同时承担三件事：
 * 1. `pipeline`：工具按它执行取数与组装；
 * 2. `scripts` / `cache`：原 `.meta/index.md` 的两张表，改成机器可读；
 * 3. 运行时演进：bootstrap / upsert / setPipeline，保留「动态生成脚本与缓存」的能力。
 */

import { readFile, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { metaDirOf } from '../core/documents.js'
import { writeAtomic } from '../core/fs.js'

/** 一条执行步骤。 */
export interface PipelineStep {
  /** 命令模板；支持 `{buildDir}` / `{runId}` / `{pluginVersion}`。 */
  run: string
  /** 产物文件名（相对 buildDir）。 */
  artifact?: string
  /** 超时毫秒。 */
  timeoutMs?: number
}

/** 脚本清单项。 */
export interface ManifestScript {
  path: string
  purpose: string
  scenario: string
}

/** 缓存清单项。 */
export interface ManifestCache {
  path: string
  content: string
  scenario: string
  asOf?: string
}

/** 清单变更历史。 */
export interface ManifestChange {
  at: string
  action: string
  reason?: string
}

/** 任务清单。 */
export interface TaskManifest {
  version: 1
  pipeline: { fetch: PipelineStep, build: PipelineStep }
  scripts: ManifestScript[]
  cache: ManifestCache[]
  updatedAt: string
  history?: ManifestChange[]
}

/** 清单文件。 */
export function manifestFile(folder: string): string {
  return join(metaDirOf(folder), 'task-pipeline.json')
}

/** 索引文件。 */
function indexFile(folder: string): string {
  return join(metaDirOf(folder), 'index.md')
}

/** 判断普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 字符串。 */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** 读 JSON 文件。 */
async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

/**
 * 读取清单。
 * @param folder - 任务目录。
 * @returns 清单、来源与是否需要 bootstrap；没有清单时给出按脚本/旧索引推断的草案。
 */
export async function readManifest(folder: string): Promise<{
  manifest?: TaskManifest
  source: 'manifest' | 'index' | 'discovered' | 'none'
  needsBootstrap: boolean
  warnings: string[]
}> {
  const warnings: string[] = []
  const raw = await readJson(manifestFile(folder))
  if (isRecord(raw) && raw['version'] === 1 && isRecord(raw['pipeline'])) {
    const manifest = normalizeManifest(raw)
    const needsBootstrap = manifest.pipeline.fetch.run.trim() === '' || manifest.pipeline.build.run.trim() === ''
    return { manifest, source: 'manifest', needsBootstrap, warnings }
  }
  if (raw !== undefined) warnings.push('task-pipeline.json 格式不合法，已按脚本推断')

  const migrated = await manifestFromIndex(folder)
  if (migrated !== undefined) {
    return { manifest: migrated, source: 'index', needsBootstrap: true, warnings: [...warnings, '发现旧 index.md，可 bootstrap 迁移'] }
  }
  const discovered = await discoverManifest(folder)
  if (discovered !== undefined) {
    return { manifest: discovered, source: 'discovered', needsBootstrap: true, warnings: [...warnings, '没有 task-pipeline.json，已按脚本命名推断'] }
  }
  return { source: 'none', needsBootstrap: true, warnings }
}

/** 归一化清单。 */
function normalizeManifest(raw: Record<string, unknown>): TaskManifest {
  const pipeline = isRecord(raw['pipeline']) ? raw['pipeline'] : {}
  const fetch = isRecord(pipeline['fetch']) ? pipeline['fetch'] : {}
  const build = isRecord(pipeline['build']) ? pipeline['build'] : {}
  const scripts = Array.isArray(raw['scripts']) ? raw['scripts'].filter(isRecord) : []
  const cache = Array.isArray(raw['cache']) ? raw['cache'].filter(isRecord) : []
  return {
    version: 1,
    pipeline: {
      fetch: normalizeStep(fetch),
      build: normalizeStep(build),
    },
    scripts: scripts.map(item => ({
      path: str(item['path']) ?? '',
      purpose: str(item['purpose']) ?? '',
      scenario: str(item['scenario']) ?? '',
    })).filter(item => item.path !== ''),
    cache: cache.map(item => ({
      path: str(item['path']) ?? '',
      content: str(item['content']) ?? '',
      scenario: str(item['scenario']) ?? '',
      ...str(item['asOf']) === undefined ? {} : { asOf: str(item['asOf']) ?? '' },
    })).filter(item => item.path !== ''),
    updatedAt: str(raw['updatedAt']) ?? new Date().toISOString(),
    ...Array.isArray(raw['history']) ? { history: raw['history'].filter(isRecord).map(item => ({
      at: str(item['at']) ?? '',
      action: str(item['action']) ?? '',
      ...str(item['reason']) === undefined ? {} : { reason: str(item['reason']) ?? '' },
    })) } : {},
  }
}

/** 归一化一步。 */
function normalizeStep(value: Record<string, unknown>): PipelineStep {
  return {
    run: str(value['run']) ?? '',
    ...str(value['artifact']) === undefined ? {} : { artifact: str(value['artifact']) ?? '' },
    ...typeof value['timeoutMs'] === 'number' ? { timeoutMs: value['timeoutMs'] } : {},
  }
}

/** 写清单。 */
export async function writeManifest(folder: string, manifest: TaskManifest): Promise<void> {
  await writeAtomic(manifestFile(folder), `${JSON.stringify(manifest, null, 2)}\n`)
}

/** 解析旧 index.md 的两张表。 */
async function manifestFromIndex(folder: string): Promise<TaskManifest | undefined> {
  let text: string
  try {
    text = await readFile(indexFile(folder), 'utf8')
  } catch {
    return undefined
  }
  const scripts: ManifestScript[] = []
  const cache: ManifestCache[] = []
  let section: 'cache' | 'script' | '' = ''
  for (const line of text.split('\n')) {
    if (line.startsWith('## 缓存清单')) { section = 'cache'; continue }
    if (line.startsWith('## 脚本清单')) { section = 'script'; continue }
    if (!line.trim().startsWith('|')) continue
    const cells = line.split('|').slice(1, -1).map(cell => cell.trim().replaceAll('`', ''))
    if (cells.length < 3) continue
    if (cells[0] === '文件名' || cells[0] === '脚本名' || /^-+$/.test(cells[0] ?? '')) continue
    const [name, purpose, scenario] = cells
    if (name === undefined || purpose === undefined || scenario === undefined) continue
    if (section === 'script') {
      scripts.push({ path: name.startsWith('.meta/') ? name : `.meta/script/${name}`, purpose, scenario })
    } else if (section === 'cache') {
      cache.push({ path: name.startsWith('.meta/') ? name : `.meta/cache/${name}`, content: purpose, scenario })
    }
  }
  const discovered = await discoverPipeline(folder)
  return {
    version: 1,
    pipeline: discovered,
    scripts,
    cache,
    updatedAt: new Date().toISOString(),
    history: [{ at: new Date().toISOString(), action: 'migrate-index', reason: '从 .meta/index.md 迁移' }],
  }
}

/** 按脚本命名推断清单。 */
async function discoverManifest(folder: string): Promise<TaskManifest | undefined> {
  const scriptsDir = join(metaDirOf(folder), 'script')
  let names: string[] = []
  try {
    names = (await readdir(scriptsDir)).filter(name => /\.(py|mjs|js)$/u.test(name))
  } catch {
    return undefined
  }
  if (names.length === 0) return undefined
  const scripts: ManifestScript[] = names.map(name => ({
    path: `.meta/script/${name}`,
    purpose: '自动推断：未登记用途',
    scenario: '自动推断',
  }))
  return {
    version: 1,
    pipeline: await discoverPipeline(folder),
    scripts,
    cache: [],
    updatedAt: new Date().toISOString(),
    history: [{ at: new Date().toISOString(), action: 'discover' }],
  }
}

/** 按脚本命名推断执行步骤。 */
async function discoverPipeline(folder: string): Promise<{ fetch: PipelineStep, build: PipelineStep }> {
  const scriptsDir = join(metaDirOf(folder), 'script')
  let names: string[] = []
  try {
    names = await readdir(scriptsDir)
  } catch {
    names = []
  }
  const fetchName = names.find(name => /^fetch.*\.py$/iu.test(name)) ?? names.find(name => /fetch.*\.py$/iu.test(name))
  const buildName = names.find(name => /^build.*\.py$/iu.test(name)) ?? names.find(name => /build.*\.py$/iu.test(name))
  const command = (name: string | undefined, args: string): string => {
    if (name === undefined) return ''
    const runner = name.endsWith('.py') ? 'python' : 'node'
    return `${runner} .meta/script/${name}${args}`
  }
  return {
    fetch: {
      run: command(fetchName, ' --out {buildDir}/episode_raw.json'),
      artifact: 'episode_raw.json',
      timeoutMs: 120000,
    },
    build: {
      run: command(buildName, ' --source {buildDir}/source.json --out {buildDir}/report.json --plugin-version {pluginVersion}'),
      artifact: 'report.json',
    },
  }
}

/**
 * 校验清单引用的文件与命令。
 * @param folder - 任务目录。
 * @param manifest - 待校验清单。
 * @returns 错误与警告。
 */
export async function validateManifest(folder: string, manifest: TaskManifest): Promise<{ errors: string[], warnings: string[] }> {
  const errors: string[] = []
  const warnings: string[] = []
  const checkFile = async (relative: string): Promise<boolean> => {
    try {
      return (await stat(join(folder, relative))).isFile()
    } catch {
      return false
    }
  }
  for (const script of manifest.scripts) {
    if (!script.path.startsWith('.meta/script/')) errors.push(`脚本必须在 .meta/script/ 下：${script.path}`)
    else if (!(await checkFile(script.path))) errors.push(`脚本不存在：${script.path}`)
  }
  for (const item of manifest.cache) {
    if (!item.path.startsWith('.meta/cache/')) errors.push(`缓存必须在 .meta/cache/ 下：${item.path}`)
    else if (!(await checkFile(item.path))) errors.push(`缓存不存在：${item.path}`)
  }
  for (const [name, step] of Object.entries(manifest.pipeline)) {
    if (step.run.trim() === '') {
      warnings.push(`${name} 未配置命令；调用 collect/build 时会返回 needsBootstrap`)
      continue
    }
    if (!step.run.includes('.meta/script/')) errors.push(`${name} 命令必须引用 .meta/script/ 下的脚本：${step.run}`)
    if (step.run.includes('..')) errors.push(`${name} 命令不能包含 ..`)
  }
  return { errors, warnings }
}

/**
 * 迁移：写 task-pipeline.json，并删除旧 index.md。
 * @param folder - 任务目录。
 * @param manifest - 已确认的清单。
 */
export async function writeManifestAndDropIndex(folder: string, manifest: TaskManifest): Promise<void> {
  await writeManifest(folder, manifest)
  await rm(indexFile(folder), { force: true })
}
