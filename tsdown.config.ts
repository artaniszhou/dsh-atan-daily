/**
 * Client 打包配置。
 *
 * 产出一个经典 script：`window.__ModuleLoader__.load({ id, factory })`。
 *  - `format: 'cjs'`：源码里的 `import 'react'` 会被编译成 `require('react')`，
 *    而这个 `require` 正是模块表注入的解析器，所以不需要手写 shim；
 *  - `external`：React 全页只有一份，绝不打进 bundle；
 *  - CSS Modules：lightningcss 编译成哈希类名，并在 factory 执行时注入
 *    一个带 `data-plugin` 标记的 `<style>`，卸载/重复加载不会叠加。
 */
import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { transform } from 'lightningcss'
import type { UserConfig } from 'tsdown'

/** 模块注册 id，必须等于包名。 */
const PLUGIN_ID = 'dsh-atan-daily'
/** CSS 虚拟模块前缀/后缀。 */
const CSS_PREFIX = '\0atan-css:'
const CSS_SUFFIX = '.mjs'
/** 运行时从模块表解析的依赖。 */
const EXTERNALS = ['react', 'react/jsx-runtime']

/**
 * CSS Modules 插件：编译 + 注入 + 导出类名映射。
 * @returns tsdown 插件。
 */
function cssModulesPlugin(): NonNullable<UserConfig['plugins']>[number] {
  return {
    name: 'atan-daily-css-modules',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css')) return null
      const absolute = source.startsWith('.') && importer !== undefined
        ? resolve(dirname(importer), source)
        : resolve(source)
      return CSS_PREFIX + absolute + CSS_SUFFIX
    },
    async load(id: string) {
      if (!id.startsWith(CSS_PREFIX)) return null
      const file = id.slice(CSS_PREFIX.length, -CSS_SUFFIX.length)
      this.addWatchFile(file)
      const source = await readFile(file)
      const { code, exports } = transform({
        filename: file,
        code: source,
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classMap: Record<string, string> = {}
      for (const [local, exported] of Object.entries(exports ?? {})) {
        classMap[local] = exported.name
      }
      const tagId = `${PLUGIN_ID}/${basename(file)}`
      return [
        `const cssText = ${JSON.stringify(code.toString())};`,
        `const tagId = ${JSON.stringify(tagId)};`,
        `if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="' + tagId + '"]') === null) {`,
        '  const tag = document.createElement(\'style\');',
        `  tag.dataset.plugin = ${JSON.stringify(PLUGIN_ID)};`,
        '  tag.dataset.pluginCss = tagId;',
        '  tag.textContent = cssText;',
        '  document.head.appendChild(tag);',
        '}',
        `export default ${JSON.stringify(classMap)};`,
      ].join('\n')
    },
  }
}

export default {
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: false,
  clean: false,
  // React 走模块表；其余依赖全部内联。tsdown 0.22 用 deps.* 取代了
  // external/noExternal（旧写法会告警）。
  deps: {
    neverBundle: EXTERNALS,
    alwaysBundle: (id: string) => !EXTERNALS.includes(id),
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  inputOptions: {
    resolve: { conditionNames: ['browser', 'import', 'require', 'default'] },
  },
  plugins: [cssModulesPlugin()],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
    codeSplitting: false,
  },
} satisfies UserConfig
