/**
 * 标题下方的公告条。
 *
 * 默认只显示一行标题；有正文时右侧出现「展开」，展开后标题完整换行、正文
 * 限定高度内部滚动。没有公告、未配置服务地址或接口失败时整块不渲染，
 * 页面结构与没有这个功能时一致。
 */
import { useEffect, useId, useState } from 'react'
import type { AnnouncementView } from '../../../protocol.ts'
import type { AtanDailyApi } from '../../api/tasks.ts'
import { t } from '../../i18n/index.ts'
import { IconMegaphone } from '../../ui/icons.tsx'
import css from './announcement.module.css'
import { useAnnouncement } from './useAnnouncement.ts'

/** 标题缺失时从正文首行截取的兜底长度。 */
const FALLBACK_TITLE_MAX = 40

/** 组件属性。 */
export interface AnnouncementBannerProps {
  api: AtanDailyApi
  /** 当前任务服务地址；空串表示未配置，不发请求。 */
  serverBaseUrl: string
}

/**
 * 取展示用标题。
 *
 * 后台漏填标题时用正文首行兜底：公告还在，只是标题没写。
 * @param view - 公告视图。
 * @returns 单行标题文本。
 */
function displayTitle(view: AnnouncementView): string {
  const title = view.title.trim()
  if (title !== '') return title
  const firstLine = view.content.trim().split('\n')[0] ?? ''
  return firstLine.length > FALLBACK_TITLE_MAX ? `${firstLine.slice(0, FALLBACK_TITLE_MAX)}…` : firstLine
}

/** 公告条。 */
export function AnnouncementBanner({ api, serverBaseUrl }: AnnouncementBannerProps) {
  const view = useAnnouncement(api, serverBaseUrl)
  const [expanded, setExpanded] = useState<boolean>(false)
  const bodyId = useId()

  // 内容换了（运营改了公告）就回到折叠态，别让展开状态错位到新内容上。
  const identity = view === null
    ? ''
    : `${view.updatedAt ?? ''}\u0000${view.title}\u0000${String(view.content.length)}`
  useEffect(() => {
    setExpanded(false)
  }, [identity])

  if (view === null) return null

  const title = displayTitle(view)
  const hasContent = view.content.trim() !== ''
  const isOpen = expanded && hasContent

  return (
    <section
      className={css.banner}
      aria-label={t('announcementLabel')}
      data-expanded={isOpen ? 'true' : 'false'}
      onKeyDown={(event) => {
        // 焦点在公告里时 Esc 收起：和多数展开控件的手感一致。
        if (event.key === 'Escape' && isOpen) {
          event.stopPropagation()
          setExpanded(false)
        }
      }}
    >
      <span className={css.icon} aria-hidden="true">
        <IconMegaphone size={15} />
      </span>
      <div className={css.body}>
        <div className={css.head}>
          <p className={css.title} title={title}>{title}</p>
          {hasContent
            ? (
              <button
                type="button"
                className={css.toggle}
                aria-expanded={isOpen}
                aria-controls={bodyId}
                onClick={() => { setExpanded(value => !value) }}
              >
                {isOpen ? t('announcementCollapse') : t('announcementExpand')}
              </button>
              )
            : null}
        </div>
        {hasContent
          ? <p id={bodyId} className={css.content} hidden={!isOpen}>{view.content}</p>
          : null}
      </div>
    </section>
  )
}
