/** Vitest 配置：组件测试用 jsdom，CSS Modules 关闭哈希以便调试。 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.spec.{ts,tsx}'],
    setupFiles: ['tests/setup.ts'],
    css: {
      modules: { classNameStrategy: 'non-scoped' },
    },
    restoreMocks: true,
  },
})
