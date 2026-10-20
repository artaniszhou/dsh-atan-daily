/**
 * 启动恢复：把上一次 Host 生命周期里遗留的 `running` 记录改成 `interrupted`。
 *
 * 只扫描保留期内的记录。只读任务列表来自 repository，不触发迁移/写注册表。
 */

import { listRunsSince, type RunRecord } from '../../core/runs.js'
import type { Logger } from '../ports.js'
import type { TaskRepository } from '../repository.js'
import type { RunRecords } from './records.js'

/** 恢复服务依赖。 */
export interface RunRecoveryDeps {
  repository: TaskRepository
  records: RunRecords
  logger: Logger
  bootId: string
  clock?: () => number
}

/** 恢复服务。 */
export interface RunRecovery {
  sweep: () => Promise<void>
}

/**
 * 创建启动恢复服务。
 * @param deps - 读模型、运行记录与 boot id。
 * @returns 恢复服务。
 */
export function createRunRecovery(deps: RunRecoveryDeps): RunRecovery {
  const now = (): number => deps.clock?.() ?? Date.now()

  return {
    async sweep(): Promise<void> {
      const tasks = await deps.repository.list()
      for (const task of tasks) {
        const since = task.historyDays > 0
          ? now() - (task.historyDays + 1) * 24 * 60 * 60 * 1000
          : 0
        let records: RunRecord[]
        try {
          records = await listRunsSince(task.folder, since)
        } catch (error: unknown) {
          deps.logger.warn(`could not scan runs of ${task.id}: ${String(error)}`)
          continue
        }
        for (const record of records) {
          if (record.status !== 'running' || record.bootId === deps.bootId) continue
          try {
            await deps.records.interrupt(task, record)
          } catch (error: unknown) {
            deps.logger.warn(`could not mark ${record.runId} interrupted: ${String(error)}`)
          }
        }
        await deps.records.prune(task).catch((error: unknown) => {
          deps.logger.warn(`could not prune the history of ${task.id}: ${String(error)}`)
        })
      }
    },
  }
}
