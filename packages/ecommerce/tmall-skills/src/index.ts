/**
 * The Tmall data skills that Skill Hub hands to the tenants that need them, and the step that builds
 * their upload packages: each skill folder gets its `SKILL.md` and one self-contained ES module per
 * script, which DSH's own Node runs with nothing installed, zipped as `<name>.zip` around `<name>/`.
 *
 * @module @deepseek-ai/dsh-tmall-skills
 */

import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zipSync } from 'fflate'
import { build } from 'tsdown'

/** One skill: its folder name and the scripts it runs. */
export interface TmallSkill {
  /** The folder and `SKILL.md` name. */
  readonly name: string
  /** Script file name under `scripts/` → the source module whose `main(argv)` it runs. */
  readonly scripts: Readonly<Record<string, string>>
}

/** The skills this package builds. */
export const SKILLS: readonly TmallSkill[] = [
  { name: 'tmall-alimama-scene-report', scripts: { 'alimama-scene-report.mjs': 'alimama-report.ts' } },
  { name: 'tmall-sycm-core-daily', scripts: { 'sycm-core-daily.mjs': 'sycm-report.ts' } },
  { name: 'tmall-item-report', scripts: { 'item-report.mjs': 'item-report.ts' } },
  { name: 'tmall-publish-category', scripts: { 'publish-category.mjs': 'publish-category-cli.ts' } },
  { name: 'ecommerce-product-draft', scripts: { 'product-draft.mjs': 'product-draft-cli.ts' } },
  { name: 'tmall-publish', scripts: { 'publish.mjs': 'publish-cli.ts' } },
  { name: 'pdd-publish', scripts: { 'pdd-publish.mjs': 'pdd-cli.ts' } },
  { name: 'doudian-publish', scripts: { 'doudian-publish.mjs': 'doudian-cli.ts' } },
  { name: 'ecommerce-multi-publish', scripts: { 'multi-publish.mjs': 'multi-publish-cli.ts' } },
]

const PACKAGE = fileURLToPath(new URL('..', import.meta.url))

/**
 * Build every skill's folder and upload package.
 * @param outDir - where `<name>/` and `<name>.zip` go; existing ones are replaced.
 * @returns the zip paths, in {@link SKILLS} order.
 */
export async function packSkills(outDir: string): Promise<string[]> {
  const out = resolve(outDir)
  const entries = await mkdtemp(join(tmpdir(), 'dsh-tmall-skills-'))
  const zips: string[] = []
  try {
    for (const skill of SKILLS) {
      const folder = join(out, skill.name)
      await rm(folder, { recursive: true, force: true })
      await mkdir(join(folder, 'scripts'), { recursive: true })
      await copyFile(join(PACKAGE, 'skills', skill.name, 'SKILL.md'), join(folder, 'SKILL.md'))
      for (const [script, module] of Object.entries(skill.scripts)) {
        const entry = join(entries, script)
        const source = join(PACKAGE, 'src', module)
        await writeFile(entry, `import { main } from ${JSON.stringify(source)}\nprocess.exit(await main(process.argv.slice(2)))\n`)
        await build({
          config: false, entry: [entry], outDir: join(folder, 'scripts'), format: 'esm', platform: 'node', target: 'node22',
          fixedExtension: true, dts: false, clean: false, deps: { alwaysBundle: [/./u] }, logLevel: 'error', treeshake: true, minify: false,
        })
      }
      const files: Record<string, Uint8Array> = {}
      for (const { path, entry } of await walk(folder, skill.name)) files[entry] = await readFile(path)
      const zip = join(out, `${skill.name}.zip`)
      await writeFile(zip, zipSync(files))
      zips.push(zip)
    }
  } finally {
    await rm(entries, { recursive: true, force: true })
  }
  return zips
}

/** Files under `dir`, each with its ZIP entry name: `prefix` and the folder names joined by `/` on every platform. */
async function walk(dir: string, prefix: string): Promise<Array<{ path: string; entry: string }>> {
  const found: Array<{ path: string; entry: string }> = []
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, item.name)
    const entry = `${prefix}/${item.name}`
    found.push(...item.isDirectory() ? await walk(path, entry) : [{ path, entry }])
  }
  return found.sort((a, b) => a.entry.localeCompare(b.entry))
}
