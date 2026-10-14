/**
 * 名流's operations skills, which only 名流's Skill Hub hands out, its operations assistant (「运营日报助手」)
 * as an assistant package, and the steps that build their upload packages: each skill folder — its
 * `SKILL.md` and the files beside it — is zipped as `<name>.zip` around `<name>/`, and the assistant as
 * `<name>-<version>.zip` around `<name>/` with `agent.json` and the four core files.
 *
 * @module @deepseek-ai/dsh-mingliu-skills
 */

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zipSync } from 'fflate'

/** The skills this package builds, by folder name under `skills/`. */
export const SKILLS: readonly string[] = [
  'ai-inspection', 'inspection-config-update', 'pdd-live-report', 'pdd-meeting-todos', 'plan-roi-analysis', 'roi-inspection', 'tianmao-daily-report',
  'video-performance-report', 'yuntai-collect',
]

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

/** The assistant's core files, as the assistant package carries them. */
export const CORE_FILES = ['IDENTITY.md', 'SOUL.md', 'USER.md', 'AGENTS.md'] as const

/**
 * Build the assistant package: `agent/agent.json` with the recommended tasks of {@link readTasks}
 * added, and the core files under `agent/`.
 * @param outDir - where the zip goes; an existing one is replaced.
 * @returns the zip path.
 */
export async function packAgent(outDir: string): Promise<string> {
  const agent = join(PACKAGE, 'agent')
  const manifest = JSON.parse(await readFile(join(agent, 'agent.json'), 'utf8')) as { name: string; version: string }
  const files: Record<string, Uint8Array> = {
    [`${manifest.name}/agent.json`]: new TextEncoder().encode(`${JSON.stringify({ ...manifest, tasks: await readTasks() }, null, 2)}\n`),
  }
  for (const name of CORE_FILES) files[`${manifest.name}/${name}`] = await readFile(join(agent, name))
  const out = resolve(outDir)
  await mkdir(out, { recursive: true })
  const zip = join(out, `${manifest.name}-${manifest.version}.zip`)
  await writeFile(zip, zipSync(files))
  return zip
}

/**
 * Files under `dir`, each with its ZIP entry name: `prefix` and the folder names joined by `/` on
 * every platform. Hidden files and folders, such as Finder's `.DS_Store`, and Python's `__pycache__` are left out.
 */
async function walk(dir: string, prefix: string): Promise<Array<{ path: string; entry: string }>> {
  const found: Array<{ path: string; entry: string }> = []
  for (const item of await readdir(dir, { withFileTypes: true })) {
    if (item.name.startsWith('.') || item.name === '__pycache__') continue
    const path = join(dir, item.name)
    const entry = `${prefix}/${item.name}`
    if (item.isDirectory()) found.push(...await walk(path, entry))
    else found.push({ path, entry })
  }
  return found.sort((a, b) => a.entry.localeCompare(b.entry))
}
