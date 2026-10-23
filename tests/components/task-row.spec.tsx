import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TaskRow } from '../../src/client/features/list/TaskRow.tsx'
import type { BotView } from '../../src/protocol.ts'
import { task } from '../fixtures.ts'

/** 一个机器人。 */
function bot(id: string, name = `机器人 ${id}`): BotView {
  return {
    botId: id,
    channel: 'feishu',
    name,
    appIdMasked: 'cli_aaaa••••0001',
    domain: 'feishu',
    createdAt: '2026-10-01T00:00:00.000Z',
    lastSend: null,
  }
}

/**
 * 渲染一行并返回回调。
 * @param overrides - 任务覆盖字段。
 * @param bots - 可用的机器人。
 */
function renderRow(overrides: Parameters<typeof task>[0] = {}, bots: BotView[] = []) {
  const handlers = {
    onRun: vi.fn(),
    onToggle: vi.fn(),
    onOpen: vi.fn(),
    onHistory: vi.fn(),
    onEdit: vi.fn(),
    onRemove: vi.fn(),
    onManagePush: vi.fn(),
  }
  render(<ul><TaskRow task={task(overrides)} bots={bots} {...handlers} /></ul>)
  return handlers
}

describe('TaskRow', () => {
  it('展示名称、详情、时间与状态', () => {
    renderRow()
    expect(screen.getByText('版本反馈')).toBeTruthy()
    expect(screen.getByText('收集版本发布后的用户反馈')).toBeTruthy()
    expect(screen.getByText(/每天 9 点 · Asia\/Shanghai/)).toBeTruthy()
    expect(screen.getByText('已启用')).toBeTruthy()
  })

  it('六个行操作各自回调', () => {
    const handlers = renderRow()
    fireEvent.click(screen.getByRole('button', { name: /执行一次: 版本反馈/ }))
    fireEvent.click(screen.getByRole('switch', { name: /已启用/ }))
    fireEvent.click(screen.getByRole('button', { name: /历史: 版本反馈/ }))
    fireEvent.click(screen.getByRole('button', { name: /会话: 版本反馈/ }))
    fireEvent.click(screen.getByRole('button', { name: /编辑: 版本反馈/ }))
    fireEvent.click(screen.getByRole('button', { name: /删除: 版本反馈/ }))
    expect(handlers.onRun).toHaveBeenCalledOnce()
    expect(handlers.onToggle).toHaveBeenCalledOnce()
    expect(handlers.onHistory).toHaveBeenCalledOnce()
    expect(handlers.onOpen).toHaveBeenCalledOnce()
    expect(handlers.onEdit).toHaveBeenCalledOnce()
    expect(handlers.onRemove).toHaveBeenCalledOnce()
  })

  it('卡片右下角只有目标图标与「推送管理」，不再有绿色推送开关', () => {
    const handlers = renderRow(
      { pushBotIds: ['b1', 'b2'], pushEnabled: true },
      [bot('b1', '阿碳'), bot('b2', '小助手')],
    )
    // 任务行只剩左侧那枚定时开关。
    expect(screen.getAllByRole('switch')).toHaveLength(1)
    expect(screen.getAllByTitle(/^(阿碳|小助手)$/)).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: '推送管理' }))
    expect(handlers.onManagePush).toHaveBeenCalledOnce()
  })

  it('推送暂停时目标图标仍在，并标明已暂停', () => {
    renderRow({ pushBotIds: ['b1'], pushEnabled: false }, [bot('b1', '阿碳')])
    expect(screen.getByRole('img', { name: '阿碳 · 推送已暂停' })).toBeTruthy()
    expect(screen.getAllByTitle(/^阿碳$/)).toHaveLength(1)
  })

  it('图标最多 5 个，超出部分不画', () => {
    const ids = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6']
    renderRow(
      { pushBotIds: ids, pushEnabled: true },
      ids.map(id => bot(id)),
    )
    expect(screen.getAllByTitle(/^机器人 b\d$/)).toHaveLength(5)
  })

  it('没有目标时只留「推送管理」入口', () => {
    const handlers = renderRow()
    expect(screen.getAllByRole('switch')).toHaveLength(1)
    expect(screen.queryByRole('img')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '推送管理' }))
    expect(handlers.onManagePush).toHaveBeenCalledOnce()
  })

  it('执行中的行禁用执行与删除，并显示执行中', () => {
    renderRow({ running: true })
    const runButton = screen.getByRole('button', { name: /执行一次: 版本反馈/ }) as HTMLButtonElement
    expect(runButton.disabled).toBe(true)
    expect(runButton.textContent).toBe('执行中…')
    expect((screen.getByRole('button', { name: /删除: 版本反馈/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('没有 cron 的任务开关不可用', () => {
    renderRow({ cron: undefined })
    expect((screen.getByRole('switch', { name: /已启用 — 到点自动执行/ }) as HTMLInputElement).disabled).toBe(true)
    expect(screen.getByText('未设时间')).toBeTruthy()
  })
})
