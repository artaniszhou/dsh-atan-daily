/**
 * 创建任务：先独占目录，再写内容，最后写注册表行。
 *
 * 目录已经存在属于可预期的冲突，映射成 409 / `conflict`。创建时用非递归
 * `mkdir` 抢占目录，因此两个并发请求只有一个能成功；失败的请求绝不能删除
 * 另一个请求刚刚建好的目录。
 */

import { mkdir, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { writeTaskDetail } from '../../core/documents.js'
import { writeAtomic } from '../../core/fs.js'
import type { ParsedSchedule } from '../../core/schedule-text.js'
import type { TaskMeta } from '../../core/task-list.js'
import {
  DEFAULT_OUTPUT_FORMAT,
  DEFAULT_PERMISSION_LEVEL,
  type OutputFormat,
  type PermissionLevel,
  type TaskRecord,
} from '../../protocol.js'
import { CONTRACT_NAME } from '../../report/contract.js'
import { BUILD_DIR, CACHE_DIR, CHARTS_DIR, HISTORY_DIR, META_DIR, SCRIPT_DIR, SHARE_DIR } from '../config.js'
import { AppError } from '../errors.js'
import { folderNameOf } from '../naming.js'
import type { TaskRepository } from '../repository.js'
import type { Workspace } from '../settings/hub.js'

/** 创建任务的输入。 */
export interface CreateTaskInput {
  name: string
  details: string
  schedule: ParsedSchedule | undefined
  timeZone: string
  /** 加载任务时一并写入 `.share/task-schema.json`。 */
  schema?: string
  /** 加载任务时的默认值覆盖。 */
  historyDays?: number
  permissionLevel?: PermissionLevel
  outputFormat?: OutputFormat
  newSession?: boolean
  enabled?: boolean
}

/** 创建任务依赖。 */
export interface CreateTaskDeps {
  repository: TaskRepository
  /** 当前工作区；未配置时抛 `no_workspace`。 */
  workspace: () => Workspace
  defaultHistoryDays: number
}

/**
 * 创建一个任务。
 * @param deps - 注册表、工作目录与读模型。
 * @param input - 已校验的输入。
 * @returns 创建后的任务视图。
 */
export async function createTask(deps: CreateTaskDeps, input: CreateTaskInput): Promise<TaskRecord> {
  const at = new Date()
  const name = input.name.trim()
  let folderName: string
  try {
    folderName = folderNameOf(name)
  } catch (error: unknown) {
    throw new AppError('invalid_input', 400, error instanceof Error ? error.message : String(error))
  }
  const workspace = deps.workspace()
  const folder = join(workspace.root, folderName)
  // The registry's directory must exist before the exclusive mkdir below.
  await workspace.store.ensure()
  try {
    // Non-recursive on purpose: EEXIST is the claim that this request owns the
    // folder. A concurrent request with the same name must not clean it up.
    await mkdir(folder)
  } catch (error: unknown) {
    const code = (error as { code?: string }).code
    if (code === 'EEXIST' || code === 'ENOTEMPTY') {
      throw new AppError('conflict', 409, `已有同名任务目录：${folderName}。请换一个任务名称，或先删除该任务`)
    }
    throw new AppError('internal', 500, error instanceof Error ? error.message : String(error))
  }

  const meta: TaskMeta = {
    v: 3,
    taskId: randomUUID(),
    folder: folderName,
    name,
    createdAt: at.toISOString(),
    scheduleMode: input.schedule === undefined ? 'manual' : 'text',
    cron: input.schedule?.cron ?? null,
    scheduleText: input.schedule?.text ?? null,
    timeZone: input.timeZone,
    enabled: input.enabled ?? input.schedule !== undefined,
    historyDays: input.historyDays ?? deps.defaultHistoryDays,
    pushBotIds: [],
    pushEnabled: false,
    newSession: input.newSession ?? true,
    permissionLevel: input.permissionLevel ?? DEFAULT_PERMISSION_LEVEL,
    outputFormat: input.outputFormat ?? DEFAULT_OUTPUT_FORMAT,
    sessionId: null,
    lastRunAt: null,
    lastStatus: null,
    lastDurationMs: null,
    lastRunId: null,
    lastError: null,
    updatedAt: at.toISOString(),
  }
  try {
    // `.share/` 是随任务上传的部分；`.meta/` 只放本地运行资料。
    await mkdir(join(folder, SHARE_DIR, CHARTS_DIR), { recursive: true })
    await mkdir(join(folder, META_DIR, CACHE_DIR), { recursive: true })
    await mkdir(join(folder, META_DIR, SCRIPT_DIR), { recursive: true })
    await mkdir(join(folder, META_DIR, BUILD_DIR), { recursive: true })
    // 与 .meta/ 同级：归档更早的报告，任务根只留最新一份。
    await mkdir(join(folder, HISTORY_DIR), { recursive: true })
    // 任务内容由用户维护；执行清单（task-pipeline.json）首轮由工具 bootstrap 生成。
    await writeTaskDetail(folder, input.details)
    if (input.schema !== undefined && input.schema.trim() !== '') {
      await writeAtomic(join(folder, SHARE_DIR, CONTRACT_NAME), input.schema)
    }
    await workspace.store.create(meta)
  } catch (error: unknown) {
    // We own the folder created above, so removing it cannot delete another
    // request's task. The registry row is only written on success.
    await rm(folder, { recursive: true, force: true }).catch(() => {})
    if ((error as { code?: string }).code === 'EEXIST') {
      throw new AppError('conflict', 409, `已有同名任务目录：${folderName}。请换一个任务名称，或先删除该任务`)
    }
    throw error
  }
  return await deps.repository.decorate(meta, input.details)
}
