import { describe, expect, it } from 'vitest'
import { en } from '../src/client/i18n/en.ts'
import { t } from '../src/client/i18n/index.ts'
import { zh } from '../src/client/i18n/zh.ts'

describe('字典一致性', () => {
  it('中文与英文的键集合完全一致', () => {
    const zhKeys = Object.keys(zh).sort()
    const enKeys = Object.keys(en).sort()
    expect(enKeys).toEqual(zhKeys)
  })

  it('没有空文案（pageSuffix 在英文里按设计为空）', () => {
    for (const [key, value] of Object.entries(zh)) {
      if (key === 'pageSuffix') continue
      expect(value, `zh.${key}`).not.toBe('')
    }
    for (const [key, value] of Object.entries(en)) {
      if (key === 'pageSuffix') continue
      expect(value, `en.${key}`).not.toBe('')
    }
  })
})

describe('t', () => {
  it('未绑定宿主时回退中文', () => {
    expect(t('nav')).toBe('阿碳日报')
  })

  it('替换 {name} 占位符', () => {
    expect(t('errorHttp', { status: 404 })).toBe('Host 返回错误（HTTP 404）')
  })
})
