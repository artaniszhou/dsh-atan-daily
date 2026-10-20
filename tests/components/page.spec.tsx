import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { HostError } from '../../src/client/api/errors.ts'
import { Page } from '../../src/client/features/page/Page.tsx'
import { fakeApi } from '../fake-api.ts'
import { task } from '../fixtures.ts'

describe('Page', () => {
  it('加载任务与设置后渲染标题、数量与行', async () => {
    const api = fakeApi({
      listTasks: vi.fn(async () => [
        task({ id: 'a', name: 'Alpha 任务' }),
        task({ id: 'b', name: 'Beta 任务' }),
      ]),
    })
    render(<Page api={api} navigate={vi.fn()} confirm={() => true} />)

    expect(await screen.findByText('Alpha 任务')).toBeTruthy()
    expect(screen.getByText('Beta 任务')).toBeTruthy()
    expect(screen.getByText('2 / 2')).toBeTruthy()
    expect(await screen.findByText('/work')).toBeTruthy()
  })

  it('搜索只保留命中的行', async () => {
    const api = fakeApi({
      listTasks: vi.fn(async () => [
        task({ id: 'a', name: 'Alpha 任务' }),
        task({ id: 'b', name: 'Beta 任务' }),
      ]),
    })
    render(<Page api={api} navigate={vi.fn()} confirm={() => true} />)
    await screen.findByText('Alpha 任务')

    fireEvent.change(screen.getByRole('textbox', { name: '搜索收集任务' }), { target: { value: 'alpha' } })
    expect(screen.getByText('Alpha 任务')).toBeTruthy()
    expect(screen.queryByText('Beta 任务')).toBeNull()
  })

  it('加载失败显示可读原因与重试', async () => {
    const api = fakeApi({
      listTasks: vi.fn(async () => { throw new HostError('network', 'offline') }),
    })
    render(<Page api={api} navigate={vi.fn()} confirm={() => true} />)

    expect(await screen.findByText('已保存的任务加载失败。')).toBeTruthy()
    expect(screen.getByText(/无法连接 Host/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy()
  })
})
