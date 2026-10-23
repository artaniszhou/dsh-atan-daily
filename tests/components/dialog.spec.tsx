import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Dialog } from '../../src/client/ui/dialog.tsx'

/** 渲染一个带两个按钮的弹层，用于键盘行为测试。 */
function renderDialog(onClose = vi.fn()) {
  render(
    <Dialog title="测试弹层" closeLabel="关闭" onClose={onClose} footer={<button type="button">最后一个</button>}>
      <button type="button">中间</button>
    </Dialog>,
  )
  return onClose
}

describe('Dialog 键盘行为', () => {
  it('焦点在最后一个控件时 Tab 回到第一个（不跑到背景）', () => {
    renderDialog()
    const close = screen.getByRole('button', { name: '关闭' })
    const last = screen.getByRole('button', { name: '最后一个' })
    last.focus()

    fireEvent.keyDown(document, { key: 'Tab' })

    expect(document.activeElement).toBe(close)
  })

  it('焦点在第一个控件时 Shift+Tab 回到最后一个', () => {
    renderDialog()
    const close = screen.getByRole('button', { name: '关闭' })
    const last = screen.getByRole('button', { name: '最后一个' })
    close.focus()

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })

    expect(document.activeElement).toBe(last)
  })

  it('焦点意外落到背景时，Tab 把它拉回弹层', () => {
    renderDialog()
    const outside = document.createElement('button')
    document.body.append(outside)
    outside.focus()

    fireEvent.keyDown(document, { key: 'Tab' })

    expect(document.activeElement).toBe(screen.getByRole('button', { name: '关闭' }))
    outside.remove()
  })

  it('焦点不在弹层内时，Esc 仍然关闭', () => {
    const onClose = renderDialog()
    const outside = document.createElement('button')
    document.body.append(outside)
    outside.focus()

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(onClose).toHaveBeenCalledOnce()
    outside.remove()
  })

  it('输入控件已消费的 Esc 不再关闭弹层', () => {
    const onClose = renderDialog()
    const inner = screen.getByRole('button', { name: '中间' })
    const consume = (event: KeyboardEvent): void => { event.preventDefault() }
    inner.addEventListener('keydown', consume)

    fireEvent.keyDown(inner, { key: 'Escape' })

    expect(onClose).not.toHaveBeenCalled()
    inner.removeEventListener('keydown', consume)
  })
})
