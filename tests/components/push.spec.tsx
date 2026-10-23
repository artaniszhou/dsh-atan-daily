import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PushDrawer } from '../../src/client/features/push/PushDrawer.tsx'
import type { BotView } from '../../src/protocol.ts'
import { task } from '../fixtures.ts'

/** 一个机器人。 */
function bot(id: string, overrides: Partial<BotView> = {}): BotView {
  return {
    botId: id,
    channel: 'feishu',
    name: `机器人 ${id}`,
    appIdMasked: 'cli_aaaa••••0001',
    domain: 'feishu',
    createdAt: '2026-10-01T00:00:00.000Z',
    lastSend: null,
    ...overrides,
  }
}

describe('PushDrawer', () => {
  it('一个机器人一行，开关按任务当前目标决定状态', () => {
    const onToggle = vi.fn()
    render(
      <PushDrawer
        task={task({ pushBotIds: ['b1'], pushEnabled: true })}
        bots={[bot('b1', { lastSend: { at: '2026-10-01T00:00:00.000Z', ok: true } }), bot('b2')]}
        onToggle={onToggle}
        onToggleEnabled={vi.fn()}
        onClose={vi.fn()}
        onManageBots={vi.fn()}
      />,
    )
    // 副标题点明是哪个任务。
    expect(screen.getByText(/「版本反馈」运行成功后/)).toBeTruthy()
    expect(screen.getByText(/上次发送成功/)).toBeTruthy()

    fireEvent.click(screen.getByRole('switch', { name: '关闭报告推送: 机器人 b1' }))
    expect(onToggle).toHaveBeenCalledWith('b1', false)

    fireEvent.click(screen.getByRole('switch', { name: '开启报告推送: 机器人 b2' }))
    expect(onToggle).toHaveBeenCalledWith('b2', true)
  })

  it('有目标时提供总开关，关掉只暂停、选择保留', () => {
    const onToggleEnabled = vi.fn()
    render(
      <PushDrawer
        task={task({ pushBotIds: ['b1'], pushEnabled: true })}
        bots={[bot('b1')]}
        onToggle={vi.fn()}
        onToggleEnabled={onToggleEnabled}
        onClose={vi.fn()}
        onManageBots={vi.fn()}
      />,
    )
    expect(screen.getByText('报告推送')).toBeTruthy()
    expect(screen.getByText(/关掉只暂停发送/)).toBeTruthy()
    // 机器人行上的开关叫「关闭报告推送: 机器人 b1」，总开关只叫「关闭报告推送」。
    fireEvent.click(screen.getByRole('switch', { name: '关闭报告推送' }))
    expect(onToggleEnabled).toHaveBeenCalledWith(false)
  })

  it('有目标但推送暂停时总开关是关的，并给出提醒', () => {
    render(
      <PushDrawer
        task={task({ pushBotIds: ['b1'], pushEnabled: false })}
        bots={[bot('b1')]}
        onToggle={vi.fn()}
        onToggleEnabled={vi.fn()}
        onClose={vi.fn()}
        onManageBots={vi.fn()}
      />,
    )
    const master = screen.getByRole('switch', { name: '开启报告推送' }) as HTMLInputElement
    expect(master.checked).toBe(false)
    expect(screen.getByText(/推送已暂停/)).toBeTruthy()
  })

  it('没有目标时不显示总开关', () => {
    render(
      <PushDrawer
        task={task()}
        bots={[bot('b1')]}
        onToggle={vi.fn()}
        onToggleEnabled={vi.fn()}
        onClose={vi.fn()}
        onManageBots={vi.fn()}
      />,
    )
    expect(screen.queryByText('报告推送')).toBeNull()
  })

  it('没有机器人时给接入入口', () => {
    const onManageBots = vi.fn()
    render(
      <PushDrawer
        task={task()}
        bots={[]}
        onToggle={vi.fn()}
        onToggleEnabled={vi.fn()}
        onClose={vi.fn()}
        onManageBots={onManageBots}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '接入机器人' }))
    expect(onManageBots).toHaveBeenCalledOnce()
  })
})
