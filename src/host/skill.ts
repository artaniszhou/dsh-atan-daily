/**
 * 随插件发布的执行规则 skill。
 *
 * 任务模板的公共部分（目录骨架、执行要求、输出约定）从任务目录移到这里：
 * 所有任务共用一份 `SKILL.md`，由 Host 注册到宿主的 skill 目录。运行时由
 * 执行指令要求模型先加载 `atan-daily-run`，把正文作为本轮指令读入会话。
 *
 * skill 正文是发布资产，不写进 lib；路径相对包根解析，源码（Vitest）与
 * 构建产物（lib/host）都指向同一个 `skill/atan-daily-run/SKILL.md`。
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 执行规则 skill 的名字（kebab-case，符合宿主 skill 命名）。 */
export const RUN_SKILL_NAME = 'atan-daily-run'

/** skill 正文的位置。 */
const SKILL_URL: URL = new URL('../../skill/atan-daily-run/SKILL.md', import.meta.url)

/** 一份可注册的 skill。 */
export interface RunSkill {
  name: string
  description: string
  content: string
  /**
   * 技能目录的绝对路径。
   *
   * 注册时作为宿主的 `resourceBase` 传给模型：`SKILL.md` 里写的
   * `references/schema.md` 这类相对路径，模型要能按它读出来。少了这一项，
   * skill 正文里就不能引用任何外部文件。
   */
  dir: string
}

/** 读取一次就够；编辑 SKILL.md 后需要重启 Host，与原来的模板一致。 */
let cached: RunSkill | undefined

/**
 * 解析 skill 的前置元数据。
 * @param raw - 整份 SKILL.md。
 * @param path - 文件路径，用于报错。
 * @returns 名称、描述与正文（不含目录，目录由 {@link readRunSkill} 补上）。
 */
export function parseRunSkill(raw: string, path: string): Omit<RunSkill, 'dir'> {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  if (frontmatter?.[1] === undefined) throw new Error(`run skill ${path} has no frontmatter`)
  const fields = new Map<string, string>()
  for (const line of frontmatter[1].split(/\r?\n/u)) {
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    fields.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim())
  }
  const name = fields.get('name')
  const description = fields.get('description')
  if (name !== RUN_SKILL_NAME) {
    throw new Error(`run skill ${path} must be named ${RUN_SKILL_NAME}`)
  }
  if (description === undefined || description === '') {
    throw new Error(`run skill ${path} has no description`)
  }
  return {
    name,
    description,
    content: raw.slice(frontmatter[0].length).trim(),
  }
}

/**
 * 解析 skill 文件的实际路径。
 * @returns 绝对路径。
 */
function skillPath(): string {
  if (SKILL_URL.protocol === 'file:') return fileURLToPath(SKILL_URL)
  return resolve(process.cwd(), 'skill', RUN_SKILL_NAME, 'SKILL.md')
}

/**
 * 读取随包发布的执行规则 skill。
 * @returns 名称、描述、正文与技能目录。
 */
export function readRunSkill(): RunSkill {
  if (cached !== undefined) return cached
  const path = skillPath()
  cached = { ...parseRunSkill(readFileSync(path, 'utf8'), path), dir: dirname(path) }
  return cached
}
