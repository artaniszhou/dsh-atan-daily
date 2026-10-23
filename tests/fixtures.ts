/** 测试用的契约 fixture：只写用例关心的字段，其余给稳定默认值。 */
import type { RunRecord, SettingsView, TaskRecord } from '../src/protocol.ts'

/**
 * 造一个任务。
 * @param overrides - 需要覆盖的字段。
 * @returns 完整任务。
 */
export function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-1',
    name: '版本反馈',
    details: '收集版本发布后的用户反馈',
    frequency: 'daily',
    createdAt: '2026-10-01T00:00:00.000Z',
    folder: '/work/task-1',
    historyCount: 0,
    scheduleMode: 'text',
    scheduleText: '每天 9 点',
    timeZone: 'Asia/Shanghai',
    enabled: true,
    historyDays: 7,
    pushBotIds: [],
    pushEnabled: false,
    cron: '0 9 * * *',
    ...overrides,
  }
}

/**
 * 造一条运行记录。
 * @param overrides - 需要覆盖的字段。
 * @returns 完整运行记录。
 */
export function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    v: 1,
    runId: 'run-1',
    taskId: 'task-1',
    trigger: 'schedule',
    catchUp: false,
    scheduledFor: '2026-10-18T01:00:00.000Z',
    startedAt: '2026-10-18T01:00:00.123Z',
    finishedAt: '2026-10-18T01:00:03.456Z',
    status: 'ok',
    durationMs: 3_333,
    sessionId: 'session-1',
    report: '2026-10-18-090000.md',
    reportExists: true,
    error: null,
    bootId: 'boot-1',
    plugin: 'dsh-atan-daily',
    ...overrides,
  }
}

/**
 * 造一份设置。
 * @param overrides - 需要覆盖的字段。
 * @returns 完整设置视图。
 */
export function settings(overrides: Partial<SettingsView> = {}): SettingsView {
  return {
    workDir: '/work',
    defaultWorkDir: '/default',
    savedWorkDir: '/work',
    tasksTotal: 0,
    tasksEnabled: 0,
    dirExists: true,
    workspace: null,
    pluginVersion: '1.0.0',
    ...overrides,
  }
}
