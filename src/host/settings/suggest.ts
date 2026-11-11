/**
 * 建议工作区。
 *
 * 只给「用户还没选过工作区」的页面一个可点的默认值，不参与任何生效判定。
 *
 * 取法按可靠性排序：
 *  1. yaml 的 `dataDir`（显式覆盖）；
 *  2. 注册表里的默认工作区 `<…>/deepseek-harness/default-workspace`，取父目录再拼 `atan-daily`
 *     —— 这样天然尊重 DSH 的 `documentsDirectory` 配置；
 *  3. 按平台探测系统 Documents 目录，再拼 `deepseek-harness/atan-daily`；
 *  4. 回退 `~/DSH/atan-daily`。
 */

import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, dirname, join, posix, win32 } from 'node:path'
import type { SuggestedWorkDirSource } from '../../protocol.js'
import { validateWorkspacePath } from './paths.js'

/** 一次建议值：绝对路径、所在父目录与来源。 */
export interface WorkspaceSuggestion {
  path: string
  parent: string
  source: SuggestedWorkDirSource
}

/** 原生命令执行器；测试可注入。 */
export type NativeRunner = (command: string, args: readonly string[], timeoutMs: number) => Promise<string>

/** 建议值计算的输入。 */
export interface SuggestWorkspaceOptions {
  /** yaml 的 `dataDir`：显式覆盖，优先级最高。 */
  configured?: string
  /** 已注册工作区，用来找 DSH 的默认工作区。 */
  workspaces?: readonly { path?: string }[]
  platform?: NodeJS.Platform
  home?: string
  /** 执行系统目录探测命令；缺省用 `execFile`。 */
  run?: NativeRunner
  /** 单次探测超时。 */
  timeoutMs?: number
}

/** 建议值里的目录名。 */
const LEAF = 'atan-daily'

/** 默认工作区的父目录名（DSH 的 `<Documents>/deepseek-harness`）。 */
const DEFAULT_PARENT_LEAF = 'deepseek-harness'

/** 默认工作区的目录名（DSH 的 `default-workspace`）。 */
const DEFAULT_WORKSPACE_LEAF = 'default-workspace'

/** 默认探测超时：设置页不该被系统命令卡住。 */
const DEFAULT_TIMEOUT_MS = 3000

/** 平台路径工具。 */
function pathApi(platform: NodeJS.Platform): typeof posix {
  return platform === 'win32' ? win32 : posix
}

/**
 * 用 `execFile` 跑一条探测命令。
 * @param command - 可执行文件。
 * @param args - 参数。
 * @param timeoutMs - 超时毫秒。
 * @returns stdout；失败时 reject。
 */
export const runNative: NativeRunner = (command, args, timeoutMs) => new Promise((resolve, reject) => {
  execFile(command, [...args], { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
    if (error !== null) {
      reject(error)
      return
    }
    resolve(String(stdout))
  })
})

/**
 * 从已注册工作区里找 DSH 默认工作区的父目录。
 * @param workspaces - 工作区行。
 * @param platform - 宿主平台。
 * @returns 父目录；找不到时为 undefined。
 */
export function defaultWorkspaceParent(
  workspaces: readonly { path?: string }[],
  platform: NodeJS.Platform,
): string | undefined {
  const api = pathApi(platform)
  const fold = (value: string): string => (platform === 'win32' ? value.toLowerCase() : value)
  for (const row of workspaces) {
    if (typeof row.path !== 'string' || row.path === '') continue
    const parent = api.dirname(row.path)
    if (fold(api.basename(row.path)) === DEFAULT_WORKSPACE_LEAF
      && fold(api.basename(parent)) === DEFAULT_PARENT_LEAF) {
      return parent
    }
  }
  return undefined
}

/**
 * 系统 Documents 目录。
 * @param platform - 宿主平台。
 * @param home - 用户主目录（Linux 用来识别被禁用的 Documents）。
 * @param run - 命令执行器。
 * @param timeoutMs - 超时。
 * @returns 绝对路径；取不到时 undefined。
 */
export async function documentsDirectory(
  platform: NodeJS.Platform,
  home: string,
  run: NativeRunner,
  timeoutMs: number,
): Promise<string | undefined> {
  try {
    let stdout: string
    if (platform === 'darwin') {
      stdout = await run('osascript', [
        '-e', 'POSIX path of (path to documents folder from user domain without folder creation)',
      ], timeoutMs)
    } else if (platform === 'win32') {
      stdout = await run('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); '
        + '[Environment]::GetFolderPath([Environment+SpecialFolder]::MyDocuments, '
        + '[Environment+SpecialFolderOption]::DoNotVerify)',
      ], timeoutMs)
    } else {
      stdout = await run('xdg-user-dir', ['DOCUMENTS'], timeoutMs)
    }
    const text = stdout.replace(/[\r\n]+$/u, '')
    if (text === '') return undefined
    // XDG 在目录被禁用时会回显家目录，这不是一个可用的 Documents。
    if (platform !== 'win32' && text === home) return undefined
    return text
  } catch {
    return undefined
  }
}

/** 用平台规则验证候选，通过时返回归一化路径。 */
function accept(path: string, platform: NodeJS.Platform): string | undefined {
  const result = validateWorkspacePath(path, platform)
  return result.ok ? result.normalized : undefined
}

/**
 * 不探测系统目录的初始建议值：有 `dataDir` 用它，否则家目录回退。
 * 页面首次读取设置时会再跑一次完整探测。
 * @param options - `dataDir`、平台与主目录。
 * @returns 建议路径、父目录与来源。
 */
export function initialSuggestion(options: {
  configured?: string
  platform?: NodeJS.Platform
  home?: string
} = {}): WorkspaceSuggestion {
  const platform = options.platform ?? process.platform
  const home = options.home ?? homedir()
  const api = pathApi(platform)
  const configured = options.configured?.trim()
  if (configured !== undefined && configured !== '') {
    const path = accept(configured, platform)
    if (path !== undefined) return { path, parent: api.dirname(path), source: 'config' }
  }
  const parent = api.join(home, 'DSH')
  return { path: api.join(parent, LEAF), parent, source: 'fallback' }
}

/**
 * 计算建议工作区。
 * @param options - 覆盖值、注册表、平台与探测依赖。
 * @returns 建议路径、父目录与来源。
 */
export async function resolveSuggestedWorkspace(
  options: SuggestWorkspaceOptions = {},
): Promise<WorkspaceSuggestion> {
  const platform = options.platform ?? process.platform
  const home = options.home ?? homedir()
  const api = pathApi(platform)
  const run = options.run ?? runNative
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const configured = options.configured?.trim()
  if (configured !== undefined && configured !== '') {
    const path = accept(configured, platform)
    if (path !== undefined) return { path, parent: api.dirname(path), source: 'config' }
  }

  const parent = defaultWorkspaceParent(options.workspaces ?? [], platform)
  if (parent !== undefined) {
    const path = accept(api.join(parent, LEAF), platform)
    if (path !== undefined) return { path, parent, source: 'default-workspace' }
  }

  const documents = await documentsDirectory(platform, home, run, timeoutMs)
  if (documents !== undefined) {
    const parentPath = accept(api.join(documents, DEFAULT_PARENT_LEAF), platform)
    if (parentPath !== undefined) {
      const path = accept(api.join(parentPath, LEAF), platform)
      if (path !== undefined) return { path, parent: parentPath, source: 'documents' }
    }
  }

  const fallbackParent = api.join(home, 'DSH')
  const fallback = accept(api.join(fallbackParent, LEAF), platform)
  return {
    path: fallback ?? api.join(fallbackParent, LEAF),
    parent: fallbackParent,
    source: 'fallback',
  }
}
