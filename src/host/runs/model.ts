/**
 * 运行模型解析。
 *
 * 部署默认是 `deepseek-official`，但 profile 可能把同一个模型路由到别的
 * provider；第一个声明该模型的 provider 胜出，已知的 DeepSeek 路由优先。
 */

import { RUN_MODEL, RUN_MODEL_PROVIDERS } from '../config.js'
import type { ModelPort } from '../ports.js'

/**
 * 找到提供 {@link RUN_MODEL} 的 provider。
 * @param models - 模型目录端口。
 * @returns provider/model 组合；没有 provider 提供时 undefined。
 */
export async function resolveRunModel(
  models: ModelPort,
): Promise<{ provider: string, model: string } | undefined> {
  const providers = models.listProviders().map(provider => provider.id)
  const ordered = [
    ...RUN_MODEL_PROVIDERS.filter(id => providers.includes(id)),
    ...providers.filter(id => !RUN_MODEL_PROVIDERS.includes(id)),
  ]
  for (const provider of ordered) {
    try {
      const listed = await models.listModels(provider)
      if (listed.some(model => model.id === RUN_MODEL)) return { provider, model: RUN_MODEL }
    } catch {
      // 列不出模型的 provider 直接跳过。
    }
  }
  return undefined
}
