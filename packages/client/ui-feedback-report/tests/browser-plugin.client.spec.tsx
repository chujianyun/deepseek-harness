// @vitest-environment jsdom
import { Context, Service } from '@deepseek-ai/cordis'
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import type { HubAccountView } from '@deepseek-ai/dsh-hub-account/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { apply, inject } from '../src/client/index.ts'
import { apply as applyNode } from '../src/index.ts'
import {
  ReportButton, ReportDialog, ReportNotice, type ReportButtonInjected, type ReportDialogInjected, type ReportNoticeInjected,
} from '../src/client/ReportDialog.tsx'

const view = (status: HubAccountView['status']): HubAccountView => ({ status, profile: null, reason: null, attempt: null, branding: null })

describe('ui-feedback-report browser plugin', () => {
  beforeAll(() => { Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 }, configurable: true }) })
  afterAll(() => { Reflect.deleteProperty(globalThis, 'dshDesktop') })

  it('adds nothing in a browser tab, which has no Hub sign-in of its own', () => {
    Reflect.deleteProperty(globalThis, 'dshDesktop')
    const slots = { inject: vi.fn() }
    apply({ slots, effect: vi.fn() } as never)
    expect(slots.inject).not.toHaveBeenCalled()
    Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 }, configurable: true })
  })

  it('adds the button, the dialog, the notice, and the menu entry over the Remotes, follows the sign-in, and leaves with the plugin', async () => {
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    await ctx.plugin(SlotRegistry).await()
    ctx.provide('locale', new LocaleRuntime(ctx))
    class LocaleHolder extends Service {
      constructor(serviceCtx: Context) { super(serviceCtx, 'localeHolder') }
    }
    new LocaleHolder(ctx)
    const receipt = { id: 'fb-1', createdAt: '2026-10-11T12:00:00.000Z' }
    const feedbackReport = { submit: vi.fn(async () => ({ ok: true as const, value: receipt })) }
    const hubAccount = { watch: vi.fn() }
    const remote = new TestRemote(ctx, { feedbackReport, hubAccount })
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
      children: { 'conversation.session.header.utilities': { kind: 'list', scope: 'root' }, 'shell.overlay': { kind: 'list', scope: 'root' } },
    } as never, () => null)
    onTestFinished(removeRoot)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    const [button] = slots.entries('conversation.session.header.utilities')
    expect(button?.component).toBe(ReportButton)
    expect(button!.options).toMatchObject({ id: 'feedback-report', order: -8 })
    const overlays = slots.entries('shell.overlay')
    expect(overlays.map(entry => entry.component)).toEqual([ReportDialog, ReportNotice])
    const buttonFace = button!.inject!() as object as ReportButtonInjected
    const dialogFace = overlays[0]!.inject!() as object as ReportDialogInjected
    const noticeFace = overlays[1]!.inject!() as object as ReportNoticeInjected

    const signal = new AbortController().signal
    streamOptions.open?.(signal)
    expect(hubAccount.watch).toHaveBeenCalledWith(signal)
    expect(streamOptions.ended?.().message).toBe('hub account stream ended')
    expect(buttonFace.hooks.signedIn.getSnapshot()).toBe(false)
    frames.push(view('signed-in'))
    wake?.()
    await vi.waitFor(() => { expect(buttonFace.hooks.signedIn.getSnapshot()).toBe(true) })
    expect(accepted).toHaveBeenCalledOnce()

    const one = 'one' as SessionId
    buttonFace.requestReport({ sessionId: one })
    expect(dialogFace.hooks.reportRequest.getSnapshot()).toEqual({ sessionId: one })
    dialogFace.settleReport()
    expect(dialogFace.hooks.reportRequest.getSnapshot()).toBeNull()
    const request = { category: 'error' as const, description: 'x', sessionId: one, attachSession: true, images: [] }
    expect(await dialogFace.submit(request)).toEqual({ ok: true, value: receipt })
    expect(feedbackReport.submit).toHaveBeenCalledWith(request)
    expect(dialogFace.uiLanguage()).toBe(ctx.locale.getSnapshot().active)
    dialogFace.notifySubmitted()
    dialogFace.notifySubmitted()
    expect(noticeFace.hooks.submitted.getSnapshot()).toBe(2)
    noticeFace.dismissNotice()
    expect(noticeFace.hooks.submitted.getSnapshot()).toBe(0)

    frames.push(view('signed-out'))
    wake?.()
    await vi.waitFor(() => { expect(buttonFace.hooks.signedIn.getSnapshot()).toBe(false) })
    fail?.(new Error('stream broke'))
    await fiber.dispose()
    expect(dispose).toHaveBeenCalledOnce()
    expect(slots.entries('conversation.session.header.utilities')).toEqual([])
    expect(slots.entries('shell.overlay')).toEqual([])
    applyNode()
  })
})
