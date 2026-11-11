/**
 * 执行一轮 agent 回合：选模型、套权限、送 prompt、等待结束，并带超时。
 *
 * 只依赖端口；测试用假的会话/agent 即可驱动。准备阶段（建会话、解析
 * agent）在 scheduler/session 层，不在这里重复。
 */

import { randomUUID } from 'node:crypto'
import { DEFAULT_PERMISSION_LEVEL, type TaskRecord } from '../../protocol.js'
import { RUN_MODEL, TURN_START_BOUND_MS } from '../config.js'
import { buildPrompt } from '../tasks/prompt.js'
import { RunFailure } from './failure.js'
import { resolveRunModel } from './model.js'
import type {
  AgentFace,
  ApprovalPort,
  Logger,
  ModelPort,
  PermissionPresetPort,
  SessionPort,
} from '../ports.js'

/** 执行器依赖。 */
export interface RunExecutorDeps {
  sessions: Pick<SessionPort, 'resolveAgent' | 'prompt' | 'selectModel'>
  models: ModelPort
  permissions: PermissionPresetPort
  approval: ApprovalPort
  logger: Logger
  /** 新会话被 prompt 后等待回合开始的上限。 */
  turnStartBoundMs?: number
  /** 送 prompt 本身的超时。 */
  promptTimeoutMs?: number
}

/** 一次执行需要的输入。 */
export interface RunInput {
  task: TaskRecord
  sessionId: string
  report: string
  /** 本轮中间件目录（`.meta/build/<runId>`）。 */
  buildDir: string
  timeoutMs: number
}

/** 执行器。 */
export interface RunExecutor {
  drive: (input: RunInput) => Promise<void>
}

/**
 * 等到 agent 开始本轮或到达上限。
 * @param agent - 目标 agent。
 * @param boundMs - 上限毫秒。
 * @param sleep - 可注入的等待（测试用）。
 * @returns 等待结束。
 */
export async function waitForTurnStart(
  agent: Pick<AgentFace, 'status'>,
  boundMs: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) }),
): Promise<void> {
  const deadline = Date.now() + boundMs
  while (Date.now() < deadline) {
    if (agent.status === 'running') return
    await sleep(100)
  }
}

/**
 * 创建执行器。
 * @param deps - 会话、模型、权限与日志。
 * @returns 执行器。
 */
export function createRunExecutor(deps: RunExecutorDeps): RunExecutor {
  const turnStartBoundMs = deps.turnStartBoundMs ?? TURN_START_BOUND_MS
  const promptTimeoutMs = deps.promptTimeoutMs ?? 30_000
  /** 正在被无人值守驱动的会话；审批闸门只在这些会话上生效。 */
  const driving = new Set<string>()
  deps.approval.gate(sessionId => driving.has(sessionId))

  return {
    async drive(input: RunInput): Promise<void> {
      driving.add(input.sessionId)
      try {
        const resolved = await deps.sessions.resolveAgent(input.sessionId)
        if ('error' in resolved) {
          throw new RunFailure('agent_unavailable', `agent unavailable: ${JSON.stringify(resolved.error)}`)
        }
        const agent = resolved.agent
        // 权限级别按任务设置：默认只允许工作区内修改，需要跨目录读写时才选完全权限。
        // 只套预设、不改审批策略：预设由「沙箱 + 审批」两个旋钮推导，擅自把审批
        // 改成 never 会让旋钮失配，页面就会显示成「自定义」。
        const preset = input.task.permissionLevel ?? DEFAULT_PERMISSION_LEVEL
        try {
          deps.permissions.set(agent.session, preset)
        } catch (error: unknown) {
          deps.logger.warn(`could not apply the ${preset} preset: ${String(error)}`)
        }
        // 越界审批由上面注册的闸门在运行期间直接拒绝，避免无人值守运行等待审批。
        const selection = await resolveRunModel(deps.models).catch(() => undefined)
        if (selection === undefined) {
          deps.logger.warn(`model ${RUN_MODEL} is unavailable; the Session keeps its default`)
        } else {
          try {
            await deps.sessions.selectModel({ sessionId: input.sessionId, ...selection })
          } catch (error: unknown) {
            deps.logger.warn(`could not select ${selection.provider}/${RUN_MODEL}: ${String(error)}`)
          }
        }

        try {
          await deps.sessions.prompt({
            requestId: randomUUID(),
            sessionId: input.sessionId,
            mode: 'queue',
            content: [{ type: 'text', text: buildPrompt(input.task, input.buildDir, input.report) }],
            clientTimeZone: input.task.timeZone,
          }, AbortSignal.timeout(promptTimeoutMs))
        } catch (error: unknown) {
          throw new RunFailure('prompt_failed', `could not send the run prompt: ${String(error)}`)
        }

        await waitForTurnStart(agent, turnStartBoundMs)

        let timer: ReturnType<typeof setTimeout> | undefined
        const timeout = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            try {
              agent.cancel({ kind: 'hook', reason: 'atan-daily: run timeout' })
            } catch (error: unknown) {
              deps.logger.warn(`could not cancel the timed-out run: ${String(error)}`)
            }
            reject(new RunFailure(
              'timeout',
              `run timed out after ${String(Math.round(input.timeoutMs / 1000))}s`,
              'timeout',
            ))
          }, input.timeoutMs)
        })
        try {
          await Promise.race([agent.whenIdle(), timeout])
        } finally {
          if (timer !== undefined) clearTimeout(timer)
        }
      } finally {
        driving.delete(input.sessionId)
      }
    },
  }
}
