/**
 * `settings.json` 的读写。
 *
 * 只负责持久化：不持有「当前工作目录」这类运行时状态，那属于 `settings/hub`。
 * 文件缺失、字段类型不对、地址手改坏了，一律按「没有这一项覆盖」处理。
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeAtomic } from '../../core/fs.js'
import { normalizeBaseUrl } from '../config.js'

/** 已保存的设置形状；缺少字段表示没有覆盖。 */
export interface SavedSettings {
  workDir?: string
  serverBaseUrl?: string
}

/** 设置文件。 */
export interface SettingsFile {
  /** 文件绝对路径。 */
  readonly path: string
  /** 读取设置；缺失或损坏的部分按「没有覆盖」返回。 */
  load(): Promise<SavedSettings>
  /** 原子写入设置。 */
  save(settings: SavedSettings): Promise<void>
}

/**
 * 创建设置文件。
 * @param settingsRoot - 插件固定的设置根。
 * @returns 设置文件读写。
 */
export function createSettingsFile(settingsRoot: string): SettingsFile {
  const path = join(settingsRoot, 'settings.json')
  return {
    path,
    async load(): Promise<SavedSettings> {
      let parsed: { workDir?: unknown, serverBaseUrl?: unknown }
      try {
        parsed = JSON.parse(await readFile(path, 'utf8')) as { workDir?: unknown, serverBaseUrl?: unknown }
      } catch {
        return {}
      }
      const saved: SavedSettings = {}
      const workDir = parsed.workDir
      if (typeof workDir === 'string' && workDir.trim() !== '') saved.workDir = workDir.trim()
      const serverBaseUrl = parsed.serverBaseUrl
      if (typeof serverBaseUrl === 'string' && serverBaseUrl.trim() !== '') {
        try {
          saved.serverBaseUrl = normalizeBaseUrl(serverBaseUrl, 'serverBaseUrl')
        } catch {
          // 手改坏的地址按「没有覆盖」处理，别让它挡住插件启动。
        }
      }
      return saved
    },
    async save(settings: SavedSettings): Promise<void> {
      await writeAtomic(path, `${JSON.stringify(settings, null, 2)}\n`)
    },
  }
}
