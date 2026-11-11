/**
 * 无依赖的 JSON Schema 子集校验器。
 *
 * 用途是给「任务数据契约」做双向校验：契约文件本身要符合元 schema，每轮
 * `report.json.data` 又要符合契约。两条链路共用这一份实现，错误信息必须
 * **可执行** —— 它会被直接回灌给模型，让模型自己改数据或改契约。
 *
 * 支持的子集（够描述日报数据，不做完整实现）：
 * - 结构：`type`（含类型数组）、`properties`、`required`、`additionalProperties`、
 *   `items`（单 schema / 元组）、`minProperties`、`maxProperties`、`$defs`、本地 `$ref`
 * - 值：`enum`、`const`、`minimum`、`maximum`、`minItems`、`maxItems`、
 *   `minLength`、`maxLength`、`pattern`、`format`（`date` / `date-time` / `uri`）
 * - 组合：`anyOf`、`oneOf`
 * - 注释：`title`、`description`、`default`、`examples`、`deprecated` 与全部 `x-` 扩展
 *
 * 子集之外的合法关键字（`if`/`then`、`patternProperties`、远程 `$ref` 等）不会被
 * 当成错误，只记一条 warning：宁可能少校验，也不要因为写法超纲把一份好数据判死。
 *
 * 本文件不依赖 Node，也不碰 fs，纯函数，方便单独回归。
 */

/** 一个校验问题。 */
export interface Issue {
  /** 数据里的位置，JSONPath 风格：`$` 根、`.name` 成员、`[0]` 下标。 */
  path: string
  /** 触发的关键字，便于定位是哪条规则。 */
  keyword: string
  /** 给人（也给模型）看的一句话。 */
  message: string
  /** 可执行的修复建议；没有更好的建议时缺省。 */
  hint?: string
}

/** 一次校验的结果。 */
export interface CheckResult {
  /** 没有任何 issue 时为 true。 */
  ok: boolean
  /** 阻断性问题。 */
  issues: Issue[]
  /** 不阻断、但值得记录的写法问题（未知关键字、无法解析的 `$ref` 等）。 */
  warnings: string[]
}

/** 校验选项。 */
export interface CheckOptions {
  /** 最多收集多少条 issue，默认 50；超出的直接丢弃，避免刷屏。 */
  maxIssues?: number
  /** `$ref` 递归与嵌套深度上限，默认 32。 */
  maxDepth?: number
  /**
   * 校验对象是不是「契约结构」本身。
   *
   * 校验业务数据时，缺必填字段的建议是「写 null 并登记到 missing[]」；
   * 校验契约结构时这句话是错的——契约缺 `x-revision` 只能补，不能写 null。
   */
  structural?: boolean
}

/** JSON Schema 的节点：布尔 schema 或对象 schema。 */
type SchemaNode = boolean | Record<string, unknown>

/** 支持的类型名。 */
const TYPE_NAMES: readonly string[] = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']

/** 支持的格式名。 */
const FORMAT_NAMES: readonly string[] = ['date', 'date-time', 'uri']

/** 真正会执行的 schema 关键字。 */
const CHECKED_KEYWORDS: ReadonlySet<string> = new Set([
  '$defs', '$ref',
  'type', 'properties', 'required', 'additionalProperties', 'items',
  'minProperties', 'maxProperties', 'minItems', 'maxItems',
  'minLength', 'maxLength', 'pattern', 'format',
  'enum', 'const', 'minimum', 'maximum',
  'anyOf', 'oneOf',
])

/** 只是注释、不参与校验的关键字。 */
const ANNOTATION_KEYWORDS: ReadonlySet<string> = new Set([
  '$schema', '$id', '$comment', 'title', 'description', 'default', 'examples',
  'deprecated', 'readOnly', 'writeOnly',
])

/** 成员名可以用点号访问的样子；否则用 `["…"]`。 */
const SIMPLE_KEY = /^[A-Za-z_$][\w$]*$/u

/** 是不是一个 schema 节点。 */
function isSchemaNode(value: unknown): value is SchemaNode {
  return typeof value === 'boolean' || isRecord(value)
}

/** 是不是普通对象（不含数组与 null）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 值的实际类型名。 */
function kindOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/** 一句话描述一个实际值，用于错误信息。 */
function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `array(${String(value.length)} 项)`
  if (typeof value === 'string') {
    const shown = value.length > 24 ? `${value.slice(0, 24)}…` : value
    return `string ${JSON.stringify(shown)}`
  }
  if (typeof value === 'number' || typeof value === 'boolean') return `${kindOf(value)} ${String(value)}`
  if (isRecord(value)) return `object(${String(Object.keys(value).length)} 个字段)`
  return kindOf(value)
}

/** 值是否符合某个类型名。 */
function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'null':
      return value === null
    case 'array':
      return Array.isArray(value)
    case 'object':
      return isRecord(value)
    case 'string':
      return typeof value === 'string'
    case 'boolean':
      return typeof value === 'boolean'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    default:
      return false
  }
}

/** 成员路径：简单名用 `.name`，其余用 `["…"]`。 */
function memberPath(base: string, key: string): string {
  return SIMPLE_KEY.test(key) ? `${base}.${key}` : `${base}[${JSON.stringify(key)}]`
}

/** 下标路径。 */
function indexPath(base: string, index: number): string {
  return `${base}[${String(index)}]`
}

/** 结构相等：只比较 JSON 值，够 `const` / `enum` 用。 */
function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false
    return left.every((item, index) => sameValue(item, right[index]))
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left)
    if (leftKeys.length !== Object.keys(right).length) return false
    return leftKeys.every(key => key in right && sameValue(left[key], right[key]))
  }
  return false
}

/** 解析本地 `$ref`；只认 `#` 与 `#/…`。 */
function resolveRef(root: SchemaNode, ref: string): SchemaNode | undefined {
  if (!ref.startsWith('#')) return undefined
  const rest = ref.slice(1)
  if (rest === '') return root
  if (!rest.startsWith('/')) return undefined
  let current: unknown = root
  for (const rawToken of rest.slice(1).split('/')) {
    const token = rawToken.replaceAll('~1', '/').replaceAll('~0', '~')
    if (Array.isArray(current)) {
      const index = Number(token)
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined
      current = current[index]
      continue
    }
    if (!isRecord(current) || !(token in current)) return undefined
    current = current[token]
  }
  return isSchemaNode(current) ? current : undefined
}

/** 日期是否真实存在（挡掉 2026-02-30 这类）。 */
function isRealDate(text: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(text)
  if (match === null) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1) return false
  const probe = new Date(Date.UTC(year, month - 1, day))
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day
}

/** 按 `format` 校验字符串；返回错误说明，合法时 undefined。 */
function checkFormat(format: string, value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  switch (format) {
    case 'date':
      return isRealDate(value) ? undefined : '不是合法的 YYYY-MM-DD 日期'
    case 'date-time':
      return /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(:\d{2})?(\.\d+)?([Zz]|[+-]\d{2}:?\d{2})?$/u.test(value)
        && !Number.isNaN(Date.parse(value))
        ? undefined
        : '不是合法的 ISO 时间'
    case 'uri':
      return /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value) ? undefined : '缺少协议前缀（https:、file: 等）'
    default:
      return undefined
  }
}

/** 类型不匹配时的修复建议。 */
function typeHint(value: unknown, expected: readonly string[]): string | undefined {
  if (value === null && !expected.includes('null')) {
    return '拿不到数据时写 null，并在报告的 missing[] 里登记原因'
  }
  if (typeof value === 'string' && (expected.includes('number') || expected.includes('integer'))) {
    const cleaned = value.trim().replaceAll(',', '').replace(/%$/u, '')
    if (cleaned !== '' && Number.isFinite(Number(cleaned))) {
      return '看着是数字却写成了字符串：去掉引号与单位，单位用 x-unit 声明'
    }
  }
  if (Array.isArray(value) && expected.includes('object')) {
    return '数组要装进对象里，例如 { "items": [ … ] }'
  }
  if (isRecord(value) && expected.includes('array')) {
    return '对象外层需要包一层数组'
  }
  return undefined
}

/** 校验过程中的累积状态。 */
interface Context {
  issues: Issue[]
  warnings: Set<string>
  maxIssues: number
  maxDepth: number
  /** 校验的是契约结构本身（见 {@link CheckOptions.structural}）。 */
  structural: boolean
}

/** 记一条 issue；超过上限后丢弃。 */
function report(context: Context, issue: Issue): void {
  if (context.issues.length < context.maxIssues) context.issues.push(issue)
}

/** 记一条 warning（去重）。 */
function warn(context: Context, message: string): void {
  context.warnings.add(message)
}

/** 校验一个节点。 */
function validateNode(
  node: SchemaNode,
  value: unknown,
  path: string,
  root: SchemaNode,
  context: Context,
  depth: number,
): void {
  if (context.issues.length >= context.maxIssues) return
  if (node === true) return
  if (node === false) {
    report(context, { path, keyword: 'false', message: '该位置不允许任何值（schema 为 false）' })
    return
  }
  if (depth > context.maxDepth) {
    warn(context, `嵌套超过 ${String(context.maxDepth)} 层，已停止校验（位置 ${path}）`)
    return
  }

  for (const key of Object.keys(node)) {
    if (CHECKED_KEYWORDS.has(key) || ANNOTATION_KEYWORDS.has(key) || key.startsWith('x-')) continue
    warn(context, `不支持的写法 ${key}（位置 ${path}），已忽略`)
  }

  const ref = node['$ref']
  if (typeof ref === 'string') {
    const target = resolveRef(root, ref)
    if (target === undefined) warn(context, `无法解析的 $ref：${ref}（位置 ${path}）`)
    else validateNode(target, value, path, root, context, depth + 1)
  }

  // —— 类型 ——
  const typeSpec = node['type']
  const expected: string[] = typeof typeSpec === 'string'
    ? [typeSpec]
    : Array.isArray(typeSpec)
      ? typeSpec.filter((item): item is string => typeof item === 'string')
      : []
  if (expected.length > 0) {
    const known = expected.filter(name => TYPE_NAMES.includes(name))
    if (known.length !== expected.length) {
      warn(context, `契约里有未知类型 ${expected.filter(name => !TYPE_NAMES.includes(name)).join(', ')}（位置 ${path}）`)
    }
    if (known.length > 0 && !known.some(name => matchesType(value, name))) {
      report(context, {
        path,
        keyword: 'type',
        message: `期望 ${known.join(' 或 ')}，实际是 ${describe(value)}`,
        ...hintOf(typeHint(value, known)),
      })
      return
    }
  }

  // —— 常量与枚举 ——
  if ('const' in node && !sameValue(value, node['const'])) {
    report(context, {
      path,
      keyword: 'const',
      message: `取值必须是 ${JSON.stringify(node['const'])}，实际是 ${describe(value)}`,
    })
  }
  const enumValues = node['enum']
  if (Array.isArray(enumValues) && !enumValues.some(item => sameValue(value, item))) {
    report(context, {
      path,
      keyword: 'enum',
      message: `取值不在允许范围内：${describe(value)}`,
      hint: `允许值：${enumValues.map(item => JSON.stringify(item)).join(' / ')}`,
    })
  }

  // —— 字符串 ——
  if (typeof value === 'string') {
    const minLength = node['minLength']
    const maxLength = node['maxLength']
    if (typeof minLength === 'number' && value.length < minLength) {
      report(context, { path, keyword: 'minLength', message: `长度至少 ${String(minLength)}，实际 ${String(value.length)}` })
    }
    if (typeof maxLength === 'number' && value.length > maxLength) {
      report(context, { path, keyword: 'maxLength', message: `长度最多 ${String(maxLength)}，实际 ${String(value.length)}` })
    }
    const pattern = node['pattern']
    if (typeof pattern === 'string') {
      let matched = true
      try {
        matched = new RegExp(pattern, 'u').test(value)
      } catch {
        warn(context, `契约里的 pattern 不是合法正则：${pattern}（位置 ${path}）`)
      }
      if (!matched) {
        report(context, {
          path,
          keyword: 'pattern',
          message: `不符合模式 ${pattern}`,
          hint: `实际值：${JSON.stringify(value.slice(0, 40))}`,
        })
      }
    }
    const format = node['format']
    if (typeof format === 'string') {
      if (!FORMAT_NAMES.includes(format)) {
        warn(context, `不支持的 format：${format}（位置 ${path}），已跳过`)
      } else {
        const problem = checkFormat(format, value)
        if (problem !== undefined) {
          report(context, {
            path,
            keyword: 'format',
            message: problem,
            hint: `实际值：${JSON.stringify(value.slice(0, 40))}`,
          })
        }
      }
    }
  }

  // —— 数字 ——
  if (typeof value === 'number' && Number.isFinite(value)) {
    const minimum = node['minimum']
    const maximum = node['maximum']
    if (typeof minimum === 'number' && value < minimum) {
      report(context, { path, keyword: 'minimum', message: `不得小于 ${String(minimum)}，实际 ${String(value)}` })
    }
    if (typeof maximum === 'number' && value > maximum) {
      report(context, { path, keyword: 'maximum', message: `不得大于 ${String(maximum)}，实际 ${String(value)}` })
    }
  }

  // —— 数组 ——
  if (Array.isArray(value)) {
    const minItems = node['minItems']
    const maxItems = node['maxItems']
    if (typeof minItems === 'number' && value.length < minItems) {
      report(context, {
        path,
        keyword: 'minItems',
        message: `至少需要 ${String(minItems)} 项，实际 ${String(value.length)} 项`,
        hint: '这一期确实没有数据时，整段留空并在 missing[] 里说明',
      })
    }
    if (typeof maxItems === 'number' && value.length > maxItems) {
      report(context, { path, keyword: 'maxItems', message: `最多允许 ${String(maxItems)} 项，实际 ${String(value.length)} 项` })
    }
    const items = node['items']
    if (Array.isArray(items)) {
      items.forEach((item, index) => {
        if (index < value.length && isSchemaNode(item)) {
          validateNode(item, value[index], indexPath(path, index), root, context, depth + 1)
        }
      })
    } else if (isSchemaNode(items)) {
      value.forEach((item, index) => {
        validateNode(items, item, indexPath(path, index), root, context, depth + 1)
      })
    }
  }

  // —— 对象 ——
  if (isRecord(value)) {
    const minProperties = node['minProperties']
    const maxProperties = node['maxProperties']
    const keys = Object.keys(value)
    if (typeof minProperties === 'number' && keys.length < minProperties) {
      report(context, { path, keyword: 'minProperties', message: `至少需要 ${String(minProperties)} 个字段，实际 ${String(keys.length)} 个` })
    }
    if (typeof maxProperties === 'number' && keys.length > maxProperties) {
      report(context, { path, keyword: 'maxProperties', message: `最多允许 ${String(maxProperties)} 个字段，实际 ${String(keys.length)} 个` })
    }
    const required = Array.isArray(node['required'])
      ? node['required'].filter((item): item is string => typeof item === 'string')
      : []
    for (const key of required) {
      if (!(key in value)) {
        report(context, {
          path: memberPath(path, key),
          keyword: 'required',
          message: `缺少必填字段 ${key}`,
          hint: context.structural
            ? '契约必须声明这个字段；补上它，不要从 required 里删掉了事'
            : '拿不到就写 null 并登记到 missing[]，不要省略这个字段',
        })
      }
    }
    const properties = isRecord(node['properties']) ? node['properties'] : undefined
    const additional = node['additionalProperties']
    for (const [key, child] of Object.entries(value)) {
      const declared = properties?.[key]
      if (declared !== undefined) {
        if (isSchemaNode(declared)) validateNode(declared, child, memberPath(path, key), root, context, depth + 1)
        else warn(context, `properties.${key} 不是合法的 schema 节点，已跳过`)
        continue
      }
      if (additional === false) {
        report(context, {
          path: memberPath(path, key),
          keyword: 'additionalProperties',
          message: `未声明的字段 ${key}`,
          hint: properties === undefined ? '该对象不接受自定义字段' : `可用字段：${Object.keys(properties).join('、')}`,
        })
        continue
      }
      if (isSchemaNode(additional) && additional !== true) {
        validateNode(additional, child, memberPath(path, key), root, context, depth + 1)
      }
    }
  }

  // —— 组合 ——
  for (const keyword of ['anyOf', 'oneOf'] as const) {
    const branches = node[keyword]
    if (!Array.isArray(branches) || branches.length === 0) continue
    let passes = 0
    // `anyOf` 要报「最深的那条抱怨」：`[boolean, 对象]` 这种写法里，
    // 布尔分支只会说「期望 boolean」，真正有用的信息在对象分支里（拼错的键名）。
    let deepest: Issue | undefined
    for (const branch of branches) {
      if (!isSchemaNode(branch)) {
        warn(context, `${keyword} 里有不是 schema 的项（位置 ${path}），已跳过`)
        continue
      }
      const nested: Context = {
        issues: [],
        warnings: context.warnings,
        maxIssues: 8,
        maxDepth: context.maxDepth,
        structural: context.structural,
      }
      validateNode(branch, value, path, root, nested, depth + 1)
      if (nested.issues.length === 0) {
        passes += 1
        continue
      }
      for (const issue of nested.issues) {
        if (deepest === undefined || issue.path.length > deepest.path.length) deepest = issue
      }
    }
    if (keyword === 'anyOf' && passes === 0) {
      if (deepest !== undefined) report(context, deepest)
      else report(context, { path, keyword, message: `不满足任何一个允许的形态（共 ${String(branches.length)} 种）` })
    }
    if (keyword === 'oneOf') {
      if (passes === 0) {
        if (deepest !== undefined) report(context, deepest)
        else report(context, { path, keyword, message: `不满足任何一种允许的形态（共 ${String(branches.length)} 种）` })
      } else if (passes > 1) {
        report(context, {
          path,
          keyword,
          message: `同时满足 ${String(passes)} 种互斥形态，契约写得过宽`,
          hint: '改用 anyOf，或把分支条件写清楚',
        })
      }
    }
  }
}

/** 把一句可选的提示塞进 issue。 */
function hintOf(hint: string | undefined): { hint?: string } {
  return hint === undefined ? {} : { hint }
}

/**
 * 用一份 schema 校验一个值。
 * @param schema - schema 节点（对象或布尔）。
 * @param value - 待校验的值。
 * @param options - 上限设置。
 * @returns 结果；`ok` 为 false 时 `issues` 至少有一条。
 */
export function check(schema: unknown, value: unknown, options?: CheckOptions): CheckResult {
  const context: Context = {
    issues: [],
    warnings: new Set(),
    maxIssues: options?.maxIssues ?? 50,
    maxDepth: options?.maxDepth ?? 32,
    structural: options?.structural ?? false,
  }
  if (!isSchemaNode(schema)) {
    return {
      ok: false,
      issues: [{ path: '$', keyword: 'schema', message: '契约根节点必须是对象或布尔值' }],
      warnings: [],
    }
  }
  validateNode(schema, value, '$', schema, context, 0)
  return { ok: context.issues.length === 0, issues: context.issues, warnings: [...context.warnings] }
}

/**
 * 把 issue 列表渲染成给人看的几行。
 * @param issues - 校验问题。
 * @param limit - 最多渲染几条，默认 8。
 * @returns 每行以 `- ` 开头；没有问题时返回空数组。
 */
export function formatIssues(issues: readonly Issue[], limit = 8): string[] {
  const lines = issues.slice(0, limit).map((issue) => {
    const hint = issue.hint === undefined ? '' : `（${issue.hint}）`
    return `- ${issue.path}：${issue.message}${hint}`
  })
  if (issues.length > limit) lines.push(`- 另有 ${String(issues.length - limit)} 处问题未显示`)
  return lines
}
