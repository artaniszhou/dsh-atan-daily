/**
 * 飞书文件消息的 `file_type`。
 *
 * 这个字段决定对方能不能在聊天里直接预览：只有 `pdf` / `doc` / `xls` / `ppt`
 * 有原生预览，其余一律 `stream`（显示成需要下载的附件）。报告默认推 PDF 就是
 * 因为这个 —— 手机上 PDF 能直接点开看，HTML 不行。
 */

/** 飞书 `im/v1/files` 接受的类型。 */
export type FeishuFileType = 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream'

/** 扩展名到飞书类型。CSV 不算表格（预览会坏），按附件走。 */
const BY_EXTENSION: Readonly<Record<string, FeishuFileType>> = {
  '.pdf': 'pdf',
  '.doc': 'doc',
  '.docx': 'doc',
  '.xls': 'xls',
  '.xlsx': 'xls',
  '.ppt': 'ppt',
  '.pptx': 'ppt',
}

/**
 * 按文件名推断飞书文件类型。
 * @param fileName - 上传时的文件名（含扩展名）。
 * @returns 飞书类型；未知扩展名按 `stream` 处理。
 */
export function fileTypeOf(fileName: string): FeishuFileType {
  const dot = fileName.lastIndexOf('.')
  if (dot < 0) return 'stream'
  return BY_EXTENSION[fileName.slice(dot).toLowerCase()] ?? 'stream'
}
