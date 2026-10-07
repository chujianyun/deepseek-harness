// @vitest-environment jsdom
import { Context, Service } from '@deepseek-ai/cordis'
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { TestRemote, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import type { EmbeddingState } from '@deepseek-ai/dsh-embedding/types'
import { apply, inject } from '../src/client/index.ts'
import { apply as applyNode } from '../src/index.ts'
import type { EmbeddingInjected } from '../src/client/embedding-source.ts'
import { EmbeddingSection } from '../src/client/EmbeddingSection.tsx'

usePinnedBrowserLanguages('zh-CN')

beforeAll(() => { Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 }, configurable: true }) })
afterAll(() => { Reflect.deleteProperty(globalThis, 'dshDesktop') })

const state: EmbeddingState = {
  local: { id: 'local/qwen3-embedding-0.6b', name: 'Qwen3-Embedding-0.6B', status: 'missing', receivedBytes: 0, totalBytes: 10, dimensions: null, error: null },
  apiModels: [],
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
  const ok = <T>(value: T) => Promise.resolve({ ok: true as const, value })
  const embedding = {
    listProviders: vi.fn(() => ok([{ provider: 'acme', displayName: 'Acme' }])),
    startDownload: vi.fn(() => ok(state)),
    pauseDownload: vi.fn(() => ok(state)),
    removeLocalModel: vi.fn(() => ok(state)),
    addApiModel: vi.fn(() => ok(state)),
    removeApiModel: vi.fn(() => ok(state)),
    watch: vi.fn(),
  }
  const remote = new TestRemote(ctx, { embedding })
  const frames: EmbeddingState[] = []
  let wake: (() => void) | undefined
  let fail: ((error: Error) => void) | undefined
  const accepted = vi.fn()
  const dispose = vi.fn(async () => {})
  const streamOptions: { open?: (signal: AbortSignal) => unknown; ended?: () => Error } = {}
  Object.assign(remote, {
    $stream: (options: typeof streamOptions) => Object.assign(streamOptions, options) && ({
      dispose,
      async *[Symbol.asyncIterator]() {
        for (;;) {
          const value = frames.shift()
          if (value !== undefined) { yield { value, accept: accepted }; continue }
          await new Promise<void>((resolve, reject) => { wake = resolve; fail = reject })
        }
      },
    }),
  })
  const slots = ctx.get('slots') as SlotRegistry
  const removeRoot = slots.register({ name: 'root', children: { 'settings.section': { kind: 'list', scope: 'root' } } } as never, () => null)
  onTestFinished(removeRoot)
  const push = (value: EmbeddingState) => { frames.push(value); wake?.() }
  return { ctx, slots, embedding, push, accepted, dispose, streamOptions, fail: (error: Error) => fail?.(error) }
}

/** The section entry's injected face; a stored entry types its callback as returning a plain record. */
function face(slots: SlotRegistry): EmbeddingInjected {
  const injected: object = slots.entries('settings.section')[0]!.inject!()
  return injected as EmbeddingInjected
}

describe('ui-settings-embedding browser plugin', () => {
  it('registers the section after Models and withdraws it and the stream with the plugin', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const [section] = b.slots.entries('settings.section')
    expect(section?.component).toBe(EmbeddingSection)
    expect(section!.options).toMatchObject({ id: 'embedding', order: 11 })
    expect(resolveSlotLabel(section!.options.label)).toBe('嵌入模型')
    await fiber.dispose()
    expect(b.slots.entries('settings.section')).toEqual([])
    expect(b.dispose).toHaveBeenCalledOnce()
  })

  it('publishes Host frames, wires the actions to the embedding Remote, and opens Models', async () => {
    const b = await bench()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const injected = face(b.slots)
    b.push(state)
    await vi.waitFor(() => { expect(b.accepted).toHaveBeenCalledOnce() })
    expect(injected.hooks.embedding.getSnapshot().state).toEqual(state)
    await injected.onRefreshProviders()
    await injected.onStart()
    await injected.onPause()
    await injected.onRemoveLocal()
    await injected.onAdd('acme', 'bge-m3')
    await injected.onRemoveApi('acme/bge-m3')
    expect(b.embedding.addApiModel).toHaveBeenCalledWith('acme', 'bge-m3')
    expect(b.embedding.removeApiModel).toHaveBeenCalledWith('acme/bge-m3')
    for (const method of ['listProviders', 'startDownload', 'pauseDownload', 'removeLocalModel'] as const) expect(b.embedding[method]).toHaveBeenCalledOnce()
    const opened = vi.fn()
    b.ctx.on('settings/open-section', opened)
    injected.onOpenModels()
    expect(opened).toHaveBeenCalledWith('models')
  })

  it('opens the Host stream through embedding.watch and survives a broken stream', async () => {
    const b = await bench()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const signal = new AbortController().signal
    b.streamOptions.open!(signal)
    expect(b.embedding.watch).toHaveBeenCalledWith(signal)
    expect(b.streamOptions.ended!().message).toBe('embedding stream ended')
    b.fail(new Error('carrier gone'))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(b.slots.entries('settings.section')).toHaveLength(1)
  })

  it('contributes nothing outside the Desktop renderer', async () => {
    const b = await bench()
    Reflect.deleteProperty(globalThis, 'dshDesktop')
    try {
      await b.ctx.plugin({ inject: [...inject], apply }).await()
      expect(b.slots.entries('settings.section')).toEqual([])
    } finally {
      Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 }, configurable: true })
    }
  })

  it('has a node half that contributes nothing', () => {
    expect(() => { applyNode() }).not.toThrow()
  })
})
