/**
 * 地图底图：按需注册 ECharts 的 GeoJSON。
 *
 * 底图放在包内的 `assets/geo/`，不在任务目录里；一个进程只注册一次。
 * 目前用的是 Apache ECharts 示例附带的简化 GeoJSON，**仅供内部试用**；
 * 对外发布必须换成标准地图（带审图号）。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { registerMap } from 'echarts'

/** 支持的地图名。 */
export type MapName = 'china' | 'world'

/** 已注册的地图。 */
const registered = new Set<MapName>()

/**
 * 判断字符串是不是支持的地图名。
 * @param value - 待判断的值。
 * @returns 是则返回地图名。
 */
export function asMapName(value: string | undefined): MapName | undefined {
  if (value === 'china' || value === 'world') return value
  return undefined
}

/**
 * 注册一张地图（幂等）。
 * @param name - 地图名。
 * @returns 注册成功为 true；资产缺失或解析失败为 false。
 */
export function ensureMap(name: MapName): boolean {
  if (registered.has(name)) return true
  try {
    const path = fileURLToPath(new URL(`../../assets/geo/${name}.json`, import.meta.url))
    const json: unknown = JSON.parse(readFileSync(path, 'utf8'))
    registerMap(name, json as never)
    registered.add(name)
    return true
  } catch {
    return false
  }
}
