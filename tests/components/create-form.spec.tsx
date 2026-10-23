import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CreateTaskForm } from '../../src/client/features/create/CreateTaskForm.tsx'
import { fakeApi } from '../fake-api.ts'

describe('CreateTaskForm', () => {
  it('名称为空时给出提示且不发请求', async () => {
    const api = fakeApi()
    render(<CreateTaskForm api={api} onCreated={vi.fn()} onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: '创建' }))

    expect((await screen.findByRole('alert')).textContent).toBe('请填写任务名称。')
    expect(api.createTask).not.toHaveBeenCalled()
  })

  it('时区不合法时拦在本地，不发请求', async () => {
    const api = fakeApi()
    render(<CreateTaskForm api={api} onCreated={vi.fn()} onClose={vi.fn()} />)

    fireEvent.change(screen.getByRole('textbox', { name: '任务名称' }), { target: { value: '版本反馈' } })
    fireEvent.change(screen.getByRole('combobox', { name: '时区' }), { target: { value: 'Tokyo' } })
    fireEvent.click(screen.getByRole('button', { name: '创建' }))

    expect((await screen.findByRole('alert')).textContent).toBe('请选择有效的时区。')
    expect(api.createTask).not.toHaveBeenCalled()
  })

  it('填写合法时提交并回调创建结果', async () => {
    const api = fakeApi()
    const onCreated = vi.fn()
    render(<CreateTaskForm api={api} onCreated={onCreated} onClose={vi.fn()} />)

    fireEvent.change(screen.getByRole('textbox', { name: '任务名称' }), { target: { value: '版本反馈' } })
    fireEvent.change(screen.getByRole('textbox', { name: '任务详情' }), { target: { value: '收集反馈' } })
    fireEvent.click(screen.getByRole('button', { name: '创建' }))

    await waitFor(() => { expect(api.createTask).toHaveBeenCalledOnce() })
    expect(api.createTask).toHaveBeenCalledWith(expect.objectContaining({ name: '版本反馈', details: '收集反馈' }))
    await waitFor(() => { expect(onCreated).toHaveBeenCalledOnce() })
  })
})
