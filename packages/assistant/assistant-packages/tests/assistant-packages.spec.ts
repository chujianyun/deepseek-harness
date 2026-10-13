import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { strToU8, zipSync } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AssistantPackagesService, { scheduleTiming } from '../src/index.ts'
import { readPackage, sha256 } from '../src/manifest.ts'
import type { AssistantPackageManifest } from '../src/types.ts'

const CORE = { 'IDENTITY.md': '# 身份\n', 'SOUL.md': '# 人格\n', 'USER.md': '# 用户\n', 'AGENTS.md': '# 方法\n' }
const TASKS = [
  { id: 'inspection', title: '部门巡检', prompt: '跑今日巡检', timing: { kind: 'weekly', weekdays: [1, 2, 3, 4, 5], time: '11:00' }, timeZone: 'Asia/Shanghai', connectors: ['feishu'], permission: 'full-access' },
  { id: 'report', title: '天猫日报', prompt: '采集昨日数据', timing: { kind: 'cron', expression: '0 6 * * 1-5' }, timeZone: 'Asia/Shanghai', connectors: [] },
] as const satisfies AssistantPackageManifest['tasks']

const manifest = (version = '1.0.0', overrides: Partial<AssistantPackageManifest> = {}): AssistantPackageManifest => ({
  name: 'ops-report', displayName: '运营日报助手', description: '每天巡检与日报', version, avatar: 'ocean',
  skills: ['ai-inspection', 'roi-inspection', 'local-skill', 'gone-skill'], connectors: ['feishu'], tasks: TASKS, ...overrides,
})

const zipOf = (m: AssistantPackageManifest, files: Record<string, string> = CORE) =>
  zipSync({ 'agent.json': strToU8(JSON.stringify(m)), ...Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])) })

interface Published { manifest: AssistantPackageManifest; zip: Uint8Array; files?: Record<string, string> }

const contexts: Context[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** The service over an in-memory user center, assistants service, Skill market, automation tasks, and schedule. */
async function mount(options: { signedIn?: boolean; market?: boolean; tasks?: boolean; home?: string } = {}) {
  const home = options.home ?? await mkdtemp(join(tmpdir(), 'assistant-packages-'))
  if (options.home === undefined) dirs.push(home)
  let tenantId: string | null = options.signedIn === false ? null : 'tenant-a'
  const published = new Map<string, Published>()
  const publish = (id: string, m: AssistantPackageManifest, files?: Record<string, string>) =>
    published.set(id, { manifest: m, zip: zipOf(m, files) })
  const hub = { fail: null as null | 'throw' | number, tamper: false, missingDownload: false }
  const request = vi.fn(async (path: string) => {
    if (hub.fail === 'throw') throw new TypeError('fetch failed')
    if (typeof hub.fail === 'number') return new Response('{}', { status: hub.fail })
    if (path === '/api/client/agent-packages') {
      return Response.json([...published].map(([id, p]) => ({ id, name: p.manifest.name, version: p.manifest.version, sha256: sha256(p.zip), sizeBytes: p.zip.byteLength, manifest: p.manifest, updatedAt: '2026-10-13T00:00:00.000Z' })))
    }
    const id = /\/api\/client\/agent-packages\/(.+)\/download$/.exec(path)?.[1]
    const p = id === undefined ? undefined : published.get(decodeURIComponent(id))
    if (p === undefined || hub.missingDownload) return new Response('{}', { status: 404 })
    const bytes = hub.tamper ? zipOf(p.manifest, { ...CORE, 'SOUL.md': 'tampered' }) : p.zip
    return new Response(bytes.slice(), { status: 200 })
  })
  const hubAccount = { getState: vi.fn(async () => ({ profile: tenantId === null ? null : { tenantId } })), request }

  type View = { id: string; name: string; description: string; avatar: object; preset?: string; subsets?: object; createdAt: string }
  const assistants = new Map<string, { view: View; files: Record<string, string> }>()
  let next = 0
  const assistantsService = {
    getState: vi.fn(async () => ({ assistants: [...assistants.values()].map(a => a.view) })),
    createAssistant: vi.fn(async (input: { name: string; description: string; avatar: object; preset?: string; subsets?: object }) => {
      const id = `assistant-${String(++next)}`
      // Like the assistants service, an empty subset object allows everything and is stored as absent.
      const subsets = input.subsets === undefined || Object.keys(input.subsets).length === 0 ? undefined : input.subsets
      const view: View = { id, name: input.name, description: input.description, avatar: input.avatar, createdAt: 'now', ...(input.preset === undefined ? {} : { preset: input.preset }), ...(subsets === undefined ? {} : { subsets }) }
      assistants.set(id, { view, files: { 'IDENTITY.md': '', 'SOUL.md': '', 'USER.md': 'blank user', 'AGENTS.md': '' } })
      return { assistantId: id }
    }),
    updateAssistant: vi.fn(async (id: string, input: {
      files?: Record<string, string>
      name?: string
      description?: string
      avatar?: object
      preset?: string | null
      subsets?: object
    }) => {
      const a = assistants.get(id)!
      const { files, preset, ...fields } = input
      Object.assign(a.files, files)
      a.view = { ...a.view, ...fields }
      if (preset === null) delete a.view.preset
      else if (preset !== undefined) a.view.preset = preset
    }),
    getAssistant: vi.fn(async (id: string) => {
      const a = assistants.get(id)!
      return { assistant: a.view, files: { ...a.files } }
    }),
    deleteAssistant: vi.fn(async (id: string) => { assistants.delete(id) }),
  }

  const catalog = [
    { id: 'skill-roi', name: 'roi-inspection', conflict: false, installedVersion: null },
    { id: 'skill-local', name: 'local-skill', conflict: true, installedVersion: null },
    ...Array.from({ length: 60 }, (_, i) => ({ id: `skill-other-${String(i)}`, name: `roi-inspection-v${String(i)}`, conflict: false, installedVersion: null })),
    { id: 'skill-deep', name: 'roi-inspection-deep', conflict: false, installedVersion: null },
  ]
  const market = {
    records: vi.fn(async () => new Map([['ai-inspection', {}]])),
    list: vi.fn(async (query: { q: string; page: number; pageSize: number }) => {
      const matches = catalog.filter(item => item.name.includes(query.q))
      const items = matches.slice((query.page - 1) * query.pageSize, query.page * query.pageSize)
      return { items, total: matches.length, page: query.page, pageSize: query.pageSize }
    }),
    installSkill: vi.fn(async (_id: string) => ({})),
  }
  const schedules = new Map<string, string>()
  const automationTasks = {
    create: vi.fn(async (request: { title: string }) => {
      const id = `schedule-${String(schedules.size + 1)}`
      schedules.set(id, `session-${id}`)
      return { sessionId: `session-${id}`, record: { id, title: request.title } }
    }),
  }
  const schedule = {
    list: vi.fn(async ({ sessionId }: { sessionId: string }) =>
      [...schedules].filter(([, session]) => session === sessionId).map(([id]) => ({ id }))),
    delete: vi.fn(async ({ id }: { id: string }) => {
      schedules.delete(id)
      return { id, deleted: true }
    }),
  }

  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('hubAccount', hubAccount as never)
  ctx.provide('assistants', assistantsService as never)
  if (options.market !== false) ctx.provide('skillMarket', market as never)
  if (options.tasks !== false) {
    ctx.provide('automationTasks', automationTasks as never)
    ctx.provide('schedule', schedule as never)
  }
  const warn = vi.spyOn(ctx.logger, 'warn')
  await ctx.plugin(AssistantPackagesService, { dshHome: home }).await()
  const setRaw = (body: BodyInit, status = 200) => { request.mockImplementationOnce(async () => new Response(body, { status })) }
  const signal = new AbortController().signal
  return {
    service: ctx.get('assistantPackages')!, signal, home, hub, publish, setRaw, request, assistants, assistantsService, market, automationTasks, schedule, schedules, warn,
    signOut: () => { tenantId = null },
    records: async () => JSON.parse(await readFile(join(home, 'assistant-packages', 'tenant-a', 'installs.json'), 'utf8')) as { installs: Record<string, { version: string; files: Record<string, string> }> },
  }
}

const refusal = async (promise: Promise<unknown>) => {
  const error = await promise.then(() => undefined, (e: unknown) => e)
  expect(error).toBeInstanceOf(RemoteError)
  return error as RemoteError
}

describe('installing a package', () => {
  it('creates the assistant with the package profile and core files, installs its Skills, and leaves every task off', async () => {
    const m = await mount()
    m.publish('pkg-1', manifest())
    const result = await m.service.installPackage('pkg-1', m.signal)

    expect(m.assistantsService.createAssistant).toHaveBeenCalledWith(expect.objectContaining({
      templateId: null, name: '运营日报助手', description: '每天巡检与日报', avatar: { kind: 'preset', key: 'ocean' },
      subsets: { skills: ['ai-inspection', 'roi-inspection', 'local-skill', 'gone-skill'], connectors: ['feishu'] },
    }))
    expect(m.assistants.get(result.assistantId)!.files).toEqual(CORE)
    expect(m.market.installSkill).toHaveBeenCalledTimes(1)
    expect(m.market.installSkill).toHaveBeenCalledWith('skill-roi', {}, m.signal)
    expect(result).toMatchObject({ version: '1.0.0', installedSkills: ['roi-inspection'], missingSkills: ['gone-skill'], keptFiles: [] })

    const installed = result.state.installed[0]!
    expect(installed).toMatchObject({ assistantId: result.assistantId, packageId: 'pkg-1', version: '1.0.0', updateVersion: null, missingSkills: ['gone-skill'] })
    expect(installed.tasks.map(t => [t.id, t.enabled, t.outdated])).toEqual([['inspection', null, false], ['report', null, false]])
    expect(result.state.packages![0]).toMatchObject({ id: 'pkg-1', installedAssistantId: result.assistantId })
  })

  it('uses the configured default avatar, no preset, and full subsets when the package names none', async () => {
    const m = await mount({ market: false })
    const { avatar: _a, skills: _s, connectors: _c, preset: _p, ...bare } = manifest()
    m.publish('pkg-1', bare)
    m.publish('pkg-2', { ...bare, name: 'bare', preset: 'standard' })
    await m.service.installPackage('pkg-1', m.signal)
    expect(m.assistantsService.createAssistant).toHaveBeenLastCalledWith(expect.objectContaining({ avatar: { kind: 'preset', key: 'sun' }, subsets: {} }))
    await m.service.installPackage('pkg-2', m.signal)
    expect(m.assistantsService.createAssistant).toHaveBeenLastCalledWith(expect.objectContaining({ preset: 'standard' }))
  })

  it('removes the new assistant when writing its core files fails', async () => {
    const m = await mount()
    m.publish('pkg-1', manifest())
    m.assistantsService.updateAssistant.mockRejectedValueOnce(new Error('disk full'))
    await expect(m.service.installPackage('pkg-1', m.signal)).rejects.toThrow('disk full')
    expect(m.assistants.size).toBe(0)
  })

  it('warns when the rollback itself fails and still reports the install failure', async () => {
    const m = await mount()
    m.publish('pkg-1', manifest())
    m.assistantsService.updateAssistant.mockRejectedValueOnce(new Error('disk full'))
    m.assistantsService.deleteAssistant.mockRejectedValueOnce(new Error('locked'))
    await expect(m.service.installPackage('pkg-1', m.signal)).rejects.toThrow('disk full')
    expect(m.warn).toHaveBeenCalledWith(expect.stringContaining('could not remove the assistant of a failed install'))
  })

  it('refuses a download that differs from the listed package and creates nothing', async () => {
    const m = await mount()
    m.publish('pkg-1', manifest())
    m.hub.tamper = true
    const error = await refusal(m.service.installPackage('pkg-1', m.signal))
    expect(error.code).toBe('assistant-packages/invalid')
    expect(m.assistants.size).toBe(0)
  })

  it('refuses a package the company does not offer, a signed-out user, and an unreachable user center', async () => {
    const m = await mount()
    expect((await refusal(m.service.installPackage('nope', m.signal))).code).toBe('assistant-packages/not-found')
    m.hub.fail = 'throw'
    expect((await refusal(m.service.installPackage('pkg-1', m.signal))).details).toEqual({ status: null })
    m.hub.fail = 500
    expect((await refusal(m.service.installPackage('pkg-1', m.signal))).details).toEqual({ status: 500 })
    m.signOut()
    expect((await refusal(m.service.installPackage('pkg-1', m.signal))).code).toBe('hub-account/signed-out')
  })

  it('reads a listed package whose download is gone as not found', async () => {
    const m = await mount()
    m.publish('pkg-1', manifest())
    m.hub.missingDownload = true
    expect((await refusal(m.service.installPackage('pkg-1', m.signal))).code).toBe('assistant-packages/not-found')
  })

  it('updates instead when the package is already installed here', async () => {
    const m = await mount()
    m.publish('pkg-1', manifest())
    const first = await m.service.installPackage('pkg-1', m.signal)
    m.publish('pkg-1', manifest('1.1.0'))
    const again = await m.service.installPackage('pkg-1', m.signal)
    expect(again).toMatchObject({ assistantId: first.assistantId, version: '1.1.0' })
    expect(m.assistants.size).toBe(1)
  })
})

describe('reading the state', () => {
  it('is empty while signed out', async () => {
    const m = await mount({ signedIn: false })
    expect(await m.service.getState(m.signal)).toEqual({ tenantId: null, packages: null, unavailable: false, installed: [] })
  })

  it('keeps installs readable and marks the list unavailable when the user center cannot be reached', async () => {
    const m = await mount()
    m.publish('pkg-1', manifest())
    await m.service.installPackage('pkg-1', m.signal)
    m.hub.fail = 503
    const state = await m.service.getState(m.signal)
    expect(state).toMatchObject({ tenantId: 'tenant-a', packages: null, unavailable: true })
    expect(state.installed).toHaveLength(1)
    expect(m.warn).toHaveBeenCalledWith(expect.stringContaining('the package list could not be read'))
  })

  it('rethrows when the caller gave up', async () => {
    const m = await mount()
    const controller = new AbortController()
    m.hub.fail = 'throw'
    controller.abort()
    await expect(m.service.getState(controller.signal)).rejects.toThrow('fetch failed')
  })

  it('hides installs whose assistant the user deleted and offers the package again', async () => {
    const m = await mount()
    m.publish('pkg-1', manifest())
    const { assistantId } = await m.service.installPackage('pkg-1', m.signal)
    m.assistants.delete(assistantId)
    const state = await m.service.getState(m.signal)
    expect(state.installed).toEqual([])
    expect(state.packages![0]!.installedAssistantId).toBeNull()
    const again = await m.service.installPackage('pkg-1', m.signal)
    expect(again.assistantId).not.toBe(assistantId)
  })

  it('shows the newer version available', async () => {
    const m = await mount()
    m.publish('pkg-1', manifest())
    await m.service.installPackage('pkg-1', m.signal)
    m.publish('pkg-1', manifest('1.0.10'))
    expect((await m.service.getState(m.signal)).installed[0]!.updateVersion).toBe('1.0.10')
  })

  it('refuses install records it cannot read', async () => {
    const m = await mount()
    await m.service.getState(m.signal)
    const dir = join(m.home, 'assistant-packages', 'tenant-a')
    await import('node:fs/promises').then(fs => fs.mkdir(dir, { recursive: true }))
    await writeFile(join(dir, 'installs.json'), '{"version":2}')
    await expect(m.service.getState(m.signal)).rejects.toThrow()
  })

  it('reports an install file that cannot be read for another reason', async () => {
    const m = await mount()
    await import('node:fs/promises').then(fs => fs.mkdir(join(m.home, 'assistant-packages', 'tenant-a', 'installs.json'), { recursive: true }))
    await expect(m.service.getState(m.signal)).rejects.toThrow(/EISDIR/)
  })
})

describe('updating', () => {
  it('replaces unchanged core files and profile fields, keeps the user\'s edits, and installs newly named Skills', async () => {
    const m = await mount()
    m.publish('pkg-1', manifest())
    const { assistantId } = await m.service.installPackage('pkg-1', m.signal)
    const a = m.assistants.get(assistantId)!
    a.files['SOUL.md'] = '# 我改过的人格\n'
    a.view = { ...a.view, description: '我改过的描述' }
    m.market.records.mockResolvedValue(new Map([['ai-inspection', {}], ['roi-inspection', {}]]))
    m.publish('pkg-1', manifest('2.0.0', { displayName: '运营日报助手 2', description: '新描述', preset: 'standard', skills: ['ai-inspection', 'roi-inspection'] }), { ...CORE, 'SOUL.md': '# 新人格\n', 'AGENTS.md': '# 新方法\n' })

    const result = await m.service.updatePackage(assistantId, m.signal)
    expect(result).toMatchObject({ version: '2.0.0', keptFiles: ['SOUL.md'], installedSkills: [], missingSkills: [] })
    expect(a.files['SOUL.md']).toBe('# 我改过的人格\n')
    expect(a.files['AGENTS.md']).toBe('# 新方法\n')
    expect(a.view).toMatchObject({ name: '运营日报助手 2', description: '我改过的描述', preset: 'standard' })

    // The kept file still counts as changed by the user on the next update.
    m.publish('pkg-1', manifest('3.0.0'), { ...CORE, 'SOUL.md': '# 第三版\n' })
    expect((await m.service.updatePackage(assistantId, m.signal)).keptFiles).toEqual(['SOUL.md'])
    expect((await m.records()).installs[assistantId]!.version).toBe('3.0.0')
  })

  it('changes nothing when already current', async () => {
    const m = await mount()
    m.publish('pkg-1', manifest())
    const { assistantId } = await m.service.installPackage('pkg-1', m.signal)
    m.assistantsService.updateAssistant.mockClear()
    expect(await m.service.updatePackage(assistantId, m.signal)).toMatchObject({ version: '1.0.0', keptFiles: [], installedSkills: [] })
    expect(m.assistantsService.updateAssistant).not.toHaveBeenCalled()
  })

  it('refuses an assistant not installed from a package', async () => {
    const m = await mount()
    expect((await refusal(m.service.updatePackage('assistant-x', m.signal))).code).toBe('assistant-packages/not-installed')
  })
})

describe('recommended tasks', () => {
  it('switching on creates an automation task bound to the assistant with the task\'s timing, permission, and connectors', async () => {
    const m = await mount()
    m.publish('pkg-1', manifest())
    const { assistantId } = await m.service.installPackage('pkg-1', m.signal)
    const state = await m.service.enableTask(assistantId, 'inspection', 'ws-1' as never, m.signal)
    expect(m.automationTasks.create).toHaveBeenCalledWith({
      title: '部门巡检', prompt: '跑今日巡检', workspaceId: 'ws-1', assistantId, permission: 'full-access', connectors: ['feishu'],
      timing: { kind: 'weekly', weekly: { time: '11:00:00', time_zone: 'Asia/Shanghai', weekdays: [1, 2, 3, 4, 5] } },
    })
    expect(state.installed[0]!.tasks[0]!.enabled).toEqual({ sessionId: 'session-schedule-1', scheduleId: 'schedule-1', version: '1.0.0' })

    await m.service.enableTask(assistantId, 'inspection', 'ws-1' as never, m.signal)
    expect(m.automationTasks.create).toHaveBeenCalledTimes(1)

    await m.service.enableTask(assistantId, 'report', 'ws-1' as never, m.signal)
    const last = m.automationTasks.create.mock.lastCall?.[0]
    expect(last).not.toHaveProperty('connectors')
    expect(last).not.toHaveProperty('permission')
  })

  it('switching off deletes the schedule; a schedule deleted elsewhere reads as off', async () => {
    const m = await mount()
    m.publish('pkg-1', manifest())
    const { assistantId } = await m.service.installPackage('pkg-1', m.signal)
    await m.service.enableTask(assistantId, 'inspection', 'ws-1' as never, m.signal)
    const off = await m.service.disableTask(assistantId, 'inspection', m.signal)
    expect(m.schedule.delete).toHaveBeenCalledWith({ sessionId: 'session-schedule-1', id: 'schedule-1' })
    expect(off.installed[0]!.tasks[0]!.enabled).toBeNull()
    await m.service.disableTask(assistantId, 'inspection', m.signal)
    expect(m.schedule.delete).toHaveBeenCalledTimes(1)

    await m.service.enableTask(assistantId, 'report', 'ws-1' as never, m.signal)
    m.schedules.clear()
    expect((await m.service.getState(m.signal)).installed[0]!.tasks[1]!.enabled).toBeNull()
    await m.service.enableTask(assistantId, 'report', 'ws-1' as never, m.signal)
    expect(m.automationTasks.create).toHaveBeenCalledTimes(3)
  })

  it('marks a switched-on task outdated after an update changes it', async () => {
    const m = await mount()
    m.publish('pkg-1', manifest())
    const { assistantId } = await m.service.installPackage('pkg-1', m.signal)
    await m.service.enableTask(assistantId, 'inspection', 'ws-1' as never, m.signal)
    m.publish('pkg-1', manifest('1.1.0', { tasks: [{ ...TASKS[0], prompt: '跑今日巡检（新口径）' }, TASKS[1]] }))
    const { state } = await m.service.updatePackage(assistantId, m.signal)
    expect(state.installed[0]!.tasks.map(t => t.outdated)).toEqual([true, false])
  })

  it('reads a switched-on task as off in a deployment without the schedule', async () => {
    const first = await mount()
    first.publish('pkg-1', manifest())
    const { assistantId } = await first.service.installPackage('pkg-1', first.signal)
    await first.service.enableTask(assistantId, 'inspection', 'ws-1' as never, first.signal)
    const second = await mount({ tasks: false, home: first.home })
    second.publish('pkg-1', manifest())
    second.assistants.set(assistantId, first.assistants.get(assistantId)!)
    expect((await second.service.getState(second.signal)).installed[0]!.tasks[0]!.enabled).toBeNull()
  })

  it('refuses unknown tasks and assistants, and a deployment without automation tasks', async () => {
    const m = await mount({ tasks: false })
    m.publish('pkg-1', manifest())
    const { assistantId } = await m.service.installPackage('pkg-1', m.signal)
    expect((await refusal(m.service.enableTask(assistantId, 'nope', 'ws-1' as never, m.signal))).code).toBe('assistant-packages/task-not-found')
    expect((await refusal(m.service.disableTask('assistant-x', 'inspection', m.signal))).code).toBe('assistant-packages/not-installed')
    expect((await refusal(m.service.enableTask(assistantId, 'inspection', 'ws-1' as never, m.signal))).code).toBe('assistant-packages/unavailable')
    expect((await m.service.disableTask(assistantId, 'inspection', m.signal)).installed[0]!.tasks[0]!.enabled).toBeNull()
  })
})

describe('schedule timing', () => {
  it('maps daily, weekly, and cron timings with the task\'s zone', () => {
    const base = { id: 't', title: 't', prompt: 'p', timeZone: 'Asia/Tokyo', connectors: [] }
    expect(scheduleTiming({ ...base, timing: { kind: 'daily', time: '09:30' } })).toEqual({ kind: 'daily', daily: { time: '09:30:00', time_zone: 'Asia/Tokyo' } })
    expect(scheduleTiming({ ...base, timing: { kind: 'cron', expression: '0 6 * * 1-5' } })).toEqual({ kind: 'cron', cron: { expression: '0 6 * * 1-5', time_zone: 'Asia/Tokyo' } })
  })
})

describe('reading a downloaded package', () => {
  const listed = (zip: Uint8Array, m = manifest()) => ({ id: 'p', name: m.name, version: m.version, sha256: sha256(zip), sizeBytes: zip.byteLength, manifest: m, updatedAt: '' })

  it('refuses a package too large, not a zip, with other files, bad JSON, an invalid manifest, or another version', () => {
    const good = zipOf(manifest())
    expect(() => readPackage(good, listed(good), 10)).toThrow('too large')
    const notZip = strToU8('not a zip')
    expect(() => readPackage(notZip, listed(notZip), 1e6)).toThrow('not a zip archive')
    const extra = zipSync({ ...Object.fromEntries(Object.entries(CORE).map(([k, v]) => [k, strToU8(v)])), 'agent.json': strToU8('{}'), 'x.sh': strToU8('') })
    expect(() => readPackage(extra, listed(extra), 1e6)).toThrow('must hold exactly')
    const badJson = zipSync({ ...Object.fromEntries(Object.entries(CORE).map(([k, v]) => [k, strToU8(v)])), 'agent.json': strToU8('{') })
    expect(() => readPackage(badJson, listed(badJson), 1e6)).toThrow('not JSON')
    const invalid = zipOf({ ...manifest(), name: 'Bad Name' })
    expect(() => readPackage(invalid, listed(invalid), 1e6)).toThrow('agent.json is invalid')
    const other = zipOf(manifest('9.9.9'))
    expect(() => readPackage(other, listed(other), 1e6)).toThrow('does not match the published version')
  })
})

describe('review fixes', () => {
  it('finds a Skill past the first page of matches, and reports a failed install as missing while the others install', async () => {
    const m = await mount()
    m.publish('pkg-1', manifest('1.0.0', { skills: ['roi-inspection-deep', 'roi-inspection'] }))
    m.market.installSkill.mockImplementation(async (id: string) => {
      if (id === 'skill-roi') throw new Error('local edits would be overwritten')
      return {}
    })
    const result = await m.service.installPackage('pkg-1', m.signal)
    expect(m.market.installSkill).toHaveBeenCalledWith('skill-deep', {}, m.signal)
    expect(result).toMatchObject({ installedSkills: ['roi-inspection-deep'], missingSkills: ['roi-inspection'] })
    expect(m.warn).toHaveBeenCalledWith(expect.stringContaining('Skill roi-inspection could not be installed'))
  })

  it('stops searching at an empty page even when the Hub\'s total says there are more', async () => {
    const m = await mount()
    m.publish('pkg-1', manifest('1.0.0', { skills: ['gone-skill'] }))
    m.market.list.mockResolvedValueOnce({ items: [], total: 999, page: 1, pageSize: 50 })
    expect((await m.service.installPackage('pkg-1', m.signal)).missingSkills).toEqual(['gone-skill'])
    expect(m.market.list).toHaveBeenCalledTimes(1)
  })

  it('reports every named Skill missing in a deployment without the Skill market', async () => {
    const m = await mount({ market: false })
    m.publish('pkg-1', manifest())
    expect((await m.service.installPackage('pkg-1', m.signal)).missingSkills).toEqual(['ai-inspection', 'roi-inspection', 'local-skill', 'gone-skill'])
  })

  it('rethrows an install interrupted by the caller', async () => {
    const m = await mount()
    m.publish('pkg-1', manifest())
    const controller = new AbortController()
    m.market.installSkill.mockImplementationOnce(async () => { controller.abort(); throw new Error('aborted') })
    await expect(m.service.installPackage('pkg-1', controller.signal)).rejects.toThrow('aborted')
  })

  it('switches off a task the new version no longer recommends', async () => {
    const m = await mount()
    m.publish('pkg-1', manifest())
    const { assistantId } = await m.service.installPackage('pkg-1', m.signal)
    await m.service.enableTask(assistantId, 'report', 'ws-1' as never, m.signal)
    await m.service.enableTask(assistantId, 'inspection', 'ws-1' as never, m.signal)
    m.publish('pkg-1', manifest('1.1.0', { tasks: [TASKS[0]] }))
    const { state } = await m.service.updatePackage(assistantId, m.signal)
    expect(m.schedule.delete).toHaveBeenCalledWith({ sessionId: 'session-schedule-1', id: 'schedule-1' })
    expect(state.installed[0]!.tasks.map(t => [t.id, t.enabled?.scheduleId])).toEqual([['inspection', 'schedule-2']])
  })

  it('switches off the tasks of a deleted assistant and drops its record', async () => {
    const m = await mount()
    m.publish('pkg-1', manifest())
    const { assistantId } = await m.service.installPackage('pkg-1', m.signal)
    await m.service.enableTask(assistantId, 'inspection', 'ws-1' as never, m.signal)
    m.assistants.delete(assistantId)
    await m.service.getState(m.signal)
    expect(m.schedule.delete).toHaveBeenCalledWith({ sessionId: 'session-schedule-1', id: 'schedule-1' })
    expect((await m.records()).installs).toEqual({})
  })

  it('leaves out a listed package it cannot read and keeps the others', async () => {
    const m = await mount()
    m.publish('pkg-1', manifest())
    const good = await (await m.request('/api/client/agent-packages')).json() as unknown[]
    m.setRaw(JSON.stringify([...good, { id: 'bad', name: 'Bad Name' }]))
    const state = await m.service.getState(m.signal)
    expect(state.packages!.map(p => p.id)).toEqual(['pkg-1'])
    expect(m.warn).toHaveBeenCalledWith(expect.stringContaining('a listed package cannot be read'))
  })

  it('reads a package list that is not a list as unavailable', async () => {
    const m = await mount()
    m.setRaw('{"oops":true}')
    expect(await m.service.getState(m.signal)).toMatchObject({ packages: null, unavailable: true })
    m.setRaw('not json')
    expect(await m.service.getState(m.signal)).toMatchObject({ packages: null, unavailable: true })
  })

  it('reads a download that breaks off as unavailable, not invalid', async () => {
    const m = await mount()
    m.publish('pkg-1', manifest())
    const broken = new ReadableStream({ start(controller) { controller.error(new TypeError('terminated')) } })
    m.request.mockImplementationOnce(m.request.getMockImplementation()!)
    m.setRaw(broken)
    const error = await refusal(m.service.installPackage('pkg-1', m.signal))
    expect(error.code).toBe('assistant-packages/unavailable')
  })

  it('rethrows a download the caller abandoned', async () => {
    const m = await mount()
    m.publish('pkg-1', manifest())
    const controller = new AbortController()
    const broken = new ReadableStream({ start(stream) { controller.abort(); stream.error(new TypeError('aborted')) } })
    m.request.mockImplementationOnce(m.request.getMockImplementation()!)
    m.setRaw(broken)
    await expect(m.service.installPackage('pkg-1', controller.signal)).rejects.toThrow('aborted')
  })
})

describe('manifest rules', () => {
  const listed = (zip: Uint8Array, m: AssistantPackageManifest) => ({ id: 'p', name: m.name, version: m.version, sha256: sha256(zip), sizeBytes: zip.byteLength, manifest: m, updatedAt: '' })
  const refused = (m: AssistantPackageManifest) => {
    const zip = zipOf(m)
    return () => readPackage(zip, listed(zip, m), 1e6)
  }
  it('refuses repeated or unordered weekdays, repeated task ids, and an unknown time zone', () => {
    expect(refused(manifest('1.0.0', { tasks: [{ ...TASKS[0], timing: { kind: 'weekly', weekdays: [1, 1, 3], time: '11:00' } }] }))).toThrow('ascending without repeats')
    expect(refused(manifest('1.0.0', { tasks: [{ ...TASKS[0], timing: { kind: 'weekly', weekdays: [3, 1], time: '11:00' } }] }))).toThrow('ascending without repeats')
    expect(refused(manifest('1.0.0', { tasks: [TASKS[0], { ...TASKS[1], id: 'inspection' }] }))).toThrow('task ids must be unique')
    expect(refused(manifest('1.0.0', { tasks: [{ ...TASKS[0], timeZone: 'Mars/Base' }] }))).toThrow('not an IANA time zone')
  })
})
