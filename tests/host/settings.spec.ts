import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSettingsStore } from '../../src/host/settings/store.js'
import {
  isPluginOwned,
  workspaceAt,
  type WorkspaceService,
  createWorkspaceService,
} from '../../src/host/settings/workspace.js'
import type { Logger, WorkspacePort } from '../../src/host/ports.js'

const roots: string[] = []
const logger: Logger = { info: () => {}, warn: () => {}, run: () => {} }

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'atan-settings-'))
  roots.push(dir)
  return dir
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('settings store', () => {
  it('loads defaults, saves a directory and clears it back to the default', async () => {
    const settingsRoot = await tempDir()
    const defaultWorkDir = join(settingsRoot, 'work')
    const store = createSettingsStore({ settingsRoot, defaultWorkDir, historyDays: 7, logger })
    await store.load()
    expect(store.workDir()).toBe(defaultWorkDir)
    expect(store.settings()).toEqual({})

    await store.save({ workDir: join(settingsRoot, 'other') })
    expect(store.workDir()).toBe(join(settingsRoot, 'other'))
    expect(JSON.parse(await readFile(join(settingsRoot, 'settings.json'), 'utf8'))).toEqual({
      workDir: join(settingsRoot, 'other'),
    })

    const reloaded = createSettingsStore({ settingsRoot, defaultWorkDir, historyDays: 7, logger })
    await reloaded.load()
    expect(reloaded.workDir()).toBe(join(settingsRoot, 'other'))

    await reloaded.save({ workDir: null })
    expect(reloaded.workDir()).toBe(defaultWorkDir)
    expect(reloaded.settings()).toEqual({})
    expect(JSON.parse(await readFile(join(settingsRoot, 'settings.json'), 'utf8'))).toEqual({})
  })
})

describe('workspace service', () => {
  it('matches registered paths and identifies plugin-owned directories', async () => {
    const root = await tempDir()
    const settingsRoot = join(root, 'settings')
    const defaultWorkDir = join(settingsRoot, 'work')
    const workspaces: WorkspacePort = {
      list: () => [{ id: 'w1', path: defaultWorkDir, title: 'Work' }],
      create: async () => ({}),
      archiveSession: async () => {},
      unarchiveSession: async () => {},
    }
    expect(workspaceAt(workspaces, defaultWorkDir)?.id).toBe('w1')
    expect(workspaceAt(workspaces, join(root, 'other'))).toBeUndefined()
    expect(isPluginOwned(settingsRoot, defaultWorkDir, join(defaultWorkDir, 'child'))).toBe(true)
    expect(isPluginOwned(settingsRoot, defaultWorkDir, join(root, 'outside'))).toBe(false)
  })

  it('creates the directory, ensures the registry and registers a workspace', async () => {
    const root = await tempDir()
    const defaultWorkDir = join(root, 'work')
    const settingsRoot = join(root, 'settings')
    const settings = createSettingsStore({ settingsRoot, defaultWorkDir, historyDays: 7, logger })
    const created: string[] = []
    const workspaces: WorkspacePort = {
      list: () => [],
      create: async (path: string) => {
        created.push(path)
        return { id: 'w-new', title: 'Work' }
      },
      archiveSession: async () => {},
      unarchiveSession: async () => {},
    }
    const service: WorkspaceService = createWorkspaceService({ settings, workspaces, logger })
    const prepared = await service.prepare(defaultWorkDir)
    expect(prepared.workspace?.id).toBe('w-new')
    expect(created).toEqual([defaultWorkDir])
    expect(await readFile(join(defaultWorkDir, 'task-list.jsonl'), 'utf8')).toBe('')
  })
})
