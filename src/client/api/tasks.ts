/**
 * Host 端点的类型化封装。
 *
 * 十个端点只在这里出现一次；组件永远拿到 `TaskRecord`/`RunRecord`/`SettingsView`，
 * 不再接触 `Record<string, unknown>`。
 */
import {
  ROUTES,
  RUN_PAGE_SIZE,
  type AnnouncementView,
  type BotsStatus,
  type ProvisionView,
  type RunRecord,
  type SettingsView,
  type TaskPatch,
  type TaskRecord,
} from '../../protocol.ts'
import { browserHttp, type HttpPort } from '../platform/http.ts'
import { HostError } from './errors.ts'
import {
  decodeAnnouncement,
  decodeBotsStatus,
  decodeProvisionResponse,
  decodeRunList,
  decodeSessionId,
  decodeSettings,
  decodeSingleTask,
  decodeTaskList,
  decodeVoid,
} from './guards.ts'
import { request } from './http.ts'
import {
  decodeTaskHubDetail,
  decodeTaskHubLoadedTask,
  decodeTaskHubPreview,
  decodeTaskHubSubmit,
  decodeTaskHubWarehouse,
  type TaskHubLoadInput,
  type TaskHubPreview,
  type TaskHubSubmitInput,
  type TaskHubSubmitResult,
  type TaskHubTaskDetail,
  type TaskHubWarehouse,
} from './task-hub.ts'

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
  patchTask(taskId: string, patch: TaskPatch): Promise<TaskRecord>
  deleteTask(taskId: string): Promise<void>
  runTask(taskId: string): Promise<string | undefined>
  listRuns(taskId: string, before?: string): Promise<RunRecord[]>
  openSession(taskId: string): Promise<string | undefined>
  loadSettings(): Promise<SettingsView>
  /** 页面公告；`enabled=false` 表示当前没有公告。 */
  loadAnnouncement(): Promise<AnnouncementView>
  saveWorkDir(workDir: string | null): Promise<SettingsView>
  /** 保存任务仓库地址；null 清除覆盖、回到 yaml 默认值。 */
  saveServerBaseUrl(serverBaseUrl: string | null): Promise<SettingsView>
  createDirectory(): Promise<SettingsView>
  /** 机器人列表 + 进行中的扫码。 */
  loadBots(): Promise<BotsStatus>
  /** 开始一次飞书扫码；`name` 会写进飞书应用名，接入后不可修改。 */
  beginFeishuProvision(name?: string): Promise<ProvisionView>
  /** 拉一次扫码进度。 */
  pollProvision(attemptId: string): Promise<ProvisionView>
  /** 取消扫码。 */
  cancelProvision(attemptId: string): Promise<ProvisionView>
  /** 移除接入（只断开本机；飞书应用需用户自行删除）。 */
  removeBot(botId: string): Promise<BotsStatus>
  /** 预览将要提交的任务包（文件 + 元信息合并后的 JSON）；未登录时由 Host 拒绝。 */
  previewTaskUpload(input: TaskHubSubmitInput): Promise<TaskHubPreview>
  /** 提交任务包到任务管理服务。 */
  submitTask(input: TaskHubSubmitInput): Promise<TaskHubSubmitResult>
  /** 已上架任务列表。 */
  listTaskWarehouse(input: { q?: string, sort?: string, page?: number, pageSize?: number }): Promise<TaskHubWarehouse>
  /** 已上架任务详情（不含提交者身份）。 */
  detailTaskHubTask(publicId: string): Promise<TaskHubTaskDetail>
  /** 把上架任务复制成本地任务。 */
  loadRemoteTask(input: TaskHubLoadInput): Promise<TaskRecord>
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
  const taskPath = (taskId: string): string => `${ROUTES.tasks}/${encodeURIComponent(taskId)}`

  return {
    listTasks: () => request(port, ROUTES.tasks, decodeTaskList),

    createTask: input => request(port, ROUTES.tasks, decodeSingleTask, jsonInit('POST', input)),

    patchTask: (taskId, patch) => request(port, taskPath(taskId), decodeSingleTask, jsonInit('PATCH', patch)),

    deleteTask: async (taskId) => {
      try {
        await request(port, taskPath(taskId), decodeVoid, jsonInit('DELETE'))
      } catch (error) {
        // 目录已经不存在，等价于删除成功。
        if (error instanceof HostError && error.code === 'not-found') return
        throw error
      }
    },

    runTask: taskId => request(port, `${taskPath(taskId)}/run`, decodeSessionId, jsonInit('POST')),

    listRuns: (taskId, before) => {
      const query = before === undefined
        ? `?limit=${String(RUN_PAGE_SIZE)}`
        : `?limit=${String(RUN_PAGE_SIZE)}&before=${encodeURIComponent(before)}`
      return request(port, `${taskPath(taskId)}/runs${query}`, decodeRunList)
    },

    openSession: taskId => request(port, `${taskPath(taskId)}/session`, decodeSessionId, jsonInit('POST')),

    loadSettings: () => request(port, ROUTES.settings, decodeSettings),

    loadAnnouncement: () => request(port, ROUTES.announcement, decodeAnnouncement),

    saveWorkDir: workDir => request(port, ROUTES.settings, decodeSettings, jsonInit('PATCH', { workDir })),

    saveServerBaseUrl: serverBaseUrl => request(
      port,
      ROUTES.settings,
      decodeSettings,
      jsonInit('PATCH', { serverBaseUrl }),
    ),

    createDirectory: () => request(port, `${ROUTES.settings}/directory`, decodeSettings, jsonInit('POST')),

    loadBots: () => request(port, `${ROUTES.im}/status`, decodeBotsStatus),

    beginFeishuProvision: name => request(
      port,
      `${ROUTES.im}/feishu/provision`,
      decodeProvisionResponse,
      jsonInit('POST', name === undefined || name === '' ? {} : { name }),
    ),

    pollProvision: attemptId => request(port, `${ROUTES.im}/provision/${encodeURIComponent(attemptId)}`, decodeProvisionResponse),

    cancelProvision: attemptId => request(
      port,
      `${ROUTES.im}/provision/${encodeURIComponent(attemptId)}`,
      decodeProvisionResponse,
      jsonInit('DELETE'),
    ),

    removeBot: botId => request(
      port,
      `${ROUTES.im}/bots/${encodeURIComponent(botId)}`,
      decodeBotsStatus,
      jsonInit('DELETE'),
    ),

    previewTaskUpload: input => request(
      port,
      `${ROUTES.taskHub}/preview`,
      decodeTaskHubPreview,
      jsonInit('POST', input),
    ),

    submitTask: input => request(
      port,
      `${ROUTES.taskHub}/submit`,
      decodeTaskHubSubmit,
      jsonInit('POST', input),
    ),

    listTaskWarehouse: input => request(
      port,
      `${ROUTES.taskHub}/warehouse`,
      decodeTaskHubWarehouse,
      jsonInit('POST', input),
    ),

    detailTaskHubTask: publicId => request(
      port,
      `${ROUTES.taskHub}/detail`,
      decodeTaskHubDetail,
      jsonInit('POST', { publicId }),
    ),

    loadRemoteTask: input => request(
      port,
      `${ROUTES.taskHub}/load`,
      decodeTaskHubLoadedTask,
      jsonInit('POST', input),
    ),
  }
}
