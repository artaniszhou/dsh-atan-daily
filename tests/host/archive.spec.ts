import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { archiveReports, reportPathOf } from '../../src/host/tasks/archive.js'
import type { Logger } from '../../src/host/ports.js'

const roots: string[] = []
const logger: Logger = { info: () => {}, warn: () => {}, run: () => {} }

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'atan-archive-'))
  roots.push(dir)
  return dir
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('archiveReports', () => {
  it('把根目录的报告移进 history，其他文件不动', async () => {
    const folder = await tempDir()
    await mkdir(join(folder, 'meta'), { recursive: true })
    await writeFile(join(folder, 'meta', 'rule.md'), '# 规则', 'utf8')
    await writeFile(join(folder, 'notes.md'), '手记', 'utf8')
    await writeFile(join(folder, '2026-10-20-090000.md'), '上一轮', 'utf8')
    await writeFile(join(folder, '2026-10-19-090000.md'), '更早', 'utf8')

    const moved = await archiveReports({ folder }, logger)
    expect(moved.sort()).toEqual(['2026-10-19-090000.md', '2026-10-20-090000.md'])
    expect((await readdir(folder)).sort()).toEqual(['history', 'meta', 'notes.md'])
    expect((await readdir(join(folder, 'history'))).sort()).toEqual(['2026-10-19-090000.md', '2026-10-20-090000.md'])
    expect((await stat(join(folder, 'meta', 'rule.md'))).isFile()).toBe(true)
    expect((await stat(join(folder, 'notes.md'))).isFile()).toBe(true)
  })

  it('没有报告时不创建 history 目录，也不报错', async () => {
    const folder = await tempDir()
    expect(await archiveReports({ folder }, logger)).toEqual([])
    await expect(stat(join(folder, 'history'))).rejects.toThrow()
  })

  it('目标已有同名文件时追加后缀，不覆盖旧报告', async () => {
    const folder = await tempDir()
    await mkdir(join(folder, 'history'), { recursive: true })
    await writeFile(join(folder, 'history', '2026-10-20-090000.md'), '早先归档的同名文件', 'utf8')
    await writeFile(join(folder, '2026-10-20-090000.md'), '新的一份', 'utf8')

    expect(await archiveReports({ folder }, logger)).toEqual(['2026-10-20-090000-2.md'])
    expect((await readdir(join(folder, 'history'))).sort()).toEqual([
      '2026-10-20-090000-2.md',
      '2026-10-20-090000.md',
    ])
  })

  it('重复调用是幂等的', async () => {
    const folder = await tempDir()
    await writeFile(join(folder, '2026-10-20-090000.md'), '报告', 'utf8')
    await archiveReports({ folder }, logger)
    expect(await archiveReports({ folder }, logger)).toEqual([])
    expect(await readdir(join(folder, 'history'))).toEqual(['2026-10-20-090000.md'])
  })

  it('任务目录不存在时安静返回', async () => {
    expect(await archiveReports({ folder: join(tmpdir(), 'atan-archive-missing') }, logger)).toEqual([])
  })
})

describe('reportPathOf', () => {
  it('优先根目录，其次 history，都没有时 undefined', async () => {
    const folder = await tempDir()
    await mkdir(join(folder, 'history'), { recursive: true })
    await writeFile(join(folder, '2026-10-20-090000.md'), '最新', 'utf8')
    await writeFile(join(folder, 'history', '2026-10-19-090000.md'), '归档', 'utf8')

    expect(await reportPathOf(folder, '2026-10-20-090000.md')).toBe(join(folder, '2026-10-20-090000.md'))
    expect(await reportPathOf(folder, '2026-10-19-090000.md')).toBe(join(folder, 'history', '2026-10-19-090000.md'))
    expect(await reportPathOf(folder, '2026-10-18-090000.md')).toBeUndefined()
  })
})
