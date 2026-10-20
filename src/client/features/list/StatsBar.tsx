/** 统计条：描述整个工作目录，不随搜索或翻页变化。 */
import { t } from '../../i18n/index.ts'
import { T } from '../../ui/tokens.ts'
import type { TaskStats } from './derive.ts'
import css from './list.module.css'

/** 统计条属性。 */
export interface StatsBarProps {
  stats: TaskStats
}

/** 一条统计的数字。 */
interface StatItem {
  key: string
  label: string
  value: string
  color?: string
  hint?: string
}

/** 统计条。 */
export function StatsBar({ stats }: StatsBarProps) {
  const items: StatItem[] = [
    { key: 'total', label: t('statsTotal'), value: String(stats.total) },
    { key: 'enabled', label: t('statsEnabled'), value: `${String(stats.enabled)} / ${String(stats.total)}` },
    {
      key: 'running',
      label: t('statsRunning'),
      value: String(stats.running),
      ...(stats.running > 0 ? { color: T.accent } : {}),
    },
    {
      key: 'attention',
      label: t('statsAttention'),
      value: String(stats.attention),
      color: stats.attention > 0 ? T.danger : T.ink2,
      hint: t('statsAttentionHint'),
    },
  ]

  return (
    <div className={css.stats} role="group" aria-label={t('statsLabel')}>
      {items.map(item => (
        <div key={item.key} className={css.stat} title={item.hint}>
          <span className={css.statLabel}>{item.label}</span>
          <span className={css.statValue} style={item.color === undefined ? undefined : { color: item.color }}>
            {item.value}
          </span>
        </div>
      ))}
    </div>
  )
}
