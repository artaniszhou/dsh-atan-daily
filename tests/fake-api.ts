/** 组件测试用的假 API：默认全部成功，用例按需覆盖单个方法。 */
import { vi } from 'vitest'
import type { AtanDailyApi } from '../src/client/api/tasks.ts'
import { settings, task } from './fixtures.ts'

/**
 * 造一个 API。
 * @param overrides - 需要替换的方法。
 * @returns 完整 API。
 */
export function fakeApi(overrides: Partial<AtanDailyApi> = {}): AtanDailyApi {
  return {
    listTasks: vi.fn(async () => [task()]),
    createTask: vi.fn(async input => task({ id: 'created', name: input.name })),
    patchTask: vi.fn(async (id: string) => task({ id })),
    deleteTask: vi.fn(async () => {}),
    runTask: vi.fn(async () => 'session-1'),
    listRuns: vi.fn(async () => []),
    openSession: vi.fn(async () => 'session-1'),
    loadSettings: vi.fn(async () => settings()),
    saveWorkDir: vi.fn(async (workDir: string | null) => settings({
      workDir: workDir ?? '/default',
      savedWorkDir: workDir ?? '',
    })),
    createDirectory: vi.fn(async () => settings()),
    ...overrides,
  }
}
