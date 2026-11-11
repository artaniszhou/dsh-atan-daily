/**
 * 上传任务：三步向导（文件 / 信息 / 预览并提交）。
 *
 * 文件由 Host 从任务目录的 `.share/` 收集：三份固定文档 + `charts/*.mjs`。
 * 名称、简介、标签都来自本地任务与 schema，页面不再让用户填写。
 * 页面不读取、不展示任何账号身份：未登录时由预览接口的报错提示。
 */
import { useEffect, useState } from 'react'
import type { TaskRecord } from '../../../protocol.ts'
import { hostErrorText } from '../../api/errors.ts'
import type { AtanDailyApi } from '../../api/tasks.ts'
import type { TaskHubFileInfo, TaskHubPreview, TaskHubScanFinding } from '../../api/task-hub.ts'
import { formatVersion } from '../../shared/format.ts'
import { t } from '../../i18n/index.ts'
import { Dialog } from '../../ui/dialog.tsx'
import { Button, TextArea } from '../../ui/primitives.tsx'
import css from './task-hub.module.css'

export interface UploadTaskDialogProps {
  api: AtanDailyApi
  task: TaskRecord
  details: string
  onClose: () => void
  onSubmitted: () => void
}

/** 文件图标文字。 */
function iconOf(file: TaskHubFileInfo): string {
  if (file.language === 'markdown') return 'MD'
  if (file.language === 'json') return 'JSON'
  if (file.language === 'javascript') return 'JS'
  return 'TXT'
}

/** 文件种类标签。 */
function kindOf(file: TaskHubFileInfo): string {
  if (file.kind === 'chart') return '图形脚本'
  if (file.kind === 'detail') return '任务详情'
  if (file.kind === 'schema') return '报告 Schema'
  return '外观覆盖'
}

/** 严重度文案。 */
function severityText(severity: TaskHubScanFinding['severity']): string {
  if (severity === 'block') return '阻断'
  if (severity === 'warn') return '提示'
  return '信息'
}

export function UploadTaskDialog({ api, task, details, onClose, onSubmitted }: UploadTaskDialogProps) {
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [preview, setPreview] = useState<TaskHubPreview | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<{ taskId: string, version: number } | null>(null)

  const input = (): { taskId: string, details: string } => ({
    taskId: task.taskId,
    details,
  })

  useEffect(() => {
    void (async () => {
      setLoading(true)
      try {
        setPreview(await api.previewTaskUpload(input()))
      } catch (failure: unknown) {
        setError(hostErrorText(failure, t))
      } finally {
        setLoading(false)
      }
    })()
    // 只在打开时读一次；后续预览由按钮触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const next = async (): Promise<void> => {
    if (step === 1) {
      setStep(2)
      return
    }
    if (step === 3) return
    setLoading(true)
    setError('')
    try {
      setPreview(await api.previewTaskUpload(input()))
      setStep(3)
    } catch (failure: unknown) {
      setError(hostErrorText(failure, t))
    } finally {
      setLoading(false)
    }
  }

  const submit = async (): Promise<void> => {
    setSubmitting(true)
    setError('')
    try {
      const submitted = await api.submitTask(input())
      setResult({ taskId: submitted.taskId, version: submitted.version })
    } catch (failure: unknown) {
      setError(hostErrorText(failure, t))
    } finally {
      setSubmitting(false)
    }
  }

  /** 预览没读到时不要一直显示「读取中」：有错误就说明没读到。 */
  const pending = error === '' ? '读取中…' : '未读取'
  const findings = preview?.scan.findings ?? []
  const footer = result !== null
    ? <Button variant="primary" size="sm" onClick={onSubmitted}>完成</Button>
    : (
      <div className={css.formActions}>
        <Button size="sm" variant="quiet" onClick={onClose}>{t('cancel')}</Button>
        {step > 1 ? <Button size="sm" variant="quiet" onClick={() => { setStep(step === 3 ? 2 : 1); setError('') }}>上一步</Button> : null}
        {step < 3
          ? <Button size="sm" variant="primary" disabled={loading} onClick={() => { void next() }}>{step === 1 ? '下一步：确认信息' : '下一步：预览'}</Button>
          : <Button size="sm" variant="primary" disabled={loading || submitting || preview === null} onClick={() => { void submit() }}>{submitting ? t('loading') : '提交'}</Button>}
      </div>
    )

  return (
    <Dialog
      title="上传任务"
      subtitle="名称、简介、标签来自任务与 Schema；上传 .share/ 三份文件与 charts/ 图形脚本"
      closeLabel={t('runsClose')}
      onClose={onClose}
      footer={footer}
    >
      {result === null ? (
        <>
          <div className={css.steps}>
            <div className={`${css.step} ${step === 1 ? css.stepActive : step > 1 ? css.stepDone : ''}`}><span>1</span>文件</div>
            <div className={css.stepLine} />
            <div className={`${css.step} ${step === 2 ? css.stepActive : step > 2 ? css.stepDone : ''}`}><span>2</span>任务信息</div>
            <div className={css.stepLine} />
            <div className={`${css.step} ${step === 3 ? css.stepActive : ''}`}><span>3</span>预览并提交</div>
          </div>

          {error === '' ? null : <div className={css.error} role="alert">{error}</div>}

          {step === 1 ? (
            <>
              <div className={css.fileGrid}>
                {preview === null
                  ? <div className={css.fileCard}><span className={css.fileIcon}>…</span><div className={css.fileBody}><div className={css.fileName}>.share/ <span className={css.tag}>{pending}</span></div></div></div>
                  : preview.files.map(file => (
                    <div key={file.path} className={css.fileCard}>
                      <span className={css.fileIcon}>{iconOf(file)}</span>
                      <div className={css.fileBody}>
                        <div className={css.fileName}>{file.path} <span className={css.tag}>{kindOf(file)}</span></div>
                        <div className={css.fileMeta}>{`${(file.bytes / 1024).toFixed(1)} KB · ${file.language}`}</div>
                      </div>
                    </div>
                  ))}
              </div>
              <div className={css.note}>
                {preview === null
                  ? pending
                  : `共 ${String(preview.totals.count)} 份、${(preview.totals.bytes / 1024).toFixed(1)} KB${preview.totals.executables > 0 ? `，含 ${String(preview.totals.executables)} 个图形脚本` : ''}。取数脚本、缓存与历史报告留在本地，不会上传。`}
              </div>
              {findings.length > 0 ? (
                <ul className={css.scanList}>
                  {findings.map((finding, index) => (
                    <li key={`${finding.code}-${String(index)}`} className={`${css.scanItem} ${finding.severity === 'block' ? css.scanBlock : finding.severity === 'warn' ? css.scanWarn : css.scanInfo}`}>
                      <b>{severityText(finding.severity)}</b>
                      <span>{finding.path === '' ? '' : `${finding.path}${finding.line === undefined ? '' : `:${String(finding.line)}`} `}{finding.message}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : null}

          {step === 2 ? (
            <div className={css.fieldGrid}>
              <div>
                <div className={css.label}><span>任务名称</span><em>来自本地任务</em></div>
                <div className={css.readonlyValue}>{task.name}</div>
              </div>
              <div>
                <div className={css.label}><span>一句话简介</span><em>来自 Schema</em></div>
                <div className={css.readonlyValue}>{preview?.package.summary ?? pending}</div>
              </div>
              <div>
                <div className={css.label}><span>标签</span><em>来自 Schema</em></div>
                <div className={css.readonlyValue}>
                  {preview === null ? pending : preview.package.tags.length === 0 ? '未生成' : preview.package.tags.join(' / ')}
                </div>
              </div>
              <div>
                <div className={css.label}><span>任务详情</span><em>使用编辑中的内容</em></div>
                <TextArea value={details} rows={5} readOnly />
              </div>
            </div>
          ) : null}

          {step === 3 && preview !== null ? (
            <>
              <div className={css.summary}>
                <h4>{preview.package.name}</h4>
                <p>{preview.package.summary}</p>
                <div className={css.kv}><span>默认执行</span><b>{preview.package.defaults.schedule}</b></div>
                <div className={css.kv}><span>时区</span><b>{preview.package.defaults.timeZone}</b></div>
                <div className={css.kv}><span>文件</span><b>{`${String(preview.totals.count)} 份 · ${(preview.totals.bytes / 1024).toFixed(1)} KB`}</b></div>
              </div>
              <pre className={css.code}>{JSON.stringify(preview.package, null, 2)}</pre>
            </>
          ) : null}
        </>
      ) : (
        <div className={css.success}>
          <div className={css.successIcon}>✓</div>
          <h3>已提交</h3>
          <p>已上传到任务仓库，审核上架后其他人才会看到。结果不另发通知。</p>
          <div className={css.ticket}>{result.taskId}</div>
          <p style={{ marginTop: 8 }}>版本 {formatVersion(result.version)}</p>
        </div>
      )}
    </Dialog>
  )
}
