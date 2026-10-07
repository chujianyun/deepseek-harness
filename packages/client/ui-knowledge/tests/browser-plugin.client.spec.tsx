// @vitest-environment jsdom
import { Context, Service } from '@deepseek-ai/cordis'
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest'
import { render } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel, type GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { TestRemote, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import type { EmbeddingState } from '@deepseek-ai/dsh-embedding/types'
import type { KnowledgeState } from '@deepseek-ai/dsh-knowledge-base/types'
import { ConversationEventRegistry } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { EMPTY_CHAT_SNAPSHOT } from '../../ui-chat/src/client/contract/snapshot.ts'
import { citationsDefinition } from '../src/client/citations.ts'
import { KnowledgeCitationsCard, type KnowledgeCitationsInjected } from '../src/client/KnowledgeCitations.tsx'
import { KnowledgePicker, type KnowledgePickerInjected } from '../src/client/KnowledgePicker.tsx'
import { apply, inject } from '../src/client/index.ts'
import { apply as applyNode } from '../src/index.ts'
import type { KnowledgeInjected } from '../src/client/knowledge-source.ts'
import { KnowledgePage } from '../src/client/KnowledgePage.tsx'
import { KnowledgePanelIcon } from '../src/client/KnowledgePanelIcon.tsx'

usePinnedBrowserLanguages('zh-CN')

beforeAll(() => { Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 }, configurable: true }) })
afterAll(() => { Reflect.deleteProperty(globalThis, 'dshDesktop') })

const knowledgeState: KnowledgeState = { revision: 1, tenantId: 't-a', bases: [] }
const embeddingState: EmbeddingState = {
  local: { id: 'local/q', name: 'Q', status: 'installed', receivedBytes: 1, totalBytes: 1, dimensions: 4, error: null }, apiModels: [],
}

/** A Remote stream fed by the spec. */
function feed<T>() {
  const frames: T[] = []
  let wake: (() => void) | undefined
  let fail: ((error: Error) => void) | undefined
  const options: { open?: (signal: AbortSignal) => unknown; ended?: () => Error } = {}
  const dispose = vi.fn(async () => {})
  return {
    frames, options, dispose,
    push: (value: T) => { frames.push(value); wake?.() },
    fail: (error: Error) => { fail?.(error) },
    stream: (accept: () => void) => ({
      dispose,
      async *[Symbol.asyncIterator]() {
        for (;;) {
          const value = frames.shift()
          if (value !== undefined) { yield { value, accept }; continue }
          await new Promise<void>((resolve, reject) => { wake = resolve; fail = reject })
        }
      },
    }),
  }
}

async function bench() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  class LocaleHolder extends Service {
    constructor(serviceCtx: Context) { super(serviceCtx, 'localeHolder') }
  }
  new LocaleHolder(ctx)
  const ok = <T,>(value: T) => Promise.resolve({ ok: true as const, value })
  const knowledgeBases = {
    createBase: vi.fn(() => ok(knowledgeState)), renameBase: vi.fn(() => ok(knowledgeState)), deleteBase: vi.fn(() => ok(knowledgeState)),
    addFiles: vi.fn(() => ok({ added: 0, rejected: [] })), reprocessItem: vi.fn(() => ok(knowledgeState)),
    deleteItem: vi.fn(() => ok(knowledgeState)), updateSettings: vi.fn(() => ok(knowledgeState)),
    reprocessAll: vi.fn(() => ok(knowledgeState)), recall: vi.fn(() => ok({ hits: [], durationMs: 1 })),
    addFolder: vi.fn(() => ok(knowledgeState)), addUrl: vi.fn(() => ok(knowledgeState)), createNote: vi.fn(() => ok(knowledgeState)),
    updateNote: vi.fn(() => ok(knowledgeState)), getNote: vi.fn(() => ok({ title: 't', content: 'c' })),
    openItem: vi.fn(() => ok(undefined)),
    watch: vi.fn(),
  }
  const embedding = { watch: vi.fn() }
  const knowledgeSelection = { select: vi.fn(() => ok({ bases: [], applies: 'now' as const })), allowedBases: vi.fn(() => ok(['b1'])) }
  const remote = new TestRemote(ctx, { knowledgeBases, embedding, knowledgeSelection })
  const events = new ConversationEventRegistry(ctx)
  const chat = createSnapshotStore<ChatSnapshot | undefined>(EMPTY_CHAT_SNAPSHOT)
  ctx.provide('uiConversation', { events, binding: () => ({ target: () => chat }) })
  const binding = vi.fn<() => object | undefined>(() => ({}))
  ctx.provide('sessions', { binding })
  const streams = { knowledgeBases: feed<KnowledgeState>(), embedding: feed<EmbeddingState>() }
  const accepted = vi.fn()
  Object.assign(remote, {
    $stream: (options: { name: 'knowledgeBases' | 'embedding'; open: (signal: AbortSignal) => unknown; ended: () => Error }) => {
      Object.assign(streams[options.name].options, options)
      return streams[options.name].stream(accepted)
    },
  })
  const slots = ctx.get('slots') as SlotRegistry
  const removeRoot = slots.register({
    name: 'root', children: {
      main: { kind: 'keyed', scope: 'root' }, 'sidebar.panellist': { kind: 'list', scope: 'root' },
      'conversation.input.left': { kind: 'list', scope: 'session' }, 'conversation.chat.turnTail': { kind: 'list', scope: 'session' },
    },
  } as never, () => null)
  onTestFinished(removeRoot)
  return { ctx, slots, knowledgeBases, embedding, knowledgeSelection, streams, accepted, events, chat, binding }
}

function face(slots: SlotRegistry): KnowledgeInjected {
  const injected: object = slots.entries('main')[0]!.inject!()
  return injected as KnowledgeInjected
}

describe('ui-knowledge browser plugin', () => {
  it('registers the page and the sidebar entry below Skills, and withdraws them and the streams with the plugin', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.slots.entries('main')[0]).toMatchObject({ component: KnowledgePage, options: { key: 'knowledge' } })
    const [entry] = b.slots.entries('sidebar.panellist')
    expect(entry).toMatchObject({ component: KnowledgePanelIcon, options: { id: 'knowledge', order: 6 } })
    expect(resolveSlotLabel(entry!.options.label)).toBe('知识库')
    expect(render(<KnowledgePanelIcon {...({} as GlobalStandardProps)} size={18} active={false} />).container.querySelector('svg')).toBeTruthy()
    await fiber.dispose()
    expect(b.slots.entries('main')).toEqual([])
    expect(b.slots.entries('sidebar.panellist')).toEqual([])
    expect(b.streams.knowledgeBases.dispose).toHaveBeenCalledOnce()
    expect(b.streams.embedding.dispose).toHaveBeenCalledOnce()
  })

  it('publishes both Host streams and wires the actions to the knowledgeBases Remote', async () => {
    const b = await bench()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const injected = face(b.slots)
    b.streams.knowledgeBases.push(knowledgeState)
    b.streams.embedding.push(embeddingState)
    await vi.waitFor(() => { expect(b.accepted).toHaveBeenCalledTimes(2) })
    expect(injected.hooks.knowledge.getSnapshot()).toMatchObject({ state: knowledgeState, embedding: embeddingState })
    await injected.onCreate('甲', 'local/q')
    await injected.onRename('b', '乙')
    await injected.onAddFiles('b', ['/a.txt'])
    await injected.onReprocess('b', 'i')
    await injected.onDeleteItem('b', 'i')
    await injected.onSaveSettings('b', { documentCount: 3 })
    await injected.onReprocessAll('b')
    await injected.onRecall('b', '年假')
    await injected.onAddFolder('b', '/d')
    await injected.onAddUrl('b', 'https://x')
    await injected.onCreateNote('b', 't', 'c')
    await injected.onUpdateNote('b', 'n', 't', 'c')
    await injected.onLoadNote('b', 'n')
    expect(b.knowledgeBases.addFolder).toHaveBeenCalledWith('b', '/d')
    expect(b.knowledgeBases.addUrl).toHaveBeenCalledWith('b', 'https://x')
    expect(b.knowledgeBases.createNote).toHaveBeenCalledWith('b', 't', 'c')
    expect(b.knowledgeBases.updateNote).toHaveBeenCalledWith('b', 'n', 't', 'c')
    expect(b.knowledgeBases.getNote).toHaveBeenCalledWith('b', 'n')
    await injected.onDelete('b')
    expect(b.knowledgeBases.updateSettings).toHaveBeenCalledWith('b', { documentCount: 3 })
    expect(b.knowledgeBases.reprocessAll).toHaveBeenCalledWith('b')
    expect(b.knowledgeBases.recall).toHaveBeenCalledWith('b', '年假')
    expect(b.knowledgeBases.createBase).toHaveBeenCalledWith('甲', 'local/q')
    expect(b.knowledgeBases.renameBase).toHaveBeenCalledWith('b', '乙')
    expect(b.knowledgeBases.addFiles).toHaveBeenCalledWith('b', ['/a.txt'])
    expect(b.knowledgeBases.reprocessItem).toHaveBeenCalledWith('b', 'i')
    expect(b.knowledgeBases.deleteItem).toHaveBeenCalledWith('b', 'i')
    expect(b.knowledgeBases.deleteBase).toHaveBeenCalledWith('b')
  })

  it('opens both Host streams through their watch methods and survives broken streams', async () => {
    const b = await bench()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const signal = new AbortController().signal
    b.streams.knowledgeBases.options.open!(signal)
    b.streams.embedding.options.open!(signal)
    expect(b.knowledgeBases.watch).toHaveBeenCalledWith(signal)
    expect(b.embedding.watch).toHaveBeenCalledWith(signal)
    expect(b.streams.knowledgeBases.options.ended!().message).toBe('knowledge stream ended')
    expect(b.streams.embedding.options.ended!().message).toBe('embedding stream ended')
    b.streams.knowledgeBases.fail(new Error('gone'))
    b.streams.embedding.fail(new Error('gone'))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(b.slots.entries('main')).toHaveLength(1)
  })

  it('adds the composer picker and the Turn citations, bound to the session, and withdraws them with the plugin', async () => {
    const b = await bench()
    const register = vi.spyOn(b.events, 'register')
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(register).toHaveBeenCalledWith(citationsDefinition)
    const sid = 's1' as SessionId
    const picker = b.slots.entries('conversation.input.left')[0]!
    expect(picker.component).toBe(KnowledgePicker)
    const resolvePicker: (sessionId: SessionId) => KnowledgePickerInjected = picker.inject as never
    const pick = resolvePicker(sid)
    expect(await pick.select(['b1'])).toBe('now')
    expect(b.knowledgeSelection.select).toHaveBeenCalledWith(sid, ['b1'])
    b.knowledgeSelection.select.mockResolvedValueOnce({ ok: false, error: { message: 'no knowledge base b1' } } as never)
    expect(await pick.select(['b1'])).toEqual({ failure: 'no knowledge base b1' })
    expect(await pick.allowed()).toEqual(['b1'])
    expect(b.knowledgeSelection.allowedBases).toHaveBeenCalledWith(sid)
    b.knowledgeSelection.allowedBases.mockResolvedValueOnce({ ok: false, error: { message: 'gone' } } as never)
    expect(await pick.allowed()).toBeUndefined()
    const card = b.slots.entries('conversation.chat.turnTail')[0]!
    expect(card.component).toBe(KnowledgeCitationsCard)
    const resolve: (sessionId: SessionId) => KnowledgeCitationsInjected = card.inject as never
    const injected = resolve(sid)
    const turnDataSource = vi.fn<(turn: number, kind: string) => void>()
    b.chat.set({ ...EMPTY_CHAT_SNAPSHOT, nodes: {
      ...EMPTY_CHAT_SNAPSHOT.nodes,
      turnDataSource: (turn, kind) => { turnDataSource(turn, kind); return EMPTY_CHAT_SNAPSHOT.nodes.turnDataSource(turn, kind) },
    } })
    expect(injected.keyedHooks.citations('3').getSnapshot()).toEqual([])
    expect(turnDataSource).toHaveBeenCalledWith(3, 'knowledge-citations')
    const citation = { knowledgeBaseId: 'b1', knowledgeBase: 'K', itemId: 'f1', item: 'a.md', kind: 'file' as const, chunk: 1, score: 1, snippet: 's' }
    expect(await injected.openItem(citation)).toBe(true)
    expect(b.knowledgeBases.openItem).toHaveBeenCalledWith('b1', 'f1')
    b.knowledgeBases.openItem.mockResolvedValueOnce({ ok: false, error: { message: 'gone' } } as never)
    expect(await injected.openItem(citation)).toBe(false)
    const open = vi.spyOn(globalThis, 'open').mockReturnValue(null)
    injected.openUrl('https://example.com/a')
    expect(open).toHaveBeenCalledWith('https://example.com/a', '_blank', 'noopener')
    open.mockRestore()
    b.chat.set(undefined)
    expect(() => injected.keyedHooks.citations('3')).toThrow('Chat target is unavailable')
    b.binding.mockReturnValueOnce(undefined)
    expect(() => resolve(sid)).toThrow('unknown session')
    await fiber.dispose()
    expect(b.slots.entries('conversation.input.left')).toEqual([])
    expect(b.slots.entries('conversation.chat.turnTail')).toEqual([])
  })

  it('contributes nothing outside the Desktop renderer, and has a node half that contributes nothing', async () => {
    const b = await bench()
    Reflect.deleteProperty(globalThis, 'dshDesktop')
    try {
      await b.ctx.plugin({ inject: [...inject], apply }).await()
      expect(b.slots.entries('main')).toEqual([])
    } finally {
      Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 }, configurable: true })
    }
    expect(() => { applyNode() }).not.toThrow()
  })
})
