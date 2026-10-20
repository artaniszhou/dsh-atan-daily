import { describe, expect, it, vi } from 'vitest'
import { createApi } from '../src/client/api/tasks.ts'
import { HostError } from '../src/client/api/errors.ts'
import { REQUEST_TIMEOUT_MS } from '../src/client/constants.ts'
import type { HttpPort, HttpResponse } from '../src/client/platform/http.ts'
import { task } from './fixtures.ts'

/**
 * 造一个响应。
 * @param status - HTTP 状态码。
 * @param body - JSON 值，或直接作为文本的字符串。
 * @returns 最小响应面。
 */
function respond(status: number, body: unknown): HttpResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }
}

describe('createApi', () => {
  it('解码任务列表', async () => {
    const port: HttpPort = async () => respond(200, { ok: true, tasks: [task()] })
    await expect(createApi(port).listTasks()).resolves.toEqual([task()])
  })

  it('创建任务走 POST 并带 JSON body', async () => {
    let seenPath = ''
    let seenMethod = ''
    let seenBody = ''
    const port: HttpPort = async (path, init) => {
      seenPath = path
      seenMethod = init?.method ?? ''
      seenBody = init?.body ?? ''
      return respond(200, { ok: true, task: task({ name: '新任务' }) })
    }
    const created = await createApi(port).createTask({
      name: '新任务', details: '详情', schedule: '每天 9 点', timeZone: 'Asia/Shanghai',
    })
    expect(created.name).toBe('新任务')
    expect(seenPath).toBe('atan-daily/tasks')
    expect(seenMethod).toBe('POST')
    expect(JSON.parse(seenBody)).toEqual({
      name: '新任务', details: '详情', schedule: '每天 9 点', timeZone: 'Asia/Shanghai',
    })
  })

  it('HTTP 400 带出 Host 的原始原因', async () => {
    const port: HttpPort = async () => respond(400, { ok: false, error: 'unknown time zone' })
    await expect(createApi(port).createTask({
      name: 'x', details: '', schedule: '', timeZone: 'Bad/Zone',
    })).rejects.toMatchObject({ code: 'invalid-input', detail: 'unknown time zone' })
  })

  it('删除时 404 视为已成功', async () => {
    const port: HttpPort = async () => respond(404, { ok: false, error: 'not found' })
    await expect(createApi(port).deleteTask('gone')).resolves.toBeUndefined()
  })

  it('非 JSON 响应归为 invalid-response', async () => {
    const port: HttpPort = async () => respond(200, '<html>fallback</html>')
    await expect(createApi(port).listTasks()).rejects.toMatchObject({ code: 'invalid-response' })
  })

  it('字段缺失归为 invalid-response', async () => {
    const port: HttpPort = async () => respond(200, { ok: true, tasks: [{ id: 'x' }] })
    await expect(createApi(port).listTasks()).rejects.toMatchObject({ code: 'invalid-response' })
  })

  it('网络失败归为 network', async () => {
    const port: HttpPort = async () => { throw new Error('offline') }
    await expect(createApi(port).listTasks()).rejects.toBeInstanceOf(HostError)
    await expect(createApi(port).listTasks()).rejects.toMatchObject({ code: 'network' })
  })

  it('超时被 abort 并归为 timeout', async () => {
    vi.useFakeTimers()
    try {
      const port: HttpPort = (_path, init) => new Promise<HttpResponse>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
      const pending = createApi(port).listTasks()
      const assertion = expect(pending).rejects.toMatchObject({ code: 'timeout' })
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })
})
