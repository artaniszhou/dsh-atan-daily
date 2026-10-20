/**
 * 旧布局迁移。
 *
 * 只由「激活」或「显式准备插件自有目录」调用；`GET` 读路径绝不触发这里。
 * 迁移必须是幂等的：第二次运行不应再移动任何文件。
 */

import { mkdir, readdir, readFile, rename, rm, rmdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { writeAtomic } from '../core/fs.js'
import { parseLegacyRule, upsertManifestSection } from '../core/rule.js'
import { CACHE_DIR, META_DIR, RULE_NAME, SCRIPT_DIR } from './config.js'
import { folderNameOf, REPORT_SUFFIX } from './naming.js'
import type { Logger } from './ports.js'

/** 旧缓存清单，迁移时并入 `rule.md`。 */
const CACHE_MANIFEST = 'cache.md'
/** 旧脚本清单，迁移时并入 `rule.md`。 */
const SCRIPT_MANIFEST = 'script.md'
/** 旧规则后缀，仅为迁移保留。 */
const RULE_SUFFIX = '.rule.md'
/** 需要搬进 `meta/` 的旧文档名。 */
const LEGACY_DOCS: readonly (readonly [string, string])[] = [
  ['数据清单.md', CACHE_MANIFEST],
  ['脚本.md', SCRIPT_MANIFEST],
  ['脚本清单.md', SCRIPT_MANIFEST],
]
/** 旧的报告归档目录，迁移时折回任务根。 */
const HISTORY_DIR = '历史报告'

/**
 * 从当前或旧位置读规则文档。
 * @param folder - 任务目录。
 * @returns 规则文本，或 undefined。
 */
async function readAnyRule(folder: string): Promise<string | undefined> {
  try {
    return await readFile(join(folder, META_DIR, RULE_NAME), 'utf8')
  } catch {
    // 下面尝试旧布局。
  }
  try {
    const names = await readdir(folder)
    const legacy = names.find(name => name.endsWith(RULE_SUFFIX))
    if (legacy === undefined) return undefined
    return await readFile(join(folder, legacy), 'utf8')
  } catch {
    return undefined
  }
}

/**
 * 把任务根下的旧文档搬进 `meta/`。
 * @param folder - 任务目录。
 * @param logger - 诊断日志。
 */
async function migrateTaskDocs(folder: string, logger: Logger): Promise<void> {
  const metaDir = join(folder, META_DIR)
  const rulePath = join(metaDir, RULE_NAME)
  let names: string[] = []
  try {
    names = (await readdir(folder, { withFileTypes: true }))
      .filter(entry => entry.isFile()).map(entry => entry.name)
  } catch {
    return
  }
  try {
    await stat(rulePath)
    // 已经有 meta/rule.md：不再迁移文档。
    return
  } catch {
    // 继续迁移。
  }
  const legacyRule = names.find(name => name.endsWith(RULE_SUFFIX))
  if (legacyRule === undefined) return
  try {
    await mkdir(metaDir, { recursive: true })
    await rename(join(folder, legacyRule), rulePath)
  } catch (error: unknown) {
    logger.warn(`could not migrate ${folder}: ${String(error)}`)
    return
  }
  for (const [from, to] of LEGACY_DOCS) {
    if (!names.includes(from)) continue
    try {
      await rename(join(folder, from), join(metaDir, to))
    } catch {
      // 同名目标已存在：保留源文件，不覆盖。
    }
  }
}

/**
 * 把旧 `tasks/` 目录里的任务搬出来。
 * @param workDir - 工作目录。
 * @param logger - 诊断日志。
 */
async function migrateLegacyTasks(workDir: string, logger: Logger): Promise<void> {
  const legacy = join(workDir, 'tasks')
  let entries
  try {
    entries = await readdir(legacy, { withFileTypes: true })
  } catch {
    return
  }
  let moved = 0
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const source = join(legacy, entry.name)
    const text = await readAnyRule(source)
    if (text === undefined) continue
    let birth: string
    try {
      birth = (await stat(source)).birthtime.toISOString()
    } catch {
      continue
    }
    const task = parseLegacyRule(text, entry.name, birth)
    let target: string
    try {
      target = folderNameOf(task.name ?? entry.name)
    } catch {
      logger.warn(`legacy task ${entry.name} has no usable folder name; left in place`)
      continue
    }
    const destination = join(workDir, target)
    try {
      await stat(destination)
      logger.warn(`legacy task ${entry.name} not migrated: ${target} already exists`)
      continue
    } catch {
      // 目标空闲，可以搬。
    }
    try {
      await rename(source, destination)
      await migrateTaskDocs(destination, logger)
      moved += 1
    } catch (error: unknown) {
      logger.warn(`legacy task ${entry.name} could not be moved: ${String(error)}`)
    }
  }
  if (moved > 0) await rmdir(legacy).catch(() => {})
}

/**
 * 把任务根目录的文件夹搬进 `meta/`，两边都存在时合并。
 * @param folder - 任务目录。
 * @param name - `cache` 或 `script`。
 */
async function moveIntoMeta(folder: string, name: string): Promise<void> {
  const source = join(folder, name)
  try {
    if (!(await stat(source)).isDirectory()) return
  } catch {
    return
  }
  const target = join(folder, META_DIR, name)
  try {
    await stat(target)
  } catch {
    await mkdir(join(folder, META_DIR), { recursive: true })
    await rename(source, target)
    return
  }
  let entries
  try {
    entries = await readdir(source, { withFileTypes: true })
  } catch {
    return
  }
  let failed = false
  for (const entry of entries) {
    const destination = join(target, entry.name)
    try {
      await stat(destination)
      // The destination already has a file with this name; keep the source
      // directory intact instead of deleting the duplicate below.
      failed = true
      continue
    } catch {
      // 目标空闲，可以搬进去。
    }
    try {
      await rename(join(source, entry.name), destination)
    } catch {
      // 搬不动的文件必须留在原处；下面不能删源目录。
      failed = true
    }
  }
  if (!failed) await rm(source, { recursive: true, force: true }).catch(() => {})
}

/**
 * 把旧 `cache.md` / `script.md` 清单并入 `rule.md`。
 * @param folder - 任务目录。
 * @param kind - 要合并的清单种类。
 */
async function mergeManifest(folder: string, kind: 'cache' | 'script'): Promise<void> {
  const metaDir = join(folder, META_DIR)
  const legacy = join(metaDir, kind === 'cache' ? CACHE_MANIFEST : SCRIPT_MANIFEST)
  let old: string
  try {
    old = await readFile(legacy, 'utf8')
  } catch {
    return
  }
  const rows = old.split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => line.startsWith('|') && !/^\|[\s:|-]+\|$/u.test(line))
    .slice(1)
  const rulePath = join(metaDir, RULE_NAME)
  let rule: string
  try {
    rule = await readFile(rulePath, 'utf8')
  } catch {
    return
  }
  await writeAtomic(rulePath, upsertManifestSection(rule, kind, rows))
  await rm(legacy, { force: true })
}

/**
 * 把旧 `历史报告/` 折回任务根。
 * @param folder - 任务目录。
 */
async function migrateReportHistory(folder: string): Promise<void> {
  const history = join(folder, HISTORY_DIR)
  let entries
  try {
    entries = await readdir(history, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(REPORT_SUFFIX)) continue
    let name = entry.name
    let suffix = 2
    while (true) {
      try {
        await stat(join(folder, name))
        name = entry.name.replace(/\.md$/u, `-${String(suffix)}.md`)
        suffix += 1
      } catch {
        break
      }
    }
    await rename(join(history, entry.name), join(folder, name)).catch(() => {})
  }
  await rmdir(history).catch(() => {})
}

/**
 * 把缓存、脚本与历史报告搬到当前布局。
 * @param folder - 任务目录。
 */
async function migrateStorageLayout(folder: string): Promise<void> {
  await moveIntoMeta(folder, CACHE_DIR)
  await moveIntoMeta(folder, SCRIPT_DIR)
  await mergeManifest(folder, 'cache')
  await mergeManifest(folder, 'script')
  await migrateReportHistory(folder)
}

/**
 * 一个目录是否看起来像采集任务，而不是恰好放在工作目录里的普通文件夹。
 * @param folder - 目录。
 * @returns 带有当前或旧规则时 true。
 */
async function looksLikeTask(folder: string): Promise<boolean> {
  try {
    if ((await stat(join(folder, META_DIR, RULE_NAME))).isFile()) return true
  } catch {
    // 继续尝试旧规则。
  }
  let names: string[] = []
  try {
    names = await readdir(folder)
  } catch {
    return false
  }
  return names.some(name => name.endsWith(RULE_SUFFIX))
}

/**
 * 在读取注册表前，把工作目录里的任务目录迁移到当前布局。
 *
 * 幂等；失败只记录，不阻断激活。
 * @param workDir - 工作目录。
 * @param logger - 诊断日志。
 */
export async function ensureTaskLayout(workDir: string, logger: Logger): Promise<void> {
  await migrateLegacyTasks(workDir, logger)
  let entries
  try {
    entries = await readdir(workDir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'tasks') continue
    const folder = join(workDir, entry.name)
    if (!(await looksLikeTask(folder))) continue
    await migrateTaskDocs(folder, logger).catch((error: unknown) => {
      logger.warn(`task document migration failed for ${entry.name}: ${String(error)}`)
    })
    await migrateStorageLayout(folder).catch((error: unknown) => {
      logger.warn(`task storage migration failed for ${entry.name}: ${String(error)}`)
    })
  }
}
