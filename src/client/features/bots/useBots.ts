/**
 * 机器人列表与扫码状态。
 *
 * 只做三件事：读列表、驱动一次扫码的轮询、执行改名/移除。二维码内容与
 * secret 都不经过这里——页面只拿到 data URL 与掩码。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { BotsStatus, BotView, ProvisionView } from '../../../protocol.ts'
import { hostErrorText } from '../../api/errors.ts'
import type { AtanDailyApi } from '../../api/tasks.ts'
import { t } from '../../i18n/index.ts'

/** 仍在进行中的扫码状态。 */
const ACTIVE_STATES: ReadonlySet<ProvisionView['state']> = new Set([
  'starting', 'waiting', 'scanned', 'saving',
])

/** 列表加载阶段。 */
export type BotsPhase = 'loading' | 'ready' | 'failed'

/** 抽屉消费的控制器。 */
export interface BotsController {
  phase: BotsPhase
  bots: BotView[]
  provisioning: ProvisionView | null
  error: string
  /** 刚刚接入成功一次；抽屉读一次后调用 `acknowledge` 清掉。 */
  justConnected: boolean
  busy: boolean
  reload: () => void
  /** 开始扫码；`name` 会写进飞书应用名，接入后不可修改。 */
  begin: (name?: string) => Promise<void>
  cancel: () => Promise<void>
  remove: (botId: string) => Promise<void>
  acknowledge: () => void
  clearError: () => void
}

/**
 * 机器人控制器。
 * @param api - host 端点集合。
 * @returns 列表、扫码与变更动作。
 */
export function useBots(api: AtanDailyApi): BotsController {
  const [phase, setPhase] = useState<BotsPhase>('loading')
  const [bots, setBots] = useState<BotView[]>([])
  const [provisioning, setProvisioning] = useState<ProvisionView | null>(null)
  const [error, setError] = useState('')
  const [justConnected, setJustConnected] = useState(false)
  const [busy, setBusy] = useState(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const apply = useCallback((status: BotsStatus): void => {
    setBots(status.bots)
    setProvisioning(status.provisioning)
  }, [])

  const load = useCallback(async (silent: boolean): Promise<void> => {
    if (!silent) setPhase('loading')
    try {
      const status = await api.loadBots()
      if (!mounted.current) return
      apply(status)
      setPhase('ready')
      setError('')
    } catch (failure: unknown) {
      if (!mounted.current) return
      setError(hostErrorText(failure, t))
      if (!silent) setPhase('failed')
    }
  }, [api, apply])

  useEffect(() => {
    void load(false)
  }, [load])

  // 扫码轮询：SDK 在 host 侧自己轮询，这里只按服务端给的间隔读快照。
  // 依赖只取"身份 + 状态 + 间隔"：状态不变时不会重装定时器，避免同一次
  // 扫码被两条定时器同时驱动。
  const attemptId = provisioning?.attemptId
  const provisionState = provisioning?.state
  const provisionInterval = provisioning?.pollIntervalMs
  useEffect(() => {
    if (attemptId === undefined || provisionState === undefined || !ACTIVE_STATES.has(provisionState)) return undefined
    let disposed = false
    let timer: number | undefined

    const tick = async (): Promise<void> => {
      try {
        const next = await api.pollProvision(attemptId)
        if (disposed || !mounted.current) return
        if (next.state === 'connected') {
          setProvisioning(null)
          setJustConnected(true)
          await load(true)
          return
        }
        setProvisioning(next)
        if (ACTIVE_STATES.has(next.state)) {
          timer = window.setTimeout(() => { void tick() }, next.pollIntervalMs)
        }
      } catch (failure: unknown) {
        if (disposed || !mounted.current) return
        setError(hostErrorText(failure, t))
        setProvisioning(null)
      }
    }

    timer = window.setTimeout(() => { void tick() }, provisionInterval ?? 1500)
    return () => {
      disposed = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [api, attemptId, provisionState, provisionInterval, load])

  const begin = useCallback(async (name?: string): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const started = await api.beginFeishuProvision(name)
      if (mounted.current) setProvisioning(started)
    } catch (failure: unknown) {
      if (mounted.current) setError(hostErrorText(failure, t))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }, [api])

  const cancel = useCallback(async (): Promise<void> => {
    const current = provisioning
    if (current === null) return
    setBusy(true)
    try {
      await api.cancelProvision(current.attemptId)
    } catch {
      // 取消失败不影响本地收尾：下一次开始会顶掉它。
    } finally {
      if (mounted.current) {
        setProvisioning(null)
        setBusy(false)
      }
    }
  }, [api, provisioning])

  const remove = useCallback(async (botId: string): Promise<void> => {
    setBusy(true)
    try {
      apply(await api.removeBot(botId))
      setError('')
    } catch (failure: unknown) {
      setError(hostErrorText(failure, t))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }, [api, apply])

  return {
    phase,
    bots,
    provisioning,
    error,
    justConnected,
    busy,
    reload: () => { void load(false) },
    begin,
    cancel,
    remove,
    acknowledge: () => { setJustConnected(false) },
    clearError: () => { setError('') },
  }
}
