// @vitest-environment jsdom
import { Context, Service } from '@deepseek-ai/cordis'
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { TestRemote, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import type { HubAccountView } from '@deepseek-ai/dsh-hub-account/types'
import { apply, inject } from '../src/client/index.ts'
import { apply as applyNode } from '../src/index.ts'
import type { HubAccountInjected } from '../src/client/hub-source.ts'
import { HubAccountSection } from '../src/client/HubAccountSection.tsx'
import { HubLauncher } from '../src/client/HubLauncher.tsx'
import { HubBrandMark, HubBrandName, HubHeroHeadline, HubHeroMark } from '../src/client/HubBrand.tsx'
import type { HubBrandInjected } from '../src/client/brand-source.ts'

usePinnedBrowserLanguages('zh-CN')

beforeAll(() => { Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 }, configurable: true }) })
afterAll(() => { Reflect.deleteProperty(globalThis, 'dshDesktop') })

const signedOut: HubAccountView = { status: 'signed-out', profile: null, reason: null, attempt: null, branding: null }

async function bench() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  class LocaleHolder extends Service {
    constructor(serviceCtx: Context) { super(serviceCtx, 'localeHolder') }
  }
  new LocaleHolder(ctx)
  const ok = (value: HubAccountView) => Promise.resolve({ ok: true as const, value })
  const hubAccount = {
    signIn: vi.fn(() => ok({ ...signedOut, attempt: { id: 'a1', phase: 'waiting-browser' } })),
    cancelSignIn: vi.fn(() => ok(signedOut)),
    signOut: vi.fn(() => ok(signedOut)),
    switchTenant: vi.fn(() => ok(signedOut)),
    getBranding: vi.fn(() => Promise.resolve({ ok: true as const, value: { tenantId: 't-a', title: '甲公司', slogan: '标语', logo: null } })),
    watch: vi.fn(),
  }
  const remote = new TestRemote(ctx, { hubAccount })
  // Frames the Host stream delivers, pushed by the spec.
  const frames: HubAccountView[] = []
  let wake: (() => void) | undefined
  const accepted = vi.fn()
  const dispose = vi.fn(async () => {})
  const streamOptions: { open?: (signal: AbortSignal) => unknown; ended?: () => Error } = {}
  let fail: ((error: Error) => void) | undefined
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
  const push = (value: HubAccountView) => { frames.push(value); wake?.() }
  const slots = ctx.get('slots') as SlotRegistry
  const removeRoot = slots.register({
    name: 'root',
    children: {
      'settings.section': { kind: 'list', scope: 'root' }, 'settings.launcher': { kind: 'single', scope: 'root' },
      'sidebar.brand.mark': { kind: 'single', scope: 'root' }, 'sidebar.brand.name': { kind: 'single', scope: 'root' },
      'conversation.hero.brand.mark': { kind: 'single', scope: 'root' }, 'conversation.hero.brand.headline': { kind: 'single', scope: 'root' },
    },
  } as never, () => null)
  onTestFinished(removeRoot)
  return { ctx, slots, hubAccount, push, accepted, dispose, streamOptions, fail: (error: Error) => fail?.(error) }
}

/**
 * Read the account section entry's injected face. A stored entry types its callback as returning a plain record,
 * while the plugin's callback returns the face object.
 * @param slots - slot registry the plugin registered into.
 * @returns the injected face object.
 */
function face(slots: SlotRegistry): object {
  const injected = slots.entries('settings.section')[0]?.inject?.()
  if (injected === undefined) throw new Error('section injected no face')
  return injected
}

describe('ui-hub-account browser plugin', () => {
  it('registers the launcher and the account section, and withdraws both and the stream with the plugin', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const [launcher] = b.slots.entries('settings.launcher')
    expect(launcher?.component).toBe(HubLauncher)
    expect(launcher!.inject!()).toBe(face(b.slots))
    const [section] = b.slots.entries('settings.section')
    expect(section?.component).toBe(HubAccountSection)
    expect(section!.options).toMatchObject({ id: 'hub-account', order: -20 })
    expect(resolveSlotLabel(section!.options.label)).toMatch(/^Skill Hub/)
    expect(b.slots.entries('sidebar.brand.mark')[0]?.component).toBe(HubBrandMark)
    expect(b.slots.entries('sidebar.brand.name')[0]?.component).toBe(HubBrandName)
    expect(b.slots.entries('conversation.hero.brand.mark')[0]?.component).toBe(HubHeroMark)
    expect(b.slots.entries('conversation.hero.brand.headline')[0]?.component).toBe(HubHeroHeadline)
    await fiber.dispose()
    expect(b.slots.entries('settings.section')).toEqual([])
    expect(b.slots.entries('settings.launcher')).toEqual([])
    expect(b.slots.entries('sidebar.brand.mark')).toEqual([])
    expect(b.slots.entries('sidebar.brand.name')).toEqual([])
    expect(b.slots.entries('conversation.hero.brand.mark')).toEqual([])
    expect(b.slots.entries('conversation.hero.brand.headline')).toEqual([])
    expect(b.dispose).toHaveBeenCalledOnce()
  })

  it('publishes Host frames and wires the actions to the hubAccount Remote', async () => {
    const b = await bench()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const injected = face(b.slots) as HubAccountInjected
    const opened = vi.spyOn(window, 'open').mockReturnValue(null)
    onTestFinished(() => { opened.mockRestore() })
    b.push(signedOut)
    await vi.waitFor(() => { expect(b.accepted).toHaveBeenCalledOnce() })
    expect(injected.hooks.hub.getSnapshot().view).toEqual(signedOut)
    await injected.onSignIn()
    b.push({ ...signedOut, attempt: { id: 'a1', phase: 'waiting-browser', authorizeUrl: 'https://hub.example/oauth/authorize?x' } })
    await vi.waitFor(() => { expect(opened).toHaveBeenCalledWith('https://hub.example/oauth/authorize?x', '_blank', 'noopener,noreferrer') })
    await injected.onCancel()
    await injected.onSwitchTenant()
    await injected.onSignOut()
    expect(b.hubAccount.cancelSignIn).toHaveBeenCalledWith('a1')
    expect(b.hubAccount.switchTenant).toHaveBeenCalledOnce()
    expect(b.hubAccount.signOut).toHaveBeenCalledOnce()
  })

  it('reads the signed-in tenant\'s branding when a frame names it', async () => {
    const b = await bench()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const brand: object = b.slots.entries('sidebar.brand.name')[0]!.inject!()
    if (!('hooks' in brand)) throw new Error('brand name injected no face')
    const { hooks } = brand as HubBrandInjected
    expect(hooks.hub).toBe((face(b.slots) as HubAccountInjected).hooks.hub)
    expect(b.slots.entries('sidebar.brand.mark')[0]!.inject!()).toBe(brand)
    // The new-session hero reads the same branding.
    expect(b.slots.entries('conversation.hero.brand.mark')[0]!.inject!()).toBe(brand)
    expect(b.slots.entries('conversation.hero.brand.headline')[0]!.inject!()).toBe(brand)
    b.push({ ...signedOut, status: 'signed-in', branding: { tenantId: 't-a', title: '甲公司', slogan: '标语', logoSha256: null } })
    await vi.waitFor(() => { expect(hooks.brand.getSnapshot()).toEqual({ tenantId: 't-a', title: '甲公司', slogan: '标语', logo: null }) })
    expect(b.hubAccount.getBranding).toHaveBeenCalledOnce()
  })

  it('opens the Host stream through hubAccount.watch and survives a broken stream', async () => {
    const b = await bench()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const signal = new AbortController().signal
    b.streamOptions.open!(signal)
    expect(b.hubAccount.watch).toHaveBeenCalledWith(signal)
    expect(b.streamOptions.ended!().message).toBe('hub account stream ended')
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
      expect(b.slots.entries('settings.launcher')).toEqual([])
    } finally {
      Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 }, configurable: true })
    }
  })

  it('has a node half that contributes nothing', () => {
    expect(() => { applyNode() }).not.toThrow()
  })
})
