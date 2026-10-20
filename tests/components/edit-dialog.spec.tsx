import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { EditDialog } from '../../src/client/features/edit/EditDialog.tsx'
import { fakeApi } from '../fake-api.ts'
import { task } from '../fixtures.ts'

describe('EditDialog', () => {
  it('拒绝非法的历史保留天数', async () => {
    const api = fakeApi()
    render(<EditDialog api={api} task={task()} onClose={vi.fn()} onSaved={vi.fn()} />)

    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '-1' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    expect((await screen.findByRole('alert')).textContent).toContain('历史保留天数必须是 0–3650 的整数。')
    expect(api.patchTask).not.toHaveBeenCalled()
  })

  it('切到“仅手动”后保存的补丁形状正确', async () => {
    const patchTask = vi.fn(async (id: string) => task({ id }))
    const api = fakeApi({ patchTask })
    const onSaved = vi.fn()
    render(<EditDialog api={api} task={task()} onClose={vi.fn()} onSaved={onSaved} />)

    fireEvent.click(screen.getByLabelText('仅手动'))
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '14' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => { expect(patchTask).toHaveBeenCalledOnce() })
    expect(patchTask).toHaveBeenCalledWith('task-1', {
      schedule: { mode: 'manual' },
      timeZone: 'Asia/Shanghai',
      historyDays: 14,
    })
    await waitFor(() => { expect(onSaved).toHaveBeenCalledOnce() })
  })

  it('clears the input when switching the schedule parser', () => {
    render(<EditDialog api={fakeApi()} task={task()} onClose={vi.fn()} onSaved={vi.fn()} />)
    const input = screen.getByRole('textbox', { name: '执行时间' }) as HTMLInputElement
    expect(input.value).toBe('每天 9 点')

    fireEvent.click(screen.getByLabelText('按 cron'))
    expect(input.value).toBe('')
  })
})
