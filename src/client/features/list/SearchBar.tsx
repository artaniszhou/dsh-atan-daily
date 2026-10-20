/** 列表上方的搜索框与匹配计数。 */
import { t } from '../../i18n/index.ts'
import { IconSearch } from '../../ui/icons.tsx'
import { TextInput } from '../../ui/primitives.tsx'
import css from './list.module.css'

/** 搜索框属性。 */
export interface SearchBarProps {
  value: string
  total: number
  matching: number
  onChange: (next: string) => void
}

/** 搜索框。 */
export function SearchBar({ value, total, matching, onChange }: SearchBarProps) {
  return (
    <div className={css.search} role="search">
      <div className={css.searchField}>
        <span className={css.searchIcon}><IconSearch /></span>
        <TextInput
          type="text"
          className={css.searchInput}
          value={value}
          placeholder={t('searchPlaceholder')}
          aria-label={t('searchLabel')}
          aria-controls="atan-daily-task-list"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => { onChange(event.currentTarget.value) }}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && value !== '') {
              // 不让 Esc 同时关掉外层面板。
              event.stopPropagation()
              onChange('')
            }
          }}
        />
        {value === ''
          ? null
          : (
            <button
              type="button"
              className={css.searchClear}
              title={t('searchClear')}
              aria-label={t('searchClear')}
              onClick={() => { onChange('') }}
            >
              <span aria-hidden="true">×</span>
            </button>
            )}
      </div>
      <span className={css.searchCount} role="status" aria-live="polite">
        {value.trim() === ''
          ? `${t('searchTotal')} ${String(total)} ${t('taskUnit')}`
          : `${t('searchMatching')} ${String(matching)} / ${String(total)} ${t('taskUnit')}`}
      </span>
    </div>
  )
}
