// @vitest-environment jsdom
import { Context, Service } from '@deepseek-ai/cordis'
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionSyncView } from '@deepseek-ai/dsh-session-sync/client'
import { apply, inject } from '../src/client/index.ts'
import { apply as applyNode } from '../src/index.ts'
import {
  ContinuationHover, ContinuationLabel, ContinueDialog, PulledBadge, PulledComposer, PulledHover,
  type ContinuationInjected, type ContinueDialogInjected, type PulledComposerInjected, type PulledRowInjected,
} from '../src/client/SessionSync.tsx'

const view = (changes: number, pulled: SessionSyncView['pulled'], continuations: SessionSyncView['continuations'] = []): SessionSyncView =>
  ({ signedIn: true, changes, pulled, continuations })
const A = 'from-a' as SessionId
const B = 'from-b' as SessionId

describe('ui-session-sync browser plugin', () => {
  beforeAll(() => { Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 }, configurable: true }) })
  afterAll(() => { Reflect.deleteProperty(globalThis, 'dshDesktop') })

  it('adds nothing in a browser tab, which has no Hub sign-in of its own', () => {
    Reflect.deleteProperty(globalThis, 'dshDesktop')
    const slots = { inject: vi.fn() }
    apply({ slots, effect: vi.fn() } as never)
    expect(slots.inject).not.toHaveBeenCalled()
    Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 }, configurable: true })
  })

  it('marks pulled rows, claims their composer, reloads the list when they change, pulls on focus, and leaves with the plugin', async () => {
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    await ctx.plugin(SlotRegistry).await()
    ctx.provide('locale', new LocaleRuntime(ctx))
    class LocaleHolder extends Service {
      constructor(serviceCtx: Context) { super(serviceCtx, 'localeHolder') }
    }
    new LocaleHolder(ctx)
    const sessions = { refresh: vi.fn(async () => {}), refreshProjections: vi.fn(async () => {}) }
    ctx.provide('sessions', sessions as never)
    const ok = <T,>(value: T) => vi.fn(async () => ({ ok: true as const, value }))
    const sessionSync = {
      watch: vi.fn(), refresh: ok(undefined),
      continueInfo: ok({ folder: '/work', folderHere: true }), continueConversation: ok({ sessionId: 'continued-1' }),
    }
    const uiWorkspace = { openSession: vi.fn(), pickDirectory: vi.fn(async () => '/picked') }
    ctx.provide('uiWorkspace', uiWorkspace as never)
    const remote = new TestRemote(ctx, { sessionSync })
    const frames: SessionSyncView[] = []
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
      children: {
        'sidebar.session.row.badge': { kind: 'list', scope: 'root' },
        'sidebar.session.row.hover': { kind: 'list', scope: 'root' },
        'conversation.composer': { kind: 'chain', scope: 'session' },
        'shell.overlay': { kind: 'list', scope: 'root' },
        'conversation.session.header.actions': { kind: 'list', scope: 'session' },
      },
    } as never, () => null)
    onTestFinished(removeRoot)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    const [badge] = slots.entries('sidebar.session.row.badge')
    expect(badge?.component).toBe(PulledBadge)
    expect(badge!.options).toMatchObject({ id: 'session-sync-badge' })
    const [hover, continuedHover] = slots.entries('sidebar.session.row.hover')
    expect(hover?.component).toBe(PulledHover)
    expect(continuedHover?.component).toBe(ContinuationHover)
    const [overlay] = slots.entries('shell.overlay')
    expect(overlay?.component).toBe(ContinueDialog)
    const [label] = slots.entries('conversation.session.header.actions')
    expect(label?.component).toBe(ContinuationLabel)
    const [composer] = slots.entries('conversation.composer')
    expect(composer?.component).toBe(PulledComposer)
    const face = badge!.inject!() as object as PulledRowInjected
    expect(hover!.inject!()).toBe(face)
    const continuationFace = label!.inject!() as object as ContinuationInjected
    expect(continuedHover!.inject!()).toBe(continuationFace)
    const dialogFace = overlay!.inject!() as object as ContinueDialogInjected
    const composerFace = composer!.inject!() as object as PulledComposerInjected
    // The composer's button asks for the dialog; the dialog's calls reach the Remote, the picker, and navigation.
    composerFace.requestContinue(A)
    expect(dialogFace.hooks.continueRequest.getSnapshot()).toBe(A)
    dialogFace.settleContinue()
    expect(dialogFace.hooks.continueRequest.getSnapshot()).toBeNull()
    await dialogFace.continueInfo(A)
    expect(sessionSync.continueInfo).toHaveBeenCalledWith({ sessionId: A })
    await dialogFace.continueConversation(A, '/work')
    expect(sessionSync.continueConversation).toHaveBeenCalledWith({ sessionId: A, cwd: '/work' })
    expect(await dialogFace.pickFolder()).toBe('/picked')
    Object.defineProperty(globalThis, '__DSH_DIRECTORY_PICKER__', { value: { pick: async () => '/desktop-picked' }, configurable: true })
    expect(await dialogFace.pickFolder()).toBe('/desktop-picked')
    Reflect.deleteProperty(globalThis, '__DSH_DIRECTORY_PICKER__')
    continuationFace.open(A)
    expect(uiWorkspace.openSession).toHaveBeenCalledWith(A)
    const select = composer!.select as (owner: object) => unknown

    const signal = new AbortController().signal
    streamOptions.open?.(signal)
    expect(sessionSync.watch).toHaveBeenCalledWith(signal)
    expect(streamOptions.ended?.().message).toBe('session sync stream ended')
    // The first state only sets what the rows show; the list was just loaded.
    frames.push(view(0, [{ sessionId: A, device: '前台电脑', revision: 1 }]))
    wake?.()
    await vi.waitFor(() => { expect(face.hooks.pulled.getSnapshot()).toEqual({ [A]: '前台电脑' }) })
    expect(sessions.refresh).not.toHaveBeenCalled()
    expect(select({ sessionId: A })).toEqual({ sessionId: A, device: '前台电脑' })
    expect(select({ sessionId: 'own' })).toBeNull()
    expect(select({ sessionId: undefined })).toBeNull()
    // A change with the same rows at the same revisions reloads the list only.
    frames.push(view(1, [{ sessionId: A, device: '前台电脑', revision: 1 }]))
    wake?.()
    await vi.waitFor(() => { expect(sessions.refresh).toHaveBeenCalledOnce() })
    expect(sessions.refreshProjections).not.toHaveBeenCalled()
    // A newer revision, and a new row, also re-read their projections.
    frames.push(view(2, [{ sessionId: A, device: '前台电脑', revision: 2 }, { sessionId: B, device: '前台电脑', revision: 1 }]))
    wake?.()
    await vi.waitFor(() => { expect(sessions.refreshProjections.mock.calls).toEqual([[A], [B]]) })
    // A state without a change reloads nothing.
    frames.push(view(2, [{ sessionId: A, device: '前台电脑', revision: 2 }], [{ sessionId: B, sourceId: A, title: null, device: '前台电脑' }]))
    wake?.()
    await vi.waitFor(() => { expect(accepted).toHaveBeenCalledTimes(4) })
    expect(continuationFace.hooks.continuations.getSnapshot()).toEqual({ [B]: { sessionId: B, sourceId: A, title: null, device: '前台电脑' } })
    expect(sessions.refresh).toHaveBeenCalledTimes(2)

    window.dispatchEvent(new Event('focus'))
    document.dispatchEvent(new Event('visibilitychange'))
    expect(sessionSync.refresh).toHaveBeenCalledTimes(2)
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(sessionSync.refresh).toHaveBeenCalledTimes(2)
    Reflect.deleteProperty(document, 'visibilityState')

    // A stream that fails stops the listener without an unhandled rejection.
    fail?.(new Error('stream broke'))
    await fiber.dispose()
    expect(dispose).toHaveBeenCalledOnce()
    window.dispatchEvent(new Event('focus'))
    expect(sessionSync.refresh).toHaveBeenCalledTimes(2)
    expect(slots.entries('sidebar.session.row.badge')).toEqual([])
    expect(slots.entries('conversation.composer')).toEqual([])
    applyNode()
  })
})
