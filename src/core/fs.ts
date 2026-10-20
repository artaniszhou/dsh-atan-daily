/**
 * Small filesystem helpers shared by the plugin halves.
 *
 * The atomic writer is deliberately conservative: it writes a sibling temp file
 * first and only then swaps it into place. On Windows a rename can fail while
 * another handle is closing, so the fallback removes the destination once and
 * retries; no partial target file is ever left behind.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Write one file atomically, creating parent directories when needed.
 * @param path - destination file.
 * @param content - complete UTF-8 content.
 */
export async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.tmp-${randomUUID().slice(0, 8)}`
  await writeFile(temp, content, 'utf8')
  try {
    await rename(temp, path)
    return
  } catch (error: unknown) {
    const code = (error as { code?: string }).code
    if (code !== 'EPERM' && code !== 'EEXIST' && code !== 'EACCES') {
      await rm(temp, { force: true }).catch(() => {})
      throw error
    }
  }
  // Windows can refuse to replace a file while another handle is closing.
  // Move the previous version aside first, then commit the new one; if the
  // commit fails, put the old file back instead of leaving neither behind.
  const previous = `${path}.old-${randomUUID().slice(0, 8)}`
  let hadPrevious = false
  try {
    await rename(path, previous)
    hadPrevious = true
  } catch {
    // The destination did not exist; there is nothing to preserve.
  }
  try {
    await rename(temp, path)
  } catch (error: unknown) {
    if (hadPrevious) await rename(previous, path).catch(() => {})
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
  if (hadPrevious) await rm(previous, { force: true }).catch(() => {})
}
