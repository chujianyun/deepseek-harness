/**
 * The Tmall data skills that Skill Hub hands to the tenants that need them, and the step that builds
 * their upload packages: each skill folder gets its `SKILL.md` and one self-contained ES module per
 * script, which DSH's own Node runs with nothing installed, zipped as `<name>.zip` around `<name>/`.
 *
 * @module @deepseek-ai/dsh-tmall-skills
 */

import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
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
      for (const path of await walk(folder)) files[`${skill.name}/${relative(folder, path)}`] = await readFile(path)
      const zip = join(out, `${skill.name}.zip`)
      await writeFile(zip, zipSync(files))
      zips.push(zip)
    }
  } finally {
    await rm(entries, { recursive: true, force: true })
  }
  return zips
}

async function walk(dir: string): Promise<string[]> {
  const found: string[] = []
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, item.name)
    found.push(...item.isDirectory() ? await walk(path) : [path])
  }
  return found.sort()
}
