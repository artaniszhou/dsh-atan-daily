/**
 * 机器人管理的 HTTP 路由。
 *
 * 挂在前缀 `/api/atan-daily/im` 下；只做四件事：解析路径、校验入参、
 * 调服务、写 JSON。所有错误都交给 `guard` 统一映射。
 */

import { HOST_IM_ROUTE } from '../../protocol.js'
import { AppError } from '../errors.js'
import type { RouteHandler } from '../ports.js'
import { answer, methodNotAllowed, pathnameOf, readJsonBody } from '../http/server.js'
import type { BotService } from '../im/service.js'

/** 机器人名称长度上限。 */
const NAME_MAX = 24

/** 路由处理器。 */
export interface BotRoutes {
  handler: RouteHandler
}

/** 从 pathname 切出相对前缀的片段。 */
function segmentsOf(pathname: string): string[] | undefined {
  const prefix = `${HOST_IM_ROUTE}/`
  if (pathname === HOST_IM_ROUTE) return []
  if (!pathname.startsWith(prefix)) return undefined
  return pathname.slice(prefix.length).split('/').filter(segment => segment !== '')
}

/** 安全的单段 id。 */
function readId(value: string | undefined): string {
  if (value === undefined || !/^[A-Za-z0-9_-]{1,64}$/u.test(value)) {
    throw new AppError('invalid_input', 400, '无效的机器人或任务标识')
  }
  return value
}

/**
 * 创建机器人路由。
 * @param service - 机器人服务。
 * @returns 前缀路由处理器。
 */
export function createBotRoutes(service: BotService): BotRoutes {
  const handler: RouteHandler = async (request, response) => {
    const segments = segmentsOf(pathnameOf(request))
    if (segments === undefined) {
      throw new AppError('not_found', 404, 'not found')
    }
    const method = (request.method ?? 'GET').toUpperCase()

    // GET /im/status —— 机器人列表 + 进行中的扫码
    if (segments.length === 1 && segments[0] === 'status') {
      if (method !== 'GET') {
        methodNotAllowed(response, method)
        return
      }
      answer(response, 200, { ok: true, ...await service.status() })
      return
    }

    // POST /im/feishu/provision —— 开始扫码
    if (segments.length === 2 && segments[0] === 'feishu' && segments[1] === 'provision') {
      if (method !== 'POST') {
        methodNotAllowed(response, method)
        return
      }
      // 名称可选：预填成飞书应用名，也是本机显示名。
      const payload = await readJsonBody(request)
      const record = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : {}
      const rawName = record['name']
      if (rawName !== undefined && typeof rawName !== 'string') {
        throw new AppError('invalid_input', 400, 'name 必须是字符串')
      }
      const name = typeof rawName === 'string' ? rawName.trim() : ''
      if (name.length > NAME_MAX) {
        throw new AppError('invalid_input', 400, `名称不能超过 ${String(NAME_MAX)} 个字符`)
      }
      answer(response, 200, {
        ok: true,
        provisioning: await (name === '' ? service.beginProvision() : service.beginProvision(name)),
      })
      return
    }

    // GET|DELETE /im/provision/:id
    if (segments.length === 2 && segments[0] === 'provision') {
      const attemptId = readId(segments[1])
      if (method === 'GET') {
        answer(response, 200, { ok: true, provisioning: await service.pollProvision(attemptId) })
        return
      }
      if (method === 'DELETE') {
        answer(response, 200, { ok: true, provisioning: await service.cancelProvision(attemptId) })
        return
      }
      methodNotAllowed(response, method)
      return
    }

    // DELETE /im/bots/:id —— 只断开本机连接；飞书侧应用需要用户自行删除。
    if (segments.length === 2 && segments[0] === 'bots') {
      const botId = readId(segments[1])
      if (method === 'DELETE') {
        answer(response, 200, { ok: true, ...await service.remove(botId) })
        return
      }
      methodNotAllowed(response, method)
      return
    }

    throw new AppError('not_found', 404, 'not found')
  }
  return { handler }
}
