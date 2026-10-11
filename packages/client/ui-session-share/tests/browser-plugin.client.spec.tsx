// @vitest-environment jsdom
import { Context, Service } from '@deepseek-ai/cordis'
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import type { HubAccountView } from '@deepseek-ai/dsh-hub-account/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionShareId } from '@deepseek-ai/dsh-session-share/client'
import { apply, inject } from '../src/client/index.ts'
import { apply as applyNode } from '../src/index.ts'
import { SessionShareDialog, ShareSessionMenuItem, type SessionShareDialogInjected, type ShareSessionInjected } from '../src/client/ShareSession.tsx'

const view = (status: HubAccountView['status']): HubAccountView => ({ status, profile: null, reason: null, attempt: null, branding: null })

describe('ui-session-share browser plugin', () => {
  beforeAll(() => { Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 }, configurable: true }) })
  afterAll(() => { Reflect.deleteProperty(globalThis, 'dshDesktop') })

  it('adds nothing in a browser tab, which has no Hub sign-in of its own', async () => {
    Reflect.deleteProperty(globalThis, 'dshDesktop')
    const slots = { inject: vi.fn() }
    apply({ slots, effect: vi.fn() } as never)
    expect(slots.inject).not.toHaveBeenCalled()
    Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 }, configurable: true })
  })

  it('adds the menu row and the dialog over the Remotes, follows the sign-in, and leaves with the plugin', async () => {
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    await ctx.plugin(SlotRegistry).await()
    ctx.provide('locale', new LocaleRuntime(ctx))
    class LocaleHolder extends Service {
      constructor(serviceCtx: Context) { super(serviceCtx, 'localeHolder') }
    }
    new LocaleHolder(ctx)
    const ok = <T,>(value: T) => vi.fn(async () => ({ ok: true as const, value }))
    const link = { shareId: 'sh-1' as SessionShareId, url: 'https://hub.example/share/sh-1', createdAt: 'c', updatedAt: 'u' }
    const sessionShare = { status: ok({ signedIn: true, link: null }), share: ok(link), revoke: ok(undefined) }
    const hubAccount = { watch: vi.fn() }
    const remote = new TestRemote(ctx, { sessionShare, hubAccount })
    const frames: HubAccountView[] = []
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
    const removeRoot = slots.register({
      name: 'root',
      children: { 'sidebar.workspaces.session.menu.item': { kind: 'list', scope: 'root' }, 'shell.overlay': { kind: 'list', scope: 'root' } },
    } as never, () => null)
    onTestFinished(removeRoot)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    const [row] = slots.entries('sidebar.workspaces.session.menu.item')
    expect(row?.component).toBe(ShareSessionMenuItem)
    expect(row!.options).toMatchObject({ id: 'share', order: 350 })
    const [overlay] = slots.entries('shell.overlay')
    expect(overlay?.component).toBe(SessionShareDialog)
    const rowFace = row!.inject!() as object as ShareSessionInjected
    const dialogFace = overlay!.inject!() as object as SessionShareDialogInjected

    // The stream reads the hubAccount Remote and names its own end.
    const signal = new AbortController().signal
    streamOptions.open?.(signal)
    expect(hubAccount.watch).toHaveBeenCalledWith(signal)
    expect(streamOptions.ended?.().message).toBe('hub account stream ended')
    expect(rowFace.hooks.signedIn.getSnapshot()).toBe(false)
    frames.push(view('signed-in'))
    wake?.()
    await vi.waitFor(() => { expect(rowFace.hooks.signedIn.getSnapshot()).toBe(true) })
    expect(accepted).toHaveBeenCalledOnce()
    frames.push(view('signed-out'))
    wake?.()
    await vi.waitFor(() => { expect(rowFace.hooks.signedIn.getSnapshot()).toBe(false) })

    const one = 'one' as SessionId
    rowFace.requestSessionShare({ sessionId: one, title: '复盘' })
    expect(dialogFace.hooks.shareRequest.getSnapshot()).toEqual({ sessionId: one, title: '复盘' })
    await dialogFace.loadStatus(one)
    expect(sessionShare.status).toHaveBeenCalledWith({ sessionId: one })
    expect(await dialogFace.share({ sessionId: one, title: '复盘' })).toEqual({ ok: true, value: link })
    expect(sessionShare.share).toHaveBeenCalledWith({ sessionId: one, title: '复盘' })
    await dialogFace.revoke(one)
    expect(sessionShare.revoke).toHaveBeenCalledWith({ sessionId: one })
    expect(typeof await dialogFace.copyLink('https://hub.example/share/sh-1')).toBe('boolean')
    dialogFace.settleSessionShare()
    expect(dialogFace.hooks.shareRequest.getSnapshot()).toBeNull()

    // A stream that fails stops the listener without an unhandled rejection.
    fail?.(new Error('stream broke'))
    await fiber.dispose()
    expect(dispose).toHaveBeenCalledOnce()
    expect(slots.entries('sidebar.workspaces.session.menu.item')).toEqual([])
    expect(slots.entries('shell.overlay')).toEqual([])
    applyNode()
  })
})
