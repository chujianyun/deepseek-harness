import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { strFromU8, unzipSync } from 'fflate'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ECOMMERCE_SKILLS } from '../../../assistant/assistants/src/templates.ts'
import { packSkills, SKILLS } from '../src/index.ts'
import { tempDir } from './support.ts'

let out: string
let cleanup: () => Promise<void>
let zips: string[]

beforeAll(async () => {
  ({ dir: out, cleanup } = await tempDir())
  zips = await packSkills(out)
}, 120_000)
afterAll(() => cleanup())

/** Run a packed script under plain Node with no workspace around it. */
async function runScript(path: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number; stderr: string }> {
  try {
    await promisify(execFile)(process.execPath, [path, ...args], { cwd: out, env: { PATH: '/usr/bin:/bin', ...env } })
    return { code: 0, stderr: '' }
  } catch (error) {
    const failed = error as { code: number; stderr: string }
    return { code: failed.code, stderr: failed.stderr }
  }
}

describe('packSkills', () => {
  it('builds exactly the Skills the e-commerce manager template starts with', () => {
    expect(SKILLS.map(skill => skill.name).sort()).toEqual([...ECOMMERCE_SKILLS].sort())
  })

  it('zips each skill as <name>/SKILL.md with its self-contained scripts', async () => {
    expect(zips).toEqual(SKILLS.map(skill => join(out, `${skill.name}.zip`)))
    for (const skill of SKILLS) {
      const files = unzipSync(await readFile(join(out, `${skill.name}.zip`)))
      expect(Object.keys(files).sort()).toEqual([`${skill.name}/SKILL.md`, ...Object.keys(skill.scripts).map(script => `${skill.name}/scripts/${script}`)].sort())
      expect(strFromU8(files[`${skill.name}/SKILL.md`] as Uint8Array)).toMatch(new RegExp(`^---\\nname: ${skill.name}\\ndescription: `, 'u'))
      for (const script of Object.keys(skill.scripts)) {
        const imports = [...strFromU8(files[`${skill.name}/scripts/${script}`] as Uint8Array).matchAll(/^import\b[^\n]*\bfrom ["']([^"']+)["']/gmu)]
        expect(imports.map(([, specifier]) => specifier).filter(specifier => !isBuiltin(specifier as string))).toEqual([])
      }
    }
  })

  it('builds scripts that run under plain Node and explain their usage', async () => {
    for (const skill of SKILLS) {
      for (const script of Object.keys(skill.scripts)) {
        const { code, stderr } = await runScript(join(out, skill.name, 'scripts', script), [])
        expect(code).toBe(64)
        expect(stderr).toMatch(/缺少 --account|缺少商品链接或 id|缺少或认不出子命令/u)
      }
    }
  })

  it('stops with an explanation outside a DSH shell call', async () => {
    const { code, stderr } = await runScript(join(out, 'tmall-alimama-scene-report', 'scripts', 'alimama-scene-report.mjs'), ['--account', 'a1'])
    expect(code).toBe(1)
    expect(stderr).toContain('找不到 dsh-ecommerce 命令')
  })

  it('replaces an earlier build', async () => {
    expect(await packSkills(out)).toEqual(zips)
  })
})
