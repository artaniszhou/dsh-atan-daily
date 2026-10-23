/**
 * IM 机器人的宿主侧类型。
 *
 * 页面契约（`BotView` / `ProvisionView` / `BotsStatus`）在 `protocol.ts`，
 * 这里只放落盘记录与掩码规则——两半都能安全引用的东西不放这里。
 */

import type { ImChannel, LastSend } from '../../protocol.js'

/** 落盘的机器人记录；**不含任何 secret**。 */
export interface BotRecord {
  botId: string
  channel: ImChannel
  /** 平台侧应用标识（飞书 app_id）。 */
  platformId: string
  /** 凭据库里的 key，secret 本身不进这个文件。 */
  secretRef: string
  /** 扫码人的 open_id：主动发送的唯一目标。 */
  ownerId: string
  /** 飞书还是 Lark，决定 OpenAPI 域名。 */
  domain: 'feishu' | 'lark'
  /** 展示名：接入时确定，之后不可修改。 */
  name: string
  createdAt: string
  lastSend?: LastSend
}

/** 发送结果：失败不抛，交给调用方记录。 */
export interface SendOutcome {
  ok: boolean
  code?: string
  message?: string
  /** 成功送达的机器人数。 */
  sent?: number
  /** 本次尝试的机器人总数。 */
  total?: number
}

/** 把 app_id 掩码成可展示的样子。 */
export function maskAppId(appId: string): string {
  return appId.length > 12 ? `${appId.slice(0, 8)}••••${appId.slice(-4)}` : 'cli_••••'
}
