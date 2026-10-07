// @vitest-environment jsdom
import { Context, Service } from '@deepseek-ai/cordis'
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { EcommerceAccountsState } from '@deepseek-ai/dsh-ecommerce-accounts/types'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { TestRemote, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject } from '../src/client/index.ts'
import { apply as applyNode } from '../src/index.ts'
import type { AccountsInjected } from '../src/client/accounts-source.ts'
import { EcommerceAccountsSection } from '../src/client/EcommerceAccountsSection.tsx'
import { ExpiredToast, type ExpiredNotice, type ExpiredToastProps } from '../src/client/ExpiredToast.tsx'

usePinnedBrowserLanguages('zh-CN')

beforeAll(() => { Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 }, configurable: true }) })
afterAll(() => { Reflect.deleteProperty(globalThis, 'dshDesktop') })

const CHROME = { status: 'ready', minVersion: 120, downloadUrl: 'https://www.google.com/chrome/' } as const
const signedIn: EcommerceAccountsState = { revision: 1, tenantId: 't-a', chrome: CHROME, accounts: [] }
const ok = <T,>(value: T) => Promise.resolve({ ok: true as const, value })

async function bench() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  class LocaleHolder extends Service {
    constructor(serviceCtx: Context) { super(serviceCtx, 'localeHolder') }
  }
  new LocaleHolder(ctx)
  const ecommerceAccounts = {
    addAccount: vi.fn(() => ok({ accountId: 'e1', state: signedIn })),
    startSignIn: vi.fn(() => ok(signedIn)),
    confirmSignIn: vi.fn(() => ok(signedIn)),
    renameAccount: vi.fn(() => ok(signedIn)),
    refresh: vi.fn(() => ok(signedIn)),
    deleteAccount: vi.fn(() => ok(signedIn)),
    watch: vi.fn(),
  }
  const remote = new TestRemote(ctx, { ecommerceAccounts })
  const frames: EcommerceAccountsState[] = []
  let wake: (() => void) | undefined
  let fail: ((error: Error) => void) | undefined
  const options: { open?: (signal: AbortSignal) => unknown; ended?: () => Error } = {}
  const dispose = vi.fn(async () => {})
  Object.assign(remote, {
    $stream: (opened: { open: (signal: AbortSignal) => unknown; ended: () => Error }) => {
      Object.assign(options, opened)
      return {
        dispose,
        async *[Symbol.asyncIterator]() {
          for (;;) {
            const value = frames.shift()
            if (value !== undefined) { yield { value, accept: () => {} }; continue }
            await new Promise<void>((resolve, reject) => { wake = resolve; fail = reject })
          }
        },
      }
    },
  })
  const slots = ctx.get('slots') as SlotRegistry
  const removeRoot = slots.register({ name: 'root', children: { 'settings.section': { kind: 'list', scope: 'root' }, 'shell.overlay': { kind: 'list', scope: 'root' } } } as never, () => null)
  onTestFinished(removeRoot)
  return {
    ctx, slots, ecommerceAccounts, options, dispose,
    push: (value: EcommerceAccountsState) => { frames.push(value); wake?.() },
    fail: (error: Error) => { fail?.(error) },
  }
}

describe('ui-ecommerce-accounts browser plugin', () => {
  it('shows the Settings section only while signed in to the user center, and withdraws it with the plugin', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.slots.entries('settings.section')).toEqual([])
    b.push(signedIn)
    await vi.waitFor(() => { expect(b.slots.entries('settings.section')).toHaveLength(1) })
    const [entry] = b.slots.entries('settings.section')
    expect(entry).toMatchObject({ component: EcommerceAccountsSection, options: { id: 'ecommerce-accounts', order: -10 } })
    expect(resolveSlotLabel(entry!.options.label)).toBe('电商账号')
    b.push({ ...signedIn, revision: 2 })
    b.push({ ...signedIn, revision: 3, tenantId: null })
    await vi.waitFor(() => { expect(b.slots.entries('settings.section')).toEqual([]) })
    b.push({ ...signedIn, revision: 4, tenantId: null })
    b.push({ ...signedIn, revision: 5 })
    await vi.waitFor(() => { expect(b.slots.entries('settings.section')).toHaveLength(1) })
    await fiber.dispose()
    expect(b.slots.entries('settings.section')).toEqual([])
    expect(b.dispose).toHaveBeenCalledOnce()
  })

  it('drives the Remote, opens the download page in a new window, and keeps going after the stream ends', async () => {
    const b = await bench()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    b.push(signedIn)
    await vi.waitFor(() => { expect(b.slots.entries('settings.section')).toHaveLength(1) })
    const face: object = b.slots.entries('settings.section')[0]!.inject!()
    const injected = face as AccountsInjected
    await injected.onAdd({ platform: 'tmall', kind: 'merchant', storeName: 's', account: 'a' })
    expect(b.ecommerceAccounts.addAccount).toHaveBeenCalledWith({ platform: 'tmall', kind: 'merchant', storeName: 's', account: 'a' })
    await injected.onStartSignIn('e1')
    expect(b.ecommerceAccounts.startSignIn).toHaveBeenCalledWith('e1')
    await injected.onConfirmSignIn('e1')
    expect(b.ecommerceAccounts.confirmSignIn).toHaveBeenCalledWith('e1')
    await injected.onRename('e1', { account: 'nick' })
    expect(b.ecommerceAccounts.renameAccount).toHaveBeenCalledWith('e1', { account: 'nick' })
    await injected.onRefresh()
    expect(b.ecommerceAccounts.refresh).toHaveBeenCalledOnce()
    await injected.onDelete('e1')
    expect(b.ecommerceAccounts.deleteAccount).toHaveBeenCalledWith('e1')
    const open = vi.spyOn(globalThis, 'open').mockReturnValue(null)
    injected.onOpenUrl('https://www.google.com/chrome/')
    expect(open).toHaveBeenCalledWith('https://www.google.com/chrome/', '_blank', 'noopener')
    const signal = new AbortController().signal
    b.options.open!(signal)
    expect(b.ecommerceAccounts.watch).toHaveBeenCalledWith(signal)
    expect(b.options.ended!().message).toBe('ecommerce accounts stream ended')
    b.fail(new Error('gone'))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(b.slots.entries('settings.section')).toHaveLength(1)
  })

  it('announces an expired sign-in in the overlay, whose action opens the accounts in Settings', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const [overlay] = b.slots.entries('shell.overlay')
    expect(overlay).toMatchObject({ component: ExpiredToast, options: { id: 'ecommerce-accounts.expired' } })
    const face: Pick<ExpiredToastProps, 'dismiss' | 'openAccounts'> & { hooks: { notice: { getSnapshot: () => ExpiredNotice | null } } } = overlay!.inject!() as never
    const account = { id: 'e1', platform: 'tmall', kind: 'merchant', storeName: '名流旗舰店', account: 'a', createdAt: '', status: 'signed-out', expired: true, inUse: false } as const
    b.push({ ...signedIn, accounts: [account] })
    await vi.waitFor(() => { expect(face.hooks.notice.getSnapshot()?.name).toBe('名流旗舰店') })
    const opened = vi.fn()
    b.ctx.on('settings/open-section', opened)
    face.openAccounts()
    expect(opened).toHaveBeenCalledWith('ecommerce-accounts')
    face.dismiss()
    expect(face.hooks.notice.getSnapshot()).toBeNull()
    await fiber.dispose()
    expect(b.slots.entries('shell.overlay')).toEqual([])
  })

  it('stays out of a non-Desktop renderer, and the node half does nothing', async () => {
    Reflect.deleteProperty(globalThis, 'dshDesktop')
    try {
      const b = await bench()
      await b.ctx.plugin({ inject: [...inject], apply }).await()
      b.push(signedIn)
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(b.slots.entries('settings.section')).toEqual([])
    } finally {
      Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 }, configurable: true })
    }
    expect(() => { applyNode() }).not.toThrow()
  })
})
