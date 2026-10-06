import { describe, expect, it, vi } from 'vitest'
import type { ConnectorsState, ConnectorView } from '@deepseek-ai/dsh-connectors/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { createConnectorsSource, type ConnectorsDependencies } from '../src/client/connectors-source.ts'

const state: ConnectorsState = { connectors: [] }
const ok = () => Promise.resolve({ ok: true as const, value: state })
const refused = (message: string) => Promise.resolve({ ok: false as const, error: new RemoteError('connectors/not-found', message, { id: 'x' }) })

function deps(over: Partial<ConnectorsDependencies> = {}): ConnectorsDependencies {
  return {
    install: vi.fn(ok), uninstall: vi.fn(ok), connect: vi.fn(ok), cancelConnect: vi.fn(ok), disconnect: vi.fn(ok), check: vi.fn(ok),
    openUrl: vi.fn(), ...over,
  }
}

const feishu = (over: Partial<ConnectorView>): ConnectorsState => ({
  connectors: [{
    id: 'feishu', status: 'connecting', cli: 'lark-cli', version: '1', receivedBytes: 0, totalBytes: 0, error: null,
    login: null, loginError: null, account: null, problem: null, ...over,
  }],
})

describe('connectors source', () => {
  it('takes card state only from the stream, marks a connector busy during its action, and keeps the last refusal until dismissed', async () => {
    let finish!: () => void
    const install = vi.fn(() => new Promise<{ ok: true; value: ConnectorsState }>((resolve) => {
      finish = () => { resolve({ ok: true, value: { connectors: [] } }) }
    }))
    const d = deps({ install, uninstall: vi.fn(() => refused('no connector x')) })
    const source = createConnectorsSource(d)
    expect(source.hooks.connectors.getSnapshot()).toEqual({ state: undefined, busy: [], failure: null })
    source.publish(state)
    const pending = source.onInstall('feishu')
    expect(source.hooks.connectors.getSnapshot().busy).toEqual(['feishu'])
    finish()
    await pending
    expect(source.hooks.connectors.getSnapshot()).toEqual({ state, busy: [], failure: null })
    await source.onUninstall('x')
    expect(d.uninstall).toHaveBeenCalledWith('x')
    expect(source.hooks.connectors.getSnapshot().failure).toBe('no connector x')
    source.onDismiss()
    expect(source.hooks.connectors.getSnapshot().failure).toBeNull()
  })

  it('wires connect, cancel, disconnect, and check, and reports a refused check', async () => {
    const d = deps({ check: vi.fn(() => refused('host gone')) })
    const source = createConnectorsSource(d)
    await source.onCancelConnect('feishu')
    await source.onDisconnect('feishu')
    await source.onCheck()
    expect(d.cancelConnect).toHaveBeenCalledWith('feishu')
    expect(d.disconnect).toHaveBeenCalledWith('feishu')
    expect(source.hooks.connectors.getSnapshot().failure).toBe('host gone')
    const passing = createConnectorsSource(deps())
    await passing.onCheck()
    expect(passing.hooks.connectors.getSnapshot().failure).toBeNull()
    passing.onOpenUrl('https://example.com/a')
  })

  it('opens each step address of a sign-in it started once, and none of a sign-in started elsewhere', async () => {
    const openUrl = vi.fn((_url: string) => {})
    const d = deps({ openUrl })
    const source = createConnectorsSource(d)
    source.publish(feishu({ login: { step: 'create-app', url: 'https://open.feishu.cn/x', qrCode: null } }))
    expect(openUrl).not.toHaveBeenCalled()
    await source.onConnect('feishu')
    expect(d.connect).toHaveBeenCalledWith('feishu')
    // A frame from before the Host started the sign-in does not end it.
    source.publish(feishu({ status: 'disconnected' }))
    source.publish(feishu({ login: { step: 'create-app', url: null, qrCode: null } }))
    source.publish(feishu({ login: null }))
    source.publish(feishu({ login: { step: 'create-app', url: 'https://open.feishu.cn/x', qrCode: null } }))
    source.publish(feishu({ login: { step: 'create-app', url: 'https://open.feishu.cn/x', qrCode: 'data:' } }))
    source.publish(feishu({ login: { step: 'authorize', url: 'https://accounts.feishu.cn/y', qrCode: null } }))
    expect(openUrl.mock.calls).toEqual([['https://open.feishu.cn/x'], ['https://accounts.feishu.cn/y']])
    source.publish(feishu({ status: 'connected' }))
    source.publish(feishu({ login: { step: 'authorize', url: 'https://accounts.feishu.cn/z', qrCode: null } }))
    expect(openUrl).toHaveBeenCalledTimes(2)
  })
})
