/** The knowledge selection through the real agent loop, over a scripted model and stand-in knowledge bases. */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, type Message } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture, renderToolsSdk, renderToolsSdkPy } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type { KnowledgeBaseView, KnowledgeRecallResult, KnowledgeState } from '@deepseek-ai/dsh-knowledge-base'
import { RemoteError, remoteErrorOf, remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import type { KnowledgeSelectionProjection } from '../src/types.ts'
import KnowledgeSelectionService, { citationsOf, KNOWLEDGE_SEARCH, KNOWLEDGE_SEARCH_DESCRIPTION, knowledgeSelectionProjection } from '../src/index.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

/** A tool schema with its canonical output, as SDK renderers take it. */
type ToolSdkSchema = Parameters<typeof renderToolsSdk>[0][number]

const SETTINGS = { chunkStrategy: 'structured' as const, chunkSeparator: '\\n\\n', chunkSize: 1024, chunkOverlap: 200, threshold: 0 }
const base = (id: string, name: string, over: Partial<KnowledgeBaseView> = {}): KnowledgeBaseView => ({
  id, name, embeddingModelId: 'local/q', embeddingModelName: 'Q', status: 'ready', items: [], createdAt: '2026-10-06T00:00:00.000Z',
  dimensions: 4, settings: { ...SETTINGS, documentCount: 2 }, ...over,
})
const hit = (itemId: string, itemName: string, score: number, over: object = {}) => ({
  itemId, itemName, itemKind: 'file' as const, source: null, ordinal: 0, text: `${itemName} 的内容`, score, ...over,
})

/** Stand-in knowledge bases: a fixed state and per-base recall answers or failures. */
function fakeKnowledge() {
  const state: { value: KnowledgeState } = {
    value: {
      revision: 1, tenantId: 't-a',
      bases: [
        base('b1', '公司制度'), base('b2', '产品资料', { settings: { ...SETTINGS, documentCount: 4 } }),
        base('b3', '重建中', { status: 'rebuilding' }), base('b4', '本地模型未装', { status: 'unavailable' }), base('b5', '会出错'),
        // Ready when listed, rebuilding by the time it is searched; and one failing with a bare reason.
        base('b6', '刚开始重建'), base('b7', '断网'),
      ],
    },
  }
  const answers: Record<string, KnowledgeRecallResult | Error> = {
    b1: { durationMs: 1, hits: [hit('i1', '年假制度.docx', 0.9, { ordinal: 2, text: '员工每年享有 5 天带薪年假。' }), hit('i2', '报销提醒', 0.4, { itemKind: 'note' })] },
    b2: { durationMs: 1, hits: [hit('i3', '年假 - 内网', 0.7, { itemKind: 'url', source: 'https://intra.example.com/leave' }), hit('i4', 'a.md', 0.2, { source: '人事/a.md' })] },
    b5: new Error('HTTP 401: invalid key'),
    b7: 'socket hang up' as never,
  }
  return {
    state,
    queries: [] as string[],
    getState: () => Promise.resolve(state.value),
    recall: (id: string, _query: string) => {
      state.value = { ...state.value }
      const answer = answers[id]
      if (id === 'b3' || id === 'b6') return Promise.reject(new RemoteError('knowledge/rebuilding', 'rebuilding', { id }))
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- a search that rejects with a bare string reason
      if (typeof answer === 'string') return Promise.reject(answer)
      if (answer instanceof Error) return Promise.reject(answer)
      return Promise.resolve(answer as KnowledgeRecallResult)
    },
  }
}

async function harness(adapter: MockAdapter, extra?: (ctx: Context) => void, before?: (ctx: Context) => Promise<void>) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  const loop = ctx.plugin(AgentLoop, { agents: [] })
  await loop
  const knowledge = fakeKnowledge()
  ctx.provide('knowledgeBases', knowledge as never)
  extra?.(ctx)
  ctx.llm.registerAdapter(['mock'], adapter)
  await before?.(ctx)
  const selection = ctx.plugin(KnowledgeSelectionService)
  await selection
  ctx.tools.register(defineContentToolFixture({ name: 'read', description: 'test tool read', parameters: {}, execute: () => Promise.resolve([{ type: 'text', text: 'ran read' }]) }))
  return { ctx, knowledge, loop, selection }
}

function idle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
}

const ask = (agent: Agent, text: string) => { agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })) }
const of = <T extends SessionEvent['type']>(log: readonly SessionEvent[], type: T) => log.filter((event): event is Extract<SessionEvent, { type: T }> => event.type === type)
const textOf = (message: Message): string => message.content.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('')

describe('knowledge selection', () => {
  it('publishes the namespace and its method', async () => {
    const { ctx } = await harness(new MockAdapter([]))
    expect(ctx.knowledgeSelection.typertRemote.namespace).toBe('knowledgeSelection')
    expect(remoteMethods(ctx.knowledgeSelection).map(method => method.method)).toEqual(['select'])
  })

  it('offers knowledge_search only once knowledge bases are selected, and searches only those', async () => {
    const adapter = new MockAdapter([
      textResponse('没有知识库可查。'),
      toolCallResponse('call-1', KNOWLEDGE_SEARCH, { query: ' 年假有几天 ' }, '我查一下知识库。'),
      textResponse('每年 5 天带薪年假。'),
    ])
    const { ctx } = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('kb-select'), { provider: 'mock', model: 'mock' })
    ask(agent, '年假有几天？')
    await idle(ctx, agent)
    expect(of(agent.session.snapshotEvents(), 'request/header')[0]!.data.header.tools?.map(tool => tool.name)).toEqual(['read'])

    expect(await ctx.knowledgeSelection.select(SessionId('kb-select'), ['b1', 'b2', 'b1', 'b3'])).toEqual({
      bases: [{ id: 'b1', name: '公司制度' }, { id: 'b2', name: '产品资料' }, { id: 'b3', name: '重建中' }], applies: 'now',
    })
    ask(agent, '年假有几天？')
    await idle(ctx, agent)
    const log = agent.session.snapshotEvents()
    expect(of(log, 'knowledge/selection').map(event => event.data.bases.map(entry => entry.id))).toEqual([['b1', 'b2', 'b3']])
    // The model sees the tool, with its fixed description, from the logged selection on.
    const tools = of(log, 'request/header').at(-1)!.data.header.tools!
    const search = tools.find(tool => tool.name === KNOWLEDGE_SEARCH)!
    expect(search.description).toBe(KNOWLEDGE_SEARCH_DESCRIPTION)
    expect(search.description).toBe(
      'Search the knowledge bases the user selected for this conversation — company documents, folders, web pages, and notes. '
      + 'Use it before answering questions those sources may cover, and name the sources you rely on. '
      + 'Returns the best-matching passages with their knowledge base, source item, and relevance.',
    )
    // The call and its result are in the log: what the model read, and the citations a client shows.
    const result = of(log, 'tool/result').at(-1)!
    expect(textOf(result.data.message as Message)).toBe([
      'Found 4 passages for "年假有几天".',
      '',
      '[1] 年假制度.docx — knowledge base "公司制度", chunk 3, relevance 0.90',
      '员工每年享有 5 天带薪年假。',
      '',
      '[2] 年假 - 内网 — knowledge base "产品资料", https://intra.example.com/leave, chunk 1, relevance 0.70',
      '年假 - 内网 的内容',
      '',
      '[3] 报销提醒 — knowledge base "公司制度", chunk 1, relevance 0.40',
      '报销提醒 的内容',
      '',
      '[4] a.md (人事/a.md) — knowledge base "产品资料", chunk 1, relevance 0.20',
      'a.md 的内容',
      '',
      'Not searched: "重建中" — it is being rebuilt for a new embedding model and can be searched once that finishes.',
    ].join('\n'))
    expect(result.data.meta).toEqual({
      citations: [
        { knowledgeBaseId: 'b1', knowledgeBase: '公司制度', itemId: 'i1', item: '年假制度.docx', kind: 'file', chunk: 3, score: 0.9, snippet: '员工每年享有 5 天带薪年假。' },
        { knowledgeBaseId: 'b2', knowledgeBase: '产品资料', itemId: 'i3', item: '年假 - 内网', kind: 'url', source: 'https://intra.example.com/leave', chunk: 1, score: 0.7, snippet: '年假 - 内网 的内容' },
        { knowledgeBaseId: 'b1', knowledgeBase: '公司制度', itemId: 'i2', item: '报销提醒', kind: 'note', chunk: 1, score: 0.4, snippet: '报销提醒 的内容' },
        { knowledgeBaseId: 'b2', knowledgeBase: '产品资料', itemId: 'i4', item: 'a.md', kind: 'file', source: '人事/a.md', chunk: 1, score: 0.2, snippet: 'a.md 的内容' },
      ],
    })
    // Folding the log alone restores the selection, as a reload or replay does.
    const fold = (state: KnowledgeSelectionProjection, event: SessionEvent) => knowledgeSelectionProjection.apply(state, event)
    const folded = log.reduce(fold, { bases: [] })
    expect(folded.bases.map(entry => entry.name)).toEqual(['公司制度', '产品资料', '重建中'])
    expect(ctx.sessionProjections.stateOf(agent.session, 'knowledgeSelection')).toEqual(folded)
  })

  it('pins the tool\'s TypeScript and Python SDK bindings', async () => {
    const { ctx } = await harness(new MockAdapter([]))
    const agent = await ctx.agentLoop.create(SessionId('kb-sdk'), { provider: 'mock', model: 'mock' })
    await ctx.knowledgeSelection.select(SessionId('kb-sdk'), ['b1'])
    const schema = ctx.tools.schemas(agent).find(tool => tool.name === KNOWLEDGE_SEARCH)!
    const sdk: ToolSdkSchema = { ...schema, output: ctx.tools.get(KNOWLEDGE_SEARCH, agent)!.output.schema }
    await expect(renderToolsSdk([sdk])).toMatchFileSnapshot('./expected/knowledge-search.sdk.ts.txt')
    await expect(renderToolsSdkPy([sdk])).toMatchFileSnapshot('./expected/knowledge-search.sdk.py.txt')
  })

  it('reports knowledge bases it cannot search instead of failing, and finds nothing kindly', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('call-1', KNOWLEDGE_SEARCH, { query: '预算' }),
      textResponse('都查不到。'),
    ])
    const { ctx, knowledge } = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('kb-skip'), { provider: 'mock', model: 'mock' })
    await ctx.knowledgeSelection.select(SessionId('kb-skip'), ['b3', 'b4', 'b5', 'b6', 'b7', 'b2'])
    // b2 disappears, as when deleted or after signing in to another company.
    knowledge.state.value = { ...knowledge.state.value, bases: knowledge.state.value.bases.filter(entry => entry.id !== 'b2') }
    ask(agent, '预算多少？')
    await idle(ctx, agent)
    const result = of(agent.session.snapshotEvents(), 'tool/result').at(-1)!
    expect(result.data.message.isError).toBe(false)
    expect(textOf(result.data.message as Message)).toBe([
      'No passages in the selected knowledge bases matched "预算".',
      '',
      'Not searched: "重建中" — it is being rebuilt for a new embedding model and can be searched once that finishes.',
      '',
      'Not searched: "本地模型未装" — its embedding model is not available on this machine yet.',
      '',
      'Not searched: "会出错" — the search failed: HTTP 401: invalid key.',
      '',
      'Not searched: "刚开始重建" — it is being rebuilt for a new embedding model and can be searched once that finishes.',
      '',
      'Not searched: "断网" — the search failed: socket hang up.',
      '',
      'Not searched: "产品资料" — it no longer exists for the signed-in company.',
    ].join('\n'))
    expect(result.data.meta).toEqual({ citations: [] })
  })

  it('applies a selection made during a turn from its next step, and withdraws the tool when cleared', async () => {
    let applied: string | undefined
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'pick', {}),
      textResponse('选好了。'),
      textResponse('不再查知识库。'),
    ])
    const { ctx } = await harness(adapter, (scoped) => {
      scoped.tools.register(defineContentToolFixture({
        name: 'pick', description: 'test tool pick', parameters: {},
        execute: async () => {
          applied = (await scoped.knowledgeSelection.select(SessionId('kb-turn'), ['b1'])).applies
          return [{ type: 'text', text: 'picked' }]
        },
      }))
    })
    const agent = await ctx.agentLoop.create(SessionId('kb-turn'), { provider: 'mock', model: 'mock' })
    ask(agent, '帮我选知识库')
    await idle(ctx, agent)
    expect(applied).toBe('next-step')
    let headers = of(agent.session.snapshotEvents(), 'request/header').map(event => event.data.header.tools?.map(tool => tool.name))
    expect(headers).toEqual([['pick', 'read'], [KNOWLEDGE_SEARCH, 'pick', 'read']])
    // Selecting the same again logs nothing; clearing withdraws the tool.
    await ctx.knowledgeSelection.select(SessionId('kb-turn'), ['b1'])
    expect((await ctx.knowledgeSelection.select(SessionId('kb-turn'), [])).applies).toBe('now')
    ask(agent, '算了')
    await idle(ctx, agent)
    const log = agent.session.snapshotEvents()
    expect(of(log, 'knowledge/selection').map(event => event.data.bases.length)).toEqual([1, 0])
    headers = of(log, 'request/header').map(event => event.data.header.tools?.map(tool => tool.name))
    expect(headers.at(-1)).toEqual(['pick', 'read'])
  })

  it('refuses an unknown knowledge base or session, and resumes a session through the session controller', async () => {
    const resolveAgent = vi.fn()
    const { ctx } = await harness(new MockAdapter([]), (scoped) => { scoped.provide('sessionController', { resolveAgent } as never) })
    const error = async (sessionId: string, ids: string[]) =>
      remoteErrorOf(await ctx.knowledgeSelection.select(SessionId(sessionId), ids).catch((thrown: unknown) => thrown))
    expect(await error('kb-none', ['nope'])).toMatchObject({ code: 'knowledge-selection/unknown-base', details: { id: 'nope' } })
    resolveAgent.mockResolvedValueOnce({ error: new RemoteError('session/not-found', 'no session', { sessionId: SessionId('kb-none') }) })
    expect(await error('kb-none', ['b1'])).toMatchObject({ code: 'session/not-found' })
    const agent = await ctx.agentLoop.create(SessionId('kb-cold'), { provider: 'mock', model: 'mock' })
    resolveAgent.mockResolvedValueOnce({ agent })
    vi.spyOn(ctx.agents, 'get').mockReturnValueOnce(undefined)
    expect((await ctx.knowledgeSelection.select(SessionId('kb-cold'), ['b1'])).applies).toBe('now')
    expect(resolveAgent).toHaveBeenLastCalledWith(SessionId('kb-cold'))
  })

  it('reports an unattached session when no session controller is composed, and keeps a selection a failed write left pending', async () => {
    const adapter = new MockAdapter([toolCallResponse('call-1', 'pick', {}), textResponse('一'), textResponse('二')])
    const { ctx } = await harness(adapter, (scoped) => {
      scoped.tools.register(defineContentToolFixture({
        name: 'pick', description: 'test tool pick', parameters: {},
        execute: async () => { await scoped.knowledgeSelection.select(SessionId('kb-fail'), ['b1']); return [{ type: 'text', text: 'picked' }] },
      }))
    })
    expect(remoteErrorOf(await ctx.knowledgeSelection.select(SessionId('kb-nobody'), ['b1']).catch((thrown: unknown) => thrown))).toMatchObject({ code: 'session/not-found' })
    const agent = await ctx.agentLoop.create(SessionId('kb-fail'), { provider: 'mock', model: 'mock' })
    const append = agent.session.append.bind(agent.session)
    let failures = 1
    vi.spyOn(agent.session, 'append').mockImplementation(((...args: unknown[]) => {
      if (args[0] === 'knowledge/selection' && failures-- > 0) throw new Error('disk full')
      return (append as (...rest: unknown[]) => unknown)(...args)
    }) as typeof agent.session.append)
    ask(agent, '选')
    await idle(ctx, agent)
    // The write failed at the step boundary; the turn went on and the selection stayed pending.
    expect(of(agent.session.snapshotEvents(), 'knowledge/selection')).toHaveLength(0)
    expect(failures).toBe(0)
    ask(agent, '再来')
    await idle(ctx, agent)
    expect(of(agent.session.snapshotEvents(), 'knowledge/selection')).toHaveLength(1)
  })

  it('serves the projection view, presents its cards, and keeps a rejected step from logging', async () => {
    expect(knowledgeSelectionProjection.wire.view({ bases: [{ id: 'b1', name: '公司制度' }] })).toEqual({ bases: [{ id: 'b1', name: '公司制度' }] })
    const adapter = new MockAdapter([toolCallResponse('call-1', 'pick', {}), textResponse('一')])
    let reject = false
    const { ctx } = await harness(adapter, (scoped) => {
      scoped.tools.register(defineContentToolFixture({
        name: 'pick', description: 'test tool pick', parameters: {},
        execute: async () => {
          // Choosing nothing when nothing is logged changes nothing.
          await scoped.knowledgeSelection.select(SessionId('kb-reject'), [])
          await scoped.knowledgeSelection.select(SessionId('kb-reject'), ['b1'])
          reject = true
          return [{ type: 'text', text: 'picked' }]
        },
      }))
    })
    // Registered after the plugin, so the plugin's listener sees the rejection from inside.
    ctx.on('agent/pre-step', async (_payload, next) => (reject ? { kind: 'reject' as const } : next()))
    const agent = await ctx.agentLoop.create(SessionId('kb-reject'), { provider: 'mock', model: 'mock' })
    ask(agent, '选')
    await idle(ctx, agent)
    expect(of(agent.session.snapshotEvents(), 'knowledge/selection')).toEqual([])
    const tool = ctx.tools.get(KNOWLEDGE_SEARCH, agent)!
    expect(tool.presentCall?.({ query: '年假' })).toEqual({ card: 'generic', title: 'Search knowledge: 年假', kind: 'search' })
    expect(tool.presentResult?.({ query: '年假' }, { content: [{ type: 'text', text: 'x' }], isError: false })).toEqual({ card: 'generic', content: [{ type: 'text', text: 'x' }] })
  })

  it('offers the tool to agents that existed before it loaded, and withdraws it when an agent or the plugin goes', async () => {
    let early: Agent | undefined
    const { ctx, loop, selection } = await harness(new MockAdapter([]), undefined, async (scoped) => {
      early = await scoped.agentLoop.create(SessionId('kb-early'), { provider: 'mock', model: 'mock' })
    })
    expect(ctx.tools.get(KNOWLEDGE_SEARCH, early)).toBeUndefined()
    const later = await ctx.agentLoop.create(SessionId('kb-later'), { provider: 'mock', model: 'mock' })
    await ctx.knowledgeSelection.select(SessionId('kb-later'), ['b1'])
    expect(ctx.tools.get(KNOWLEDGE_SEARCH, later)).toBeDefined()
    await selection.dispose()
    expect(ctx.tools.get(KNOWLEDGE_SEARCH, later)).toBeUndefined()
    await loop.dispose()
  })

  it('withdraws the tool when its agent is disposed', async () => {
    const { ctx, loop } = await harness(new MockAdapter([]))
    const agent = await ctx.agentLoop.create(SessionId('kb-dispose'), { provider: 'mock', model: 'mock' })
    await ctx.knowledgeSelection.select(SessionId('kb-dispose'), ['b1'])
    const disposed: Agent[] = []
    ctx.on('agent/disposed', ({ agent: gone }) => { disposed.push(gone) })
    await loop.dispose()
    expect(disposed.includes(agent)).toBe(true)
  })

  it('logs nothing at a step boundary when the pending selection matches the logged one', async () => {
    const adapter = new MockAdapter([toolCallResponse('call-1', 'pick', {}), textResponse('一')])
    const { ctx } = await harness(adapter, (scoped) => {
      scoped.tools.register(defineContentToolFixture({
        name: 'pick', description: 'test tool pick', parameters: {},
        execute: async () => { await scoped.knowledgeSelection.select(SessionId('kb-same'), ['b1']); return [{ type: 'text', text: 'picked' }] },
      }))
    })
    const agent = await ctx.agentLoop.create(SessionId('kb-same'), { provider: 'mock', model: 'mock' })
    await ctx.knowledgeSelection.select(SessionId('kb-same'), ['b1'])
    ask(agent, '选')
    await idle(ctx, agent)
    expect(of(agent.session.snapshotEvents(), 'knowledge/selection')).toHaveLength(1)
  })

  it('cuts a long passage to a short snippet for its citation', () => {
    const text = '长'.repeat(200)
    const [citation] = citationsOf({ hits: [{ knowledgeBaseId: 'b1', knowledgeBase: '库', itemId: 'i', item: 'a.md', kind: 'file', chunk: 1, score: 1, text }], skipped: [] })
    expect(citation!.snippet).toBe(`${'长'.repeat(160)}…`)
  })
})
