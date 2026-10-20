/**
 * 分页位置计算（纯函数）。
 *
 * 短列表显示全部页码；长列表保留首页、尾页与当前页附近的窗口，
 * 跳过的位置用 `'gap'` 表示，由组件渲染成省略号。
 */

/**
 * 计算分页条要显示的页码。
 * @param current - 当前页（1 起）。
 * @param total - 总页数。
 * @returns 页码与间隔标记，按显示顺序排列。
 */
export function pagePositions(current: number, total: number): Array<number | 'gap'> {
  if (total <= 7) return Array.from({ length: total }, (_value, index) => index + 1)
  let start = Math.max(2, current - 1)
  let end = Math.min(total - 1, current + 1)
  if (current <= 3) {
    start = 2
    end = 4
  } else if (current >= total - 2) {
    start = total - 3
    end = total - 1
  }
  const positions: Array<number | 'gap'> = [1]
  if (start > 2) positions.push('gap')
  for (let page = start; page <= end; page += 1) positions.push(page)
  if (end < total - 1) positions.push('gap')
  positions.push(total)
  return positions
}
