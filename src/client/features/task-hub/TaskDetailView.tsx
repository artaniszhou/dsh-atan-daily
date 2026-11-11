/**
 * 任务详情：任务仓库抽屉里的只读视图，展示任务包内容与默认参数。
 *
 * 任务包 v2 是一组 `{ path, content }`：三份固定文档加 `charts/*.mjs`。
 * 服务端与 Host 都已剔除提交者身份，这里不再有任何账号信息。
 */
import { useEffect, useState } from 'react'
import { hostErrorText } from '../../api/errors.ts'
import type { AtanDailyApi } from '../../api/tasks.ts'
import type { TaskHubTaskDetail } from '../../api/task-hub.ts'
import { t } from '../../i18n/index.ts'
import { formatVersion } from '../../shared/format.ts'
import { Button, Notice, SkeletonList } from '../../ui/primitives.tsx'
import css from './task-hub.module.css'

export interface TaskDetailViewProps {
  api: AtanDailyApi
  publicId: string
  onBack: () => void
}

/** JSON 美化；解析失败时原样显示。 */
function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text) as unknown, null, 2)
  } catch {
    return text
  }
}

/**
 * 拉一次详情并渲染；失败时留在本视图重试，不关闭抽屉。
 */
export function TaskDetailView({ api, publicId, onBack }: TaskDetailViewProps) {
  const [detail, setDetail] = useState<TaskHubTaskDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [epoch, setEpoch] = useState(0)

  useEffect(() => {
    void (async () => {
      setLoading(true)
      setError('')
      try {
        setDetail(await api.detailTaskHubTask(publicId))
      } catch (failure: unknown) {
        setError(hostErrorText(failure, t))
      } finally {
        setLoading(false)
      }
    })()
  }, [api, publicId, epoch])

  const defaults = detail?.task.defaults
  const historyDays = defaults?.historyDays
  const checks = detail?.task.checks
  const body = loading
    ? <SkeletonList label="任务详情" />
    : error !== ''
      ? (
        <Notice kind="error">
          <span>{error}</span>
          <Button size="sm" variant="quiet" onClick={() => { setEpoch(value => value + 1) }}>{t('retry')}</Button>
        </Notice>
        )
      : detail === null
        ? <Notice kind="empty">任务详情为空。</Notice>
        : (
          <div className={css.detailSections}>
            <div className={css.summary}>
              <h4>{detail.task.name}</h4>
              <p>{detail.task.summary}</p>
              <div className={css.kv}><span>标签</span><b>{detail.task.tags.length === 0 ? '—' : detail.task.tags.join(' / ')}</b></div>
              <div className={css.kv}><span>版本</span><b>{formatVersion(detail.meta.version)}</b></div>
              <div className={css.kv}><span>加载量</span><b>{detail.meta.loadCount}</b></div>
              <div className={css.kv}>
                <span>文件</span>
                <b>{`${String(checks?.fileCount ?? detail.task.files.length)} 份 · ${((checks?.totalBytes ?? 0) / 1024).toFixed(1)} KB`}</b>
              </div>
              <div className={css.kv}><span>自定义图形</span><b>{checks?.hasExecutable === true ? '有' : '无'}</b></div>
            </div>

            <div className={css.summary}>
              <h4>默认执行</h4>
              <div className={css.kv}><span>执行时间</span><b>{defaults?.schedule === undefined || defaults.schedule === '' ? '—' : defaults.schedule}</b></div>
              <div className={css.kv}><span>时区</span><b>{defaults?.timeZone === undefined || defaults.timeZone === '' ? '—' : defaults.timeZone}</b></div>
              <div className={css.kv}>
                <span>历史保留</span>
                <b>{historyDays === undefined ? '—' : historyDays === 0 ? '永久' : `${String(historyDays)} 天`}</b>
              </div>
              <div className={css.kv}>
                <span>权限级别</span>
                <b>{defaults?.permissionLevel === 'danger-full-access' ? '完全权限' : '工作区内修改'}</b>
              </div>
              <div className={css.kv}><span>每次执行新会话</span><b>{defaults?.newSession === true ? '是' : '否'}</b></div>
            </div>

            {detail.task.files.map(file => (
              <section key={file.path}>
                <h4 className={css.sectionTitle}>{file.path}</h4>
                <pre className={file.path.endsWith('.md') ? css.detailText : css.code}>
                  {file.path.endsWith('.json') ? prettyJson(file.content) : file.content}
                </pre>
              </section>
            ))}
          </div>
          )

  return (
    <div className={css.loadForm}>
      <button type="button" className={css.back} onClick={onBack}>← 返回任务仓库</button>
      {body}
    </div>
  )
}
