import { describe, expect, it } from 'vitest'
import { filterTasks, paginate, taskStats } from '../src/client/features/list/derive.ts'
import { task } from './fixtures.ts'

describe('filterTasks', () => {
  const tasks = [
    task({ id: 'a', name: 'Release Feedback', details: '收集用户反馈' }),
    task({ id: 'b', name: '行业新闻', details: '每日摘要' }),
  ]

  it('空查询返回全部', () => {
    expect(filterTasks(tasks, '')).toHaveLength(2)
    expect(filterTasks(tasks, '   ')).toHaveLength(2)
  })

  it('按名称且不区分大小写', () => {
    expect(filterTasks(tasks, 'release').map(item => item.id)).toEqual(['a'])
  })

  it('按详情匹配中文', () => {
    expect(filterTasks(tasks, '摘要').map(item => item.id)).toEqual(['b'])
  })

  it('无匹配返回空数组', () => {
    expect(filterTasks(tasks, '不存在')).toEqual([])
  })
})

describe('paginate', () => {
  const items = Array.from({ length: 25 }, (_value, index) => index + 1)

  it('算出页数并返回当前页', () => {
    const result = paginate(items, 2, 10)
    expect(result.pages).toBe(3)
    expect(result.page).toBe(2)
    expect(result.visible).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20])
  })

  it('越界页码钳到最后一页', () => {
    const result = paginate(items, 99, 10)
    expect(result.page).toBe(3)
    expect(result.visible).toEqual([21, 22, 23, 24, 25])
  })

  it('空列表也保留第 1 页', () => {
    expect(paginate([], 1, 10)).toEqual({ page: 1, pages: 1, visible: [] })
  })
})

describe('taskStats', () => {
  it('统计总数、启用、执行中与异常', () => {
    const tasks = [
      task({ id: 'a', enabled: true, running: true }),
      task({ id: 'b', enabled: false, lastStatus: 'failed' }),
      task({ id: 'c', enabled: true, lastStatus: 'timeout' }),
      task({ id: 'd', enabled: false, lastStatus: 'ok' }),
    ]
    expect(taskStats(tasks)).toEqual({ total: 4, enabled: 2, running: 1, attention: 2 })
  })
})
