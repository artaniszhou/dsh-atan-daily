import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { nextReportName } from '../../src/host/tasks/report.js'
import { task } from '../fixtures.js'

const roots: string[] = []
const at = new Date('2026-10-22T01:00:00Z')

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'atan-report-'))
  roots.push(dir)
  return dir
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('nextReportName', () => {
  it('returns the time-stamped name when the folder is empty', async () => {
    const folder = await tempDir()
    expect(await nextReportName(task({ folder, timeZone: 'UTC' }), at)).toBe('2026-10-22-010000.md')
  })

  it('adds a suffix when the root already has that name', async () => {
    const folder = await tempDir()
    await writeFile(join(folder, '2026-10-22-010000.md'), 'x', 'utf8')
    expect(await nextReportName(task({ folder, timeZone: 'UTC' }), at)).toBe('2026-10-22-010000-2.md')
  })

  it('counts names in history/ as used so a re-run never duplicates an archived report', async () => {
    const folder = await tempDir()
    await mkdir(join(folder, 'history'), { recursive: true })
    await writeFile(join(folder, 'history', '2026-10-22-010000.md'), 'x', 'utf8')
    expect(await nextReportName(task({ folder, timeZone: 'UTC' }), at)).toBe('2026-10-22-010000-2.md')
  })
})
