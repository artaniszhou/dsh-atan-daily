/**
 * 执行一轮 agent 回合：选模型、套权限、送 prompt、等待结束，并带超时。
 *
 * 只依赖端口；测试用假的会话/agent 即可驱动。准备阶段（建会话、解析
 * agent）在 scheduler/session 层，不在这里重复。
 */

import { randomUUID } from 'node:crypto'
import type { TaskRecord } from '../../protocol.js'
import { RUN_MODEL, RUN_PERMISSION_PRESET, TURN_START_BOUND_MS } from '../config.js'
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

  return {
    async drive(input: RunInput): Promise<void> {
      const resolved = await deps.sessions.resolveAgent(input.sessionId)
      if ('error' in resolved) {
        throw new RunFailure('agent_unavailable', `agent unavailable: ${JSON.stringify(resolved.error)}`)
      }
      const agent = resolved.agent
      try {
        deps.permissions.set(agent.session, RUN_PERMISSION_PRESET)
      } catch (error: unknown) {
        deps.logger.warn(`could not apply the ${RUN_PERMISSION_PRESET} preset: ${String(error)}`)
      }
      // The preset normally bundles `never`; this keeps the guarantee even when
      // a profile overrides the preset table with an approval-asking bundle.
      try {
        deps.approval.setPolicy(agent, 'never')
      } catch (error: unknown) {
        deps.logger.warn(`could not set the approval policy to never: ${String(error)}`)
      }
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
          content: [{ type: 'text', text: buildPrompt(input.task, input.report) }],
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
    },
  }
}
