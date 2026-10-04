/** Moving to the trash across volumes falls back to copy-then-delete. */
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import SkillController from '../src/index.ts'

const failure = vi.hoisted(() => ({ code: 'EXDEV' as string | undefined }))
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: vi.fn(async (from: string, to: string) => {
      if (failure.code !== undefined) throw Object.assign(new Error(`${failure.code}: rename failed`), { code: failure.code })
      return actual.rename(from, to)
    }),
  }
})

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function boot() {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-skill-controller-xv-')))
  dirs.push(home)
  const dshHome = join(home, '.dsh')
  await mkdir(join(dshHome, 'skills', 'beta'), { recursive: true })
  await writeFile(join(dshHome, 'skills', 'beta', 'SKILL.md'), '---\nname: beta\ndescription: Beta\n---\n\nBody.\n')
  const ctx = new Context()
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(SkillFileSystem, { dshHome, agentsHome: join(home, '.agents'), watch: false })
  await ctx.plugin(SkillController, { home, platform: 'darwin' })
  return { home, dshHome, controller: ctx.get('skillController')! }
}

it('copies then deletes when the trash is on another volume', async () => {
  failure.code = 'EXDEV'
  const { home, dshHome, controller } = await boot()
  expect(await controller.uninstall('beta', new AbortController().signal)).toEqual({ done: true })
  expect(await readdir(join(dshHome, 'skills'))).toEqual([])
  expect(await readdir(join(home, '.Trash', 'beta'))).toEqual(['SKILL.md'])
})

it('reports any other rename failure without copying', async () => {
  failure.code = 'EACCES'
  const { dshHome, controller } = await boot()
  const error = await controller.uninstall('beta', new AbortController().signal).catch((caught: unknown) => caught)
  expect(remoteErrorOf(error)).toMatchObject({ code: 'installed-skills/rejected' })
  expect(await readdir(join(dshHome, 'skills'))).toEqual(['beta'])
})
