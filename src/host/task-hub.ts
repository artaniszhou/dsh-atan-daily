/**
 * 任务仓库桥接：把本地任务作为版本提交给 atan-admin-server，并把上架任务加载回本地。
 *
 * 提交请求体只有两块：身份（uid / taskId / submitter）与 task（即 task.json）。
 * 包内不含任何身份信息；taskId 来自本地任务元数据（创建时生成的 UUID）。
 */

import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { TaskRecord } from '../protocol.js'
import { isOutputFormat, type OutputFormat } from '../protocol.js'
import type { ParsedSchedule } from '../core/schedule-text.js'
import { parseScheduleText } from '../core/schedule-text.js'
import { isKnownTimeZone } from '../core/cron.js'
import { browserAvailable } from '../report/render/pdf.js'
import { scanFiles, type ScanFinding } from '../core/scan.js'
import { checkSharePath, SHARE_DIR } from '../core/share.js'
import { writeAtomic } from '../core/fs.js'
import type { AccountIdentity, AccountProvider } from './account.js'
import { AppError } from './errors.js'
import { answer, readJsonBody } from './http/server.js'
import type { Logger, RouteHandler, RouteRequest } from './ports.js'
import type { TaskRepository } from './repository.js'
import type { CreateTaskInput } from './tasks/create.js'
import {
  PackError,
  buildTaskPackage,
  type BuildResult,
  type ShareFile,
  type TaskSubmitter,
} from './task-pack.js'

/** 仓库里的一件任务（公开视图，不含 uid / taskId）。 */
export interface RemoteTaskView {
  publicId: string
  name: string
  summary: string
  tags: string[]
  version: number
  loadCount: number
  updatedAt: number
}

/** 路由依赖。 */
export interface TaskHubDeps {
  /** 每次请求现取：页面改了地址不用重启宿主。 */
  serverBaseUrl: () => string
  account: AccountProvider
  repository: TaskRepository
  createTask: (input: CreateTaskInput) => Promise<TaskRecord>
  /** 新建任务后让调度器重新装载定时器。 */
  refreshSchedule: () => Promise<void>
  logger: Logger
}

const PREFIX = '/atan-daily/task-hub'

/** 预览/提交的请求体：`id` 是本地任务目录名。 */
interface PackageRequest {
  task: TaskRecord
  details: string
}

/**
 * 创建任务仓库路由。
 * @param deps - 服务地址、账号、任务库。
 * @returns 路由处理器。
 */
export function createTaskHub(deps: TaskHubDeps): RouteHandler {
  return async (request, response) => {
    const path = pathnameOf(request)
    const action = path.startsWith(`${PREFIX}/`) ? path.slice(PREFIX.length + 1) : ''
    if (action === 'account') {
      if ((request.method ?? 'GET') !== 'GET') throw new AppError('invalid_input', 405, 'method not allowed')
      answer(response, 200, { ok: true, account: await deps.account.resolve() })
      return
    }
    if ((request.method ?? 'GET') !== 'POST') throw new AppError('invalid_input', 405, 'method not allowed')
    const body = asRecord(await readJsonBody(request))

    if (action === 'preview') {
      const account = await requireAccount(deps)
      const input = await readPackageRequest(deps, body)
      const built = await guardPack(() => buildTaskPackage({ task: input.task, details: input.details }))
      answer(response, 200, {
        ok: true,
        account,
        files: built.files,
        totals: built.totals,
        scan: {
          ok: built.scan.ok,
          block: built.scan.block,
          warn: built.scan.warn,
          info: built.scan.info,
          findings: built.scan.findings,
        },
        package: built.package,
      })
      return
    }

    if (action === 'submit') {
      const account = await requireAccount(deps)
      const input = await readPackageRequest(deps, body)
      const built = await guardPack(() => buildTaskPackage({ task: input.task, details: input.details }))
      const result = await postServer(deps, 'submit', {
        uid: account.uid,
        taskId: input.task.taskId,
        submitter: submitterOf(account),
        task: {
          schemaVersion: 2,
          kind: 'atan-daily/task',
          name: built.package.name,
          summary: built.package.summary,
          tags: built.package.tags,
          defaults: built.package.defaults,
          files: built.package.files,
        },
      })
      answer(response, 200, { ok: true, ...result })
      return
    }

    if (action === 'warehouse') {
      const result = await postServer(deps, 'list', {
        q: optionalString(body['q']),
        sort: optionalString(body['sort']) ?? 'latest',
        page: numberOr(body['page'], 1),
        pageSize: numberOr(body['pageSize'], 20),
      })
      answer(response, 200, { ok: true, ...result })
      return
    }

    if (action === 'detail') {
      const publicId = requiredString(body['publicId'], 'publicId')
      const result = await postServer(deps, 'detail', { publicId })
      answer(response, 200, { ok: true, ...result })
      return
    }

    if (action === 'load') {
      const publicId = requiredString(body['publicId'], 'publicId')
      const result = await postServer(deps, 'load', { publicId })
      const pkg = asRemotePackage(result['task'])
      const fields = validateRemoteFiles(pkg.files)
      const scheduleText = optionalString(body['schedule']) ?? pkg.defaults.schedule
      const timeZone = optionalString(body['timeZone']) ?? pkg.defaults.timeZone
      if (!isKnownTimeZone(timeZone)) {
        throw new AppError('invalid_input', 400, `未知时区：${timeZone}`)
      }
      let schedule: ParsedSchedule | undefined
      if (scheduleText !== '' && scheduleText !== '仅手动') {
        try {
          schedule = parseScheduleText(scheduleText)
        } catch (error: unknown) {
          throw new AppError('invalid_input', 400, error instanceof Error ? error.message : String(error))
        }
      }
      const name = optionalString(body['name']) ?? pkg.name
      const requestedFormat = isOutputFormat(pkg.defaults.outputFormat) ? pkg.defaults.outputFormat : undefined
      const outputFormat = browserAvailable() ? (requestedFormat ?? 'png') : 'pdf'
      // 加载即分叉：本地新建任务，taskId 由 createTask 重新生成。
      const task = await deps.createTask({
        name,
        details: fields.detail,
        schedule,
        timeZone,
        schema: fields.schema,
        historyDays: pkg.defaults.historyDays,
        permissionLevel: pkg.defaults.permissionLevel === 'danger-full-access' ? 'danger-full-access' : 'workspace-write',
        outputFormat,
        newSession: pkg.defaults.newSession,
        enabled: body['enabled'] === false ? false : schedule !== undefined,
      })
      await writeExtraShareFiles(task.folder, fields.files)
      deps.logger.info(`loaded task ${publicId} as ${task.taskId} (${String(fields.files.length)} files)`)
      await deps.refreshSchedule()
      answer(response, 201, { ok: true, task })
      return
    }

    throw new AppError('not_found', 404, 'not found')
  }
}

/** 读取本地任务并解析详情。 */
async function readPackageRequest(deps: TaskHubDeps, body: Record<string, unknown>): Promise<PackageRequest> {
  const taskId = requiredString(body['taskId'], 'taskId')
  const task = await deps.repository.read(taskId)
  if (task === undefined) throw new AppError('not_found', 404, '任务不存在')
  return { task, details: optionalString(body['details']) ?? task.details }
}

/** 把组包错误映射成 400。 */
async function guardPack(run: () => Promise<BuildResult>): Promise<BuildResult> {
  try {
    return await run()
  } catch (error: unknown) {
    if (error instanceof PackError) throw new AppError('invalid_input', 400, error.message)
    throw error
  }
}

/** 服务端返回的任务包形状（只取用到的字段）。 */
interface RemotePackage {
  name: string
  defaults: {
    schedule: string
    timeZone: string
    historyDays: number
    permissionLevel: string
    outputFormat?: OutputFormat
    newSession: boolean
  }
  files: ShareFile[]
}

/** 校验服务端返回的包结构。 */
function asRemotePackage(value: unknown): RemotePackage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AppError('internal', 502, '任务包格式不正确')
  }
  const record = value as Record<string, unknown>
  const defaults = record['defaults']
  const files = record['files']
  if (typeof record['name'] !== 'string' || typeof defaults !== 'object' || defaults === null || !Array.isArray(files)) {
    throw new AppError('internal', 502, '任务包缺少 name/defaults/files')
  }
  return record as unknown as RemotePackage
}

/**
 * 校验下载到的文件，并取出三份固定文档。
 * @param files - 服务端返回的文件列表。
 * @returns 详情、契约与其余待写文件。
 */
function validateRemoteFiles(files: readonly ShareFile[]): {
  detail: string
  schema: string
  files: ShareFile[]
} {
  if (files.length === 0) throw new AppError('invalid_input', 400, '任务包没有文件')
  const seen = new Set<string>()
  for (const file of files) {
    if (typeof file.path !== 'string' || typeof file.content !== 'string') {
      throw new AppError('invalid_input', 400, '任务包里的文件必须是 { path, content }')
    }
    const problem = checkSharePath(file.path)
    if (problem !== undefined) {
      throw new AppError('invalid_input', 400, `任务包含非法路径：${file.path}（${problem.message}）`)
    }
    if (seen.has(file.path)) throw new AppError('invalid_input', 400, `任务包含重复文件：${file.path}`)
    seen.add(file.path)
  }
  const scan = scanFiles(files)
  if (!scan.ok) {
    const first: ScanFinding | undefined = scan.findings.find(item => item.severity === 'block')
    throw new AppError('invalid_input', 400, `任务包未通过静态检查：${first?.path ?? ''} ${first?.message ?? ''}`.trim())
  }
  const detail = files.find(file => file.path === `${SHARE_DIR}/task-detail.md`)
  const schema = files.find(file => file.path === `${SHARE_DIR}/task-schema.json`)
  if (detail === undefined || schema === undefined) {
    throw new AppError('invalid_input', 400, '任务包缺少 task-detail.md 或 task-schema.json')
  }
  return {
    detail: detail.content,
    schema: schema.content,
    files: files.filter(file => file.path !== detail.path && file.path !== schema.path),
  }
}

/** 写展示覆盖与图形脚本；详情与契约由 createTask 写入。 */
async function writeExtraShareFiles(folder: string, files: readonly ShareFile[]): Promise<void> {
  for (const file of files) {
    const target = join(folder, file.path)
    await mkdir(dirname(target), { recursive: true })
    await writeAtomic(target, file.content)
  }
}

function pathnameOf(request: RouteRequest): string {
  try {
    return new URL(request.url ?? '/', 'http://atan-daily.invalid').pathname
  } catch {
    return '/'
  }
}

async function requireAccount(deps: TaskHubDeps): Promise<AccountIdentity> {
  const account = await deps.account.resolve()
  if (!account.signedIn) {
    throw new AppError('invalid_input', 401, '请先登录 DeepSeek 后再上传')
  }
  if (!account.complete) {
    throw new AppError('invalid_input', 400, '当前账号缺少账号 ID，无法上传')
  }
  return account
}

function submitterOf(account: AccountIdentity): TaskSubmitter {
  return {
    uid: account.uid,
    email: account.email,
    phone: account.phone,
    ...account.realNameId === '' ? {} : { realNameId: account.realNameId },
  }
}

async function postServer(deps: TaskHubDeps, action: string, body: unknown): Promise<Record<string, any>> {
  const baseUrl = deps.serverBaseUrl()
  if (baseUrl === '') {
    throw new AppError('invalid_input', 400, '任务仓库地址未配置，请在页面的「任务仓库地址」里填写')
  }
  let response: Response
  try {
    response = await fetch(`${baseUrl}/api/atan-daily/task/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    })
  } catch (error: unknown) {
    deps.logger.warn(`task hub ${action} failed: ${error instanceof Error ? error.message : String(error)}`)
    throw new AppError('internal', 502, '任务仓库暂不可用，请稍后重试')
  }
  let payload: Record<string, any>
  try {
    payload = await response.json() as Record<string, any>
  } catch {
    throw new AppError('internal', 502, '任务仓库返回了无法解析的响应')
  }
  if (!response.ok || payload['code'] !== 200) {
    const message = typeof payload['msg'] === 'string' ? payload['msg'] : `任务仓库返回 HTTP ${String(response.status)}`
    throw new AppError(response.status === 400 ? 'invalid_input' : 'internal', response.status, message)
  }
  const data = payload['data']
  if (typeof data !== 'object' || data === null) throw new AppError('internal', 502, '任务仓库响应缺少 data')
  return data as Record<string, any>
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AppError('invalid_input', 400, '请求体必须是对象')
  }
  return value as Record<string, unknown>
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function requiredString(value: unknown, name: string): string {
  const text = optionalString(value)
  if (text === undefined) throw new AppError('invalid_input', 400, `${name} 不能为空`)
  return text
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
