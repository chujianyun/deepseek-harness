// @vitest-environment jsdom
import { Context, Service } from '@deepseek-ai/cordis'
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest'
import { render } from '@testing-library/react'
import type { AssistantsState } from '@deepseek-ai/dsh-assistants/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel, type GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { TestRemote, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject } from '../src/client/index.ts'
import { apply as applyNode } from '../src/index.ts'
import type { AssistantsInjected } from '../src/client/assistants-source.ts'
import { AssistantSeat } from '../src/client/AssistantSeat.tsx'
import { AssistantsPage } from '../src/client/AssistantsPage.tsx'
import { AssistantsPanelIcon } from '../src/client/AssistantsPanelIcon.tsx'

usePinnedBrowserLanguages('zh-CN')

beforeAll(() => { Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 }, configurable: true }) })
afterAll(() => { Reflect.deleteProperty(globalThis, 'dshDesktop') })

const state: AssistantsState = {
  revision: 1, tenantId: 't-a', defaultId: 'a1',
  assistants: [{ id: 'a1', name: '日常助手', description: '', avatar: { kind: 'preset', key: 'sun' }, createdAt: '2026-10-07T00:00:00Z' }],
}

interface Summary { id: string; blank: boolean; retainedBy: { mainView?: number }; projectionValues?: Record<string, unknown> }

async function bench() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  class LocaleHolder extends Service {
    constructor(serviceCtx: Context) { super(serviceCtx, 'localeHolder') }
  }
  new LocaleHolder(ctx)
  const list = createSnapshotStore<{ byId: Record<string, Summary> }>({ byId: {} })
  ctx.provide('sessions', { list } as never)
  const startSession = vi.fn()
  ctx.provide('uiWorkspace', { startSession } as never)
  const assistants = {
    select: vi.fn((_sessionId: string, assistantId: string) => Promise.resolve({ ok: true as const, value: assistantId })),
    watch: vi.fn(),
  }
  const remote = new TestRemote(ctx, { assistants })
  const frames: AssistantsState[] = []
  let wake: (() => void) | undefined
  let fail: ((error: Error) => void) | undefined
  const options: { open?: (signal: AbortSignal) => unknown; ended?: () => Error } = {}
  const dispose = vi.fn(async () => {})
  const accepted = vi.fn()
  Object.assign(remote, {
    $stream: (opened: { open: (signal: AbortSignal) => unknown; ended: () => Error }) => {
      Object.assign(options, opened)
      return {
        dispose,
        async *[Symbol.asyncIterator]() {
          for (;;) {
            const value = frames.shift()
            if (value !== undefined) { yield { value, accept: accepted }; continue }
            await new Promise<void>((resolve, reject) => { wake = resolve; fail = reject })
          }
        },
      }
    },
  })
  const slots = ctx.get('slots') as SlotRegistry
  const removeRoot = slots.register({
    name: 'root',
    children: {
      main: { kind: 'keyed', scope: 'root' },
      'sidebar.panellist': { kind: 'list', scope: 'root' },
      'conversation.hero.assistant': { kind: 'single', scope: 'session-maybe' },
    },
  } as never, () => null)
  onTestFinished(removeRoot)
  return {
    ctx, slots, assistants, options, dispose, accepted, list, startSession,
    push: (value: AssistantsState) => { frames.push(value); wake?.() },
    fail: (error: Error) => { fail?.(error) },
  }
}

describe('ui-assistants browser plugin', () => {
  it('registers the page, the sidebar entry below Connectors, and the picker, and withdraws them with the plugin', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.slots.entries('main')[0]).toMatchObject({ component: AssistantsPage, options: { key: 'assistants' } })
    const [entry] = b.slots.entries('sidebar.panellist')
    expect(entry).toMatchObject({ component: AssistantsPanelIcon, options: { id: 'assistants', order: 8 } })
    expect(resolveSlotLabel(entry!.options.label)).toBe('智能体')
    expect(b.slots.entries('conversation.hero.assistant')[0]).toMatchObject({ component: AssistantSeat })
    expect(b.slots.entries('conversation.hero.assistant')[0]!.inject!()).toBe(b.slots.entries('main')[0]!.inject!())
    expect(render(<AssistantsPanelIcon {...({} as GlobalStandardProps)} size={18} active={false} />).container.querySelector('svg')).toBeTruthy()
    await fiber.dispose()
    expect(b.slots.entries('main')).toEqual([])
    expect(b.slots.entries('sidebar.panellist')).toEqual([])
    expect(b.slots.entries('conversation.hero.assistant')).toEqual([])
    expect(b.dispose).toHaveBeenCalledOnce()
  })

  it('publishes the Host stream and binds a pick to the main view\'s blank session when it appears', async () => {
    const b = await bench()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const face: object = b.slots.entries('main')[0]!.inject!()
    const injected = face as AssistantsInjected
    b.push(state)
    await vi.waitFor(() => { expect(b.accepted).toHaveBeenCalledOnce() })
    expect(injected.hooks.assistants.getSnapshot().state).toEqual(state)
    await injected.onChat('a1')
    expect(b.startSession).toHaveBeenCalledOnce()
    expect(b.assistants.select).not.toHaveBeenCalled()
    b.list.set({ byId: {
      old: { id: 'old', blank: false, retainedBy: { mainView: 0 } },
      side: { id: 'side', blank: true, retainedBy: {} },
      s1: { id: 's1', blank: true, retainedBy: { mainView: 1 }, projectionValues: { assistant: 'other' } },
    } })
    await vi.waitFor(() => { expect(b.assistants.select).toHaveBeenCalledWith('s1', 'a1') })
    b.list.set({ byId: { s2: { id: 's2', blank: true, retainedBy: { mainView: 1 } } } })
    await vi.waitFor(() => { expect(injected.hooks.assistants.getSnapshot().bound).toBeNull() })
    const signal = new AbortController().signal
    b.options.open!(signal)
    expect(b.assistants.watch).toHaveBeenCalledWith(signal)
    expect(b.options.ended!().message).toBe('assistants stream ended')
    b.fail(new Error('gone'))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(b.slots.entries('main')).toHaveLength(1)
  })

  it('stays out of a non-Desktop renderer, and the node half does nothing', async () => {
    Reflect.deleteProperty(globalThis, 'dshDesktop')
    try {
      const b = await bench()
      await b.ctx.plugin({ inject: [...inject], apply }).await()
      expect(b.slots.entries('main')).toEqual([])
      expect(b.slots.entries('conversation.hero.assistant')).toEqual([])
    } finally {
      Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 }, configurable: true })
    }
    expect(() => { applyNode() }).not.toThrow()
  })
})
