/**
 * DeepSeek 账号身份解析。
 *
 * DSH 只向插件暴露 profile 的 id / 昵称 / 一个脱敏联系方式；上传需要
 * uid、邮箱、手机号、实名认证 ID 四项。这里先取 profile，再在 Host 侧用
 * 同一份平台会话读取 current-user 的原始字段（不把 token 交给页面）。
 * 拿不到的字段返回空串，页面据此禁用上传。
 */
import { PLUGIN_VERSION } from './config.js'

/** 上传时随任务包提交的身份信息。 */
export interface AccountIdentity {
  signedIn: boolean
  uid: string
  email: string
  phone: string
  realNameId: string
  displayName: string
  complete: boolean
}

/** 账号服务端口；只声明用到的成员。 */
export interface DeepSeekAccountPort {
  getState?: () => Promise<{ status: 'signed-out' | 'credential-stored' }>
  getProfile?: (client: {
    version: string
    locale: string
    timezoneOffsetSeconds: number
  }) => Promise<
    | { status: 'ready', value: { id: string | null, name: string | null, contact: string | null } }
    | { status: 'failed' }
    | null
  >
  getPlatformSession?: () => Promise<{
    origin: string
    token: string
    userId: string | null
    requestHeaders?: Record<string, string>
  } | null>
}

/** 账号解析器。 */
export interface AccountProvider {
  resolve: () => Promise<AccountIdentity>
}

const EMPTY: AccountIdentity = {
  signedIn: false,
  uid: '',
  email: '',
  phone: '',
  realNameId: '',
  displayName: '',
  complete: false,
}

/**
 * 创建账号解析器。
 * @param account - 宿主账号服务；缺失时返回未登录。
 * @returns 解析器。
 */
export function createAccountProvider(account: DeepSeekAccountPort | undefined): AccountProvider {
  return {
    resolve: async () => {
      if (account === undefined) return { ...EMPTY }
      const client = {
        version: PLUGIN_VERSION,
        locale: 'zh',
        timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
      }

      let signedIn = false
      try {
        const state = await account.getState?.()
        signedIn = state !== undefined && state.status === 'credential-stored'
      } catch {
        // 账号状态读取失败按未登录处理，不阻塞页面其他功能。
      }

      let profile: { id: string | null, name: string | null, contact: string | null } | null = null
      try {
        const result = await account.getProfile?.(client)
        if (result !== null && result !== undefined && result.status === 'ready') {
          profile = result.value
          signedIn = true
        }
      } catch {
        // 保留 signedIn 的初始判断。
      }

      if (!signedIn) return { ...EMPTY }

      let contact = profile?.contact ?? ''
      let email = contact.includes('@') ? contact : ''
      let phone = contact !== '' && !contact.includes('@') ? contact : ''
      let realNameId = ''
      let uid = profile?.id ?? ''
      let displayName = profile?.name ?? ''

      try {
        const session = await account.getPlatformSession?.()
        if (session !== null && session !== undefined) {
          const response = await fetch(`${session.origin}/auth-api/v0/users/current`, {
            method: 'GET',
            redirect: 'error',
            headers: {
              ...session.requestHeaders,
              'x-dsh-auth-token': session.token,
            },
            signal: AbortSignal.timeout(8000),
          })
          if (response.ok) {
            const payload = await response.json() as Record<string, any>
            const raw = payload?.data?.biz_data ?? payload?.data ?? payload
            uid = String(raw?.uid ?? raw?.id ?? uid ?? '')
            email = String(raw?.email ?? email ?? '')
            phone = String(raw?.mobile ?? raw?.mobile_number ?? phone ?? '')
            realNameId = String(
              raw?.real_name_id ?? raw?.realNameId ?? raw?.realname_id
              ?? raw?.real_name_auth_id ?? raw?.realnameId ?? realNameId ?? '',
            )
            displayName = String(raw?.id_profile?.name ?? displayName ?? '')
            contact = contact === '' ? String(raw?.email ?? raw?.mobile ?? '') : contact
          }
        }
      } catch {
        // 原始字段读取失败时仍返回 profile 能提供的部分。
      }

      if (email === '' && contact.includes('@')) email = contact
      if (phone === '' && contact !== '' && !contact.includes('@')) phone = contact

      return {
        signedIn: true,
        uid,
        email,
        phone,
        realNameId,
        displayName,
        // 实名认证 ID 取不到就不带；uid 是上传的唯一硬前提。
        complete: uid !== '',
      }
    },
  }
}
