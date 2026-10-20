/**
 * 设置存储：`settings.json` 的读写与当前工作目录切换。
 *
 * 设置文件固定在 `settingsRoot` 下，绝不随工作目录移动；工作目录变化时
 * 重建对应的任务注册表（`TaskListStore`）。
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeAtomic } from '../../core/fs.js'
import { TaskListStore } from '../../core/task-list.js'
import type { Logger } from '../ports.js'

/** 已保存的设置形状；缺少 `workDir` 表示使用默认目录。 */
export interface SavedSettings {
  workDir?: string
}

/** 设置服务。 */
export interface SettingsStore {
  /** 插件固定的设置根。 */
  readonly settingsRoot: string
  /** 未保存覆盖时的默认工作目录。 */
  readonly defaultWorkDir: string
  /** 新任务的默认保留天数。 */
  readonly historyDays: number
  /** 当前工作目录。 */
  workDir(): string
  /** 当前工作目录对应的任务注册表。 */
  store(): TaskListStore
  /** 已保存的设置快照（不可变）。 */
  settings(): SavedSettings
  /** 切换到另一个工作目录（不写设置文件）。 */
  useWorkDir(path: string): void
  /** 读取设置文件；缺失或损坏时回退默认值。 */
  load(): Promise<void>
  /** 切换工作目录并持久化；`null` 清除已保存目录、回到默认目录。 */
  save(next: { workDir: string | null }): Promise<void>
}

/** 设置服务依赖。 */
export interface SettingsStoreDeps {
  settingsRoot: string
  defaultWorkDir: string
  historyDays: number
  logger: Logger
}

/**
 * 创建设置服务。
 * @param deps - 根目录、默认工作目录与日志。
 * @returns 设置服务。
 */
export function createSettingsStore(deps: SettingsStoreDeps): SettingsStore {
  const settingsFile = join(deps.settingsRoot, 'settings.json')
  let currentWorkDir = deps.defaultWorkDir
  let currentStore = createStore(currentWorkDir)
  let saved: SavedSettings = {}

  function createStore(workDir: string): TaskListStore {
    return new TaskListStore(workDir, {
      defaultHistoryDays: deps.historyDays,
      warn: (message: string) => {
        deps.logger.warn(message)
      },
    })
  }

  return {
    settingsRoot: deps.settingsRoot,
    defaultWorkDir: deps.defaultWorkDir,
    historyDays: deps.historyDays,
    workDir: () => currentWorkDir,
    store: () => currentStore,
    settings: () => saved,
    useWorkDir(path: string): void {
      currentWorkDir = path
      currentStore = createStore(path)
    },
    async load(): Promise<void> {
      // 异步读期间若用户已经保存，保存的值必须胜出：按对象身份判断。
      const seen = saved
      let loadedWorkDir: string | undefined
      try {
        const parsed = JSON.parse(await readFile(settingsFile, 'utf8')) as { workDir?: unknown }
        const workDir = parsed.workDir
        if (typeof workDir === 'string' && workDir.trim() !== '') loadedWorkDir = workDir.trim()
      } catch {
        // 没有设置文件（或读不动）就是「使用默认目录」。
      }
      if (saved !== seen) return
      saved = {
        ...loadedWorkDir === undefined ? {} : { workDir: loadedWorkDir },
      }
      currentWorkDir = loadedWorkDir ?? deps.defaultWorkDir
      currentStore = createStore(currentWorkDir)
    },
    async save(next: { workDir: string | null }): Promise<void> {
      const clearing = next.workDir === null
      const workDir = next.workDir ?? deps.defaultWorkDir
      // "No saved directory" stays as no key, so the configured default keeps
      // applying until the page actually pins a path. A null PATCH clears the
      // key instead of pinning today's default into the file.
      const nextSaved: SavedSettings = clearing ? {} : { workDir }
      // Persist before switching: a failed write must not move the runtime to
      // a directory the settings file does not record.
      await writeAtomic(settingsFile, `${JSON.stringify(nextSaved, null, 2)}\n`)
      saved = nextSaved
      if (workDir !== currentWorkDir) {
        currentWorkDir = workDir
        currentStore = createStore(workDir)
      }
    },
  }
}
