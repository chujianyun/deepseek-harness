/**
 * Scanning a folder for the files a knowledge base can read. Subfolders are walked; entries whose
 * names start with a dot and symbolic links are left out silently, as system and tool clutter.
 */
import type { Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { isSupported } from './readers.ts'
import type { KnowledgeSkippedFile } from './types.ts'

/** A supported file of a folder. */
export interface FolderFile {
  /** Path relative to the folder, with `/` separators. */
  readonly path: string
  readonly size: number
  /** Modification time in milliseconds. */
  readonly modifiedAt: number
}

/** What a folder holds for a knowledge base. */
export interface FolderScan {
  /** Supported files, at most the limit, by path. */
  readonly files: readonly FolderFile[]
  /** Unsupported files, and supported ones past the limit, by path: the first `MAX_LISTED_SKIPPED`. */
  readonly skipped: readonly KnowledgeSkippedFile[]
  /** Every file skipped. */
  readonly skippedCount: number
}

/** Most skipped files listed; a folder of many unsupported files still lists a readable few. */
export const MAX_LISTED_SKIPPED = 500

/**
 * Walk a folder.
 * @param root - absolute folder path.
 * @param limit - most supported files kept.
 * @returns the supported files and the skipped ones.
 * @throws when `root` cannot be read as a folder.
 */
export async function scanFolder(root: string, limit: number): Promise<FolderScan> {
  const entries: Dirent[] = await readdir(root, { recursive: true, withFileTypes: true })
  const found: { path: string; absolute: string }[] = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const absolute = join(entry.parentPath, entry.name)
    const path = relative(root, absolute).split(sep).join('/')
    if (path.split('/').some(part => part.startsWith('.'))) continue
    found.push({ path, absolute })
  }
  // Code-unit order, the same on every machine and locale.
  found.sort((a, b) => Number(a.path > b.path) - Number(a.path < b.path))
  const files: FolderFile[] = []
  const skipped: KnowledgeSkippedFile[] = []
  let skippedCount = 0
  const skip = (path: string, reason: KnowledgeSkippedFile['reason']): void => {
    skippedCount++
    if (skipped.length < MAX_LISTED_SKIPPED) skipped.push({ path, reason })
  }
  for (const { path, absolute } of found) {
    if (!isSupported(path)) { skip(path, 'unsupported'); continue }
    if (files.length >= limit) { skip(path, 'limit'); continue }
    const info = await stat(absolute)
    files.push({ path, size: info.size, modifiedAt: info.mtimeMs })
  }
  return { files, skipped, skippedCount }
}
