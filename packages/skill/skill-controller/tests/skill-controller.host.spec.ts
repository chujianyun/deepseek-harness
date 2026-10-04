/** Installed user-level skills over a real registry and filesystem provider. */
import { mkdir, mkdtemp, readdir, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import { remoteErrorOf, remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import SkillController, { type SkillControllerInternals } from '../src/index.ts'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function temp(): Promise<string> {
  // Discovery reports real paths (macOS resolves /var to /private/var).
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-skill-controller-')))
  dirs.push(dir)
  return dir
}

async function writeSkill(root: string, name: string, description = `${name} description`): Promise<void> {
  await mkdir(join(root, name), { recursive: true })
  await writeFile(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\nBody of ${name}.\n`)
}

/** Registry behind Loader with a settings stub that writes back into its live config, plus the local provider. */
async function boot(internals: SkillControllerInternals = {}) {
  const home = await temp()
  const dshHome = join(home, '.dsh')
  const agentsHome = join(home, '.agents')
  const customDir = join(home, 'custom-skills')
  await writeSkill(join(dshHome, 'skills'), 'beta')
  await writeSkill(join(agentsHome, 'skills'), 'alpha')
  await mkdir(customDir, { recursive: true })
  await writeFile(join(agentsHome, 'skills', 'flat.md'), '---\nname: flat\ndescription: Flat skill\n---\n\nFlat body.\n')
  // A deployment-configured custom directory (shipped presets point it at packaged skills) is not user-installed.
  await writeSkill(customDir, 'packaged')
  const ctx = new Context()
  const live = await liveConfig(ctx, SkillRegistry, {})
  const writes: object[] = []
  ctx.provide('settings', { update: async (_entry: string, patch: Record<string, unknown>) => { writes.push(patch); await live.update(patch) } } as never)
  await ctx.plugin(SkillFileSystem, { dshHome, agentsHome, customSkillDirs: [customDir], watch: false })
  await ctx.plugin(SkillController, { home, ...internals })
  return { ctx, home, dshHome, agentsHome, customDir, writes, controller: ctx.get('skillController')! }
}

describe('installedSkills Remote', () => {
  it('publishes the namespace and its methods', async () => {
    const { controller } = await boot()
    expect(controller.typertRemote.namespace).toBe('installedSkills')
    expect(remoteMethods(controller).map(method => method.method)).toEqual(['list', 'setEnabled', 'reveal', 'edit', 'uninstall'])
  })

  it('lists user-level skills sorted by name, excluding custom-directory, bundled, and runtime skills', async () => {
    const { ctx, controller, dshHome, agentsHome } = await boot()
    ctx.skills.register({ name: 'runtime-only', description: 'Runtime', source: 'runtime', content: 'x' })
    const { skills } = await controller.list()
    expect(skills).toEqual([
      { name: 'alpha', description: 'alpha description', group: 'custom', source: 'user-agents', path: join(agentsHome, 'skills', 'alpha', 'SKILL.md'), enabled: true },
      { name: 'beta', description: 'beta description', group: 'custom', source: 'user-dsh', path: join(dshHome, 'skills', 'beta', 'SKILL.md'), enabled: true },
      { name: 'flat', description: 'Flat skill', group: 'custom', source: 'user-agents', path: join(agentsHome, 'skills', 'flat.md'), enabled: true },
    ])
  })

  it('switches a skill off and on through the registry, and refuses unknown names', async () => {
    const { ctx, controller } = await boot()
    expect(await controller.setEnabled('beta', false)).toMatchObject({ name: 'beta', enabled: false })
    expect((await controller.list()).skills.find(skill => skill.name === 'beta')).toMatchObject({ enabled: false })
    expect((await ctx.skills.get('beta'))?.invocation).toEqual({ modelInvocable: false, userInvocable: false })
    expect(await controller.setEnabled('beta', true)).toMatchObject({ enabled: true })
    expect((await ctx.skills.get('beta'))?.invocation).toEqual({ modelInvocable: true, userInvocable: true })
    const failure = await controller.setEnabled('runtime-only', false).catch((error: unknown) => error)
    expect(remoteErrorOf(failure)).toMatchObject({ code: 'installed-skills/not-found', details: { name: 'runtime-only' } })
  })

  it('reports a registry that cannot persist the switch in either direction', async () => {
    const { ctx, controller } = await boot()
    vi.spyOn(ctx.skills, 'setDisabled').mockRejectedValueOnce(new Error('read-only profile')).mockRejectedValueOnce('locked')
    const disabling = await controller.setEnabled('alpha', false).catch((error: unknown) => error)
    expect(remoteErrorOf(disabling)).toMatchObject({ code: 'installed-skills/rejected', details: { name: 'alpha' } })
    expect(remoteErrorOf(disabling)?.message).toContain('could not be disabled: read-only profile')
    const enabling = await controller.setEnabled('alpha', true).catch((error: unknown) => error)
    expect(remoteErrorOf(enabling)?.message).toContain('could not be enabled: locked')
  })

  it('defaults every native integration to the Host implementation', () => {
    const ctx = new Context()
    const controller = new SkillController(ctx)
    expect(controller).toBeInstanceOf(SkillController)
  })

  it('reveals and edits the instruction file, containing native failures', async () => {
    const reveal = vi.fn(async (_path: string, _signal: AbortSignal) => {})
    const openTextFile = vi.fn(async (_path: string, _signal: AbortSignal) => {})
    const { controller, agentsHome } = await boot({ reveal, openTextFile })
    const signal = new AbortController().signal
    const path = join(agentsHome, 'skills', 'alpha', 'SKILL.md')
    expect(await controller.reveal('alpha', signal)).toEqual({ done: true })
    expect(reveal).toHaveBeenCalledWith(path, signal)
    expect(await controller.edit('alpha', signal)).toEqual({ done: true })
    expect(openTextFile).toHaveBeenCalledWith(path, signal)
    openTextFile.mockRejectedValueOnce(new Error('no editor'))
    const failure = await controller.edit('alpha', signal).catch((error: unknown) => error)
    expect(remoteErrorOf(failure)).toMatchObject({ code: 'installed-skills/rejected' })
  })

  it('moves a skill folder to the macOS trash, naming collisions like Finder, and forgets its disabled state', async () => {
    const { controller, home, dshHome, writes } = await boot({ platform: 'darwin' })
    await mkdir(join(home, '.Trash', 'beta'), { recursive: true })
    await controller.setEnabled('beta', false)
    expect(await controller.uninstall('beta', new AbortController().signal)).toEqual({ done: true })
    expect(await readdir(join(dshHome, 'skills'))).toEqual([])
    expect((await readdir(join(home, '.Trash'))).sort()).toEqual(['beta', 'beta 2'])
    expect(await readdir(join(home, '.Trash', 'beta 2'))).toEqual(['SKILL.md'])
    expect(writes).toEqual([{ disabledSkills: ['beta'] }, { disabledSkills: [] }])
  })

  it('moves a flat skill file itself to the trash', async () => {
    const { controller, home, agentsHome } = await boot({ platform: 'darwin' })
    await controller.uninstall('flat', new AbortController().signal)
    expect(await readdir(join(agentsHome, 'skills'))).toEqual(['alpha'])
    expect(await readdir(join(home, '.Trash'))).toEqual(['flat.md'])
  })

  it('moves an installed symlink itself to the trash and leaves the folder it points to untouched', async () => {
    const { controller, home, dshHome } = await boot({ platform: 'darwin' })
    const source = join(home, 'code', 'linked')
    await writeSkill(join(home, 'code'), 'linked')
    await symlink(source, join(dshHome, 'skills', 'linked'))
    await controller.uninstall('linked', new AbortController().signal)
    expect(await readdir(source)).toEqual(['SKILL.md'])
    expect(await readlink(join(home, '.Trash', 'linked'))).toBe(source)
    expect(await readdir(join(dshHome, 'skills'))).toEqual(['beta'])
  })

  it('still reports an uninstall as done when forgetting its disabled state fails', async () => {
    const { ctx, controller, home } = await boot({ platform: 'darwin' })
    await controller.setEnabled('beta', false)
    const warn = vi.spyOn(ctx.logger, 'warn')
    vi.spyOn(ctx.skills, 'setDisabled').mockRejectedValueOnce(new Error('profile locked'))
    expect(await controller.uninstall('beta', new AbortController().signal)).toEqual({ done: true })
    expect(await readdir(join(home, '.Trash'))).toEqual(['beta'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('profile locked'))
  })

  it('sends a skill to the Windows recycle bin with the path quoted as a PowerShell literal', async () => {
    const run = vi.fn(async () => ({ stdout: '', stderr: '' }))
    const { controller, agentsHome } = await boot({ platform: 'win32', run })
    const signal = new AbortController().signal
    await controller.uninstall('alpha', signal)
    const [command, args, passedSignal, window] = run.mock.calls[0] as unknown as [string, string[], AbortSignal, string]
    expect([command, passedSignal, window]).toEqual(['powershell.exe', signal, 'hidden'])
    expect(args.at(-1)).toContain(`'${join(agentsHome, 'skills', 'alpha')}'`)
    expect(args.at(-1)).toContain('SendToRecycleBin')
  })

  it('refuses to uninstall a user-level skill whose provider reports no installed location', async () => {
    const { ctx, controller } = await boot({ platform: 'darwin' })
    ctx.skills.registerProvider(() => ({
      name: 'virtual',
      list: async () => [{ name: 'virtual-one', description: 'Virtual', invocation: { modelInvocable: true, userInvocable: true }, provider: 'virtual', source: 'user-dsh', rank: 1, path: '/virtual/SKILL.md', locator: null }],
      get: async () => undefined,
    }))
    const failure = await controller.uninstall('virtual-one', new AbortController().signal).catch((error: unknown) => error)
    expect(remoteErrorOf(failure)).toMatchObject({ code: 'installed-skills/rejected', details: { name: 'virtual-one' } })
  })

  it('refuses to uninstall on a platform without a supported trash', async () => {
    const { controller, agentsHome } = await boot({ platform: 'linux' })
    const failure = await controller.uninstall('alpha', new AbortController().signal).catch((error: unknown) => error)
    expect(remoteErrorOf(failure)).toMatchObject({ code: 'installed-skills/rejected' })
    expect(await readdir(join(agentsHome, 'skills'))).toEqual(['alpha', 'flat.md'])
  })

  it('reads through the default agent preset scope and releases it', async () => {
    const { ctx, controller } = await boot()
    const preset = createScope(ctx, { preset: 'default' })
    const released = vi.fn()
    ctx.provide('agentPresets', { acquireScope: async () => ({ key: scopeOf(preset.ctx)!, [Symbol.asyncDispose]: async () => { released() } }) } as never)
    const list = vi.spyOn(ctx.skills, 'list')
    await controller.list()
    expect(list.mock.calls[0]?.[0]).toMatchObject({ scope: scopeOf(preset.ctx) })
    expect(released).toHaveBeenCalledOnce()
    await preset.dispose()
  })

  it('reports a failed skill listing', async () => {
    const { ctx, controller } = await boot()
    vi.spyOn(ctx.skills, 'list').mockRejectedValueOnce(new Error('disk gone'))
    const failure = await controller.list().catch((error: unknown) => error)
    expect(remoteErrorOf(failure)?.code).toBe('gateway/internal')
  })
})
