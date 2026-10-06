import { describe, expect, it, vi } from 'vitest'
import type { ConnectorsState } from '@deepseek-ai/dsh-connectors/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { createConnectorsSource } from '../src/client/connectors-source.ts'

const state: ConnectorsState = { connectors: [] }

describe('connectors source', () => {
  it('takes card state only from the stream, marks a connector busy during its action, and keeps the last refusal until dismissed', async () => {
    let finish!: () => void
    const install = vi.fn(() => new Promise<{ ok: true; value: ConnectorsState }>((resolve) => {
      finish = () => { resolve({ ok: true, value: { connectors: [] } }) }
    }))
    const uninstall = vi.fn(() => Promise.resolve({ ok: false as const, error: new RemoteError('connectors/not-found', 'no connector x', { id: 'x' }) }))
    const source = createConnectorsSource({ install, uninstall })
    expect(source.hooks.connectors.getSnapshot()).toEqual({ state: undefined, busy: [], failure: null })
    source.publish(state)
    const pending = source.onInstall('feishu')
    expect(source.hooks.connectors.getSnapshot().busy).toEqual(['feishu'])
    finish()
    await pending
    expect(source.hooks.connectors.getSnapshot()).toEqual({ state, busy: [], failure: null })
    await source.onUninstall('x')
    expect(uninstall).toHaveBeenCalledWith('x')
    expect(source.hooks.connectors.getSnapshot().failure).toBe('no connector x')
    source.onDismiss()
    expect(source.hooks.connectors.getSnapshot().failure).toBeNull()
  })
})
