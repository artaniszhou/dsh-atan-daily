import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createBotService, WELCOME_TEXT } from '../../src/host/im/service.ts'
import { BotStore } from '../../src/host/im/store.ts'
import type { FeishuClient } from '../../src/host/im/feishu-api.ts'
import type { CredentialsPort, Logger } from '../../src/host/ports.ts'

const roots: string[] = []
const logger: Logger = { info: () => {}, warn: () => {}, run: () => {} }

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** 临时目录。 */
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'atan-im-'))
  roots.push(dir)
  return dir
}

/** 假的凭据库。 */
interface FakeCredentials extends CredentialsPort {
  values: Map<string, string>
}

/**
 * 造一个内存凭据库。
 * @returns 凭据端口 + 可断言的值表。
 */
function fakeCredentials(): FakeCredentials {
  const values = new Map<string, string>()
  return {
    values,
    resolve: async (ref: string) => values.has(ref) ? { value: values.get(ref) as string } : undefined,
    set: async (ref: string, value: string) => { values.set(ref, value) },
    unset: async (ref: string) => { values.delete(ref) },
  }
}

/** 假的飞书客户端。 */
function fakeClient(): FeishuClient & { texts: string[], files: string[], uploads: number } {
  const texts: string[] = []
  const files: string[] = []
  const client = {
    texts,
    files,
    uploads: 0,
    token: async () => 'token',
    botInfo: async () => ({ name: '测试机器人', openId: 'ou_bot' }),
    sendText: async (_app: unknown, _openId: string, text: string) => { texts.push(text) },
    uploadFile: async (_app: unknown, name: string) => { client.uploads += 1; return `key-${name}` },
    sendFile: async (_app: unknown, _openId: string, fileKey: string) => { files.push(fileKey) },
    forget: () => {},
  }
  return client
}

/** 造一个扫码会立即成功的 registerApp。 */
function instantRegisterApp() {
  return async (options: Record<string, unknown>) => {
    const onQr = options['onQRCodeReady'] as (info: unknown) => void
    onQr({ url: 'https://accounts.feishu.cn/open-apis/authen/v1/device', expireIn: 300 })
    return {
      client_id: 'cli_test123456789',
      client_secret: 'secret-value',
      user_info: { open_id: 'ou_owner', tenant_brand: 'feishu' },
    }
  }
}

/** 轮询到终态。 */
async function settle<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  let last = await read()
  for (let index = 0; index < 200 && !done(last); index += 1) {
    await new Promise(resolve => setTimeout(resolve, 5))
    last = await read()
  }
  return last
}

describe('bot service', () => {
  it('扫码成功后写凭据、存记录并发欢迎消息', async () => {
    const dir = await tempDir()
    const store = new BotStore(join(dir, 'bots.json'))
    const credentials = fakeCredentials()
    const client = fakeClient()
    const service = createBotService({
      store,
      credentials,
      client,
      logger,
      registerApp: instantRegisterApp(),
      makeQr: async () => 'data:image/png;base64,QUJD',
    })

    const started = await service.beginProvision()
    expect(started.state).toBe('waiting')
    expect(started.qrCodeDataUrl).toBe('data:image/png;base64,QUJD')

    const finished = await settle(
      () => service.pollProvision(started.attemptId),
      view => !['starting', 'waiting', 'saving'].includes(view.state),
    )
    expect(finished.state).toBe('connected')

    const [bot] = await store.list()
    expect(bot?.platformId).toBe('cli_test123456789')
    expect(bot?.ownerId).toBe('ou_owner')
    expect(bot?.name).toBe('测试机器人')
    expect([...credentials.values.values()]).toEqual(['secret-value'])
    expect(client.texts).toEqual([WELCOME_TEXT])

    // 落盘文件里不能出现 secret。
    expect(await readFile(join(dir, 'bots.json'), 'utf8')).not.toContain('secret-value')
  })

  it('发送报告会先上传再发文件，并记录发送结果', async () => {
    const dir = await tempDir()
    const store = new BotStore(join(dir, 'bots.json'))
    const credentials = fakeCredentials()
    const client = fakeClient()
    const service = createBotService({ store, credentials, client, logger })

    const botId = 'fs_abc123'
    await store.put({
      botId,
      channel: 'feishu',
      platformId: 'cli_test123456789',
      secretRef: 'ATAN_FEISHU_ABC',
      ownerId: 'ou_owner',
      domain: 'feishu',
      name: '测试机器人',
      createdAt: new Date(0).toISOString(),
    })
    await credentials.set('ATAN_FEISHU_ABC', 'secret-value')

    const folder = join(dir, '任务')
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, '2026-10-22-090000.md'), '# 报告', 'utf8')

    const task = {
      id: '任务',
      name: '任务',
      details: '',
      frequency: 'daily' as const,
      createdAt: new Date(0).toISOString(),
      folder,
      historyCount: 0,
      scheduleMode: 'manual' as const,
      timeZone: 'UTC',
      enabled: true,
      historyDays: 7,
      report: '2026-10-22-090000.md',
      pushBotIds: [botId],
      pushEnabled: true,
    }

    const outcome = await service.sendReport(task)
    expect(outcome).toEqual({ ok: true, sent: 1, total: 1 })
    expect(client.uploads).toBe(1)
    expect(client.texts).toEqual(['任务 · 2026-10-22-090000.md'])
    expect(client.files).toEqual(['key-2026-10-22-090000.md'])
    expect((await store.get(botId))?.lastSend?.ok).toBe(true)
  })

  it('用本次运行的报告名推送，而不是任务快照里的上一份', async () => {
    const dir = await tempDir()
    const store = new BotStore(join(dir, 'bots.json'))
    const credentials = fakeCredentials()
    const client = fakeClient()
    const service = createBotService({ store, credentials, client, logger })
    await store.put({
      botId: 'fs_a', channel: 'feishu', platformId: 'cli_a', secretRef: 'REF_A',
      ownerId: 'ou_a', domain: 'feishu', name: 'A', createdAt: new Date(0).toISOString(),
    })
    await credentials.set('REF_A', 'secret-a')
    const folder = join(dir, 't')
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, '2026-10-21-090000.md'), '# 上一轮', 'utf8')
    await writeFile(join(folder, '2026-10-22-090000.md'), '# 本轮', 'utf8')

    const task = {
      id: 't', name: 't', details: '', frequency: 'daily' as const, createdAt: new Date(0).toISOString(),
      folder, historyCount: 0, scheduleMode: 'manual' as const, timeZone: 'UTC', enabled: true,
      historyDays: 7, report: '2026-10-21-090000.md', pushBotIds: ['fs_a'], pushEnabled: true,
    }

    const outcome = await service.sendReport(task, '2026-10-22-090000.md')
    expect(outcome).toEqual({ ok: true, sent: 1, total: 1 })
    expect(client.files).toEqual(['key-2026-10-22-090000.md'])
    expect(client.texts).toEqual(['t · 2026-10-22-090000.md'])
  })

  it('报告已经归档到 history 时仍能推送', async () => {
    const dir = await tempDir()
    const store = new BotStore(join(dir, 'bots.json'))
    const credentials = fakeCredentials()
    const client = fakeClient()
    const service = createBotService({ store, credentials, client, logger })
    await store.put({
      botId: 'fs_a', channel: 'feishu', platformId: 'cli_a', secretRef: 'REF_A',
      ownerId: 'ou_a', domain: 'feishu', name: 'A', createdAt: new Date(0).toISOString(),
    })
    await credentials.set('REF_A', 'secret-a')
    const folder = join(dir, 't')
    await mkdir(join(folder, 'history'), { recursive: true })
    await writeFile(join(folder, 'history', '2026-10-22-090000.md'), '# 已归档', 'utf8')

    const task = {
      id: 't', name: 't', details: '', frequency: 'daily' as const, createdAt: new Date(0).toISOString(),
      folder, historyCount: 1, scheduleMode: 'manual' as const, timeZone: 'UTC', enabled: true,
      historyDays: 7, report: '2026-10-22-090000.md', pushBotIds: ['fs_a'], pushEnabled: true,
    }

    expect(await service.sendReport(task)).toEqual({ ok: true, sent: 1, total: 1 })
    expect(client.uploads).toBe(1)
  })

  it('报告抬头发送失败不影响文件投递', async () => {
    const dir = await tempDir()
    const store = new BotStore(join(dir, 'bots.json'))
    const credentials = fakeCredentials()
    const client = fakeClient()
    client.sendText = async () => { throw new Error('抬头失败') }
    const service = createBotService({ store, credentials, client, logger })
    await store.put({
      botId: 'fs_a', channel: 'feishu', platformId: 'cli_a', secretRef: 'REF_A',
      ownerId: 'ou_a', domain: 'feishu', name: 'A', createdAt: new Date(0).toISOString(),
    })
    await credentials.set('REF_A', 'secret-a')
    const folder = join(dir, 't')
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, '2026-10-22-090000.md'), '# 报告', 'utf8')

    const task = {
      id: 't', name: 't', details: '', frequency: 'daily' as const, createdAt: new Date(0).toISOString(),
      folder, historyCount: 0, scheduleMode: 'manual' as const, timeZone: 'UTC', enabled: true,
      historyDays: 7, report: '2026-10-22-090000.md', pushBotIds: ['fs_a'], pushEnabled: true,
    }

    expect(await service.sendReport(task)).toEqual({ ok: true, sent: 1, total: 1 })
    expect(client.files).toEqual(['key-2026-10-22-090000.md'])
  })

  it('机器人不存在或凭据缺失时返回稳定错误码', async () => {
    const dir = await tempDir()
    const store = new BotStore(join(dir, 'bots.json'))
    const credentials = fakeCredentials()
    const service = createBotService({ store, credentials, client: fakeClient(), logger })
    const base = {
      id: 't', name: 't', details: '', frequency: 'daily' as const, createdAt: new Date(0).toISOString(),
      folder: dir, historyCount: 0, scheduleMode: 'manual' as const, timeZone: 'UTC', enabled: true,
      historyDays: 7, report: 'x.md',
    }
    expect(await service.sendReport({ ...base, pushBotIds: ['fs_missing'], pushEnabled: true })).toMatchObject({ ok: false, code: 'bot_missing' })

    await store.put({
      botId: 'fs_known', channel: 'feishu', platformId: 'cli_x', secretRef: 'REF_X',
      ownerId: 'ou', domain: 'feishu', name: 'x', createdAt: new Date(0).toISOString(),
    })
    expect(await service.sendReport({ ...base, pushBotIds: ['fs_known'], pushEnabled: true })).toMatchObject({ ok: false, code: 'credentials_missing' })
  })

  it('一个任务可以推给多个机器人，个别失败不影响其余', async () => {
    const dir = await tempDir()
    const store = new BotStore(join(dir, 'bots.json'))
    const credentials = fakeCredentials()
    const client = fakeClient()
    const service = createBotService({ store, credentials, client, logger })

    await store.put({
      botId: 'fs_a', channel: 'feishu', platformId: 'cli_a', secretRef: 'REF_A',
      ownerId: 'ou_a', domain: 'feishu', name: 'A', createdAt: new Date(0).toISOString(),
    })
    await credentials.set('REF_A', 'secret-a')
    await mkdir(join(dir, 't'), { recursive: true })
    await writeFile(join(dir, 't', 'r.md'), '# 报告', 'utf8')

    const base = {
      id: 't', name: 't', details: '', frequency: 'daily' as const, createdAt: new Date(0).toISOString(),
      folder: join(dir, 't'), historyCount: 0, scheduleMode: 'manual' as const, timeZone: 'UTC', enabled: true,
      historyDays: 7, report: 'r.md', pushEnabled: true,
    }

    const outcome = await service.sendReport({ ...base, pushBotIds: ['fs_a', 'fs_missing'] })
    expect(outcome).toMatchObject({ ok: false, code: 'bot_missing', sent: 1, total: 2 })
    expect(client.uploads).toBe(1)
    expect((await store.get('fs_a'))?.lastSend?.ok).toBe(true)
  })
})

describe('bot store', () => {
  it('名称落盘后可直接读回，迁移旧 alias 字段', async () => {
    const dir = await tempDir()
    const path = join(dir, 'bots.json')
    const store = new BotStore(path)
    await store.put({
      botId: 'fs_1', channel: 'feishu', platformId: 'cli_1', secretRef: 'REF_1',
      ownerId: 'ou_1', domain: 'feishu', name: '日报助手', createdAt: new Date(0).toISOString(),
    })
    expect((await store.get('fs_1'))?.name).toBe('日报助手')
    await store.remove('fs_1')
    expect(await store.list()).toEqual([])
  })
})
