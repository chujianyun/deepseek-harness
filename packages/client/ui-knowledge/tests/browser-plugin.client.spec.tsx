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
import { apply, inject } from '../src/client/index.ts'
import { apply as applyNode } from '../src/index.ts'
import type { KnowledgeInjected } from '../src/client/knowledge-source.ts'
import { KnowledgePage } from '../src/client/KnowledgePage.tsx'
import { KnowledgePanelIcon } from '../src/client/KnowledgePanelIcon.tsx'

usePinnedBrowserLanguages('zh-CN')

beforeAll(() => { Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 }, configurable: true }) })
afterAll(() => { Reflect.deleteProperty(globalThis, 'dshDesktop') })

const knowledgeState: KnowledgeState = { tenantId: 't-a', bases: [] }
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
    deleteItem: vi.fn(() => ok(knowledgeState)),
    watch: vi.fn(),
  }
  const embedding = { watch: vi.fn() }
  const remote = new TestRemote(ctx, { knowledgeBases, embedding })
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
    name: 'root', children: { main: { kind: 'keyed', scope: 'root' }, 'sidebar.panellist': { kind: 'list', scope: 'root' } },
  } as never, () => null)
  onTestFinished(removeRoot)
  return { ctx, slots, knowledgeBases, embedding, streams, accepted }
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
    await injected.onDelete('b')
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
