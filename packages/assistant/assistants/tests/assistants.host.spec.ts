import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { assembleContextFor, type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import AssistantsService, { ASSISTANT_SECTION, assistantProjectionDefinition, renderInstructions } from '../src/index.ts'
import { hubStub } from '../../../connector/connectors/tests/support.ts'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function setup(options: { tenant?: string | null; home?: string; before?: (ctx: Context) => Promise<void> } = {}) {
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
  await ctx.plugin(AssistantsService, { dshHome: home })
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

  it('drops the section once the bound assistant is deleted', async () => {
    const env = await setup()
    const state = await env.settle(s => s.assistants.length === 1)
    const agent = await env.agent('s1')
    expect(await env.turnPrompt(agent)).not.toBe('')
    await rm(join(env.home, 'assistants', 't-a', state.defaultId!), { recursive: true })
    env.hub.set('t-b')
    await env.settle(s => s.tenantId === 't-b')
    env.hub.set('t-a')
    await env.settle(s => s.tenantId === 't-a' && s.assistants.length === 0)
    expect(await env.turnPrompt(agent)).toBe('')
    expect(env.events(agent, 'assistant/instructions').at(-1)).toEqual({ text: '' })
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

describe('renderInstructions', () => {
  it('skips blank files and returns empty text when every file is blank', () => {
    expect(renderInstructions('A', [['IDENTITY.md', ' \n'], ['SOUL.md', '']])).toBe('')
    expect(renderInstructions('A', [['IDENTITY.md', 'x'], ['SOUL.md', '']])).toBe('You are the assistant "A". The user wrote the core files below to define your identity, personality, what you know about them, and how you work. Follow them in this session.\n\n<core_file name="IDENTITY.md">\nx\n</core_file>')
  })
})
