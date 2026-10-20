import { describe, expect, it } from 'vitest'
import { pagePositions } from '../src/client/shared/paging.ts'

describe('pagePositions', () => {
  it('七页以内全部显示', () => {
    expect(pagePositions(1, 5)).toEqual([1, 2, 3, 4, 5])
    expect(pagePositions(3, 7)).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  it('当前页在开头：显示窗口 + 尾页', () => {
    expect(pagePositions(1, 10)).toEqual([1, 2, 3, 4, 'gap', 10])
  })

  it('当前页在中间：两侧留省略号', () => {
    expect(pagePositions(5, 10)).toEqual([1, 'gap', 4, 5, 6, 'gap', 10])
  })

  it('当前页在结尾：显示首页 + 尾段', () => {
    expect(pagePositions(10, 10)).toEqual([1, 'gap', 7, 8, 9, 10])
  })
})
