/**
 * 自定义图形：在受限子进程里执行任务自带的脚本，拿到 SVG。
 *
 * 脚本来自 `.share/charts/`，可能是别人上传的，因此不能让它在完整 Node
 * 权限下跑。优先用 Node 的权限模型：禁止文件写入、子进程、worker、addon
 * 与 `eval`，只允许读脚本自身；环境变量清空，工作目录设为临时目录。
 * 运行环境不支持权限模型时退化为「普通子进程 + 静态规则 + 人工审核」。
 *
 * 独立进程仍然保留：超时能真的杀掉、崩溃不影响 Host、输出可以限制大小。
 */

import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

/** 运行脚本的入口（编译后与 theme.js 同目录）。 */
const RUNNER = fileURLToPath(new URL('./custom-runner.js', import.meta.url))

/** 输出上限：1MB。 */
const MAX_OUTPUT_BYTES = 1_000_000
/** 超时：2 秒。 */
const TIMEOUT_MS = 2000

/** 权限模型是否可用；探测一次后缓存。 */
let permissionSupported: boolean | undefined

/**
 * 探测当前 Node 是否支持 `--permission`。
 * @returns true 表示可以加沙箱参数。
 */
function supportsPermission(): boolean {
  if (permissionSupported !== undefined) return permissionSupported
  try {
    const probe = spawnSync(process.execPath, ['--permission', '-e', '0'], {
      timeout: 5000,
      windowsHide: true,
      stdio: 'ignore',
    })
    permissionSupported = probe.error === undefined && probe.status === 0
  } catch {
    permissionSupported = false
  }
  return permissionSupported
}

/**
 * 子进程的沙箱参数。
 * @param script - 脚本绝对路径；只放开对它的读权限。
 * @returns 传给 node 的参数。
 */
function sandboxFlags(script: string): string[] {
  if (!supportsPermission()) return []
  return [
    '--permission',
    // 图形脚本只做字符串拼接，不需要 eval / new Function。
    '--disallow-code-generation-from-strings',
    `--allow-fs-read=${script}`,
  ]
}

/**
 * 消毒 SVG：去掉脚本、事件属性、foreignObject 与外链。
 * @param svg - 原始 SVG。
 * @returns 处理后的 SVG。
 */
export function sanitizeSvg(svg: string): string {
  return svg
    .replace(/<script[\s\S]*?<\/script>/giu, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/giu, '')
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/giu, '')
    .replace(/\son[a-z]+\s*=\s*'[^']*'/giu, '')
    .replace(/\s(href|xlink:href|src)\s*=\s*"(?:https?:)?\/\/[^"]*"/giu, '')
}

/**
 * 执行自定义图形脚本。
 * @param script - 脚本绝对路径。
 * @param payload - 传给脚本的数据（rows / columns / theme / width / height）。
 * @returns 消毒后的 SVG；超时、崩溃、输出非法时返回 undefined。
 */
export function renderCustomSvg(script: string, payload: unknown): string | undefined {
  const result = spawnSync(process.execPath, [...sandboxFlags(script), RUNNER], {
    input: JSON.stringify({ script, payload }),
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
    windowsHide: true,
    // 脚本读不到任何环境变量；工作目录是空的临时目录。
    env: {},
    cwd: tmpdir(),
  })
  if (result.error !== undefined || result.status !== 0) return undefined
  const svg = (result.stdout ?? '').trim()
  if (!svg.startsWith('<svg')) return undefined
  return sanitizeSvg(svg)
}
