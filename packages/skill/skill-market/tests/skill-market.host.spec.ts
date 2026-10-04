/** The market source and the `skillMarket` Remote over a mock Skill Hub, a real registry, and a real credential store. */
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import HubAccount from '@deepseek-ai/dsh-hub-account'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import { remoteErrorOf, remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { strToU8, zipSync } from 'fflate'
import SkillMarket, { compareVersions, INSTALL_RECORD, nextPatch } from '../src/index.ts'
import { browse, startMockUserCenter, type MockSkill } from '../../../credentials/hub-account/tests/mock-user-center.ts'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const PDF: MockSkill = { id: 's-pdf', name: 'pdf-tools', description: 'Read PDF files', category: { id: 'c-doc', name: '文档' }, version: '1.0.0', files: { 'scripts/run.sh': 'echo pdf\n' } }
const SQL: MockSkill = { id: 's-sql', name: 'sql-helper', description: 'Write SQL', category: { id: 'c-dev', name: '研发' }, version: '2.1.0' }
const signal = () => new AbortController().signal

async function temp(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-skill-market-')))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function writeSkill(root: string, name: string, description: string): Promise<void> {
  await mkdir(join(root, name), { recursive: true })
  await writeFile(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\nBody of ${name}.\n`)
}

async function boot({ signedIn = true } = {}) {
  const center = await startMockUserCenter()
  cleanups.push(() => center.close())
  center.skills = [PDF, SQL]
  const home = await temp()
  const dshHome = join(home, '.dsh')
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose().then(() => undefined))
  await ctx.plugin(LocalCredentialProvider, { path: join(home, 'credentials.yaml'), watch: false })
  await ctx.plugin(AuthorizationService)
  await ctx.plugin(HubAccount, { origin: center.origin, clientId: center.clientId, allowLoopbackHttp: true })
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(SkillFileSystem, { dshHome, agentsHome: join(home, '.agents'), watch: false })
  const hub = ctx.get('hubAccount')!
  const signIn = async () => {
    await hub.signIn()
    await expect.poll(async () => (await hub.getState()).attempt?.authorizeUrl).toBeDefined()
    await browse((await hub.getState()).attempt!.authorizeUrl!)
    await expect.poll(async () => (await hub.getState()).status).toBe('signed-in')
  }
  if (signedIn) await signIn()
  const live = await liveConfig(ctx, SkillMarket, { dshHome, watch: false })
  ctx.provide('settings', { update: async (_entry: string, patch: Record<string, unknown>) => { await live.update(patch) } } as never)
  const market = ctx.get('skillMarket')!
  return { ctx, center, home, dshHome, hub, market, signIn, live }
}

describe('skillMarket', () => {
  it('publishes the namespace and its methods', async () => {
    const { market } = await boot()
    expect(market.typertRemote.namespace).toBe('skillMarket')
    expect(remoteMethods(market).map(method => method.method)).toEqual(['list', 'categories', 'detail', 'installSkill', 'uploadSources', 'inspectFolder', 'uploadOptions', 'uploadSkill', 'installedStatus'])
  })

  it('needs a Hub sign-in and discovers nothing while signed out', async () => {
    const { ctx, market } = await boot({ signedIn: false })
    expect(remoteErrorOf(await market.list({}, signal()).catch((error: unknown) => error))).toMatchObject({ code: 'hub-account/signed-out' })
    expect(remoteErrorOf(await market.installSkill('s-pdf', {}, signal()).catch((error: unknown) => error))).toMatchObject({ code: 'hub-account/signed-out' })
    expect((await ctx.skills.list()).filter(skill => skill.source === 'market')).toEqual([])
    expect(await market.records()).toEqual(new Map())
  })

  it('lists the Hub as the employee sees it, passing search, category, and page through', async () => {
    const { center, market } = await boot()
    const first = await market.list({ q: ' pdf ', categoryId: 'c-doc', page: 1, pageSize: 12 }, signal())
    expect(center.clientRequests.at(-1)).toBe('/api/client/skills?q=pdf&categoryId=c-doc&page=1&pageSize=12')
    expect(first).toEqual({
      total: 1, page: 1, pageSize: 12,
      items: [{ id: 's-pdf', name: 'pdf-tools', description: 'Read PDF files', category: { id: 'c-doc', name: '文档' }, version: '1.0.0', updatedAt: '2026-10-01T08:00:00.000Z', installedVersion: null, updateAvailable: false, conflict: false }],
    })
    expect((await market.list({ page: 2, pageSize: 1 }, signal())).items.map(item => item.name)).toEqual(['sql-helper'])
    expect(await market.categories(signal())).toEqual([{ id: 'c-doc', name: '文档' }, { id: 'c-dev', name: '研发' }])
  })

  it('shows a Skill with its SKILL.md and files', async () => {
    const { market } = await boot()
    const detail = await market.detail('s-pdf', signal())
    expect(detail).toMatchObject({ name: 'pdf-tools', ownerName: '韩梅梅', version: '1.0.0', installedVersion: null })
    expect(detail.skillMd).toContain('# pdf-tools')
    expect(detail.files.map(file => file.path)).toEqual(['SKILL.md', 'scripts/run.sh'])
    expect(remoteErrorOf(await market.detail('missing', signal()).catch((error: unknown) => error))).toMatchObject({ code: 'skill-market/not-found', details: { id: 'missing' } })
  })

  it('installs into the tenant directory with a record, and the Skill joins the catalog as a market Skill', async () => {
    const { ctx, market, dshHome } = await boot()
    const card = await market.installSkill('s-pdf', {}, signal())
    expect(card).toMatchObject({ name: 'pdf-tools', installedVersion: '1.0.0', conflict: false })
    const dir = join(dshHome, 'skills-market', 't-a', 'pdf-tools')
    expect(await readFile(join(dir, 'scripts/run.sh'), 'utf8')).toBe('echo pdf\n')
    const record = JSON.parse(await readFile(join(dir, INSTALL_RECORD), 'utf8')) as Record<string, unknown>
    expect(record).toMatchObject({ hubSkillId: 's-pdf', name: 'pdf-tools', version: '1.0.0', files: [{ path: 'SKILL.md' }, { path: 'scripts/run.sh' }] })
    expect(await readdir(join(dshHome, 'skills-market', 't-a'))).toEqual(['pdf-tools'])
    const skill = await ctx.skills.get('pdf-tools')
    expect(skill).toMatchObject({ source: 'market', invocation: { modelInvocable: true, userInvocable: true } })
    expect(skill?.content).toContain('Use pdf-tools.')
    expect((await market.list({}, signal())).items.find(item => item.id === 's-pdf')?.installedVersion).toBe('1.0.0')
    expect((await market.detail('s-pdf', signal())).installedVersion).toBe('1.0.0')
  })

  it('replaces an installed Skill in one move when installed again', async () => {
    const { center, market, dshHome } = await boot()
    await market.installSkill('s-pdf', {}, signal())
    center.skills = [{ ...PDF, version: '1.1.0', files: { 'scripts/run.sh': 'echo pdf 1.1\n' } }, SQL]
    expect((await market.installSkill('s-pdf', {}, signal())).installedVersion).toBe('1.1.0')
    expect(await readFile(join(dshHome, 'skills-market', 't-a', 'pdf-tools', 'scripts/run.sh'), 'utf8')).toBe('echo pdf 1.1\n')
    expect(await readdir(join(dshHome, 'skills-market', 't-a'))).toEqual(['pdf-tools'])
  })

  it('refuses a name a user Skill already uses, and project Skills still win in their project', async () => {
    const { ctx, market, home, dshHome } = await boot()
    await writeSkill(join(home, '.agents', 'skills'), 'pdf-tools', 'My own PDF skill')
    expect((await market.list({}, signal())).items.find(item => item.name === 'pdf-tools')?.conflict).toBe(true)
    expect(remoteErrorOf(await market.installSkill('s-pdf', {}, signal()).catch((error: unknown) => error)))
      .toMatchObject({ code: 'skill-market/name-conflict', details: { name: 'pdf-tools' } })
    await expect(readdir(join(dshHome, 'skills-market', 't-a'))).rejects.toThrow()

    const project = await temp()
    await mkdir(join(project, '.git'))
    await writeSkill(join(project, '.dsh', 'skills'), 'sql-helper', 'Project SQL')
    await market.installSkill('s-sql', {}, signal())
    expect((await ctx.skills.get('sql-helper', { cwd: project }))?.source).toBe('project-dsh')
    expect((await ctx.skills.get('sql-helper'))?.source).toBe('market')
  })

  describe('rejected packages leave nothing behind', () => {
    const traversal = zipSync({ 'pdf-tools/SKILL.md': strToU8('x'), 'pdf-tools/../escape.sh': strToU8('x') })
    it.each([
      ['a body that is not a zip', strToU8('not a zip'), 'not a zip archive'],
      ['an entry outside the Skill folder', zipSync({ 'other/SKILL.md': strToU8('x') }), 'unexpected entry'],
      ['an entry climbing out of the Skill folder', traversal, 'unexpected entry'],
      ['a package without SKILL.md', zipSync({ 'pdf-tools/README.md': strToU8('x') }), 'SKILL.md is missing'],
      ['files that differ from the published version', zipSync({ 'pdf-tools/SKILL.md': strToU8('tampered'), 'pdf-tools/scripts/run.sh': strToU8('echo pdf\n') }), 'do not match'],
    ])('%s', async (_label, body, reason) => {
      const { center, market, dshHome } = await boot()
      center.downloadBody = body
      const error = remoteErrorOf(await market.installSkill('s-pdf', {}, signal()).catch((failure: unknown) => failure))
      expect(error).toMatchObject({ code: 'skill-market/invalid-package' })
      expect(error?.message).toContain(reason)
      expect(await readdir(join(dshHome, 'skills-market', 't-a')).catch(() => [])).toEqual([])
    })

    it('a package over the size limit', async () => {
      const { ctx, live, dshHome } = await boot()
      await live.update({ maxPackageBytes: 10 })
      const error = remoteErrorOf(await ctx.get('skillMarket')!.installSkill('s-pdf', {}, signal()).catch((failure: unknown) => failure))
      expect(error?.message).toContain('too large')
      expect(await readdir(join(dshHome, 'skills-market', 't-a')).catch(() => [])).toEqual([])
    })

    it('a package that inflates past the size limit', async () => {
      const { center, ctx, live, dshHome } = await boot()
      center.downloadBody = zipSync({ 'pdf-tools/SKILL.md': new Uint8Array(4096) }, { level: 9 })
      await live.update({ maxPackageBytes: 2048 })
      const error = remoteErrorOf(await ctx.get('skillMarket')!.installSkill('s-pdf', {}, signal()).catch((failure: unknown) => failure))
      expect(error?.message).toContain('too large')
      expect(await readdir(join(dshHome, 'skills-market', 't-a')).catch(() => [])).toEqual([])
    })

    it('a Hub that fails or cannot be reached', async () => {
      const { center, market, dshHome } = await boot()
      center.clientStatus = 503
      expect(remoteErrorOf(await market.installSkill('s-pdf', {}, signal()).catch((failure: unknown) => failure)))
        .toMatchObject({ code: 'skill-market/unavailable', details: { status: 503 } })
      center.clientStatus = undefined
      await center.close()
      expect(remoteErrorOf(await market.list({}, signal()).catch((failure: unknown) => failure)))
        .toMatchObject({ code: 'skill-market/unavailable', details: { status: null } })
      expect(await readdir(join(dshHome, 'skills-market', 't-a')).catch(() => [])).toEqual([])
    })
  })

  it('switches a market Skill off for the signed-in tenant only', async () => {
    const { ctx, center, hub, market, dshHome } = await boot()
    await market.installSkill('s-pdf', {}, signal())
    await market.setDisabled('pdf-tools', true)
    expect(market.isDisabled('pdf-tools')).toBe(true)
    expect((await ctx.skills.get('pdf-tools'))?.invocation).toEqual({ modelInvocable: false, userInvocable: false })
    expect((await ctx.skills.list()).find(skill => skill.name === 'pdf-tools')?.invocation.userInvocable).toBe(false)

    // Tenant B has its own directory and its own switches.
    center.tenant = { tenantId: 't-b', tenantName: '乙公司' }
    await hub.switchTenant()
    await expect.poll(async () => (await hub.getState()).attempt?.authorizeUrl).toBeDefined()
    await browse((await hub.getState()).attempt!.authorizeUrl!)
    await expect.poll(() => market.tenantId).toBe('t-b')
    expect(await ctx.skills.get('pdf-tools')).toBeUndefined()
    await market.installSkill('s-pdf', {}, signal())
    expect(market.isDisabled('pdf-tools')).toBe(false)
    expect((await ctx.skills.get('pdf-tools'))?.invocation.userInvocable).toBe(true)
    expect(await readdir(join(dshHome, 'skills-market'))).toEqual(['t-a', 't-b'])
    await market.setDisabled('pdf-tools', false)
  })

  it('refuses to switch Skills while signed out', async () => {
    const { market, hub } = await boot()
    await hub.signOut()
    await expect.poll(() => market.tenantId).toBeUndefined()
    expect(remoteErrorOf(await market.setDisabled('pdf-tools', true).catch((error: unknown) => error))).toMatchObject({ code: 'hub-account/signed-out' })
  })

  it('accepts directory entries, refuses an invalid Skill name, and ignores a record of another name', async () => {
    const { center, market, dshHome } = await boot()
    center.skills = [{ ...PDF, files: { 'a.txt': 'a', 'scripts/run.sh': 'echo pdf\n', 'z.txt': 'z' } }, { ...SQL, id: 's-bad', name: 'Bad_Name' }]
    const files = { 'SKILL.md': '---\nname: pdf-tools\ndescription: Read PDF files\n---\n\n# pdf-tools\n\nUse pdf-tools.\n', 'a.txt': 'a', 'scripts/run.sh': 'echo pdf\n', 'z.txt': 'z' }
    center.downloadBody = zipSync({ 'pdf-tools/': new Uint8Array(), 'pdf-tools/scripts/': new Uint8Array(), ...Object.fromEntries(Object.entries(files).map(([path, text]) => [`pdf-tools/${path}`, strToU8(text)])) })
    expect((await market.installSkill('s-pdf', {}, signal())).installedVersion).toBe('1.0.0')
    const record = JSON.parse(await readFile(join(dshHome, 'skills-market', 't-a', 'pdf-tools', INSTALL_RECORD), 'utf8')) as { files: { path: string }[] }
    expect(record.files.map(file => file.path)).toEqual(['SKILL.md', 'a.txt', 'scripts/run.sh', 'z.txt'])
    center.downloadBody = undefined
    expect(remoteErrorOf(await market.installSkill('s-bad', {}, signal()).catch((error: unknown) => error))?.message).toContain('invalid Skill name')
    await mkdir(join(dshHome, 'skills-market', 't-a', 'renamed'), { recursive: true })
    await writeFile(join(dshHome, 'skills-market', 't-a', 'renamed', INSTALL_RECORD), JSON.stringify({ ...record, hubSkillId: 'x', name: 'other', version: '1', installedAt: 'x' }))
    expect([...(await market.records()).keys()]).toEqual(['pdf-tools'])
  })

  it('switches a market Skill back on', async () => {
    const { ctx, market } = await boot()
    await market.installSkill('s-pdf', {}, signal())
    await market.setDisabled('pdf-tools', true)
    await market.setDisabled('pdf-tools', false)
    expect(market.isDisabled('pdf-tools')).toBe(false)
    expect((await ctx.skills.get('pdf-tools'))?.invocation.userInvocable).toBe(true)
  })

  it('checks user Skills through the default agent preset scope and releases it', async () => {
    const { ctx, market } = await boot()
    const preset = createScope(ctx, { preset: 'default' })
    const released = vi.fn()
    ctx.provide('agentPresets', { acquireScope: async () => ({ key: scopeOf(preset.ctx)!, [Symbol.asyncDispose]: async () => { released() } }) } as never)
    const list = vi.spyOn(ctx.skills, 'list')
    await market.list({}, signal())
    expect(list.mock.calls.at(-1)?.[0]).toMatchObject({ scope: scopeOf(preset.ctx) })
    expect(released).toHaveBeenCalledOnce()
    await preset.dispose()
  })

  it('falls back to defaults without Loader and refuses to persist a switch without Settings', async () => {
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose().then(() => undefined))
    await ctx.plugin(SkillRegistry)
    ctx.provide('hubAccount', { getState: async () => ({ profile: null }), watch: async function* () {} } as never)
    const market = new SkillMarket(ctx)
    market.tenantId = 't-x'
    expect(market.isDisabled('pdf-tools')).toBe(false)
    expect(market.tenantDir('t-x')).toMatch(/skills-market[/\\]t-x$/)
    await expect(market.setDisabled('pdf-tools', true)).rejects.toThrow('requires the settings service')
  })

  describe('updates and lifecycle (T24)', () => {
    const v2 = { ...PDF, version: '1.1.0', files: { 'scripts/run.sh': 'echo pdf 1.1\n', 'scripts/new.sh': 'echo new\n' } }
    const dirOf = (dshHome: string) => join(dshHome, 'skills-market', 't-a', 'pdf-tools')

    it('offers an update when the Hub publishes a newer version, and the update lands the new files', async () => {
      const { center, market, dshHome } = await boot()
      await market.installSkill('s-pdf', {}, signal())
      expect(await market.installedStatus(signal())).toEqual([{ name: 'pdf-tools', hubSkillId: 's-pdf', installedVersion: '1.0.0', latestVersion: '1.0.0', state: 'current' }])
      center.skills = [v2, SQL]
      expect((await market.list({}, signal())).items[0]).toMatchObject({ installedVersion: '1.0.0', version: '1.1.0', updateAvailable: true })
      expect((await market.detail('s-pdf', signal())).updateAvailable).toBe(true)
      expect(await market.installedStatus(signal())).toEqual([{ name: 'pdf-tools', hubSkillId: 's-pdf', installedVersion: '1.0.0', latestVersion: '1.1.0', state: 'update' }])
      expect(await market.installSkill('s-pdf', {}, signal())).toMatchObject({ installedVersion: '1.1.0', updateAvailable: false })
      expect(await readFile(join(dirOf(dshHome), 'scripts/run.sh'), 'utf8')).toBe('echo pdf 1.1\n')
      expect(await readFile(join(dirOf(dshHome), 'scripts/new.sh'), 'utf8')).toBe('echo new\n')
      expect(JSON.parse(await readFile(join(dirOf(dshHome), INSTALL_RECORD), 'utf8'))).toMatchObject({ version: '1.1.0' })
      expect((await market.installedStatus(signal()))[0]?.state).toBe('current')
      await market.installSkill('s-sql', {}, signal())
      expect((await market.installedStatus(signal())).map(status => status.name)).toEqual(['pdf-tools', 'sql-helper'])
    })

    it('refuses to overwrite local edits until asked, leaving the local files untouched', async () => {
      const { center, market, dshHome } = await boot()
      await market.installSkill('s-pdf', {}, signal())
      const dir = dirOf(dshHome)
      await writeFile(join(dir, 'scripts/run.sh'), 'echo my edit\n')
      await writeFile(join(dir, 'notes.md'), 'mine\n')
      await unlink(join(dir, 'SKILL.md'))
      center.skills = [v2, SQL]
      const error = remoteErrorOf(await market.installSkill('s-pdf', {}, signal()).catch((failure: unknown) => failure))
      expect(error).toMatchObject({ code: 'skill-market/local-changes', details: { name: 'pdf-tools', files: ['SKILL.md', 'notes.md', 'scripts/run.sh'] } })
      expect(await readFile(join(dir, 'scripts/run.sh'), 'utf8')).toBe('echo my edit\n')
      expect(JSON.parse(await readFile(join(dir, INSTALL_RECORD), 'utf8'))).toMatchObject({ version: '1.0.0' })
      await market.installSkill('s-pdf', { overwriteLocalChanges: true }, signal())
      expect(await readFile(join(dir, 'scripts/run.sh'), 'utf8')).toBe('echo pdf 1.1\n')
      expect(await readdir(dir)).not.toContain('notes.md')
    })

    it('treats a same-named directory without an install record as local files to protect', async () => {
      const { market, dshHome } = await boot()
      await writeSkill(join(dshHome, 'skills-market', 't-a'), 'pdf-tools', 'Hand-placed copy')
      expect(remoteErrorOf(await market.installSkill('s-pdf', {}, signal()).catch((failure: unknown) => failure)))
        .toMatchObject({ code: 'skill-market/local-changes', details: { files: ['SKILL.md'] } })
    })

    it('keeps a Skill the Hub withdrew installed and usable, marked unavailable, and reports unknown when the Hub cannot be asked', async () => {
      const { ctx, center, market } = await boot()
      await market.installSkill('s-pdf', {}, signal())
      center.skills = [SQL]
      expect(await market.installedStatus(signal())).toEqual([{ name: 'pdf-tools', hubSkillId: 's-pdf', installedVersion: '1.0.0', latestVersion: null, state: 'unavailable' }])
      expect((await ctx.skills.get('pdf-tools'))?.invocation.modelInvocable).toBe(true)
      expect((await market.list({}, signal())).items.map(item => item.name)).toEqual(['sql-helper'])
      center.clientStatus = 503
      expect((await market.installedStatus(signal()))[0]).toMatchObject({ state: 'unknown', latestVersion: null })
    })

    it('stops reading the Hub when the caller withdraws', async () => {
      const { market } = await boot()
      await market.installSkill('s-pdf', {}, signal())
      const controller = new AbortController()
      const pending = market.installedStatus(controller.signal)
      controller.abort()
      await expect(pending).rejects.toThrow()
    })

    it('shows only the signed-in tenant\'s market Skills, and brings them back after switching back', async () => {
      const { ctx, center, hub, market } = await boot()
      await market.installSkill('s-pdf', {}, signal())
      const switchTo = async (tenant: { tenantId: string; tenantName: string }) => {
        center.tenant = tenant
        await hub.switchTenant()
        await expect.poll(async () => (await hub.getState()).attempt?.authorizeUrl).toBeDefined()
        await browse((await hub.getState()).attempt!.authorizeUrl!)
        await expect.poll(() => market.tenantId).toBe(tenant.tenantId)
      }
      const marketNames = async () => (await ctx.skills.list()).filter(skill => skill.source === 'market').map(skill => skill.name)
      expect(await marketNames()).toEqual(['pdf-tools'])
      await switchTo({ tenantId: 't-b', tenantName: '乙公司' })
      expect(await marketNames()).toEqual([])
      expect(await market.installedStatus(signal())).toEqual([])
      await switchTo({ tenantId: 't-a', tenantName: '甲公司' })
      expect(await marketNames()).toEqual(['pdf-tools'])
    })

    it('orders versions numerically', () => {
      expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0)
      expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
      expect(compareVersions('1.0', '1.0.1')).toBeLessThan(0)
      expect(compareVersions('1.0.1', '1.0')).toBeGreaterThan(0)
    })
  })

  describe('upload to the Skill Hub (T25)', () => {
    async function folder(root: string, name: string, frontmatter = `name: ${name}\ndescription: ${name} description`) {
      const dir = join(root, name)
      await mkdir(join(dir, 'scripts'), { recursive: true })
      await mkdir(join(dir, 'node_modules', 'x'), { recursive: true })
      await mkdir(join(dir, '__pycache__'), { recursive: true })
      await writeFile(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\nBody.\n`)
      await writeFile(join(dir, 'scripts', 'run.sh'), 'echo run\n')
      await writeFile(join(dir, '.DS_Store'), 'junk')
      await writeFile(join(dir, 'node_modules', 'x', 'index.js'), 'junk')
      await writeFile(join(dir, '__pycache__', 'a.pyc'), 'junk')
      return dir
    }

    it('offers the user\'s own Skills and previews a folder as an upload would send it', async () => {
      const { market, dshHome } = await boot()
      const dir = await folder(join(dshHome, 'skills'), 'report-writer')
      const other = await folder(join(dshHome, 'skills'), 'alpha-notes')
      expect(await market.uploadSources()).toEqual([
        { name: 'alpha-notes', description: 'alpha-notes description', dir: other, source: 'user-dsh' },
        { name: 'report-writer', description: 'report-writer description', dir, source: 'user-dsh' },
      ])
      expect(await market.inspectFolder(dir, signal())).toEqual({
        dir, name: 'report-writer', description: 'report-writer description', fileCount: 2, sizeBytes: expect.any(Number) as number,
        problems: [], existing: null, suggestedVersion: '1.0.0',
      })
    })

    it('reports why a folder cannot be uploaded', async () => {
      const { market, home } = await boot()
      const root = join(home, 'loose')
      await mkdir(join(root, 'empty'), { recursive: true })
      expect((await market.inspectFolder(join(root, 'empty'), signal())).problems).toEqual(['no-skill-md'])
      expect((await market.inspectFolder(join(root, 'missing'), signal())).problems).toEqual(['unreadable'])
      await mkdir(join(root, 'plain'), { recursive: true })
      await writeFile(join(root, 'plain', 'SKILL.md'), '# no frontmatter\n')
      expect((await market.inspectFolder(join(root, 'plain'), signal())).problems).toEqual(['no-frontmatter'])
      expect((await market.inspectFolder(await folder(root, 'yaml', 'name: [oops'), signal())).problems).toEqual(['invalid-yaml'])
      expect((await market.inspectFolder(await folder(root, 'bad', 'name: Bad_Name\ndescription: x'), signal())).problems).toEqual(['invalid-name'])
      expect((await market.inspectFolder(await folder(root, 'nodesc', 'name: nodesc'), signal())).problems).toEqual(['no-description'])
      expect((await market.inspectFolder(await folder(root, 'list', '- a'), signal())).problems).toEqual(['invalid-name', 'no-description'])
      expect((await market.inspectFolder(await folder(root, 'scalar', 'just text'), signal())).problems).toEqual(['invalid-name', 'no-description'])
      expect(remoteErrorOf(await market.uploadSkill({ dir: join(root, 'empty'), version: '1.0.0' }, signal()).catch((error: unknown) => error)))
        .toMatchObject({ code: 'skill-market/invalid-folder', details: { problems: ['no-skill-md'] } })
    })

    it('uploads a new Skill without junk and leaves the local folder untouched; an employee\'s upload is submitted for review', async () => {
      const { center, market, home } = await boot()
      const dir = await folder(join(home, 'work'), 'report-writer')
      const before = (await stat(join(dir, 'SKILL.md'))).mtimeMs
      const result = await market.uploadSkill({ dir, version: '1.0.0', visibility: 'departments', departmentIds: ['d-rd'], categoryId: 'c-doc' }, signal())
      expect(result).toMatchObject({ name: 'report-writer', version: '1.0.0', mode: 'create', status: 'pending', reviewUrl: expect.stringContaining('/skills/review/') as string })
      expect(center.uploads[0]).toEqual({
        path: '/api/client/skills', fields: { version: '1.0.0', visibility: 'departments', departmentIds: 'd-rd', categoryId: 'c-doc' },
        entries: ['report-writer/SKILL.md', 'report-writer/scripts/run.sh'],
      })
      expect((await readdir(dir)).sort()).toEqual(['.DS_Store', 'SKILL.md', '__pycache__', 'node_modules', 'scripts'])
      expect((await stat(join(dir, 'SKILL.md'))).mtimeMs).toBe(before)
    })

    it('uploads the next version of the employee\'s own Skill, and a tenant admin\'s upload is published', async () => {
      const { center, market, home } = await boot()
      center.tenantAdmin = true
      center.owned.push({ id: 's-own', name: 'report-writer', versions: [{ version: '1.2.0', status: 'published' }] })
      const dir = await folder(join(home, 'work'), 'report-writer')
      const preview = await market.inspectFolder(dir, signal())
      expect(preview).toMatchObject({ existing: { skillId: 's-own', highestVersion: '1.2.0', currentVersion: '1.2.0', workingStatus: null }, suggestedVersion: '1.2.1' })
      const result = await market.uploadSkill({ dir, version: '1.2.1', visibility: 'private', categoryId: 'c-doc' }, signal())
      expect(result).toEqual({ skillId: 's-own', name: 'report-writer', version: '1.2.1', mode: 'version', status: 'published', reviewUrl: null })
      expect(center.uploads[0]).toMatchObject({ path: '/api/client/skills/s-own/versions', fields: { version: '1.2.1' } })
      expect((await market.list({}, signal())).items.map(item => item.name)).toContain('report-writer')
    })

    it('passes the Hub\'s reasons through verbatim', async () => {
      const { center, market, home } = await boot()
      const dir = await folder(join(home, 'work'), 'report-writer')
      const reason = async (version: string) =>
        (await market.uploadSkill({ dir, version }, signal()).catch((error: unknown) => error)) as Error
      expect(remoteErrorOf(await reason('v1'))).toMatchObject({ code: 'skill-market/upload-rejected', message: '版本号格式应为 x.y.z（如 1.0.0）', details: { status: 400 } })
      center.owned.push({ id: 's-own', name: 'report-writer', versions: [{ version: '1.0.0', status: 'published' }, { version: '1.1.0', status: 'pending' }] })
      expect((await reason('1.2.0')).message).toBe('该 Skill 已有未成为正式的版本 1.1.0（审核中），请先处理后再上传新版本')
      center.owned[0]!.versions.pop()
      expect((await reason('0.9.0')).message).toBe('新版本号必须高于已有的最高版本 1.0.0')
      center.clientStatus = 413
      expect(remoteErrorOf(await reason('2.0.0'))).toMatchObject({ code: 'skill-market/unavailable', details: { status: 413 } })
    })

    it('reports a Hub that cannot be reached', async () => {
      const { center, market, home } = await boot()
      const dir = await folder(join(home, 'work'), 'report-writer')
      await center.close()
      expect(remoteErrorOf(await market.uploadSkill({ dir, version: '1.0.0' }, signal()).catch((error: unknown) => error))).toMatchObject({ code: 'skill-market/unavailable' })
    })

    it('sends an employee list, and reports rejections without a usable reason, dropped uploads, and withdrawn callers', async () => {
      const { center, market, home } = await boot()
      const dir = await folder(join(home, 'work'), 'report-writer')
      await market.uploadSkill({ dir, version: '1.0.0', visibility: 'employees', employeeIds: ['e-li', 'e-han'] }, signal())
      expect(center.uploads[0]?.fields).toMatchObject({ visibility: 'employees', employeeIds: ['e-li', 'e-han'] })
      const other = await folder(join(home, 'work'), 'other-skill')
      const attempt = async (controller = new AbortController()) => market.uploadSkill({ dir: other, version: '1.0.0' }, controller.signal).catch((error: unknown) => error)
      center.uploadReply = { status: 400, body: JSON.stringify({ message: ['版本号格式应为 x.y.z', 'SKILL.md 缺少 description'] }) }
      expect((await attempt() as Error).message).toBe('版本号格式应为 x.y.z；SKILL.md 缺少 description')
      center.uploadReply = { status: 413, body: 'too large' }
      expect(remoteErrorOf(await attempt())).toMatchObject({ code: 'skill-market/upload-rejected', message: 'the Skill Hub answered 413', details: { status: 413 } })
      center.uploadReply = 'drop'
      expect(remoteErrorOf(await attempt())).toMatchObject({ code: 'skill-market/unavailable' })
      center.uploadReply = undefined
      const controller = new AbortController()
      const gate = Promise.withResolvers<undefined>()
      center.uploadHook = () => { controller.abort(); return gate.promise }
      expect(remoteErrorOf(await attempt(controller))).toBeUndefined()
      gate.resolve(undefined)
    })

    it('reads visibility and category choices', async () => {
      const { market } = await boot()
      expect(await market.uploadOptions(signal())).toEqual({
        categories: [{ id: 'c-doc', name: '文档' }, { id: 'c-dev', name: '研发' }],
        departments: [{ id: 'd-root', parentId: null, name: '甲公司' }, { id: 'd-rd', parentId: 'd-root', name: '研发部' }],
        employees: [{ id: 'e-li', name: '李雷', departmentName: '研发部' }, { id: 'e-han', name: '韩梅梅', departmentName: '甲公司' }],
      })
    })

    it('suggests the next patch version', () => {
      expect(nextPatch('1.2.3')).toBe('1.2.4')
      expect(nextPatch('0.9.9')).toBe('0.9.10')
      expect(nextPatch('weird')).toBe('weird')
    })
  })
})
