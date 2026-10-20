import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CACHE_HEADING,
  EMPTY_DETAIL,
  parseManifestRows,
  parseRuleContent,
  readRuleContent,
  renderRuleContent,
  upsertManifestSection,
  writeRuleContent,
} from '../../src/core/rule.js'

describe('rule document', () => {
  it('renders the template with details and both manifests', () => {
    const text = renderRuleContent('收集反馈', ['| a | b | c |'], ['| s | f | u |'])
    expect(text).toContain('收集反馈')
    expect(text).toContain(CACHE_HEADING)
    expect(text).toContain('| s | f | u |')
    expect(text).not.toMatch(/\{\{(DETAILS|CACHE_SECTION|SCRIPT_SECTION)\}\}/u)
  })

  it('does not expand markers that appear inside the user details', () => {
    const text = renderRuleContent('前置 {{CACHE_SECTION}} 后置')
    expect(text).toContain('前置 {{CACHE_SECTION}} 后置')
    // The template's own marker must still have been replaced (no leftover at
    // the template position); the only remaining occurrence is the user text.
    expect(text.match(/\{\{CACHE_SECTION\}\}/gu)).toHaveLength(1)
  })

  it('round-trips task details and keeps the empty placeholder empty', () => {
    expect(parseRuleContent(renderRuleContent('第一行\n## 二级标题'))).toBe('第一行\n## 二级标题')
    expect(parseRuleContent(renderRuleContent(''))).toBe('')
    expect(renderRuleContent('')).toContain(EMPTY_DETAIL)
  })

  it('merges and parses manifest rows', () => {
    const first = renderRuleContent('x')
    const withCache = upsertManifestSection(first, 'cache', ['| a | b | c |'])
    expect(parseManifestRows(withCache, CACHE_HEADING)).toEqual(['| a | b | c |'])
    const merged = upsertManifestSection(withCache, 'cache', ['| a | b | c |', '| d | e | f |'])
    expect(parseManifestRows(merged, CACHE_HEADING)).toEqual(['| a | b | c |', '| d | e | f |'])
  })

  it('writes and reads a rule on disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atan-rule-'))
    try {
      await writeRuleContent(dir, '详情')
      expect(await readRuleContent(dir)).toBe('详情')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
