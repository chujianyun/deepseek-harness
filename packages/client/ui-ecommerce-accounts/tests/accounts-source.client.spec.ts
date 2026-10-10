import { describe, expect, it, vi } from 'vitest'
import type { EcommerceAccountsState } from '@deepseek-ai/dsh-ecommerce-accounts/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { createAccountsSource } from '../src/client/accounts-source.ts'

const state = (revision: number): EcommerceAccountsState => ({
  revision, tenantId: 't-a', chrome: { status: 'ready', minVersion: 120, downloadUrl: 'u' }, buyerDailyPages: 20, accounts: [],
})
const ok = <T>(value: T) => Promise.resolve({ ok: true as const, value })
const refused = (error: RemoteError) => Promise.resolve({ ok: false, error } as never)

function harness() {
  const deps = {
    add: vi.fn(() => ok({ accountId: 'e1', state: state(5) })),
    startSignIn: vi.fn(() => ok(state(6))),
    confirmSignIn: vi.fn(() => ok(state(7))),
    rename: vi.fn(() => ok(state(7))),
    refresh: vi.fn(() => ok(state(8))),
    setDailyPages: vi.fn(() => ok(state(8))),
    remove: vi.fn(() => ok(state(9))),
    openUrl: vi.fn(),
  }
  const source = createAccountsSource(deps)
  return { deps, source, revision: () => source.hooks.accounts.getSnapshot().state?.revision }
}

describe('accounts source', () => {
  it('keeps the newer of the stream and each answer', async () => {
    const h = harness()
    expect(h.revision()).toBeUndefined()
    h.source.publish(state(10))
    expect(await h.source.onAdd({ platform: 'tmall', kind: 'merchant', storeName: 's', account: 'a' })).toEqual({ accountId: 'e1' })
    expect(h.revision()).toBe(10)
    h.source.publish(state(3))
    expect(h.revision()).toBe(10)
    h.source.publish(state(11))
    expect(await h.source.onStartSignIn('e1')).toBeUndefined()
    expect(await h.source.onConfirmSignIn('e1')).toBeUndefined()
    expect(await h.source.onRename('e1', { account: 'nick' })).toBeUndefined()
    expect(h.deps.rename).toHaveBeenCalledWith('e1', { account: 'nick' })
    await h.source.onRefresh()
    expect(await h.source.onSetDailyPages(30)).toBeUndefined()
    expect(h.deps.setDailyPages).toHaveBeenCalledWith(30)
    expect(await h.source.onDelete('e1')).toBeUndefined()
    expect(h.revision()).toBe(11)
    h.source.onOpenUrl('u')
    expect(h.deps.openUrl).toHaveBeenCalledWith('u')
  })

  it('words each refusal', async () => {
    const h = harness()
    h.deps.startSignIn.mockReturnValueOnce(refused(new RemoteError('ecommerce-accounts/chrome-missing', 'missing', {})))
    expect(await h.source.onStartSignIn('e1')).toEqual({ kind: 'chrome-missing' })
    h.deps.startSignIn.mockReturnValueOnce(refused(new RemoteError('ecommerce-accounts/chrome-outdated', 'old', { version: '100.0', minVersion: 120 })))
    expect(await h.source.onStartSignIn('e1')).toEqual({ kind: 'chrome-outdated', version: '100.0', minVersion: 120 })
    h.deps.add.mockReturnValueOnce(refused(new RemoteError('ecommerce-accounts/duplicate', 'dup', { accountId: 'e0' })))
    expect(await h.source.onAdd({ platform: 'tmall', kind: 'merchant', storeName: 's', account: 'a' })).toEqual({ kind: 'duplicate' })
    h.deps.startSignIn.mockReturnValueOnce(refused(new RemoteError('ecommerce-accounts/browser-busy', 'busy', { accountId: 'e1' })))
    expect(await h.source.onStartSignIn('e1')).toEqual({ kind: 'browser-busy' })
    h.deps.remove.mockReturnValueOnce(refused(new RemoteError('ecommerce-accounts/in-use', 'busy', { accountId: 'e1' })))
    expect(await h.source.onDelete('e1')).toEqual({ kind: 'in-use' })
    h.deps.remove.mockReturnValueOnce(refused(new RemoteError('ecommerce-accounts/delete-failed', 'locked', { accountId: 'e1', reason: 'EBUSY' })))
    expect(await h.source.onDelete('e1')).toEqual({ kind: 'delete-failed' })
    h.deps.remove.mockReturnValueOnce(refused(new RemoteError('ecommerce-accounts/not-found', 'gone', { accountId: 'e1' })))
    expect(await h.source.onDelete('e1')).toEqual({ kind: 'other', message: 'gone' })
  })
})
