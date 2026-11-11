/**
 * 设置视图。
 *
 * 只读注册表元数据 + 一次目录 `stat`：不读任务文档，也不跑迁移。
 * 未配置工作目录时给出一份空视图（`workDirConfigured=false`），页面据此进入引导态。
 */

import { stat } from 'node:fs/promises'
import type { SettingsView } from '../../protocol.js'
import type { TaskRepository } from '../repository.js'
import type { WorkspacePort } from '../ports.js'
import type { WorkspaceHub } from './hub.js'
import { workspaceAt } from './workspace.js'

/** 设置视图服务。 */
export interface SettingsDescriber {
  describe(): Promise<SettingsView>
}

/** 设置视图依赖。 */
export interface SettingsDescriberDeps {
  /** 工作区状态与设置快照。 */
  hub: WorkspaceHub
  repository: TaskRepository
  workspaces: WorkspacePort
  pluginVersion: string
  /** 当前宿主是否找到可用于 PNG/PDF 的 Chrome/Edge。 */
  browserAvailable: () => boolean
}

/**
 * 创建设置视图服务。
 * @param deps - 工作区、只读计数与 Workspace 端口。
 * @returns 设置视图服务。
 */
export function createSettingsDescriber(deps: SettingsDescriberDeps): SettingsDescriber {
  return {
    async describe(): Promise<SettingsView> {
      const snapshot = deps.hub.snapshot()
      const workspace = deps.hub.current()
      let dirExists = false
      if (workspace !== null) {
        try {
          dirExists = (await stat(workspace.root)).isDirectory()
        } catch {
          dirExists = false
        }
      }
      let tasksTotal = 0
      let tasksEnabled = 0
      // Only count when the workspace exists: a missing directory is an empty
      // list, not a reason to create one.
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
        workDir: snapshot.workDir,
        workDirConfigured: snapshot.workDirConfigured,
        suggestedWorkDir: snapshot.suggestedWorkDir,
        savedWorkDir: snapshot.savedWorkDir,
        serverBaseUrl: snapshot.serverBaseUrl,
        savedServerBaseUrl: snapshot.savedServerBaseUrl,
        defaultServerBaseUrl: snapshot.defaultServerBaseUrl,
        tasksTotal,
        tasksEnabled,
        dirExists,
        workspace: workspace === null ? null : workspaceAt(deps.workspaces, workspace.root) ?? null,
        pluginVersion: deps.pluginVersion,
        browserAvailable: deps.browserAvailable(),
      }
    },
  }
}
