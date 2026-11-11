#!/usr/bin/env node
/**
 * 版本一致性校验：`package.json` 是唯一权威，其余位置必须跟着它。
 *
 * 检查项：
 *  1. `package-lock.json` 的根 `version` 与 `packages[""].version`
 *  2. `README.md` 的「当前版本 **X**」
 *  3. `docs/PRODUCT.md` 的「适用于 **X**」
 *  4. `docs/CHANGELOG.md` 的最新条目号
 *  5. `src/` 里没有重新写死的 `PLUGIN_VERSION = 'X'` 字面量
 *
 * 由 `npm run check` 与 `prepack` 调用；只做校验，不写文件。
 */

import { readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const problems = []

/** 读一个 UTF-8 文本文件。 */
async function read(relativePath) {
  return readFile(join(ROOT, relativePath), 'utf8')
}

/** 记录一处不一致。 */
function check(ok, message) {
  if (!ok) problems.push(message)
}

/** 用正则取第一个捕获组。 */
function firstGroup(text, pattern) {
  return pattern.exec(text)?.[1]?.trim()
}

const pkg = JSON.parse(await read('package.json'))
const version = pkg.version

check(typeof version === 'string' && version.length > 0, 'package.json 缺少 version')

const lock = JSON.parse(await read('package-lock.json'))
check(lock.version === version, `package-lock.json 根 version 是 ${String(lock.version)}，应为 ${String(version)}`)
check(
  lock.packages?.['']?.version === version,
  `package-lock.json packages[""].version 是 ${String(lock.packages?.['']?.version)}，应为 ${String(version)}`,
)

const readme = firstGroup(await read('README.md'), /当前版本\s*\*\*([^*]+)\*\*/u)
check(readme === version, `README.md 当前版本是 ${String(readme)}，应为 ${String(version)}`)

const product = firstGroup(await read('docs/PRODUCT.md'), /适用于\s*\*\*([^*]+)\*\*/u)
check(product === version, `docs/PRODUCT.md 适用于 ${String(product)}，应为 ${String(version)}`)

const changelog = firstGroup(await read('docs/CHANGELOG.md'), /^##\s+(\d+\.\d+\.\d+)/mu)
check(changelog === version, `docs/CHANGELOG.md 最新条目是 ${String(changelog)}，应为 ${String(version)}`)

/** 递归列出目录下的 `.ts` 文件。 */
async function listTs(directory) {
  const found = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...(await listTs(path)))
    else if (entry.isFile() && entry.name.endsWith('.ts')) found.push(path)
  }
  return found
}

const hardcoded = /PLUGIN_VERSION\s*=\s*['"]\d/u
for (const file of await listTs(join(ROOT, 'src'))) {
  const text = await readFile(file, 'utf8')
  if (hardcoded.test(text)) {
    problems.push(`${relative(ROOT, file)}: 不要手写 PLUGIN_VERSION 字面量，改为从 src/host/version.ts 导入`)
  }
}

if (problems.length === 0) {
  console.log(`版本一致：${version}`)
} else {
  console.error(`版本不一致（以 package.json 的 ${String(version)} 为准）：`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exitCode = 1
}
