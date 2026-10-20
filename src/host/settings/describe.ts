/**
 * 设置视图。
 *
 * 只读注册表元数据 + 一次目录 `stat`：不读任何 `rule.md`，也不跑迁移。
 */

import { stat } from 'node:fs/promises'
import type { SettingsView } from '../../protocol.js'
import type { TaskRepository } from '../repository.js'
import type { WorkspacePort } from '../ports.js'
import type { SettingsStore } from './store.js'
import { workspaceAt } from './workspace.js'

/** 设置视图服务。 */
export interface SettingsDescriber {
  describe(): Promise<SettingsView>
}

/** 设置视图依赖。 */
export interface SettingsDescriberDeps {
  settings: SettingsStore
  repository: TaskRepository
  workspaces: WorkspacePort
  pluginVersion: string
}

/**
 * 创建设置视图服务。
 * @param deps - 设置、只读计数与 Workspace 端口。
 * @returns 设置视图服务。
 */
export function createSettingsDescriber(deps: SettingsDescriberDeps): SettingsDescriber {
  return {
    async describe(): Promise<SettingsView> {
      const workDir = deps.settings.workDir()
      let dirExists = false
      try {
        dirExists = (await stat(workDir)).isDirectory()
      } catch {
        dirExists = false
      }
      let tasksTotal = 0
      let tasksEnabled = 0
      // Only count when the directory actually exists: reading a missing
      // directory is an empty list, not a reason to create one.
      if (dirExists) {
        try {
          const counts = await deps.repository.count()
          tasksTotal = counts.total
          tasksEnabled = counts.enabled
        } catch {
          // The settings page still opens; a broken registry counts as zero.
        }
      }
      return {
        workDir,
        defaultWorkDir: deps.settings.defaultWorkDir,
        savedWorkDir: deps.settings.settings().workDir ?? '',
        tasksTotal,
        tasksEnabled,
        dirExists,
        workspace: workspaceAt(deps.workspaces, workDir) ?? null,
        pluginVersion: deps.pluginVersion,
      }
    },
  }
}
