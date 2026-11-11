/**
 * 任务文档：用户写的任务细节与文件索引。
 *
 * 一个任务目录里有两份 Markdown：
 * - `task-detail.md`（与 `.meta/` 同级）：用户写的目标、数据源、口径与边界。
 * - `.meta/index.md`：`.meta/cache/` 与 `.meta/script/` 的文件索引。
 *
 * 共用的执行要求与输出约定不再写进任务目录，而是由 `atan-daily-run` skill
 * 提供。这样任务目录只保留「这一个任务自己的内容」，执行规则只维护一份。
 */

import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { writeAtomic } from './fs.js'

/** 工作目录下放注册表的隐藏目录。 */
export const TASK_DIR = '.task'
/** 任务根目录下、随任务上传的目录。 */
export const SHARE_DIR = '.share'
/** 任务根目录下的任务细节文件名（在 `.share/` 里）。 */
export const TASK_DETAIL_NAME = 'task-detail.md'
/** `.meta/` 下的文件索引文件名。 */
export const INDEX_NAME = 'index.md'
/** 任务资料目录名；与 Host 侧配置一致。 */
export const META_DIR = '.meta'
/** `.share/` 下的自定义图形目录（随任务上传）。 */
export const CHARTS_DIR = 'charts'
/** `.meta/` 下每轮执行的中间件目录。 */
export const BUILD_DIR = 'build'

/** 工作目录下放注册表的隐藏目录。 */
export function taskStateDir(workDir: string): string {
  return join(workDir, TASK_DIR)
}

/** 任务的资料目录。 */
export function metaDirOf(folder: string): string {
  return join(folder, META_DIR)
}

/** 随任务上传的目录。 */
export function shareDirOf(folder: string): string {
  return join(folder, SHARE_DIR)
}

/** 一次运行的中间件目录。 */
export function buildDirOf(folder: string, runId: string): string {
  return join(folder, META_DIR, BUILD_DIR, runId)
}

/** 细节为空时写入的占位文本。 */
export const EMPTY_DETAIL = '_创建时未填写任务细节，执行前请先补充。_'

/** 缓存清单的标题。 */
export const CACHE_HEADING = '## 缓存清单'
/** 脚本清单的标题。 */
export const SCRIPT_HEADING = '## 脚本清单'

/** 文件索引的固定开头。 */
const INDEX_INTRO = [
  '# 文件索引',
  '',
  '本文件登记 `.meta/cache/` 与 `.meta/script/` 下的文件；新增、更新或删除文件后同步这里，保持索引与目录内容一致。',
  '',
].join('\n')

/** 清单种类。 */
type ManifestKind = 'cache' | 'script'

/**
 * 一个清单段落的行。
 * @param kind - 缓存或脚本。
 * @param rows - 表格行，每行是完整的 `| ... |` 文本。
 * @returns 段落行。
 */
function manifestLines(kind: ManifestKind, rows: readonly string[]): string[] {
  const cache = kind === 'cache'
  return [
    cache ? CACHE_HEADING : SCRIPT_HEADING,
    '',
    cache
      ? '记录 `.meta/cache/` 下每份文档保存了什么、什么时候可以用到它。'
      : '记录 `.meta/script/` 下每个脚本做什么、什么时候可以用到它。优先使用 Python 脚本。',
    '',
    cache ? '| 文件名 | 存储内容 | 可用场景 |' : '| 脚本名 | 功能 | 可用场景 |',
    '|---|---|---|',
    ...rows,
  ]
}

/**
 * 渲染一个清单段落。
 * @param kind - 缓存或脚本。
 * @param rows - 表格行。
 * @returns 以换行结尾的段落。
 */
export function renderManifestSection(kind: ManifestKind, rows: readonly string[] = []): string {
  return `${manifestLines(kind, rows).join('\n')}\n`
}

/**
 * 渲染一份任务细节文档。
 * @param details - 用户写的任务细节。
 * @returns 以换行结尾的文档；空细节写入占位文本。
 */
export function renderTaskDetail(details: string): string {
  const text = details.trim()
  return `${text === '' ? EMPTY_DETAIL : text}\n`
}

/**
 * 解析一份任务细节文档。
 * @param text - 文件内容。
 * @returns 任务细节；空文件或占位文本返回空串。
 */
export function parseTaskDetail(text: string): string {
  const value = text.trim()
  return value === '' || value === EMPTY_DETAIL ? '' : value
}

/**
 * 渲染一份文件索引。
 * @param cacheRows - 缓存清单行。
 * @param scriptRows - 脚本清单行。
 * @returns 以换行结尾的索引文档。
 */
export function renderIndexContent(
  cacheRows: readonly string[] = [],
  scriptRows: readonly string[] = [],
): string {
  const body = `${INDEX_INTRO}${renderManifestSection('cache', cacheRows)}\n${renderManifestSection('script', scriptRows)}`
  return `${body.replace(/\n{3,}/gu, '\n\n').trimEnd()}\n`
}

/**
 * 读一个可选文件；只有 `ENOENT` 当作缺失。
 * @param path - 绝对路径。
 * @returns 文本，或 undefined。
 */
async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error: unknown) {
    if ((error as { code?: string }).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * 判断路径是否为已存在的普通文件。
 * @param path - 绝对路径。
 * @returns true 表示存在且是文件。
 */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/**
 * 读任务目录里的任务细节。
 * @param folder - 任务目录。
 * @returns 任务细节；文件不存在时为空串。
 */
export async function readTaskDetail(folder: string): Promise<string> {
  const text = await readOptional(join(folder, SHARE_DIR, TASK_DETAIL_NAME))
  return text === undefined ? '' : parseTaskDetail(text)
}

/**
 * 原子写入任务细节。
 * @param folder - 任务目录。
 * @param details - 用户写的任务细节。
 */
export async function writeTaskDetail(folder: string, details: string): Promise<void> {
  await writeAtomic(join(folder, SHARE_DIR, TASK_DETAIL_NAME), renderTaskDetail(details))
}

/**
 * 原子写入文件索引。
 * @param folder - 任务目录。
 * @param cacheRows - 缓存清单行。
 * @param scriptRows - 脚本清单行。
 */
export async function writeTaskIndex(
  folder: string,
  cacheRows: readonly string[] = [],
  scriptRows: readonly string[] = [],
): Promise<void> {
  await writeAtomic(join(folder, META_DIR, INDEX_NAME), renderIndexContent(cacheRows, scriptRows))
}

/**
 * 确保任务的两份文档都存在；已存在的文件绝不覆盖。
 * @param folder - 任务目录。
 * @returns true 表示补写了至少一份文件。
 */
export async function ensureTaskDocuments(folder: string): Promise<boolean> {
  let wrote = false
  if (!(await isFile(join(folder, SHARE_DIR, TASK_DETAIL_NAME)))) {
    await writeTaskDetail(folder, '')
    wrote = true
  }
  return wrote
}
