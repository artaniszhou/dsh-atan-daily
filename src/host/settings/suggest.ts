/**
 * 建议工作目录。
 *
 * 只给「用户还没选过目录」的页面一个可点的默认值，不参与任何生效判定。
 * Windows 优先 `文档`，取不到就退回家目录；macOS 与 Linux 用家目录下自建目录，
 * 避开 TCC 受保护目录（Documents / Desktop / Downloads）。
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 建议目录的输入。 */
export interface SuggestedWorkDirOptions {
  /** yaml 的 `dataDir`；有值时直接作为建议值，供私有部署统一引导。 */
  configured?: string
  platform?: NodeJS.Platform
  /** 用户主目录。 */
  home?: string
  /** 目录是否存在；测试可注入。 */
  exists?: (path: string) => boolean
}

/**
 * 计算建议工作目录。
 * @param options - 配置覆盖、平台与主目录。
 * @returns 绝对路径。
 */
export function suggestedWorkDir(options: SuggestedWorkDirOptions = {}): string {
  const configured = options.configured?.trim()
  if (configured !== undefined && configured !== '') return configured
  const platform = options.platform ?? process.platform
  const home = options.home ?? homedir()
  const exists = options.exists ?? existsSync
  if (platform === 'win32') {
    const documents = join(home, 'Documents')
    // 中文系统与 OneDrive 重定向下可能没有字面 `Documents`，探测失败就退回家目录。
    return exists(documents) ? join(documents, 'DSH', 'atan-daily') : join(home, 'DSH', 'atan-daily')
  }
  return join(home, 'DSH', 'atan-daily')
}
