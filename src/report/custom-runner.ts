/**
 * 自定义图形子进程入口。
 *
 * stdin 收 `{ script, payload }`，动态 import 脚本，调用默认导出，
 * 把返回的 SVG 写到 stdout。只由 `custom.ts` 调用。
 */

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

async function main(): Promise<void> {
  const input = JSON.parse(readFileSync(0, 'utf8')) as { script: string, payload: unknown }
  const module = await import(pathToFileURL(input.script).href) as { default?: unknown }
  const render = module.default
  if (typeof render !== 'function') {
    throw new Error('自定义图表脚本必须 export default function render(payload)')
  }
  const svg: unknown = await (render as (payload: unknown) => unknown)(input.payload)
  if (typeof svg !== 'string' || !svg.trim().startsWith('<svg')) {
    throw new Error('自定义图表脚本必须返回 SVG 字符串')
  }
  process.stdout.write(svg)
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
