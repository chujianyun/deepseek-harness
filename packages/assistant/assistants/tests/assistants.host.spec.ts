import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { assembleContextFor, type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import KnowledgeSelectionService from '@deepseek-ai/dsh-knowledge-selection'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import AssistantsService, {
  ASSISTANT_SECTION, assistantProjectionDefinition, CORE_FILES_WITHDRAWN, ECOMMERCE_MANAGER, ECOMMERCE_SKILLS, renderInstructions,
  renderUser, withName,
} from '../src/index.ts'
import type { CreateAssistantInput } from '../src/types.ts'
import { hubStub } from '../../../connector/connectors/tests/support.ts'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

interface SetupOptions {
  tenant?: string | null
  home?: string
  before?: (ctx: Context) => Promise<void>
  config?: Record<string, number>
}

async function setup(options: SetupOptions = {}) {
  const home = options.home ?? await mkdtemp(join(tmpdir(), 'dsh-assistants-'))
  if (options.home === undefined) cleanups.push(() => rm(home, { recursive: true, force: true }))
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  const hub = hubStub(options.tenant === undefined ? 't-a' : options.tenant)
  ctx.provide('hubAccount', hub.service as never)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: 'Deployment persona.' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await options.before?.(ctx)
  await ctx.plugin(AssistantsService, { dshHome: home, ...options.config })
  const service = ctx.get('assistants')!
  const settle = async (predicate: (state: Awaited<ReturnType<typeof service.getState>>) => boolean) => {
    for (let i = 0; i < 200; i++) {
      const state = await service.getState()
      if (predicate(state)) return state
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    throw new Error('state never settled')
  }
  const agent = async (id: string): Promise<Agent> => (await ctx.agents.create({ sessionId: SessionId(id) })).agent
  const turnPrompt = async (target: Agent) => {
    const assembly = await ctx.systemPrompt.assemble(assembleContextFor(target, new AbortController().signal))
    return assembly.sections.find(section => section.name === ASSISTANT_SECTION)?.text ?? ''
  }
  const events = (target: Agent, type: string) => target.session.ownEvents().filter(event => event.type === type).map(event => event.data)
  return { ctx, home, hub, service, settle, agent, turnPrompt, events }
}

describe('assistants storage', () => {
  it('creates the Daily Assistant as the default the first time a tenant signs in, and only once', async () => {
    const first = await setup()
    const state = await first.settle(s => s.assistants.length === 1)
    expect(state).toMatchObject({ tenantId: 't-a', assistants: [{ name: '日常助手', templateId: 'daily', avatar: { kind: 'preset', key: 'sun' } }] })
    expect(state.defaultId).toBe(state.assistants[0]!.id)
    const dir = join(first.home, 'assistants', 't-a', state.defaultId!)
    expect((await readdir(dir)).sort()).toEqual(['AGENTS.md', 'IDENTITY.md', 'SOUL.md', 'USER.md', 'assistant.json'])
    expect(await readFile(join(dir, 'IDENTITY.md'), 'utf8')).toContain('日常助手')

    const again = await setup({ home: first.home })
    expect((await again.settle(s => s.tenantId === 't-a')).assistants.map(a => a.id)).toEqual([state.defaultId])
  })

  it('does not recreate the Daily Assistant after the user removed every assistant', async () => {
    const first = await setup()
    const state = await first.settle(s => s.assistants.length === 1)
    await rm(join(first.home, 'assistants', 't-a', state.defaultId!), { recursive: true })
    const again = await setup({ home: first.home })
    expect((await again.settle(s => s.tenantId === 't-a')).assistants).toEqual([])
  })

  it('keeps each tenant\'s assistants apart and shows none while signed out', async () => {
    const env = await setup()
    const a = await env.settle(s => s.assistants.length === 1)
    env.hub.set('t-b')
    const b = await env.settle(s => s.tenantId === 't-b' && s.assistants.length === 1)
    expect(b.assistants[0]!.id).not.toBe(a.assistants[0]!.id)
    env.hub.set(null)
    expect(await env.settle(s => s.tenantId === null)).toMatchObject({ defaultId: null, assistants: [] })
    env.hub.set('t-a')
    expect((await env.settle(s => s.tenantId === 't-a')).assistants.map(x => x.id)).toEqual([a.assistants[0]!.id])
  })

  it('tells which bound ids another tenant on this machine keeps, and nothing else about them', async () => {
    const env = await setup()
    const a = (await env.settle(s => s.assistants.length === 1)).assistants[0]!
    expect(await env.service.otherTenantAssistants([a.id])).toEqual([])
    env.hub.set('t-b')
    const b = (await env.settle(s => s.tenantId === 't-b' && s.assistants.length === 1)).assistants[0]!
    const root = join(env.home, 'assistants')
    // A hidden folder is no tenant, a folder without assistant.json holds no assistant, and an id is one path segment.
    await mkdir(join(root, '.backup', 'kept'), { recursive: true })
    await writeFile(join(root, '.backup', 'kept', 'assistant.json'), '{}')
    await mkdir(join(root, 't-a', 'half'))
    await writeFile(join(root, 'stray.txt'), '')
    const asked = [a.id, a.id, b.id, 'kept', 'half', 'gone', '..', '../t-a/' + a.id, `t-a/${a.id}`, '.hidden']
    expect(await env.service.otherTenantAssistants(asked)).toEqual([a.id])
    env.hub.set(null)
    await env.settle(s => s.tenantId === null)
    expect(await env.service.otherTenantAssistants([a.id, b.id])).toEqual([])
  })

  it('skips a malformed assistant.json and a directory without one', async () => {
    const first = await setup()
    await first.settle(s => s.assistants.length === 1)
    const tenantDir = join(first.home, 'assistants', 't-a')
    await writeFile(join(tenantDir, 'stray.txt'), '')
    await mkdir(join(tenantDir, 'half'))
    await mkdir(join(tenantDir, 'bad'))
    await writeFile(join(tenantDir, 'bad', 'assistant.json'), JSON.stringify({ version: 1, id: 'other' }))
    const again = await setup({ home: first.home })
    expect((await again.settle(s => s.tenantId === 't-a')).assistants).toHaveLength(1)
  })
})

describe('session binding', () => {
  it('binds a new main session to the default assistant and carries its core files from the first turn', async () => {
    const env = await setup()
    const state = await env.settle(s => s.assistants.length === 1)
    const agent = await env.agent('s1')
    expect(env.events(agent, 'assistant/selected')).toEqual([{ assistantId: state.defaultId }])
    const text = await env.turnPrompt(agent)
    expect(text).toContain('You are the assistant "日常助手"')
    expect(text).toContain('<core_file name="IDENTITY.md">')
    expect(env.events(agent, 'assistant/instructions')).toEqual([{ text }])
    const assembly = await env.ctx.systemPrompt.assemble(assembleContextFor(agent, new AbortController().signal))
    expect(assembly.sections.map(section => section.name).indexOf(ASSISTANT_SECTION))
      .toBeGreaterThan(assembly.sections.map(section => section.name).indexOf('deployment:persona-prefix'))
  })

  it('records the core files again only when they change, and the next turn carries the edit', async () => {
    const env = await setup()
    const state = await env.settle(s => s.assistants.length === 1)
    const agent = await env.agent('s1')
    await env.turnPrompt(agent)
    await env.turnPrompt(agent)
    expect(env.events(agent, 'assistant/instructions')).toHaveLength(1)
    await writeFile(join(env.home, 'assistants', 't-a', state.defaultId!, 'SOUL.md'), '# 人格\n\n说话像海盗。\n')
    expect(await env.turnPrompt(agent)).toContain('说话像海盗')
    expect(env.events(agent, 'assistant/instructions')).toHaveLength(2)
  })

  it('leaves a non-turn assembly without recording, using the last recorded text', async () => {
    const env = await setup()
    await env.settle(s => s.assistants.length === 1)
    const agent = await env.agent('s1')
    const assembly = await env.ctx.systemPrompt.assemble(assembleContextFor(agent))
    expect(assembly.sections.find(section => section.name === ASSISTANT_SECTION)?.text).toBe('')
    expect(env.events(agent, 'assistant/instructions')).toEqual([])
  })

  it('says the earlier core files no longer apply once the bound assistant is deleted, and records that once', async () => {
    const env = await setup()
    const state = await env.settle(s => s.assistants.length === 1)
    const agent = await env.agent('s1')
    expect(await env.turnPrompt(agent)).not.toBe('')
    await rm(join(env.home, 'assistants', 't-a', state.defaultId!), { recursive: true })
    env.hub.set('t-b')
    await env.settle(s => s.tenantId === 't-b')
    env.hub.set('t-a')
    await env.settle(s => s.tenantId === 't-a' && s.assistants.length === 0)
    expect(await env.turnPrompt(agent)).toBe(CORE_FILES_WITHDRAWN)
    expect(await env.turnPrompt(agent)).toBe(CORE_FILES_WITHDRAWN)
    const recorded = env.events(agent, 'assistant/instructions')
    expect(recorded).toHaveLength(2)
    expect(recorded[0]).toMatchObject({ text: expect.stringContaining('<core_file') as string })
    expect(recorded[1]).toEqual({ text: CORE_FILES_WITHDRAWN })
  })

  it('says the earlier core files no longer apply once the user empties every one of them', async () => {
    const env = await setup()
    const id = (await env.settle(s => s.assistants.length === 1)).defaultId!
    const agent = await env.agent('s1')
    expect(await env.turnPrompt(agent)).toContain('<core_file')
    await env.service.updateAssistant(id, { files: { 'IDENTITY.md': '', 'SOUL.md': ' ', 'USER.md': '', 'AGENTS.md': '' } })
    expect(await env.turnPrompt(agent)).toBe(CORE_FILES_WITHDRAWN)
    await env.service.updateAssistant(id, { files: { 'SOUL.md': '# 人格\n\n回来了。\n' } })
    expect(await env.turnPrompt(agent)).toContain('回来了。')
  })

  it('binds no assistant while signed out, and the prompt stays as before', async () => {
    const env = await setup({ tenant: null })
    await env.settle(s => s.tenantId === null)
    const agent = await env.agent('s1')
    expect(env.events(agent, 'assistant/selected')).toEqual([])
    expect(await env.turnPrompt(agent)).toBe('')
    await expect(env.service.select(agent, 'x')).rejects.toMatchObject({ code: 'hub-account/signed-out' })
  })

  it('lets a blank session pick an assistant, and refuses an unknown one', async () => {
    const env = await setup()
    await env.settle(s => s.assistants.length === 1)
    const agent = await env.agent('s1')
    const error = await env.service.select(agent, 'missing').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(RemoteError)
    expect(error).toMatchObject({ code: 'assistants/not-found' })
  })

  it('does not bind subagent sessions', async () => {
    const env = await setup()
    await env.settle(s => s.assistants.length === 1)
    const parent = await env.agent('parent')
    const child = (await env.ctx.agents.create({ sessionId: SessionId('child'), parentAgent: parent, meta: { parentSession: parent.session.id } })).agent
    expect(env.events(child, 'assistant/selected')).toEqual([])
  })
})

describe('assistants state stream and projection', () => {
  it('streams the state on every change until the reader stops', async () => {
    const env = await setup()
    await env.settle(s => s.assistants.length === 1)
    const stop = new AbortController()
    const iterator = env.service.watch(stop.signal)[Symbol.asyncIterator]()
    expect((await iterator.next()).value).toMatchObject({ tenantId: 't-a' })
    const next = iterator.next()
    env.hub.set('t-b')
    expect((await next).value).toMatchObject({ tenantId: 't-b' })
    const done = iterator.next()
    stop.abort()
    expect((await done).done).toBe(true)
  })

  it('ignores a sign-in update for the same tenant', async () => {
    const env = await setup()
    const before = await env.settle(s => s.assistants.length === 1)
    env.hub.set('t-a')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect((await env.service.getState()).revision).toBe(before.revision)
  })

  it('folds only its own events and exposes the bound id to the client', () => {
    const initial = assistantProjectionDefinition.init()
    const other = { type: 'turn/start', data: {} } as never
    expect(assistantProjectionDefinition.apply(initial, other)).toBe(initial)
    expect(assistantProjectionDefinition.wire.view({ assistantId: 'a', instructions: 'x' })).toBe('a')
  })

  it('lists assistants in creation order', async () => {
    const first = await setup()
    await first.settle(s => s.assistants.length === 1)
    const dir = join(first.home, 'assistants', 't-a', 'older')
    await mkdir(dir)
    await writeFile(join(dir, 'assistant.json'), JSON.stringify({ version: 1, id: 'older', name: '旧', description: '', avatar: { kind: 'preset', key: 'sun' }, createdAt: '2000-01-01T00:00:00Z' }))
    const again = await setup({ home: first.home })
    expect((await again.settle(s => s.tenantId === 't-a')).assistants[0]!.id).toBe('older')
  })
})

describe('session binding edge cases', () => {
  it('keeps a pick that reached the service before the default binding', async () => {
    const env = await setup()
    await env.settle(s => s.assistants.length === 1)
    const dir = join(env.home, 'assistants', 't-a', 'other')
    await mkdir(dir)
    await writeFile(join(dir, 'assistant.json'), JSON.stringify({ version: 1, id: 'other', name: '其他', description: '', avatar: { kind: 'preset', key: 'sun' }, createdAt: '2030-01-01T00:00:00Z' }))
    env.hub.set('t-b')
    await env.settle(s => s.tenantId === 't-b')
    env.hub.set('t-a')
    await env.settle(s => s.tenantId === 't-a' && s.assistants.length === 2)
    let picked: Promise<string> | undefined
    env.ctx.on('agent/created', ({ agent }) => { picked ??= env.service.select(agent, 'other') }, { prepend: true })
    const agent = await env.agent('raced')
    await picked
    expect(env.events(agent, 'assistant/selected')).toEqual([{ assistantId: 'other' }])
  })

  it('carries the core files for a session that existed before the service started', async () => {
    let early: Agent | undefined
    const env = await setup({ before: async (ctx) => {
      early = (await ctx.agents.create({ sessionId: SessionId('early') })).agent
      await ctx.agents.create({ sessionId: SessionId('early-child'), parentAgent: early, meta: { parentSession: early.session.id } })
    } })
    await env.settle(s => s.assistants.length === 1)
    expect(env.events(early!, 'assistant/selected')).toEqual([])
    const defaultId = (await env.service.getState()).defaultId!
    await env.service.select(early!, defaultId)
    await env.service.select(early!, defaultId)
    expect(env.events(early!, 'assistant/selected')).toEqual([{ assistantId: defaultId }])
    expect(await env.turnPrompt(early!)).toContain('日常助手')
  })

  it('refuses to change the assistant once the session started, and binds none to a started session', async () => {
    const env = await setup()
    const state = await env.settle(s => s.assistants.length === 1)
    const original = env.ctx.sessionProjections.stateOf.bind(env.ctx.sessionProjections) as (session: Agent['session'], key: string) => object | undefined
    const started = (session: Agent['session'], key: string): object | undefined => key === 'turnBoundary'
      ? { openTurnStartSeq: null, lastTurn: 1 }
      : original(session, key)
    vi.spyOn(env.ctx.sessionProjections, 'stateOf').mockImplementation(started)
    const agent = await env.agent('started')
    expect(env.events(agent, 'assistant/selected')).toEqual([])
    await expect(env.service.select(agent, state.defaultId!)).rejects.toMatchObject({ code: 'assistants/locked' })
  })

  it('switches the session to the assistant\'s preset before binding it', async () => {
    const select = vi.fn(async () => 'standard')
    const first = await setup()
    await first.settle(s => s.assistants.length === 1)
    const dir = join(first.home, 'assistants', 't-a', 'coder')
    await mkdir(dir)
    await writeFile(join(dir, 'assistant.json'), JSON.stringify({ version: 1, id: 'coder', name: '编程', description: '', avatar: { kind: 'preset', key: 'sun' }, preset: 'ptc', templateId: 'x', createdAt: '2030-01-01T00:00:00Z' }))
    const withPresets = await setup({ home: first.home, before: async (ctx) => { ctx.provide('agentPresets', { select } as never) } })
    const coder = (await withPresets.settle(s => s.assistants.length === 2)).assistants.find(item => item.id === 'coder')!
    expect(coder).toMatchObject({ preset: 'ptc', templateId: 'x' })
    const agent = await withPresets.agent('s1')
    await withPresets.service.select(agent, 'coder')
    expect(select).toHaveBeenCalledWith(agent, 'ptc')
    expect(withPresets.events(agent, 'assistant/selected').at(-1)).toEqual({ assistantId: 'coder' })
    const without = await setup({ home: first.home })
    await without.settle(s => s.assistants.length === 2)
    const plain = await without.agent('s2')
    await without.service.select(plain, 'coder')
    expect(without.events(plain, 'assistant/selected').at(-1)).toEqual({ assistantId: 'coder' })
  })

  it('leaves out a core file deleted on disk', async () => {
    const env = await setup()
    const state = await env.settle(s => s.assistants.length === 1)
    const agent = await env.agent('s1')
    await rm(join(env.home, 'assistants', 't-a', state.defaultId!, 'SOUL.md'))
    const text = await env.turnPrompt(agent)
    expect(text).toContain('IDENTITY.md')
    expect(text).not.toContain('SOUL.md')
  })

  it('fails the turn when a core file cannot be read', async () => {
    const env = await setup()
    const state = await env.settle(s => s.assistants.length === 1)
    const agent = await env.agent('s1')
    const file = join(env.home, 'assistants', 't-a', state.defaultId!, 'SOUL.md')
    await rm(file)
    await mkdir(file)
    await expect(env.turnPrompt(agent)).rejects.toMatchObject({ code: 'EISDIR' })
  })
})

const USER = { name: '小明', language: '中文', notes: '杭州\n运营', background: '在名流做天猫店运营。' }
const input = (over: Partial<CreateAssistantInput> = {}): CreateAssistantInput => ({
  templateId: 'ecommerce', name: '我的管家', description: '店铺助手', avatar: { kind: 'preset', key: 'ocean' }, user: USER, ...over,
})
const PNG = 'data:image/png;base64,iVBORw0KGgo='

describe('creating assistants', () => {
  it('creates one from a template with its name, user information, model, and preset', async () => {
    const env = await setup({ before: async (ctx) => { ctx.provide('agentPresets', { resolve: async (id: string) => ({ id }), select: vi.fn() } as never) } })
    await env.settle(s => s.assistants.length === 1)
    const model = { provider: 'acme', model: 'chat', reasoningEffort: 'high' }
    const { assistantId, state } = await env.service.createAssistant(input({ name: ' 我的管家 ', model, preset: 'standard', avatar: { kind: 'image', dataUrl: PNG } }))
    expect(state.assistants.at(-1)).toMatchObject({ id: assistantId, name: '我的管家', templateId: 'ecommerce', model, preset: 'standard', avatar: { kind: 'image', dataUrl: PNG } })
    const dir = join(env.home, 'assistants', 't-a', assistantId)
    expect(await readFile(join(dir, 'IDENTITY.md'), 'utf8')).toContain('- **名称**：我的管家')
    expect(await readFile(join(dir, 'AGENTS.md'), 'utf8')).toBe(ECOMMERCE_MANAGER.files['AGENTS.md'])
    expect(await readFile(join(dir, 'USER.md'), 'utf8')).toContain('- **称呼**：小明')
    const again = await setup({ home: env.home })
    expect((await again.settle(s => s.assistants.length === 2)).assistants[1]).toMatchObject({ model, preset: 'standard' })
    expect(state.templates.map(t => t.id)).toEqual(['daily', 'ecommerce'])
  })

  it('creates a blank one whose user information reaches the prompt', async () => {
    const env = await setup()
    await env.settle(s => s.assistants.length === 1)
    const { assistantId } = await env.service.createAssistant(input({ templateId: null, name: '空白' }))
    const dir = join(env.home, 'assistants', 't-a', assistantId)
    expect(await readFile(join(dir, 'SOUL.md'), 'utf8')).toBe('# 人格\n\n')
    expect((await env.service.getState()).assistants.at(-1)).not.toHaveProperty('templateId')
    const agent = await env.agent('s1')
    await env.service.select(agent, assistantId)
    const text = await env.turnPrompt(agent)
    expect(text).toContain('- **称呼**：小明')
    expect(text).toContain('在名流做天猫店运营。')
  })

  it('refuses bad input', async () => {
    const env = await setup({ config: { maxNameLength: 4, maxDescriptionLength: 3, maxAvatarLength: 40 } })
    await env.settle(s => s.assistants.length === 1)
    const code = (promise: Promise<unknown>) => promise.then(() => 'ok', (e: unknown) => (e as { code: string }).code)
    expect(await code(env.service.createAssistant(input({ templateId: 'nope' })))).toBe('assistants/template-not-found')
    expect(await code(env.service.createAssistant(input({ name: '  ' })))).toBe('assistants/invalid-name')
    expect(await code(env.service.createAssistant(input({ name: '一二三四五' })))).toBe('assistants/invalid-name')
    expect(await code(env.service.createAssistant(input({ name: '名', description: '一二三四' })))).toBe('assistants/invalid-description')
    expect(await code(env.service.createAssistant(input({ name: '名', description: '', avatar: { kind: 'image', dataUrl: 'data:image/gif;base64,R0lG' } })))).toBe('assistants/invalid-avatar')
    expect(await code(env.service.createAssistant(input({ name: '名', description: '', avatar: { kind: 'image', dataUrl: `data:image/png;base64,${'A'.repeat(40)}` } })))).toBe('assistants/invalid-avatar')
    expect(await code(env.service.createAssistant(input({ name: '名', description: '', preset: 'gone' })))).toBe('ok')
    env.hub.set(null)
    await env.settle(s => s.tenantId === null)
    expect(await code(env.service.createAssistant(input({ name: '名', description: '' })))).toBe('hub-account/signed-out')
  })

  it('refuses a preset the deployment no longer composes', async () => {
    const env = await setup({ before: async (ctx) => { ctx.provide('agentPresets', { resolve: async () => { throw new Error('Unknown agent preset') } } as never) } })
    await env.settle(s => s.assistants.length === 1)
    await expect(env.service.createAssistant(input({ preset: 'gone' }))).rejects.toMatchObject({ code: 'assistants/preset-unavailable' })
  })
})

describe('binding an assistant\'s model and preset', () => {
  it('installs the assistant\'s model and preset, and keeps the defaults when either is gone', async () => {
    const useModel = vi.fn(async (_agent: Agent, selection: { model: string }) => selection.model !== 'removed')
    const select = vi.fn(async (_agent: Agent, preset: string) => {
      if (preset === 'gone') throw new Error('Unknown agent preset')
      return preset
    })
    const env = await setup({ before: async (ctx) => {
      ctx.provide('sessionController', { useModel } as never)
      ctx.provide('agentPresets', { resolve: async (id: string) => ({ id }), select } as never)
    } })
    await env.settle(s => s.assistants.length === 1)
    const model = { provider: 'acme', model: 'chat' }
    const { assistantId } = await env.service.createAssistant(input({ model, preset: 'ptc' }))
    const agent = await env.agent('s1')
    await env.service.select(agent, assistantId)
    expect(useModel).toHaveBeenCalledWith(agent, model)
    expect(select).toHaveBeenCalledWith(agent, 'ptc')
    // Settings removed the model and the deployment the preset: binding still succeeds on the defaults.
    const dir = join(env.home, 'assistants', 't-a', assistantId)
    const stored = JSON.parse(await readFile(join(dir, 'assistant.json'), 'utf8')) as Record<string, unknown>
    await writeFile(join(dir, 'assistant.json'), JSON.stringify({ ...stored, model: { provider: 'acme', model: 'removed' }, preset: 'gone' }))
    env.hub.set('t-b')
    await env.settle(s => s.tenantId === 't-b')
    env.hub.set('t-a')
    await env.settle(s => s.tenantId === 't-a' && s.assistants.length === 2)
    const second = await env.agent('s2')
    await env.service.select(second, assistantId)
    expect(useModel).toHaveLastReturnedWith(Promise.resolve(false))
    expect(env.events(second, 'assistant/selected').at(-1)).toEqual({ assistantId })
  })
})

describe('switching assistants in a blank session', () => {
  it('returns to the default preset and the global model after an assistant that set them, and leaves them otherwise', async () => {
    const useModel = vi.fn(async () => true)
    const select = vi.fn(async (_agent: Agent, preset: string) => preset)
    const env = await setup({ before: async (ctx) => {
      ctx.provide('sessionController', { useModel } as never)
      ctx.provide('agentPresets', { resolve: async (id: string) => ({ id }), select, defaultId: 'standard' } as never)
      ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'deepseek', model: 'chat' }) } as never)
    } })
    const state = await env.settle(s => s.assistants.length === 1)
    const plain = state.defaultId!
    const { assistantId: tuned } = await env.service.createAssistant(input({ model: { provider: 'acme', model: 'pro' }, preset: 'ptc' }))
    const agent = await env.agent('s1')
    expect(useModel).not.toHaveBeenCalled()
    await env.service.select(agent, tuned)
    expect(useModel).toHaveBeenLastCalledWith(agent, { provider: 'acme', model: 'pro' })
    expect(select).toHaveBeenLastCalledWith(agent, 'ptc')
    await env.service.select(agent, plain)
    expect(useModel).toHaveBeenLastCalledWith(agent, { provider: 'deepseek', model: 'chat' })
    expect(select).toHaveBeenLastCalledWith(agent, 'standard')
    const { assistantId: other } = await env.service.createAssistant(input({ name: '另一个' }))
    useModel.mockClear()
    select.mockClear()
    await env.service.select(agent, other)
    expect(useModel).not.toHaveBeenCalled()
    expect(select).not.toHaveBeenCalled()
  })
})

describe('core file helpers', () => {
  it('puts the name into the identity line, and renders user information on one line each', () => {
    expect(withName('# 身份\n\n- **名称**：旧\n- **定位**：x\n', '新')).toBe('# 身份\n\n- **名称**：新\n- **定位**：x\n')
    expect(withName('# 身份\n', '新')).toBe('# 身份\n')
    expect(renderUser({ name: ' 小明 ', language: '', notes: 'a\n b', background: ' ' })).toBe('# 用户信息\n\n- **称呼**：小明\n- **偏好语言**：\n- **备注**：a b\n\n## 背景\n')
  })
})

describe('renderInstructions', () => {
  it('skips blank files and returns empty text when every file is blank', () => {
    expect(renderInstructions('A', [['IDENTITY.md', ' \n'], ['SOUL.md', '']])).toBe('')
    expect(renderInstructions('A', [['IDENTITY.md', 'x'], ['SOUL.md', '']])).toBe('You are the assistant "A". The user wrote the core files below to define your identity, personality, what you know about them, and how you work. They replace any earlier version in this conversation; follow them.\n\n<core_file name="IDENTITY.md">\nx\n</core_file>')
  })
})

describe('managing assistants', () => {
  const code = (promise: Promise<unknown>) => promise.then(() => 'ok', (e: unknown) => (e as { code: string }).code)

  it('reads an assistant with its core files, and refuses an unknown one', async () => {
    const env = await setup()
    const state = await env.settle(s => s.assistants.length === 1)
    const detail = await env.service.getAssistant(state.defaultId!)
    expect(detail.assistant).toEqual(state.assistants[0])
    expect(detail.files['SOUL.md']).toContain('# 人格')
    await rm(join(env.home, 'assistants', 't-a', state.defaultId!, 'USER.md'))
    expect((await env.service.getAssistant(state.defaultId!)).files['USER.md']).toBe('')
    expect(await code(env.service.getAssistant('missing'))).toBe('assistants/not-found')
  })

  it('saves edits that the next turn of a running session carries, and renames the identity line', async () => {
    const env = await setup()
    const id = (await env.settle(s => s.assistants.length === 1)).defaultId!
    const agent = await env.agent('s1')
    expect(await env.turnPrompt(agent)).toContain('"日常助手"')
    const files = { 'SOUL.md': '# 人格\n\n说话像海盗。\n', 'evil.md': 'x' } as never
    const state = await env.service.updateAssistant(id, {
      name: ' 海盗 ', description: '新描述', avatar: { kind: 'image', dataUrl: PNG }, model: { provider: 'acme', model: 'chat' }, preset: 'ptc', files,
    })
    expect(state.assistants[0]).toMatchObject({ name: '海盗', description: '新描述', avatar: { kind: 'image', dataUrl: PNG }, model: { provider: 'acme', model: 'chat' }, preset: 'ptc' })
    const text = await env.turnPrompt(agent)
    expect(text).toContain('You are the assistant "海盗"')
    expect(text).toContain('说话像海盗')
    expect(text).toContain('- **名称**：海盗')
    const dir = join(env.home, 'assistants', 't-a', id)
    expect(await readdir(dir)).not.toContain('evil.md')
    const again = await setup({ home: env.home })
    expect((await again.settle(s => s.assistants.length === 1)).assistants[0]).toMatchObject({ name: '海盗', preset: 'ptc' })
    const cleared = await again.service.updateAssistant(id, { model: null, preset: null })
    expect(cleared.assistants[0]).not.toHaveProperty('model')
    expect(cleared.assistants[0]).not.toHaveProperty('preset')
    expect(cleared.assistants[0]).toMatchObject({ name: '海盗', description: '新描述' })
  })

  it('keeps the identity file when only other fields change, and writes the name into an edited one', async () => {
    const env = await setup()
    const id = (await env.settle(s => s.assistants.length === 1)).defaultId!
    const dir = join(env.home, 'assistants', 't-a', id)
    await env.service.updateAssistant(id, { files: { 'IDENTITY.md': '# 身份\n\n- **名称**：随便\n' } })
    expect(await readFile(join(dir, 'IDENTITY.md'), 'utf8')).toBe('# 身份\n\n- **名称**：随便\n')
    await env.service.updateAssistant(id, { name: '新名', files: { 'IDENTITY.md': '# 身份\n\n- **名称**：旧名\n' } })
    expect(await readFile(join(dir, 'IDENTITY.md'), 'utf8')).toBe('# 身份\n\n- **名称**：新名\n')
    await rm(join(dir, 'IDENTITY.md'))
    await env.service.updateAssistant(id, { name: '再改' })
    expect(await readFile(join(dir, 'IDENTITY.md'), 'utf8')).toBe('')
  })

  it('refuses bad edits and leaves the assistant as it was', async () => {
    const env = await setup({ config: { maxNameLength: 4, maxDescriptionLength: 3, maxCoreFileLength: 5 } })
    const id = (await env.settle(s => s.assistants.length === 1)).defaultId!
    expect(await code(env.service.updateAssistant('missing', {}))).toBe('assistants/not-found')
    expect(await code(env.service.updateAssistant(id, { name: '' }))).toBe('assistants/invalid-name')
    expect(await code(env.service.updateAssistant(id, { description: '一二三四' }))).toBe('assistants/invalid-description')
    expect(await code(env.service.updateAssistant(id, { avatar: { kind: 'image', dataUrl: 'data:image/gif;base64,R0lG' } }))).toBe('assistants/invalid-avatar')
    expect(await code(env.service.updateAssistant(id, { files: { 'AGENTS.md': '一二三四五六' } }))).toBe('assistants/invalid-file')
    expect(await code(env.service.updateAssistant(id, { files: { 'AGENTS.md': '一二三四五' } }))).toBe('ok')
    expect((await env.service.getState()).assistants[0]!.name).toBe('日常助手')
  })

  it('refuses a preset the deployment no longer composes', async () => {
    const env = await setup({ before: async (ctx) => { ctx.provide('agentPresets', { resolve: async () => { throw new Error('Unknown agent preset') } } as never) } })
    const id = (await env.settle(s => s.assistants.length === 1)).defaultId!
    expect(await code(env.service.updateAssistant(id, { preset: 'gone' }))).toBe('assistants/preset-unavailable')
  })

  it('applies a changed model and preset to a blank session bound to the assistant, and leaves started ones', async () => {
    const useModel = vi.fn(async () => true)
    const select = vi.fn(async (_agent: Agent, preset: string) => preset)
    const env = await setup({ before: async (ctx) => {
      ctx.provide('sessionController', { useModel } as never)
      ctx.provide('agentPresets', { resolve: async (id: string) => ({ id }), select, defaultId: 'standard' } as never)
      ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'deepseek', model: 'chat' }) } as never)
    } })
    const id = (await env.settle(s => s.assistants.length === 1)).defaultId!
    const blank = await env.agent('blank')
    await env.service.updateAssistant(id, { model: { provider: 'acme', model: 'pro' }, preset: 'ptc' })
    expect(useModel).toHaveBeenLastCalledWith(blank, { provider: 'acme', model: 'pro' })
    expect(select).toHaveBeenLastCalledWith(blank, 'ptc')
    expect(env.events(blank, 'assistant/selected')).toHaveLength(1)
    useModel.mockClear()
    await env.service.updateAssistant(id, { description: '只改描述' })
    expect(useModel).not.toHaveBeenCalled()
    await env.service.updateAssistant(id, { model: null, preset: null })
    expect(useModel).toHaveBeenLastCalledWith(blank, { provider: 'deepseek', model: 'chat' })
    expect(select).toHaveBeenLastCalledWith(blank, 'standard')
  })

  it('makes another assistant the default, which new and blank sessions then bind', async () => {
    const env = await setup()
    const first = (await env.settle(s => s.assistants.length === 1)).defaultId!
    const { assistantId: second } = await env.service.createAssistant(input())
    const blank = await env.agent('blank')
    const picked = await env.agent('picked')
    await env.service.select(picked, second)
    expect((await env.service.setDefault(second)).defaultId).toBe(second)
    expect(env.events(blank, 'assistant/selected').at(-1)).toEqual({ assistantId: second })
    expect(env.events(picked, 'assistant/selected')).toHaveLength(2)
    expect(env.events(await env.agent('fresh'), 'assistant/selected')).toEqual([{ assistantId: second }])
    await env.service.setDefault(second)
    expect(env.events(blank, 'assistant/selected')).toHaveLength(2)
    const again = await setup({ home: env.home })
    expect((await again.settle(s => s.assistants.length === 2)).defaultId).toBe(second)
    expect(await code(env.service.setDefault('missing'))).toBe('assistants/not-found')
    expect(first).not.toBe(second)
  })

  it('duplicates the configuration and core files under a copy name, without the sessions', async () => {
    const env = await setup({ config: { maxNameLength: 6 } })
    await env.settle(s => s.assistants.length === 1)
    const model = { provider: 'acme', model: 'chat' }
    const { assistantId: source } = await env.service.createAssistant(input({ name: '店铺管家甲', model, preset: 'ptc' }))
    await env.service.updateAssistant(source, { files: { 'SOUL.md': '# 人格\n\n严谨。\n' } })
    const bound = await env.agent('s1')
    await env.service.select(bound, source)
    const { assistantId, state } = await env.service.duplicateAssistant(source)
    expect(state.assistants.at(-1)).toMatchObject({ id: assistantId, name: '店铺管 副本', description: '店铺助手', model, preset: 'ptc', templateId: 'ecommerce' })
    const copy = await env.service.getAssistant(assistantId)
    const original = await env.service.getAssistant(source)
    expect(copy.files['SOUL.md']).toBe(original.files['SOUL.md'])
    expect(copy.files['AGENTS.md']).toBe(original.files['AGENTS.md'])
    expect(copy.files['IDENTITY.md']).toContain('- **名称**：店铺管 副本')
    expect(env.events(bound, 'assistant/selected')).toEqual([{ assistantId: state.defaultId }, { assistantId: source }])
    expect(await code(env.service.duplicateAssistant('missing'))).toBe('assistants/not-found')
  })

  it('deletes an assistant: its sessions continue without its core files and the default moves on', async () => {
    const env = await setup()
    const first = (await env.settle(s => s.assistants.length === 1)).defaultId!
    const { assistantId: second } = await env.service.createAssistant(input())
    const original = env.ctx.sessionProjections.stateOf.bind(env.ctx.sessionProjections) as (session: Agent['session'], key: string) => object | undefined
    const started = await env.agent('started')
    vi.spyOn(env.ctx.sessionProjections, 'stateOf').mockImplementation((session: Agent['session'], key: string): object | undefined => (
      key === 'turnBoundary' && session === started.session ? { openTurnStartSeq: null, lastTurn: 1 } : original(session, key)))
    expect(await env.turnPrompt(started)).not.toBe('')
    const state = await env.service.deleteAssistant(first)
    expect(state).toMatchObject({ defaultId: second, assistants: [{ id: second }] })
    expect(await readdir(join(env.home, 'assistants', 't-a'))).not.toContain(first)
    expect(await env.turnPrompt(started)).toBe(CORE_FILES_WITHDRAWN)
    expect(env.events(started, 'assistant/selected')).toEqual([{ assistantId: first }])
    const again = await setup({ home: env.home })
    expect((await again.settle(s => s.assistants.length === 1)).defaultId).toBe(second)
    expect(await code(env.service.deleteAssistant(first))).toBe('assistants/not-found')
  })

  it('moves blank sessions of a deleted assistant to the default, and after the last one new sessions bind none', async () => {
    const useModel = vi.fn(async () => true)
    const env = await setup({ before: async (ctx) => {
      ctx.provide('sessionController', { useModel } as never)
      ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'deepseek', model: 'chat' }) } as never)
    } })
    const first = (await env.settle(s => s.assistants.length === 1)).defaultId!
    const { assistantId: tuned } = await env.service.createAssistant(input({ model: { provider: 'acme', model: 'pro' } }))
    const blank = await env.agent('blank')
    await env.service.select(blank, tuned)
    expect((await env.service.deleteAssistant(tuned)).defaultId).toBe(first)
    expect(env.events(blank, 'assistant/selected').at(-1)).toEqual({ assistantId: first })
    expect(useModel).toHaveBeenLastCalledWith(blank, { provider: 'deepseek', model: 'chat' })
    expect((await env.service.deleteAssistant(first)).defaultId).toBeNull()
    expect(await env.turnPrompt(blank)).toBe('')
    const fresh = await env.agent('fresh')
    expect(env.events(fresh, 'assistant/selected')).toEqual([])
    expect(await env.turnPrompt(fresh)).toBe('')
    const again = await setup({ home: env.home })
    expect(await again.settle(s => s.tenantId === 't-a')).toMatchObject({ defaultId: null, assistants: [] })
  })

  it('deletes an assistant whose files were already removed on disk', async () => {
    const env = await setup()
    const id = (await env.settle(s => s.assistants.length === 1)).defaultId!
    await rm(join(env.home, 'assistants', 't-a', id), { recursive: true })
    expect((await env.service.deleteAssistant(id)).assistants).toEqual([])
  })

  it('refuses every change while signed out', async () => {
    const env = await setup({ tenant: null })
    await env.settle(s => s.tenantId === null)
    expect(await code(env.service.getAssistant('x'))).toBe('hub-account/signed-out')
    expect(await code(env.service.deleteAssistant('x'))).toBe('hub-account/signed-out')
  })
})

const memorySkill = (name: string, source = 'memory', modelInvocable = true) => ({
  name, description: `${name} 说明`, invocation: { modelInvocable, userInvocable: true }, provider: 'memory', source, rank: 10, locator: name,
})
const withSkills = (...skills: ReturnType<typeof memorySkill>[]) => async (ctx: Context) => {
  await ctx.plugin(SkillRegistry)
  ctx.skills.registerProvider(() => ({
    name: 'memory', list: async () => skills, get: async (candidate: { name: string }) => ({ ...skills.find(skill => skill.name === candidate.name)!, content: 'body' }),
  }))
}

describe('capability subsets', () => {
  it('stores subsets from the input or the template, without empty or repeated ids, and edits and copies them', async () => {
    const env = await setup()
    await env.settle(s => s.assistants.length === 1)
    // The e-commerce manager starts with the e-commerce Skills, publishing among them, the office document Skills, and Feishu.
    const shopSubsets = { skills: [...ECOMMERCE_SKILLS, 'office-docx', 'office-pptx', 'office-xlsx'], connectors: ['feishu'] }
    expect((await env.service.getState()).templates.find(t => t.id === 'ecommerce')!.subsets).toEqual(shopSubsets)
    expect(ECOMMERCE_SKILLS).toEqual(expect.arrayContaining(['tmall-publish', 'pdd-publish', 'doudian-publish', 'ecommerce-multi-publish', 'ecommerce-product-draft']))
    const { assistantId: shop } = await env.service.createAssistant(input())
    const { assistantId: chosen } = await env.service.createAssistant(input({ subsets: { skills: ['a', 'a', ''], knowledgeBases: [] } }))
    const { assistantId: blank } = await env.service.createAssistant(input({ templateId: null, name: '空白' }))
    let state = await env.service.getState()
    const view = (id: string) => state.assistants.find(item => item.id === id)!
    expect(view(shop).subsets).toEqual(shopSubsets)
    expect(view(chosen).subsets).toEqual({ skills: ['a'], knowledgeBases: [] })
    expect(view(blank)).not.toHaveProperty('subsets')
    const again = await setup({ home: env.home })
    expect((await again.settle(s => s.assistants.length === 4)).assistants.find(item => item.id === chosen)!.subsets).toEqual({ skills: ['a'], knowledgeBases: [] })
    state = await env.service.updateAssistant(shop, { subsets: { skills: ['b'] } })
    expect(view(shop).subsets).toEqual({ skills: ['b'] })
    state = await env.service.updateAssistant(shop, { description: '只改描述' })
    expect(view(shop).subsets).toEqual({ skills: ['b'] })
    state = (await env.service.duplicateAssistant(shop)).state
    expect(state.assistants.at(-1)!.subsets).toEqual({ skills: ['b'] })
    state = await env.service.updateAssistant(shop, { subsets: {} })
    expect(view(shop)).not.toHaveProperty('subsets')
  })

  it('shows a session only the Skills its assistant allows, leaves connector Skills to the connector subset, and limits subagents too', async () => {
    const env = await setup({ before: withSkills(memorySkill('alpha'), memorySkill('beta'), memorySkill('lark-im', 'connector-feishu')) })
    const daily = (await env.settle(s => s.assistants.length === 1)).defaultId!
    // A Skill DSH registers at runtime reaches every session, like an account-wide Skill.
    env.ctx.skills.register({ name: 'ecommerce-accounts', description: 'shop data', source: 'ecommerce-accounts', content: 'body' })
    const { assistantId: narrow } = await env.service.createAssistant(input({ subsets: { skills: ['alpha'] } }))
    const names = async (scope: object) => (await env.ctx.skills.list({ scope })).map(skill => skill.name)
    const free = await env.agent('free')
    expect(await names(free)).toEqual(['alpha', 'beta', 'ecommerce-accounts', 'lark-im'])
    const agent = await env.agent('narrow')
    await env.service.select(agent, narrow)
    expect(await names(agent)).toEqual(['alpha', 'ecommerce-accounts', 'lark-im'])
    expect(await env.ctx.skills.get('beta', { scope: agent })).toBeUndefined()
    const child = (await env.ctx.agents.create({ sessionId: SessionId('narrow-child'), parentAgent: agent, meta: { parentSession: agent.session.id } })).agent
    expect(await names(child)).toEqual(['alpha', 'ecommerce-accounts', 'lark-im'])
    const orphan = (await env.ctx.agents.create({ sessionId: SessionId('orphan'), meta: { parentSession: SessionId('gone') } })).agent
    expect(await names(orphan)).toEqual(['alpha', 'beta', 'ecommerce-accounts', 'lark-im'])
    expect(await names({})).toEqual(['alpha', 'beta', 'ecommerce-accounts', 'lark-im'])
    // Editing the subset reaches the session's next read; deleting the assistant lifts it.
    await env.service.updateAssistant(narrow, { subsets: { skills: [] } })
    expect(await names(agent)).toEqual(['ecommerce-accounts', 'lark-im'])
    await env.service.select(free, daily)
    await env.service.deleteAssistant(narrow)
    expect(await names(agent)).toEqual(['alpha', 'beta', 'ecommerce-accounts', 'lark-im'])
  })

  it('limits the connectors and knowledge bases of a session through their services', async () => {
    let connectorFilter: ((agent: Agent, id: string) => boolean) | undefined
    let knowledgeFilter: ((agent: Agent, id: string) => boolean) | undefined
    const env = await setup({ before: async (ctx) => {
      ctx.provide('connectors', { restrict: (filter: typeof connectorFilter) => { connectorFilter = filter; return () => { connectorFilter = undefined } } } as never)
      ctx.provide('knowledgeSelection', { restrict: (filter: typeof knowledgeFilter) => { knowledgeFilter = filter; return () => { knowledgeFilter = undefined } } } as never)
    } })
    await env.settle(s => s.assistants.length === 1)
    const { assistantId } = await env.service.createAssistant(input({ subsets: { connectors: ['feishu'], knowledgeBases: ['kb1'] } }))
    const agent = await env.agent('s1')
    await env.service.select(agent, assistantId)
    expect(connectorFilter!(agent, 'feishu')).toBe(true)
    expect(connectorFilter!(agent, 'dingtalk')).toBe(false)
    expect(knowledgeFilter!(agent, 'kb1')).toBe(true)
    expect(knowledgeFilter!(agent, 'kb2')).toBe(false)
    const free = await env.agent('free')
    expect(connectorFilter!(free, 'dingtalk')).toBe(true)
    await env.ctx.fiber.dispose()
    expect(connectorFilter).toBeUndefined()
    expect(knowledgeFilter).toBeUndefined()
  })

  it('offers the Skills, connectors, and knowledge bases available now, and none from a service not composed', async () => {
    let released = 0
    const env = await setup({ before: async (ctx) => {
      await withSkills(memorySkill('alpha'), memorySkill('hidden', 'memory', false), memorySkill('lark-im', 'connector-feishu'))(ctx)
      ctx.provide('connectors', {
        restrict: () => () => {},
        getState: async () => ({ connectors: [
          { id: 'feishu', status: 'connected', enabled: true }, { id: 'dingtalk', status: 'not-installed', enabled: true },
        ] }),
      } as never)
      ctx.provide('knowledgeBases', { getState: async () => ({ bases: [{ id: 'kb1', name: '公司制度' }] }) } as never)
      ctx.provide('agentPresets', { acquireScope: async () => ({ key: {}, [Symbol.asyncDispose]: async () => { released += 1 } }) } as never)
    } })
    await env.settle(s => s.assistants.length === 1)
    // DSH's own runtime Skills reach every session, so subsets never offer them.
    env.ctx.skills.register({ name: 'ecommerce-accounts', description: 'shop data', source: 'ecommerce-accounts', content: 'body' })
    expect(await env.service.capabilityOptions()).toEqual({
      skills: [{ id: 'alpha', name: 'alpha', description: 'alpha 说明' }],
      connectors: [{ id: 'feishu', name: 'feishu' }],
      knowledgeBases: [{ id: 'kb1', name: '公司制度' }],
    })
    expect(released).toBe(1)
    const bare = await setup()
    await bare.settle(s => s.assistants.length === 1)
    expect(await bare.service.capabilityOptions()).toEqual({ skills: [], connectors: [], knowledgeBases: [] })
    const presetless = await setup({ before: withSkills(memorySkill('alpha')) })
    await presetless.settle(s => s.assistants.length === 1)
    expect((await presetless.service.capabilityOptions()).skills.map(skill => skill.id)).toEqual(['alpha'])
  })
})

describe('knowledge preselection', () => {
  const base = (id: string) => ({ id, name: `知识库 ${id}`, status: 'ready', settings: { documentCount: 5 } })
  const withKnowledge = (ids: string[]) => async (ctx: Context): Promise<void> => {
    ctx.provide('knowledgeBases', { getState: async () => ({ tenantId: 't-a', bases: ids.map(base) }) } as never)
    await ctx.plugin(KnowledgeSelectionService)
  }
  const selected = (env: Awaited<ReturnType<typeof setup>>, agent: Agent) =>
    env.ctx.sessionProjections.stateOf(agent.session, 'knowledgeSelection')?.bases.map(item => item.id)

  it('selects the existing knowledge bases an assistant allows when a blank session binds it, and logs them', async () => {
    const env = await setup({ before: withKnowledge(['kb1', 'kb2', 'kb3']) })
    await env.settle(s => s.assistants.length === 1)
    const { assistantId } = await env.service.createAssistant(input({ subsets: { knowledgeBases: ['kb3', 'deleted', 'kb1'] } }))
    await env.service.setDefault(assistantId)
    const fresh = await env.agent('fresh')
    expect(env.events(fresh, 'knowledge/selection')).toEqual([{ bases: [{ id: 'kb1', name: '知识库 kb1' }, { id: 'kb3', name: '知识库 kb3' }] }])
    expect(await env.ctx.knowledgeSelection.allowedBases(fresh.id)).toEqual(['kb1', 'kb3'])
  })

  it('replaces only its own preselection on switching assistants, and keeps a selection the user changed', async () => {
    const ids = ['kb1', 'kb2']
    const env = await setup({ before: async (ctx) => {
      ctx.provide('knowledgeBases', { getState: async () => ({ tenantId: 't-a', bases: ids.map(base) }) } as never)
      await ctx.plugin(KnowledgeSelectionService)
    } })
    const global = (await env.settle(s => s.assistants.length === 1)).defaultId!
    const { assistantId: only } = await env.service.createAssistant(input({ subsets: { knowledgeBases: ['kb1', 'kb2'] } }))
    const { assistantId: other } = await env.service.createAssistant(input({ name: '另一个', subsets: { knowledgeBases: ['kb2'] } }))
    const { assistantId: plain } = await env.service.createAssistant(input({ name: '第三个' }))
    const untouched = await env.agent('untouched')
    expect(selected(env, untouched)).toEqual([])
    await env.service.select(untouched, only)
    expect(selected(env, untouched)).toEqual(['kb1', 'kb2'])
    await env.service.select(untouched, other)
    expect(selected(env, untouched)).toEqual(['kb2'])
    await env.service.select(untouched, global)
    expect(selected(env, untouched)).toEqual([])
    // A knowledge base deleted after the preselection does not make it look changed.
    await env.service.select(untouched, only)
    ids.pop()
    await env.service.select(untouched, plain)
    expect(selected(env, untouched)).toEqual([])
    ids.push('kb2')
    const changed = await env.agent('changed')
    await env.service.select(changed, only)
    await env.ctx.knowledgeSelection.select(changed.id, ['kb2'])
    await env.service.select(changed, global)
    expect(selected(env, changed)).toEqual(['kb2'])
    await env.service.select(changed, other)
    expect(selected(env, changed)).toEqual(['kb2'])
    // A selection made before any preselection is the user's too.
    const manual = await env.agent('manual')
    await env.ctx.knowledgeSelection.select(manual.id, ['kb1'])
    await env.service.select(manual, plain)
    await env.service.select(manual, only)
    expect(selected(env, manual)).toEqual(['kb1'])
  })

  it('follows an edited subset in blank sessions, and clears the preselection once no assistant is left', async () => {
    const env = await setup({ before: withKnowledge(['kb1', 'kb2', 'kb3']) })
    const daily = (await env.settle(s => s.assistants.length === 1)).defaultId!
    const { assistantId } = await env.service.createAssistant(input({ subsets: { knowledgeBases: ['kb1', 'kb2'] } }))
    const agent = await env.agent('s1')
    await env.service.select(agent, assistantId)
    await env.service.updateAssistant(assistantId, { subsets: { knowledgeBases: ['kb3'] } })
    expect(selected(env, agent)).toEqual(['kb3'])
    await env.service.updateAssistant(assistantId, { description: '只改描述' })
    expect(selected(env, agent)).toEqual(['kb3'])
    await env.service.updateAssistant(assistantId, { subsets: {} })
    expect(selected(env, agent)).toEqual([])
    await env.service.updateAssistant(assistantId, { subsets: { knowledgeBases: ['kb1'] } })
    await env.service.deleteAssistant(daily)
    await env.service.deleteAssistant(assistantId)
    expect(selected(env, agent)).toEqual([])
  })

  it('leaves a started session\'s selection alone', async () => {
    const env = await setup({ before: withKnowledge(['kb1', 'kb2']) })
    const daily = (await env.settle(s => s.assistants.length === 1)).defaultId!
    const { assistantId } = await env.service.createAssistant(input({ subsets: { knowledgeBases: ['kb1'] } }))
    const agent = await env.agent('started')
    await env.service.select(agent, assistantId)
    const original = env.ctx.sessionProjections.stateOf.bind(env.ctx.sessionProjections) as (session: Agent['session'], key: string) => object | undefined
    vi.spyOn(env.ctx.sessionProjections, 'stateOf').mockImplementation((session: Agent['session'], key: string) => key === 'turnBoundary'
      ? { openTurnStartSeq: null, lastTurn: 1 }
      : original(session, key))
    await env.service.updateAssistant(assistantId, { subsets: { knowledgeBases: ['kb2'] } })
    await env.service.setDefault(assistantId)
    await env.service.deleteAssistant(daily)
    await env.service.deleteAssistant(assistantId)
    expect(env.events(agent, 'knowledge/selection')).toEqual([{ bases: [{ id: 'kb1', name: '知识库 kb1' }] }])
  })

  it('keeps the binding when the preselection fails', async () => {
    const warn = vi.fn()
    let reads = 0
    const env = await setup({ before: async (ctx) => {
      ctx.provide('knowledgeBases', { getState: async () => {
        reads += 1
        if (reads === 1) throw new Error('storage gone')
        return { tenantId: 't-a', bases: [base('kb1')] }
      } } as never)
      ctx.provide('knowledgeSelection', { restrict: () => () => {}, select: async () => { throw new Error('disk full') } } as never)
    } })
    await env.settle(s => s.assistants.length === 1)
    vi.spyOn(env.ctx.logger, 'warn').mockImplementation(warn)
    const { assistantId } = await env.service.createAssistant(input({ subsets: { knowledgeBases: ['kb1'] } }))
    const agent = await env.agent('s1')
    expect(await env.service.select(agent, assistantId)).toBe(assistantId)
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('not preselected: Error: storage gone'))
    const next = await env.agent('s2')
    expect(await env.service.select(next, assistantId)).toBe(assistantId)
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('not preselected: Error: disk full'))
    expect(env.events(next, 'assistant/selected').at(-1)).toEqual({ assistantId })
  })
})
