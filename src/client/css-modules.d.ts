/**
 * CSS Modules 的类型声明。
 *
 * 构建时由 tsdown 插件把 `.module.css` 编译成「类名映射 + 注入样式」的模块；
 * 类型侧只暴露一个字符串映射。
 */
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}
