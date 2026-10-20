/**
 * Host 端点的类型化封装。
 *
 * 十个端点只在这里出现一次；组件永远拿到 `TaskRecord`/`RunRecord`/`SettingsView`，
 * 不再接触 `Record<string, unknown>`。
 */
import {
  ROUTES,
  RUN_PAGE_SIZE,
  type RunRecord,
  type SettingsView,
  type TaskPatch,
  type TaskRecord,
} from '../../protocol.ts'
import { browserHttp, type HttpPort } from '../platform/http.ts'
import { HostError } from './errors.ts'
import {
  decodeRunList,
  decodeSessionId,
  decodeSettings,
  decodeSingleTask,
  decodeTaskList,
  decodeVoid,
} from './guards.ts'
import { request } from './http.ts'

/** 新建任务的入参。 */
export interface CreateTaskInput {
  name: string
  details: string
  /** 用户口述的执行时间；空串表示只能手动执行。 */
  schedule: string
  timeZone: string
}

/** 页面能做的全部 host 操作。 */
export interface AtanDailyApi {
  listTasks(): Promise<TaskRecord[]>
  createTask(input: CreateTaskInput): Promise<TaskRecord>
  patchTask(id: string, patch: TaskPatch): Promise<TaskRecord>
  deleteTask(id: string): Promise<void>
  runTask(id: string): Promise<string | undefined>
  listRuns(id: string, before?: string): Promise<RunRecord[]>
  openSession(id: string): Promise<string | undefined>
  loadSettings(): Promise<SettingsView>
  saveWorkDir(workDir: string | null): Promise<SettingsView>
  createDirectory(): Promise<SettingsView>
}

/** 带 JSON 头的请求初始化。 */
function jsonInit(method: string, body?: unknown): { method: string, headers: Record<string, string>, body?: string } {
  return {
    method,
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }
}

/**
 * 创建一整套 API 方法。
 * @param port - HTTP 端口；测试注入假实现。
 * @returns 类型化的端点集合。
 */
export function createApi(port: HttpPort = browserHttp): AtanDailyApi {
  const taskPath = (id: string): string => `${ROUTES.tasks}/${encodeURIComponent(id)}`

  return {
    listTasks: () => request(port, ROUTES.tasks, decodeTaskList),

    createTask: input => request(port, ROUTES.tasks, decodeSingleTask, jsonInit('POST', input)),

    patchTask: (id, patch) => request(port, taskPath(id), decodeSingleTask, jsonInit('PATCH', patch)),

    deleteTask: async (id) => {
      try {
        await request(port, taskPath(id), decodeVoid, jsonInit('DELETE'))
      } catch (error) {
        // 目录已经不存在，等价于删除成功。
        if (error instanceof HostError && error.code === 'not-found') return
        throw error
      }
    },

    runTask: id => request(port, `${taskPath(id)}/run`, decodeSessionId, jsonInit('POST')),

    listRuns: (id, before) => {
      const query = before === undefined
        ? `?limit=${String(RUN_PAGE_SIZE)}`
        : `?limit=${String(RUN_PAGE_SIZE)}&before=${encodeURIComponent(before)}`
      return request(port, `${taskPath(id)}/runs${query}`, decodeRunList)
    },

    openSession: id => request(port, `${taskPath(id)}/session`, decodeSessionId, jsonInit('POST')),

    loadSettings: () => request(port, ROUTES.settings, decodeSettings),

    saveWorkDir: workDir => request(port, ROUTES.settings, decodeSettings, jsonInit('PATCH', { workDir })),

    createDirectory: () => request(port, `${ROUTES.settings}/directory`, decodeSettings, jsonInit('POST')),
  }
}
