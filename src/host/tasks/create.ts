/**
 * 创建任务：先独占目录，再写内容，最后写注册表行。
 *
 * 目录已经存在属于可预期的冲突，映射成 409 / `conflict`。创建时用非递归
 * `mkdir` 抢占目录，因此两个并发请求只有一个能成功；失败的请求绝不能删除
 * 另一个请求刚刚建好的目录。
 */

import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { writeRuleContent } from '../../core/rule.js'
import type { ParsedSchedule } from '../../core/schedule-text.js'
import type { TaskListStore, TaskMeta } from '../../core/task-list.js'
import type { TaskRecord } from '../../protocol.js'
import { CACHE_DIR, META_DIR, SCRIPT_DIR } from '../config.js'
import { AppError } from '../errors.js'
import { folderNameOf } from '../naming.js'
import type { TaskRepository } from '../repository.js'

/** 创建任务的输入。 */
export interface CreateTaskInput {
  name: string
  details: string
  schedule: ParsedSchedule | undefined
  timeZone: string
}

/** 创建任务依赖。 */
export interface CreateTaskDeps {
  repository: TaskRepository
  store: () => TaskListStore
  workDir: () => string
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
  let id: string
  try {
    id = folderNameOf(input.name)
  } catch (error: unknown) {
    throw new AppError('invalid_input', 400, error instanceof Error ? error.message : String(error))
  }
  const folder = join(deps.workDir(), id)
  // The registry's directory must exist before the exclusive mkdir below.
  await deps.store().ensure()
  try {
    // Non-recursive on purpose: EEXIST is the claim that this request owns the
    // folder. A concurrent request with the same name must not clean it up.
    await mkdir(folder)
  } catch (error: unknown) {
    const code = (error as { code?: string }).code
    if (code === 'EEXIST' || code === 'ENOTEMPTY') {
      throw new AppError('conflict', 409, `已有同名任务目录：${id}。请换一个任务名称，或先删除该任务`)
    }
    throw new AppError('internal', 500, error instanceof Error ? error.message : String(error))
  }

  const meta: TaskMeta = {
    v: 2,
    id,
    name: input.name,
    createdAt: at.toISOString(),
    scheduleMode: input.schedule === undefined ? 'manual' : 'text',
    cron: input.schedule?.cron ?? null,
    scheduleText: input.schedule?.text ?? null,
    timeZone: input.timeZone,
    enabled: input.schedule !== undefined,
    historyDays: deps.defaultHistoryDays,
    sessionId: null,
    lastRunAt: null,
    lastStatus: null,
    lastDurationMs: null,
    lastRunId: null,
    lastError: null,
    updatedAt: at.toISOString(),
  }
  try {
    await mkdir(join(folder, META_DIR, CACHE_DIR), { recursive: true })
    await mkdir(join(folder, META_DIR, SCRIPT_DIR), { recursive: true })
    await writeRuleContent(folder, input.details)
    await deps.store().create(meta)
  } catch (error: unknown) {
    // We own the folder created above, so removing it cannot delete another
    // request's task. The registry row is only written on success.
    await rm(folder, { recursive: true, force: true }).catch(() => {})
    if ((error as { code?: string }).code === 'EEXIST') {
      throw new AppError('conflict', 409, `已有同名任务目录：${id}。请换一个任务名称，或先删除该任务`)
    }
    throw error
  }
  return await deps.repository.decorate(meta, input.details)
}
