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

  it('任务卡片右下角「推送管理」打开该任务的推送抽屉，选中即写回任务', async () => {
    const api = fakeApi({
      listTasks: vi.fn(async () => [task()]),
      patchTask: vi.fn(async (id: string, patch) => task({ id, ...patch })),
      loadBots: vi.fn(async () => ({
        bots: [{
          botId: 'fs_1',
          channel: 'feishu' as const,
          name: '阿碳日报助手',
          appIdMasked: 'cli_aaaa••••0001',
          domain: 'feishu' as const,
          createdAt: '2026-10-01T00:00:00.000Z',
          lastSend: null,
        }],
        provisioning: null,
      })),
    })
    render(<Page api={api} navigate={vi.fn()} confirm={() => true} />)
    await screen.findByText('版本反馈')

    fireEvent.click(screen.getByRole('button', { name: '推送管理' }))
    expect(await screen.findByText(/「版本反馈」运行成功后/)).toBeTruthy()

    // 从"没有目标"里选一个 = 顺手打开推送。
    fireEvent.click(screen.getByRole('switch', { name: '开启报告推送: 阿碳日报助手' }))
    expect(api.patchTask).toHaveBeenCalledWith('task-1', { pushBotIds: ['fs_1'], pushEnabled: true })

    // 抽屉顶部的总开关可以只暂停发送，目标保留。
    fireEvent.click(await screen.findByRole('switch', { name: '关闭报告推送' }))
    expect(api.patchTask).toHaveBeenLastCalledWith('task-1', { pushBotIds: ['fs_1'], pushEnabled: false })
  })
})
