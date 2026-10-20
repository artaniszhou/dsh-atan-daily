import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TaskRow } from '../../src/client/features/list/TaskRow.tsx'
import { task } from '../fixtures.ts'

/**
 * 渲染一行并返回回调。
 * @param overrides - 任务覆盖字段。
 */
function renderRow(overrides: Parameters<typeof task>[0] = {}) {
  const handlers = {
    onRun: vi.fn(),
    onToggle: vi.fn(),
    onOpen: vi.fn(),
    onHistory: vi.fn(),
    onEdit: vi.fn(),
    onRemove: vi.fn(),
  }
  render(<ul><TaskRow task={task(overrides)} {...handlers} /></ul>)
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
    fireEvent.click(screen.getByRole('switch'))
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

  it('执行中的行禁用执行与删除，并显示执行中', () => {
    renderRow({ running: true })
    const runButton = screen.getByRole('button', { name: /执行一次: 版本反馈/ }) as HTMLButtonElement
    expect(runButton.disabled).toBe(true)
    expect(runButton.textContent).toBe('执行中…')
    expect((screen.getByRole('button', { name: /删除: 版本反馈/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('没有 cron 的任务开关不可用', () => {
    renderRow({ cron: undefined })
    expect((screen.getByRole('switch') as HTMLInputElement).disabled).toBe(true)
    expect(screen.getByText('未设时间')).toBeTruthy()
  })
})
