/** 分页条：首页/尾页 + 当前页附近窗口，跳过的位置显示省略号。 */
import { t } from '../../i18n/index.ts'
import { pagePositions } from '../../shared/paging.ts'
import { Button } from '../../ui/primitives.tsx'
import css from './list.module.css'

/** 分页属性。 */
export interface PagerProps {
  page: number
  pages: number
  onChange: (next: number) => void
}

/** 分页条。 */
export function Pager({ page, pages, onChange }: PagerProps) {
  return (
    <nav className={css.pager} aria-label={t('paginationLabel')}>
      <span className={css.pagerStatus} role="status" aria-live="polite">
        {`${t('pageLabel')} ${String(page)} / ${String(pages)}${t('pageSuffix')}`}
      </span>
      <div className={css.pagerPages}>
        <Button size="sm" variant="quiet" disabled={page <= 1} onClick={() => { onChange(page - 1) }}>
          {t('pagePrevious')}
        </Button>
        {pagePositions(page, pages).map((position, index) => (position === 'gap'
          ? <span key={`gap-${String(index)}`} className={css.pageGap} aria-hidden="true">…</span>
          : (
            <Button
              key={position}
              size="sm"
              variant="quiet"
              className={position === page ? css.pageButtonActive : undefined}
              aria-label={`${t('pageLabel')} ${String(position)}${t('pageSuffix')}`}
              aria-current={position === page ? 'page' : undefined}
              onClick={() => { onChange(position) }}
            >
              {String(position)}
            </Button>
            )))}
        <Button size="sm" variant="quiet" disabled={page >= pages} onClick={() => { onChange(page + 1) }}>
          {t('pageNext')}
        </Button>
      </div>
    </nav>
  )
}
