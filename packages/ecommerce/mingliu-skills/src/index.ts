/**
 * 名流's operations skills, which only 名流's Skill Hub hands out, the recommended tasks of its
 * operations assistant, and the step that builds the skills' upload packages: each skill folder —
 * its `SKILL.md` and the reference files beside it — is zipped as `<name>.zip` around `<name>/`.
 *
 * @module @deepseek-ai/dsh-mingliu-skills
 */

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zipSync } from 'fflate'

/** The skills this package builds, by folder name under `skills/`. */
export const SKILLS: readonly string[] = ['ai-inspection', 'inspection-config-update', 'roi-inspection']

const PACKAGE = fileURLToPath(new URL('..', import.meta.url))

/**
 * Build every skill's upload package.
 * @param outDir - where `<name>.zip` goes; an existing one is replaced.
 * @returns the zip paths, in {@link SKILLS} order.
 */
export async function packSkills(outDir: string): Promise<string[]> {
  const out = resolve(outDir)
  await mkdir(out, { recursive: true })
  const zips: string[] = []
  for (const name of SKILLS) {
    const files: Record<string, Uint8Array> = {}
    for (const { path, entry } of await walk(join(PACKAGE, 'skills', name), name)) files[entry] = await readFile(path)
    const zip = join(out, `${name}.zip`)
    await rm(zip, { force: true })
    await writeFile(zip, zipSync(files))
    zips.push(zip)
  }
  return zips
}

/**
 * The recommended tasks of 名流's operations assistant, one JSON file each under `agent/tasks/`, as the
 * assistant package's `agent.json` lists them.
 * @returns the tasks, by file name.
 */
export async function readTasks(): Promise<unknown[]> {
  const dir = join(PACKAGE, 'agent', 'tasks')
  const names = (await readdir(dir)).filter(name => name.endsWith('.json')).sort()
  const tasks: unknown[] = []
  for (const name of names) tasks.push(JSON.parse(await readFile(join(dir, name), 'utf8')))
  return tasks
}

/**
 * Files under `dir`, each with its ZIP entry name: `prefix` and the folder names joined by `/` on
 * every platform. Hidden files and folders, such as Finder's `.DS_Store`, are left out.
 */
async function walk(dir: string, prefix: string): Promise<Array<{ path: string; entry: string }>> {
  const found: Array<{ path: string; entry: string }> = []
  for (const item of await readdir(dir, { withFileTypes: true })) {
    if (item.name.startsWith('.')) continue
    const path = join(dir, item.name)
    const entry = `${prefix}/${item.name}`
    if (item.isDirectory()) found.push(...await walk(path, entry))
    else found.push({ path, entry })
  }
  return found.sort((a, b) => a.entry.localeCompare(b.entry))
}
