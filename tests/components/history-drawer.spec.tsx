import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { HistoryDrawer } from '../../src/client/features/history/HistoryDrawer.tsx'
import { fakeApi } from '../fake-api.ts'
import { run, task } from '../fixtures.ts'

describe('HistoryDrawer', () => {
  it('加载并展示运行记录，点击“打开”跳到会话', async () => {
    const api = fakeApi({ listRuns: vi.fn(async () => [run()]) })
    const onOpenSession = vi.fn()
    const onClose = vi.fn()
    render(<HistoryDrawer api={api} task={task()} onClose={onClose} onOpenSession={onOpenSession} />)

    expect(await screen.findByText('2026-10-18 09:00')).toBeTruthy()
    expect(screen.getByText('成功')).toBeTruthy()
    expect(screen.getByText(/2026-10-18-090000\.md/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '打开' }))
    expect(onOpenSession).toHaveBeenCalledWith('session-1')
  })

  it('Esc 关闭抽屉', async () => {
    const api = fakeApi({ listRuns: vi.fn(async () => [run()]) })
    const onClose = vi.fn()
    render(<HistoryDrawer api={api} task={task()} onClose={onClose} onOpenSession={vi.fn()} />)
    await screen.findByText('2026-10-18 09:00')
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('空历史显示空态', async () => {
    const api = fakeApi({ listRuns: vi.fn(async () => []) })
    render(<HistoryDrawer api={api} task={task()} onClose={vi.fn()} onOpenSession={vi.fn()} />)
    expect(await screen.findByText('还没有运行记录。')).toBeTruthy()
  })

  it('加载失败显示原因与重试', async () => {
    const api = fakeApi({ listRuns: vi.fn(async () => { throw new Error('offline') }) })
    render(<HistoryDrawer api={api} task={task()} onClose={vi.fn()} onOpenSession={vi.fn()} />)
    expect(await screen.findByText('运行历史加载失败。')).toBeTruthy()
    expect(screen.getByText(/offline/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy()
  })
})
