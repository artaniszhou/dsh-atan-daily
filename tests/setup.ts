/** 每个组件测试后清理 DOM，避免用例之间互相污染。 */
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(() => {
  cleanup()
})
