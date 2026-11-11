/**
 * 页面公告的加载节奏。
 *
 * 公告是首屏附加信息，不值得为它做实时推送：
 *  - 打开页面拉一次（Host 侧有 30s 缓存，通常零等待）；
 *  - 每 5 分钟一拍，长时间停留的页面也能看到新公告；
 *  - 从后台切回前台且离开超过 1 分钟时补一次。
 *
 * 任何失败都静默隐藏：公告坏了不能影响任务列表与设置。
 */
import { useEffect, useState } from 'react'
import type { AnnouncementView } from '../../../protocol.ts'
import type { AtanDailyApi } from '../../api/tasks.ts'

/** 轮询间隔。 */
const POLL_MS = 5 * 60_000

/** 回到前台时，离开超过这么久才补拉。 */
const RESUME_AFTER_MS = 60_000

/**
 * 拉取当前公告。
 * @param api - 页面 API。
 * @param serverBaseUrl - 当前任务服务地址；为空表示未配置，不发请求。
 * @returns 公告视图；null 表示不渲染（没有公告、未配置或请求失败）。
 */
export function useAnnouncement(api: AtanDailyApi, serverBaseUrl: string): AnnouncementView | null {
  const [view, setView] = useState<AnnouncementView | null>(null)

  useEffect(() => {
    if (serverBaseUrl === '') {
      setView(null)
      return
    }

    let alive = true
    const load = async (): Promise<void> => {
      try {
        const next = await api.loadAnnouncement()
        if (!alive) return
        setView(next.enabled ? next : null)
      } catch {
        // 静默降级：公告接口异常时不显示任何东西，也不弹错误条。
        if (alive) setView(null)
      }
    }

    void load()
    const timer = window.setInterval(() => {
      void load()
    }, POLL_MS)

    let hiddenAt = 0
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now()
        return
      }
      if (hiddenAt !== 0 && Date.now() - hiddenAt > RESUME_AFTER_MS) void load()
      hiddenAt = 0
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      alive = false
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [api, serverBaseUrl])

  return view
}
