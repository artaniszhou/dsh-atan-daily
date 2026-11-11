/**
 * 契约块定位：给每个块分配稳定 key，并支持按 key 找到它在 `x-blocks` 里的位置。
 *
 * key 的规则与渲染计划完全一致：组件名 + 同组件出现序号（`chart#3`）。这样
 * 覆盖文件、面板、渲染器三处说的是同一件事。
 */

/** 块在契约里的位置。 */
export interface LocatedBlock {
  /** 解析后的块对象。 */
  block: Record<string, unknown>
  /** 它所在的数组（顶层 `x-blocks`、card 的 children，或 columns 的某一栏）。 */
  siblings: Record<string, unknown>[]
  /** 在数组里的下标。 */
  index: number
}

/** 块目录条目。 */
export interface OutlineBlock {
  key: string
  component: string
  /** 图表图注、表格小标题、卡片标题、标题文字。 */
  title?: string
  /** 绑定的字段名。 */
  source?: string
  /** 图表系列类型。 */
  series?: string[]
  /** 子块（card / columns）。 */
  children?: OutlineBlock[]
}

/** 判断普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 块组件名；缺失或空串时返回 undefined。 */
function componentOf(block: Record<string, unknown>): string | undefined {
  const component = block['component']
  return typeof component === 'string' && component.trim() !== '' ? component : undefined
}

/**
 * 按渲染顺序遍历块。
 * @param schema - 契约。
 * @param visit - 访问回调；返回 false 可提前结束。
 * @returns 是否完整遍历。
 */
export function walkBlocks(
  schema: Record<string, unknown>,
  visit: (block: Record<string, unknown>, key: string) => boolean | void,
): boolean {
  const counters = new Map<string, number>()

  const render = (block: Record<string, unknown>): boolean => {
    const component = componentOf(block)
    if (component === undefined) return true
    const next = (counters.get(component) ?? 0) + 1
    counters.set(component, next)
    const key = `${component}#${String(next)}`
    if (visit(block, key) === false) return false

    const children = block['children']
    if (Array.isArray(children)) {
      for (const child of children) {
        if (Array.isArray(child)) {
          for (const item of child) {
            if (isRecord(item) && !render(item)) return false
          }
        } else if (isRecord(child)) {
          if (!render(child)) return false
        }
      }
    }
    return true
  }

  const blocks = schema['x-blocks']
  if (Array.isArray(blocks)) {
    for (const block of blocks) {
      if (isRecord(block) && !render(block)) return false
    }
  }
  return true
}

/**
 * 找到某个 key 对应的块。
 * @param schema - 契约。
 * @param key - 块 key。
 * @returns 位置；找不到时 undefined。
 */
export function locateBlock(schema: Record<string, unknown>, key: string): LocatedBlock | undefined {
  const counters = new Map<string, number>()

  const render = (
    block: Record<string, unknown>,
    siblings: Record<string, unknown>[],
    index: number,
  ): LocatedBlock | undefined => {
    const component = componentOf(block)
    if (component === undefined) return undefined
    const next = (counters.get(component) ?? 0) + 1
    counters.set(component, next)
    if (`${component}#${String(next)}` === key) return { block, siblings, index }
    const children = block['children']
    if (Array.isArray(children)) {
      for (const child of children) {
        const list = Array.isArray(child) ? child : [child]
        for (let childIndex = 0; childIndex < list.length; childIndex += 1) {
          const item = list[childIndex]
          if (!isRecord(item)) continue
          const found = render(item, list as Record<string, unknown>[], childIndex)
          if (found !== undefined) return found
        }
      }
    }
    return undefined
  }

  const blocks = schema['x-blocks']
  if (Array.isArray(blocks)) {
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index]
      if (!isRecord(block)) continue
      const found = render(block, blocks as Record<string, unknown>[], index)
      if (found !== undefined) return found
    }
  }
  return undefined
}

/** 块标题：图表/表格/卡片用 title，标题块用 text。 */
function titleOf(block: Record<string, unknown>): string | undefined {
  const title = block['title']
  if (typeof title === 'string' && title.trim() !== '') return title.trim()
  const text = block['text']
  if (typeof text === 'string' && text.trim() !== '') return text.trim()
  return undefined
}

/**
 * 生成块目录，供面板选择与重新绑定使用。
 * @param schema - 契约。
 * @returns 目录树。
 */
export function outlineOf(schema: Record<string, unknown>): OutlineBlock[] {
  const result: OutlineBlock[] = []
  const counters = new Map<string, number>()

  const build = (block: Record<string, unknown>): OutlineBlock | undefined => {
    const component = componentOf(block)
    if (component === undefined) return undefined
    const next = (counters.get(component) ?? 0) + 1
    counters.set(component, next)
    const entry: OutlineBlock = { key: `${component}#${String(next)}`, component }
    const title = titleOf(block)
    if (title !== undefined) entry.title = title
    const source = block['source']
    if (typeof source === 'string') entry.source = source
    const series = block['series']
    if (Array.isArray(series)) {
      const types = series
        .map(item => (isRecord(item) && typeof item['type'] === 'string' ? item['type'] : undefined))
        .filter((item): item is string => item !== undefined)
      if (types.length > 0) entry.series = types
    }
    const children = block['children']
    if (Array.isArray(children)) {
      const nested: OutlineBlock[] = []
      for (const child of children) {
        const list = Array.isArray(child) ? child : [child]
        for (const item of list) {
          if (!isRecord(item)) continue
          const entryChild = build(item)
          if (entryChild !== undefined) nested.push(entryChild)
        }
      }
      if (nested.length > 0) entry.children = nested
    }
    return entry
  }

  const blocks = schema['x-blocks']
  if (Array.isArray(blocks)) {
    for (const block of blocks) {
      if (!isRecord(block)) continue
      const entry = build(block)
      if (entry !== undefined) result.push(entry)
    }
  }
  return result
}
