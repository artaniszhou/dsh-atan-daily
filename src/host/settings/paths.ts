/**
 * 工作区路径校验（Host 权威）。
 *
 * 规则按**宿主平台**执行，不按浏览器平台：远程访问时两者可能不同。这里只做纯字符串
 * 校验（不碰文件系统）；存在性、canonical 化、是否已注册由路由层补充。
 */

import { posix, win32 } from 'node:path'
import type { HostPlatform, WorkspacePathErrorCode } from '../../protocol.js'

/** 校验结果：成功带归一化路径，失败带稳定 code 与可选细节。 */
export type PathValidation =
  | { ok: true, normalized: string }
  | { ok: false, code: WorkspacePathErrorCode, detail?: string }

/** Windows 保留设备名（含带扩展名的形式，如 `CON.txt`）。 */
const WINDOWS_RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
])

/** Windows 分段中不允许出现的字符（盘符后的 `:` 已在调用前剥离）。 */
const WINDOWS_FORBIDDEN = /[<>:"|?*\u0000-\u001F]/u

/** 盘符限定形式 `C:\`。 */
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/u

/** 完整 UNC 形式 `\\server\share…`。 */
const WINDOWS_UNC = /^\\\\[^\\/]+[\\/][^\\/]+/u

/** 设备路径前缀 `\\?\` 与 `\\.\`。 */
const WINDOWS_DEVICE = /^\\\\[?.][\\/]/u

/** 把用户输入归一为候选文本：去首尾空白、去掉成对外层引号。 */
export function normalizeInput(raw: string): string {
  let text = raw.trim()
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    text = text.slice(1, -1).trim()
  }
  return text
}

/**
 * 宿主平台到契约枚举的映射。
 * @param platform - `process.platform`。
 * @returns 契约里的平台值。
 */
export function hostPlatformOf(platform: NodeJS.Platform = process.platform): HostPlatform {
  if (platform === 'win32' || platform === 'darwin' || platform === 'linux') return platform
  return 'other'
}

/**
 * 路径比较键：Windows 大小写不敏感并统一分隔符，POSIX 只做归一化。
 * @param path - 绝对路径。
 * @param platform - 宿主平台。
 * @returns 可直接用 `===` 比较的键。
 */
export function pathKey(path: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32'
    ? win32.normalize(path).toLowerCase()
    : posix.normalize(path)
}

/**
 * 判断 `child` 是否等于 `parent` 或位于其下（用于设置根目录保护）。
 * @param parent - 父目录（已归一化）。
 * @param child - 候选目录（已归一化）。
 * @param platform - 宿主平台。
 * @returns 命中返回 true。
 */
export function isInside(parent: string, child: string, platform: NodeJS.Platform = process.platform): boolean {
  const key = pathKey(child, platform)
  const root = pathKey(parent, platform)
  if (key === root) return true
  const separator = platform === 'win32' ? '\\' : '/'
  const prefix = root.endsWith(separator) ? root : `${root}${separator}`
  return key.startsWith(prefix)
}

/** 去掉末尾分隔符，但保留 Windows 盘根与 POSIX 根。 */
function trimTrailing(path: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    if (/^[A-Za-z]:[\\/]$/u.test(path)) return path
    return path.replace(/[\\/]+$/u, '')
  }
  return path === '/' ? path : path.replace(/\/+$/u, '')
}

/**
 * Windows 路径校验。
 * @param text - 已归一化输入的候选路径。
 * @returns 校验结果。
 */
function validateWindows(text: string): PathValidation {
  if (WINDOWS_DEVICE.test(text)) {
    return { ok: false, code: 'path_device_form' }
  }
  if (WINDOWS_UNC.test(text)) {
    // 完整 UNC：继续做分段检查。
  } else if (WINDOWS_DRIVE.test(text)) {
    // 盘符限定：继续。
  } else if (/^[A-Za-z]:/u.test(text) || text.startsWith('\\') || text.startsWith('/')) {
    return { ok: false, code: 'path_not_fully_qualified' }
  } else {
    return { ok: false, code: 'path_not_absolute' }
  }
  if (text.length > 32_767) return { ok: false, code: 'path_too_long' }
  // 盘符后的冒号是合法的，其余冒号不允许。
  const body = /^[A-Za-z]:/u.test(text) ? text.slice(2) : text
  if (WINDOWS_FORBIDDEN.test(body)) {
    return { ok: false, code: 'path_forbidden_char' }
  }
  const segments = body.split(/[\\/]+/u).filter(segment => segment !== '')
  for (const segment of segments) {
    if (segment === '.' || segment === '..') continue
    if (segment.length > 255) return { ok: false, code: 'path_component_too_long', detail: segment }
    if (/[ .]$/u.test(segment)) return { ok: false, code: 'path_trailing_dot_space', detail: segment }
    const stem = segment.split('.')[0]?.toUpperCase() ?? ''
    if (WINDOWS_RESERVED.has(stem)) return { ok: false, code: 'path_reserved_name', detail: segment }
  }
  const normalized = trimTrailing(win32.normalize(text), 'win32')
  if (!WINDOWS_UNC.test(normalized) && !WINDOWS_DRIVE.test(normalized)) {
    return { ok: false, code: 'path_not_fully_qualified' }
  }
  return { ok: true, normalized }
}

/**
 * macOS / Linux 路径校验。
 * @param text - 已归一化输入的候选路径。
 * @param platform - `darwin` 或其它 POSIX 平台。
 * @returns 校验结果。
 */
function validatePosix(text: string, platform: NodeJS.Platform): PathValidation {
  if (!text.startsWith('/')) return { ok: false, code: 'path_not_absolute' }
  if (text.includes('\0')) return { ok: false, code: 'path_forbidden_char' }
  const normalized = trimTrailing(posix.normalize(text), platform)
  const limit = platform === 'darwin' ? 1024 : 4096
  if (Buffer.byteLength(normalized, 'utf8') > limit) return { ok: false, code: 'path_too_long' }
  for (const segment of normalized.split('/')) {
    if (segment === '') continue
    if (Buffer.byteLength(segment, 'utf8') > 255) {
      return { ok: false, code: 'path_component_too_long', detail: segment }
    }
  }
  return { ok: true, normalized }
}

/**
 * 按宿主平台校验一个工作区目录地址。
 * @param raw - 用户输入（可带首尾空白或成对引号）。
 * @param platform - 宿主平台；默认 `process.platform`。
 * @returns 归一化路径，或稳定错误码。
 */
export function validateWorkspacePath(
  raw: string,
  platform: NodeJS.Platform = process.platform,
): PathValidation {
  const text = normalizeInput(raw)
  if (text === '') return { ok: false, code: 'path_empty' }
  return platform === 'win32' ? validateWindows(text) : validatePosix(text, platform)
}
