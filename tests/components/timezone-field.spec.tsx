import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { isValidTimeZone, TimeZoneField } from '../../src/client/ui/timezone-field.tsx'

/** 渲染一个空的时区选择器。 */
function renderField(onChange = vi.fn()) {
  render(<TimeZoneField value="" onChange={onChange} />)
  return { input: screen.getByRole('combobox', { name: '时区' }) as HTMLInputElement, onChange }
}

describe('isValidTimeZone', () => {
  it('接受 IANA 时区、拒绝半截词与空串', () => {
    expect(isValidTimeZone('Asia/Shanghai')).toBe(true)
    expect(isValidTimeZone('UTC')).toBe(true)
    expect(isValidTimeZone('Tokyo')).toBe(false)
    expect(isValidTimeZone('')).toBe(false)
  })
})

describe('TimeZoneField', () => {
  it('过滤结果里只有合法时区，不再把输入原文当选项', () => {
    const { input } = renderField()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'Tok' } })

    const options = screen.getAllByRole('option').map(option => option.textContent ?? '')
    expect(options).toContain('Asia/Tokyo')
    expect(options).not.toContain('Tok')
    expect(options.every(isValidTimeZone)).toBe(true)
  })

  it('回车选中第一项即写入合法时区', () => {
    const { input, onChange } = renderField()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'Asia/Tok' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onChange).toHaveBeenLastCalledWith('Asia/Tokyo')
    expect(input.value).toBe('Asia/Tokyo')
  })

  it('没有匹配项时给出提示，且回车不选中任何值', () => {
    const { input, onChange } = renderField()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'zzzz' } })

    expect(screen.getByText('没有匹配的时区')).toBeTruthy()
    fireEvent.keyDown(input, { key: 'Enter' })
    // 只有输入本身触发的 onChange，没有第二条「选中」写入。
    expect(onChange).toHaveBeenCalledOnce()
    expect(onChange).toHaveBeenCalledWith('zzzz')
  })
})
