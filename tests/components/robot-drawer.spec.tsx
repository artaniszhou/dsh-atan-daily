import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { RobotDrawer } from '../../src/client/features/bots/RobotDrawer.tsx'
import type { BotsController } from '../../src/client/features/bots/useBots.ts'
import type { BotView } from '../../src/protocol.ts'

/** 造一个控制器。 */
function controller(overrides: Partial<BotsController> = {}): BotsController {
  return {
    phase: 'ready',
    bots: [],
    provisioning: null,
    error: '',
    justConnected: false,
    busy: false,
    reload: vi.fn(),
    begin: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    acknowledge: vi.fn(),
    clearError: vi.fn(),
    ...overrides,
  }
}

/** 一个已接入的机器人。 */
function bot(overrides: Partial<BotView> = {}): BotView {
  return {
    botId: 'fs_1',
    channel: 'feishu',
    name: '阿碳日报助手',
    appIdMasked: 'cli_a1b2••••9f3c',
    domain: 'feishu',
    createdAt: '2026-10-22T00:00:00.000Z',
    lastSend: { at: '2026-10-22T01:00:00.000Z', ok: true },
    ...overrides,
  }
}

describe('RobotDrawer', () => {
  it('空态只有一个接入口，平台卡片点进去进入扫码视图', () => {
    const bots = controller()
    render(<RobotDrawer bots={bots} onClose={() => {}} />)
    expect(screen.getByText('还没有接入机器人')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '接入机器人' }))
    expect(screen.getByText('飞书 / Lark')).toBeTruthy()
    // 规划中的平台也是卡片，但不可点。
    expect(screen.getByText('钉钉')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /钉钉/ })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /飞书 \/ Lark/ }))
    expect(screen.getByRole('button', { name: '生成二维码' })).toBeTruthy()
    expect(bots.begin).not.toHaveBeenCalled()
  })

  it('名称默认有值，改了之后点生成二维码才传给 begin', () => {
    const bots = controller()
    render(<RobotDrawer bots={bots} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '接入机器人' }))
    fireEvent.click(screen.getByRole('button', { name: /飞书 \/ Lark/ }))

    const input = screen.getByLabelText('名称') as HTMLInputElement
    expect(input.value).toBe('阿碳日报助手')
    fireEvent.change(input, { target: { value: '我的日报' } })
    fireEvent.click(screen.getByRole('button', { name: '生成二维码' }))
    expect(bots.begin).toHaveBeenCalledWith('我的日报')
  })

  it('扫码视图展示二维码与倒计时', () => {
    const bots = controller({
      provisioning: {
        attemptId: 'a1',
        state: 'waiting',
        qrCodeDataUrl: 'data:image/png;base64,QUJD',
        expiresAt: Date.now() + 120_000,
        pollIntervalMs: 1500,
      },
    })
    render(<RobotDrawer bots={bots} onClose={() => {}} />)
    const image = screen.getByRole('img', { name: '用飞书或 Lark 扫码' })
    expect(image.getAttribute('src')).toBe('data:image/png;base64,QUJD')
    expect(screen.getByText(/二维码 .* 后失效/)).toBeTruthy()
  })

  it('移除前给出停用与删除飞书应用的两步路径', () => {
    const bots = controller({ bots: [bot()] })
    render(<RobotDrawer bots={bots} onClose={() => {}} />)
    expect(screen.getByText('阿碳日报助手')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '移除' }))
    expect(screen.getByText(/飞书里的应用还在/)).toBeTruthy()

    // 第 1 步停用：路径落在管理后台；第 2 步删除：路径落在开发者后台。
    expect(screen.getByText(/工作台 → 应用管理/)).toBeTruthy()
    expect(screen.getByText(/凭证与基础信息/)).toBeTruthy()
    expect(screen.getByText(/已发布的应用要先停用才能删除/)).toBeTruthy()
    expect(screen.getByRole('link', { name: '打开管理后台' }).getAttribute('href')).toBe('https://www.feishu.cn/admin')
    expect(screen.getByRole('link', { name: '打开开发者后台' }).getAttribute('href')).toBe('https://open.feishu.cn/app')

    expect(bots.remove).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '确认移除' }))
    expect(bots.remove).toHaveBeenCalledWith('fs_1')
  })

  it('Lark 租户的入口指向 larksuite 域名', () => {
    const bots = controller({ bots: [bot({ domain: 'lark' })] })
    render(<RobotDrawer bots={bots} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '移除' }))
    expect(screen.getByRole('link', { name: '打开管理后台' }).getAttribute('href')).toBe('https://www.larksuite.com/admin')
    expect(screen.getByRole('link', { name: '打开开发者后台' }).getAttribute('href')).toBe('https://open.larksuite.com/app')
  })
})
