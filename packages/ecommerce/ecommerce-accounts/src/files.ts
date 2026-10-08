/** Writing the package's JSON files so a reader never sees half of one. */

import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Write a value as indented JSON, replacing the file whole through a temporary file beside it.
 * @param path - the file; its directory is created when missing.
 * @param value - the value.
 */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`)
  await rename(`${path}.tmp`, path)
}
