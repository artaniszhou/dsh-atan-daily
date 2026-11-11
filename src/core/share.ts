/**
 * 任务包目录：`.share/`。
 *
 * `.share/` 是随任务上传的部分，只放「别人下载后能复现报告」的资产：
 * 任务细节、数据契约、外观覆盖，以及无法从文字重建的自定义图形脚本。
 * 取数脚本与缓存留在 `.meta/`，不上传。
 *
 * 本模块只做路径约定与安全判定，不碰文件系统。
 */

/** 随任务上传的目录名。 */
export const SHARE_DIR = '.share'

/** `.share/` 下的自定义图形目录名。 */
export const SHARE_CHARTS = 'charts'

/** `.share/` 根下允许的文件（相对 `.share/`）。 */
export const SHARE_ROOT_FILES = ['task-detail.md', 'task-schema.json', 'task-display.json'] as const

/** 允许出现在 `.share/` 根的文件名。 */
export type ShareRootFile = typeof SHARE_ROOT_FILES[number]

/** 图形脚本唯一允许的扩展名。 */
export const CHART_EXTENSION = '.mjs'

/** 上传包里的文件种类。 */
export type ShareKind = 'detail' | 'schema' | 'display' | 'chart'

/** 一个路径的归类结果。 */
export interface SharePathInfo {
  kind: ShareKind
  /** 规范化后的相对路径（`/` 分隔）。 */
  path: string
}

/** 一条路径问题。 */
export interface SharePathProblem {
  code: string
  message: string
}

/** Windows 保留设备名；上传到 Windows 上会创建失败。 */
const RESERVED_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu

/** 单个路径段允许的字符。 */
const SEGMENT = /^[A-Za-z0-9._-]+$/u

/** 判断字符串是不是允许的根文件名。 */
export function isShareRootFile(value: string): value is ShareRootFile {
  return (SHARE_ROOT_FILES as readonly string[]).includes(value)
}

/** `.share/` 目录的绝对路径。 */
export function shareDirOf(folder: string): string {
  return `${folder}/${SHARE_DIR}`
}

/** 把相对路径拼成绝对路径（调用方先用 {@link checkSharePath} 校验）。 */
export function sharePathOf(folder: string, relative: string): string {
  return `${folder}/${relative}`
}

/**
 * 把一个路径段归类成文件种类；不合法时返回 undefined。
 * @param path - 相对任务目录的路径，`/` 分隔。
 * @returns 种类与规范化路径。
 */
export function classifySharePath(path: string): SharePathInfo | undefined {
  if (checkSharePath(path) !== undefined) return undefined
  const rest = path.slice(SHARE_DIR.length + 1)
  if (isShareRootFile(rest)) {
    const kind: ShareKind = rest === 'task-detail.md'
      ? 'detail'
      : rest === 'task-schema.json' ? 'schema' : 'display'
    return { kind, path }
  }
  return { kind: 'chart', path }
}

/**
 * 校验一条随包路径。
 *
 * 规则：必须以 `.share/` 开头、只允许 `/` 分隔、根下只能是三份固定文件、
 * `charts/` 下只能是单层 `.mjs`；不允许 `..`、绝对路径、盘符、控制字符、
 * 隐藏段、Windows 保留名、结尾点或空格。
 * @param path - 相对任务目录的路径。
 * @returns 问题；合法时 undefined。
 */
export function checkSharePath(path: string): SharePathProblem | undefined {
  if (path === '' || path.length > 200) {
    return { code: 'path_length', message: '路径为空或超过 200 字符' }
  }
  if (path.includes('\\')) {
    return { code: 'path_separator', message: '路径必须使用 / 分隔' }
  }
  if (/[\u0000-\u001f\u007f]/u.test(path)) {
    return { code: 'path_control', message: '路径含控制字符' }
  }
  if (/^[A-Za-z]:/u.test(path) || path.startsWith('/') || path.startsWith('//')) {
    return { code: 'path_absolute', message: '不允许绝对路径或盘符' }
  }
  if (!path.startsWith(`${SHARE_DIR}/`)) {
    return { code: 'path_root', message: `路径必须以 ${SHARE_DIR}/ 开头` }
  }
  const segments = path.split('/')
  if (segments.length < 2 || segments.length > 3) {
    return { code: 'path_depth', message: `只允许 ${SHARE_DIR}/ 根三份文件或 ${SHARE_DIR}/${SHARE_CHARTS}/<名字>.mjs` }
  }
  for (const segment of segments.slice(1)) {
    const problem = checkSegment(segment)
    if (problem !== undefined) return problem
  }
  const rest = segments.slice(1).join('/')
  if (segments.length === 2) {
    if (!isShareRootFile(rest)) {
      return { code: 'path_file', message: `${SHARE_DIR}/ 根只允许 ${SHARE_ROOT_FILES.join('、')}` }
    }
    return undefined
  }
  if (segments[1] !== SHARE_CHARTS) {
    return { code: 'path_dir', message: `${SHARE_DIR}/ 下只允许 ${SHARE_CHARTS}/ 子目录` }
  }
  if (!rest.endsWith(CHART_EXTENSION) || rest.length <= SHARE_CHARTS.length + 1 + CHART_EXTENSION.length) {
    return { code: 'path_extension', message: `图形脚本只允许 ${CHART_EXTENSION}` }
  }
  return undefined
}

/**
 * 校验一个路径段。
 * @param segment - 段名。
 * @returns 问题；合法时 undefined。
 */
function checkSegment(segment: string): SharePathProblem | undefined {
  if (segment === '' || segment === '.' || segment === '..') {
    return { code: 'path_traversal', message: '路径段不能为空、. 或 ..' }
  }
  if (segment.length > 64) {
    return { code: 'path_segment_length', message: '单个路径段不能超过 64 字符' }
  }
  if (!SEGMENT.test(segment)) {
    return { code: 'path_character', message: `路径段只允许字母、数字、. _ -：${segment}` }
  }
  if (segment.startsWith('.')) {
    return { code: 'path_hidden', message: `不允许隐藏文件或目录：${segment}` }
  }
  if (segment.endsWith('.') || segment.endsWith(' ')) {
    return { code: 'path_trailing', message: `路径段不能以点或空格结尾：${segment}` }
  }
  if (RESERVED_NAMES.test(segment)) {
    return { code: 'path_reserved', message: `Windows 保留名：${segment}` }
  }
  return undefined
}

/** 文件对应的展示语言。 */
export function languageOf(path: string): 'markdown' | 'json' | 'javascript' | 'text' {
  if (path.endsWith('.md')) return 'markdown'
  if (path.endsWith('.json')) return 'json'
  if (path.endsWith('.mjs') || path.endsWith('.js')) return 'javascript'
  return 'text'
}
