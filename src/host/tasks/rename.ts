/**
 * 任务改名：目录名跟着任务名走。
 *
 * 主键是 `taskId`（UUID，改名不变），目录名只是 `folder`，所以改名 = 挪目录 +
 * 回写一行。两步之间任何一步失败都要还原：目录叫新名、注册表还是旧名，下次启动
 * 就会按 `folder` 找不到任务。
 */

import { rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { TaskMetaPatch } from '../../core/task-list.js'
import type { TaskRecord } from '../../protocol.js'
import { AppError } from '../errors.js'
import { folderNameOf } from '../naming.js'
import type { TaskRepository } from '../repository.js'
import type { Workspace } from '../settings/hub.js'

/** 改名依赖。 */
export interface RenameDeps {
  repository: TaskRepository
  /** 当前工作区；未配置时抛 `no_workspace`。 */
  workspace: () => Workspace
  /** 正在执行的任务不允许挪目录。 */
  isRunning: (taskId: string) => boolean
}

/**
 * 路径是否已存在（任何类型）。
 * @param path - 绝对路径。
 * @returns true 表示已占用。
 */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * 由任务名算出目录名；名称不能当目录用时返回 400。
 * @param name - 任务名。
 * @returns 目录名。
 */
function folderForName(name: string): string {
  try {
    return folderNameOf(name)
  } catch (error: unknown) {
    throw new AppError('invalid_input', 400, error instanceof Error ? error.message : String(error))
  }
}

/**
 * 应用一次元数据补丁；`name` 变化时同时把任务目录改成新名字。
 *
 * 目录名只跟随任务名：没有「目录与名称各改各的」这种隐性状态，`folder` 单独存
 * 列是为了让主键与路径解耦，不是为了允许两者长期不一致。
 * @param deps - 读模型、注册表、工作目录与运行态。
 * @param task - 当前任务。
 * @param patch - 元数据补丁，可含 `name`。
 * @returns 更新后的任务视图。
 */
export async function renameTask(
  deps: RenameDeps,
  task: TaskRecord,
  patch: TaskMetaPatch,
): Promise<TaskRecord> {
  const workspace = deps.workspace()
  const store = workspace.store
  // 目录名以注册表为准：`TaskRecord.folder` 是绝对路径，不能直接拿来拼。
  const meta = await store.get(task.taskId)
  if (meta === undefined) throw new AppError('not_found', 404, 'task not found')
  const nextName = patch.name ?? meta.name
  const nextFolder = nextName === meta.name ? meta.folder : folderForName(nextName)

  if (nextFolder === meta.folder) {
    await store.patch(task.taskId, patch)
    return await read(deps, task.taskId)
  }

  if (deps.isRunning(task.taskId)) {
    throw new AppError('already_running', 409, '任务正在执行，等这一轮结束再改名')
  }
  const root = workspace.root
  const from = join(root, meta.folder)
  const to = join(root, nextFolder)
  if (await exists(to)) {
    throw new AppError('conflict', 409, `已有同名任务目录：${nextFolder}。请换一个任务名称`)
  }
  try {
    await rename(from, to)
  } catch (error: unknown) {
    throw new AppError('internal', 500, `改名失败：${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    await store.patch(task.taskId, { ...patch, folder: nextFolder })
  } catch (error: unknown) {
    // 注册表没写成功就把目录挪回去，否则下次按 folder 找不到这个任务。
    await rename(to, from).catch(() => {})
    throw error
  }
  return await read(deps, task.taskId)
}

/**
 * 读回刚更新过的任务。
 * @param deps - 改名依赖。
 * @param taskId - 任务身份。
 * @returns 任务视图。
 */
async function read(deps: RenameDeps, taskId: string): Promise<TaskRecord> {
  const updated = await deps.repository.read(taskId)
  if (updated === undefined) throw new AppError('not_found', 404, 'task not found')
  return updated
}
