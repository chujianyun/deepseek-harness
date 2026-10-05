import { describe, expect, it, vi } from 'vitest'
import type { HubAccountView } from '@deepseek-ai/dsh-hub-account/types'
import { createHubSource, type HubDependencies } from '../src/client/hub-source.ts'

const signedOut: HubAccountView = { status: 'signed-out', profile: null, reason: null, attempt: null, branding: null }
const waiting = (id: string, url?: string): HubAccountView => ({
  ...signedOut, attempt: { id, phase: 'waiting-browser', ...url === undefined ? {} : { authorizeUrl: url } },
})

function deps() {
  const ok = (value: HubAccountView) => Promise.resolve({ ok: true as const, value })
  return {
    signIn: vi.fn<HubDependencies['signIn']>(() => ok(waiting('a1'))),
    cancelSignIn: vi.fn<HubDependencies['cancelSignIn']>(() => ok({ ...signedOut, attempt: { id: 'a1', phase: 'cancelled' } })),
    signOut: vi.fn<HubDependencies['signOut']>(() => ok(signedOut)),
    switchTenant: vi.fn<HubDependencies['switchTenant']>(() => ok(waiting('a2'))),
    open: vi.fn<HubDependencies['open']>(),
  }
}

describe('hub source', () => {
  it('opens the sign-in page once the Host publishes it for an attempt this window started', async () => {
    const d = deps()
    const source = createHubSource(d)
    await source.onSignIn()
    expect(d.open).not.toHaveBeenCalled()
    source.publish(waiting('a1', 'https://hub/authorize?x'))
    source.publish(waiting('a1', 'https://hub/authorize?x'))
    expect(d.open).toHaveBeenCalledExactlyOnceWith('https://hub/authorize?x')
  })

  it('does not open a page for an attempt started elsewhere', () => {
    const d = deps()
    const source = createHubSource(d)
    source.publish(waiting('other', 'https://hub/authorize?y'))
    expect(d.open).not.toHaveBeenCalled()
  })

  it('opens the page when the frame arrives before the call returns', async () => {
    const d = deps()
    let release!: () => void
    d.signIn.mockImplementation(() => new Promise((resolve) => { release = () => { resolve({ ok: true, value: waiting('a1') }) } }))
    const source = createHubSource(d)
    const pending = source.onSignIn()
    source.publish(waiting('a1', 'https://hub/early'))
    release()
    await pending
    expect(d.open).toHaveBeenCalledExactlyOnceWith('https://hub/early')
  })

  it('switching tenant opens the new attempt; reopen opens the current page again', async () => {
    const d = deps()
    const source = createHubSource(d)
    await source.onSwitchTenant()
    source.publish(waiting('a2', 'https://hub/b'))
    source.onReopen()
    expect(d.open.mock.calls).toEqual([['https://hub/b'], ['https://hub/b']])
  })

  it('cancels the current attempt and records refusals', async () => {
    const d = deps()
    d.signOut.mockResolvedValue({ ok: false, error: { code: 'x', message: 'boom', details: {} } as never })
    const source = createHubSource(d)
    source.publish(waiting('a1', 'https://hub/a'))
    await source.onCancel()
    expect(d.cancelSignIn).toHaveBeenCalledWith('a1')
    await source.onSignOut()
    expect(source.hooks.hub.getSnapshot()).toMatchObject({ busy: false, failure: 'boom' })
  })

  it('ignores a frame for another attempt once the Host named this window\'s attempt', async () => {
    const d = deps()
    const source = createHubSource(d)
    await source.onSignIn()
    source.publish(waiting('elsewhere', 'https://hub/other'))
    expect(d.open).not.toHaveBeenCalled()
  })

  it('forgets the pending page when sign-in is refused, and does nothing without an attempt or a page', async () => {
    const d = deps()
    d.signIn.mockResolvedValue({ ok: false, error: { code: 'x', message: 'offline', details: {} } as never })
    const source = createHubSource(d)
    await source.onSignIn()
    expect(source.hooks.hub.getSnapshot().failure).toBe('offline')
    source.publish(waiting('a1', 'https://hub/a'))
    await source.onCancel()
    expect(d.cancelSignIn).toHaveBeenCalledOnce()
    source.publish(signedOut)
    await source.onCancel()
    source.onReopen()
    expect(d.cancelSignIn).toHaveBeenCalledOnce()
    expect(d.open).not.toHaveBeenCalled()
  })
})
