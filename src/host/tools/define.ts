/**
 * 插件内的工具定义helper。
 *
 * 不依赖 `@deepseek-ai/dsh-tools` 的运行时导入：插件只拿到 `ctx.tools.register`，
 * 这里把简单的参数 DSL 转成 JSON Schema，并补上字符串输出与 text 渲染。
 * 宿主的注册表只要求 `{ name, description, parameters, output, execute }`。
 */

/** 简单参数声明。 */
interface ParameterSpec {
  type: 'string' | 'number' | 'boolean' | 'array'
  /** 数组元素类型；当前只支持字符串数组。 */
  items?: 'string'
  required?: boolean
  description?: string
  enum?: string[]
}

/** 工具输出。 */
interface OutputSpec {
  schema: Record<string, unknown>
  render: (args: any, value: any) => Array<Record<string, unknown>>
}

/** 工具定义。 */
export interface ToolSpec {
  name: string
  description: string
  parameters?: Record<string, ParameterSpec>
  output?: OutputSpec
  execute: (args: any, exec: any) => Promise<unknown>
}

/** 工具定义（注册表就绪）。 */
export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: OutputSpec
  execute: (args: unknown, exec: unknown) => Promise<unknown>
}

/** 默认 text 渲染。 */
function text(value: unknown): Array<Record<string, unknown>> {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
}

/**
 * 定义工具：参数 DSL → JSON Schema，校验必填与类型。
 * @param spec - 工具声明。
 * @returns 可直接交给 `ctx.tools.register` 的定义。
 */
export function defineTool(spec: ToolSpec): ToolDefinition {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [key, parameter] of Object.entries(spec.parameters ?? {})) {
    properties[key] = {
      type: parameter.type,
      ...parameter.type === 'array' ? { items: { type: parameter.items ?? 'string' } } : {},
      ...parameter.description === undefined ? {} : { description: parameter.description },
      ...parameter.enum === undefined ? {} : { enum: parameter.enum },
    }
    if (parameter.required === true) required.push(key)
  }
  const parameters = {
    type: 'object',
    additionalProperties: false,
    properties,
    ...required.length === 0 ? {} : { required },
  }
  return {
    name: spec.name,
    description: spec.description,
    parameters,
    output: spec.output ?? { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args: unknown, exec: unknown): Promise<unknown> {
      if (typeof args !== 'object' || args === null || Array.isArray(args)) throw new Error('工具参数必须是对象')
      const record = args as Record<string, unknown>
      for (const [key, parameter] of Object.entries(spec.parameters ?? {})) {
        const value = record[key]
        if (value === undefined) {
          if (parameter.required === true) throw new Error(`缺少参数：${key}`)
          continue
        }
        if (parameter.type === 'string' && typeof value !== 'string') throw new Error(`参数 ${key} 必须是字符串`)
        if (parameter.type === 'number' && typeof value !== 'number') throw new Error(`参数 ${key} 必须是数字`)
        if (parameter.type === 'boolean' && typeof value !== 'boolean') throw new Error(`参数 ${key} 必须是布尔值`)
        if (parameter.type === 'array') {
          if (!Array.isArray(value)) throw new Error(`参数 ${key} 必须是字符串数组`)
          for (const item of value) {
            if (typeof item !== 'string') throw new Error(`参数 ${key} 的元素必须是字符串`)
          }
        }
        if (parameter.enum !== undefined && typeof value === 'string' && !parameter.enum.includes(value)) {
          throw new Error(`参数 ${key} 只能是：${parameter.enum.join(' / ')}`)
        }
      }
      return spec.execute(record, exec)
    },  }
}
