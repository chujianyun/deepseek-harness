// @vitest-environment jsdom
import { Context, Service } from '@deepseek-ai/cordis'
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest'
import { render } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel, type GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { TestRemote, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import type { ConnectorsState } from '@deepseek-ai/dsh-connectors/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { apply, inject } from '../src/client/index.ts'
import { apply as applyNode } from '../src/index.ts'
import type { ConnectorsInjected } from '../src/client/connectors-source.ts'
import { ConnectorsPage } from '../src/client/ConnectorsPage.tsx'
import { ConnectorsPanelIcon } from '../src/client/ConnectorsPanelIcon.tsx'

usePinnedBrowserLanguages('zh-CN')

beforeAll(() => { Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 }, configurable: true }) })
afterAll(() => { Reflect.deleteProperty(globalThis, 'dshDesktop') })

const state: ConnectorsState = {
  connectors: [{
    id: 'feishu', status: 'not-installed', cli: 'lark-cli', version: '1.0.97', receivedBytes: 0, totalBytes: 10, error: null,
    login: null, loginError: null, account: null, problem: null, enabled: true, skills: [],
  }],
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
  const connectors = {
    installConnector: vi.fn(() => Promise.resolve({ ok: true as const, value: state })),
    uninstallConnector: vi.fn(() => Promise.resolve({ ok: false as const, error: new RemoteError('connectors/unavailable', 'nope', { id: 'x' }) })),
    connect: vi.fn(() => Promise.resolve({ ok: true as const, value: state })),
    cancelConnect: vi.fn(() => Promise.resolve({ ok: true as const, value: state })),
    disconnect: vi.fn(() => Promise.resolve({ ok: true as const, value: state })),
    check: vi.fn(() => Promise.resolve({ ok: true as const, value: state })),
    setEnabled: vi.fn(() => Promise.resolve({ ok: true as const, value: state })),
    watch: vi.fn(),
  }
  const remote = new TestRemote(ctx, { connectors })
  const frames: ConnectorsState[] = []
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
    name: 'root', children: { main: { kind: 'keyed', scope: 'root' }, 'sidebar.panellist': { kind: 'list', scope: 'root' } },
  } as never, () => null)
  onTestFinished(removeRoot)
  return {
    ctx, slots, connectors, options, dispose, accepted,
    push: (value: ConnectorsState) => { frames.push(value); wake?.() },
    fail: (error: Error) => { fail?.(error) },
  }
}

describe('ui-connectors browser plugin', () => {
  it('registers the page and the sidebar entry below Knowledge, and withdraws them and the stream with the plugin', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.slots.entries('main')[0]).toMatchObject({ component: ConnectorsPage, options: { key: 'connectors' } })
    const [entry] = b.slots.entries('sidebar.panellist')
    expect(entry).toMatchObject({ component: ConnectorsPanelIcon, options: { id: 'connectors', order: 7 } })
    expect(resolveSlotLabel(entry!.options.label)).toBe('连接器')
    expect(render(<ConnectorsPanelIcon {...({} as GlobalStandardProps)} size={18} active={false} />).container.querySelector('svg')).toBeTruthy()
    await fiber.dispose()
    expect(b.slots.entries('main')).toEqual([])
    expect(b.slots.entries('sidebar.panellist')).toEqual([])
    expect(b.dispose).toHaveBeenCalledOnce()
  })

  it('publishes the Host stream and wires the actions to the connectors Remote', async () => {
    const b = await bench()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const face: object = b.slots.entries('main')[0]!.inject!()
    const injected = face as ConnectorsInjected
    b.push(state)
    await vi.waitFor(() => { expect(b.accepted).toHaveBeenCalledOnce() })
    expect(injected.hooks.connectors.getSnapshot().state).toEqual(state)
    await injected.onInstall('feishu')
    expect(b.connectors.installConnector).toHaveBeenCalledWith('feishu')
    await injected.onUninstall('feishu')
    expect(b.connectors.uninstallConnector).toHaveBeenCalledWith('feishu')
    expect(injected.hooks.connectors.getSnapshot().failure).toBe('nope')
    await injected.onConnect('feishu')
    await injected.onCancelConnect('feishu')
    await injected.onDisconnect('feishu')
    await injected.onCheck()
    expect(b.connectors.connect).toHaveBeenCalledWith('feishu')
    expect(b.connectors.cancelConnect).toHaveBeenCalledWith('feishu')
    expect(b.connectors.disconnect).toHaveBeenCalledWith('feishu')
    expect(b.connectors.check).toHaveBeenCalledOnce()
    await injected.onSetEnabled('feishu', false)
    expect(b.connectors.setEnabled).toHaveBeenCalledWith('feishu', false)
    const open = vi.spyOn(globalThis, 'open').mockReturnValue(null)
    injected.onOpenUrl('https://open.feishu.cn/x')
    expect(open).toHaveBeenCalledWith('https://open.feishu.cn/x', '_blank', 'noopener')
    open.mockRestore()
    const signal = new AbortController().signal
    b.options.open!(signal)
    expect(b.connectors.watch).toHaveBeenCalledWith(signal)
    expect(b.options.ended!().message).toBe('connectors stream ended')
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
      expect(b.slots.entries('sidebar.panellist')).toEqual([])
    } finally {
      Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 }, configurable: true })
    }
    expect(() => { applyNode() }).not.toThrow()
  })
})
