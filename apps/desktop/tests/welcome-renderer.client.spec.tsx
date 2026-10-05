// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Welcome } from '../src/client/WelcomePage.tsx'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveDesktopLocale } from '../src/locale.ts'
import type { HubAccountView, HubSignInAttemptView } from '@deepseek-ai/dsh-hub-account/types'
import type { WelcomeNotice } from '../src/welcome-api.ts'

const html = readFileSync(join(import.meta.dirname, '../renderer/welcome.html'), 'utf8')
afterEach(cleanup)

const signedOut: HubAccountView = { status: 'signed-out', profile: null, reason: null, attempt: null }
const withAttempt = (attempt: HubSignInAttemptView): HubAccountView => ({ ...signedOut, attempt })

function mount(language = 'zh-CN', takeNotice = vi.fn<() => Promise<WelcomeNotice | undefined>>().mockResolvedValue(undefined)) {
  cleanup()
  const stopAccount = vi.fn()
  const api = {
    takeNotice,
    analytics: vi.fn(async (_event: string, _attributes: object) => {}),
    analyticsEnabled: async () => true,
    onAccountState: vi.fn((_listener: (state: HubAccountView) => void) => stopAccount),
    startSignIn: vi.fn(async (): Promise<HubAccountView> => signedOut),
    cancelSignIn: vi.fn(async (): Promise<HubAccountView> => signedOut),
    copySignInLink: vi.fn(async () => undefined),
    ...resolveDesktopLocale(language),
  }
  const mounted = render(<Welcome api={api} />)
  const button = (id: string) => document.querySelector<HTMLButtonElement>(id)!
  const receive = (state: HubAccountView) => { act(() => { api.onAccountState.mock.calls[0]![0](state) }) }
  const copy = () => {
    const heading = document.querySelector('main')!.getAttribute('aria-labelledby')!
    return [
      document.title, document.querySelector('img')!.alt, document.getElementById(heading)!.textContent,
      ...heading === 'welcome-heading' ? [document.querySelector('#welcome-description')!.textContent] : [],
      ...[...document.querySelectorAll('button')].filter(item => item.closest('[hidden]') === null)
        .map(item => `${item.textContent || item.getAttribute('aria-label')}${item.disabled ? ' [disabled]' : ''}`),
      '',
    ].join('\n')
  }
  return { document, api, button, receive, copy, unmount: mounted.unmount, stopAccount }
}

describe('desktop welcome presentation', () => {
  it.each(['zh-CN', 'en'])('renders the %s entry with the company sign-in as its only action', async (language) => {
    const view = mount(language)
    expect(view.document.documentElement.lang).toBe(language)
    expect(view.document.querySelector('img')!.getAttribute('src')).toBe('assets/welcome-brand.svg')
    expect(view.document.querySelector('input')).toBeNull()
    await expect(view.copy()).toMatchFileSnapshot(`./expected/welcome/${language}.expected.txt`)
  })

  it('starts a sign-in and shows the attempt the Host returns', async () => {
    const view = mount()
    const started = Promise.withResolvers<HubAccountView>()
    view.api.startSignIn.mockReturnValueOnce(started.promise)
    fireEvent.click(view.button('#sign-in'))
    expect(view.api.analytics).toHaveBeenCalledWith('auth_page_click', { button_name: 'sign_in' })
    expect(view.document.querySelector('#auth-status')!.textContent).toBe(view.api.messages.welcomeAuthStarting)
    expect(view.button('#auth-cancel').disabled).toBe(true)
    await act(async () => { started.resolve(withAttempt({ id: 'a1', phase: 'waiting-browser', authorizeUrl: 'https://hub.example/x' })); await started.promise })
    expect(view.document.querySelector('#auth-status')!.textContent).toBe(view.api.messages.welcomeAuthWaiting)
    expect(view.button('#auth-cancel').disabled).toBe(false)
  })

  it('returns to the entry when starting fails to reach the Host', async () => {
    const view = mount()
    view.api.startSignIn.mockRejectedValueOnce(new Error('closed'))
    await act(async () => { fireEvent.click(view.button('#sign-in')) })
    expect(view.document.querySelector('#auth-status')!.textContent).toBe(view.api.messages.welcomeAuthFailed)
    expect(view.button('#auth-retry').hidden).toBe(false)
  })

  it('keeps visible copy in the shell dictionaries and denies network access', () => {
    expect([...html.matchAll(/>([^<]*\p{L}[^<]*)</gu)]).toEqual([])
    expect(html).toContain("default-src 'none'")
    expect(html).toContain("form-action 'none'")
  })
})

it.each(['zh-CN', 'en'])('renders %s timeout with a manual retry', async (language) => {
  const view = mount(language)
  view.receive(withAttempt({ id: 'expired', phase: 'failed', error: 'expired' }))
  expect(view.button('#auth-retry').hidden).toBe(false)
  expect(view.api.startSignIn).not.toHaveBeenCalled()
  await expect(view.copy() + view.document.querySelector('#auth-description')!.textContent + '\n').toMatchFileSnapshot(`./expected/welcome/${language}-timeout.expected.txt`)
  fireEvent.click(view.button('#auth-retry'))
  expect(view.api.startSignIn).toHaveBeenCalledOnce()
})

it.each([
  ['denied', 'welcomeAuthDenied'], ['network', 'welcomeAuthNetwork'], ['storage', 'welcomeAuthStorage'], ['protocol', 'welcomeAuthFailed'],
] as const)('names the %s failure and offers a retry', (error, key) => {
  const view = mount()
  view.receive(withAttempt({ id: 'failed', phase: 'failed', error }))
  expect(view.document.querySelector('#auth-status')!.textContent).toBe(view.api.messages[key])
  expect(view.document.querySelector<HTMLElement>('#auth-description')!.hidden).toBe(true)
  expect(view.button('#auth-retry').hidden).toBe(false)
  expect(view.button('#auth-cancel').hidden).toBe(true)
})

it.each(['zh-CN', 'en'])('renders %s browser fallback and copies only the active login link', async (language) => {
  const view = mount(language)
  const waiting = withAttempt({ id: 'waiting', phase: 'waiting-browser', authorizeUrl: 'https://hub.example/login' })
  view.receive(waiting)
  await expect(view.copy() + view.document.querySelector('#auth-description')!.textContent + '\n')
    .toMatchFileSnapshot(`./expected/welcome/${language}-waiting.expected.txt`)
  fireEvent.click(view.button('#auth-copy'))
  await vi.waitFor(() => { expect(view.button('#auth-copy').textContent).toBe(view.api.messages.welcomeAuthCopied) })
  expect(view.api.copySignInLink).toHaveBeenCalledWith('waiting')
  await vi.waitFor(() => { expect(view.button('#auth-copy').disabled).toBe(false) }, { timeout: 3000 })
  view.api.copySignInLink.mockRejectedValueOnce(new Error('clipboard unavailable'))
  fireEvent.click(view.button('#auth-copy'))
  await vi.waitFor(() => { expect(view.button('#auth-copy').textContent).toBe(view.api.messages.welcomeAuthCopyFailed) })
  view.receive(withAttempt({ id: 'waiting', phase: 'exchanging' }))
  expect(view.button('#auth-copy').hidden).toBe(true)
  expect(view.button('#auth-loading').hidden).toBe(false)
  expect(view.button('#auth-cancel').disabled).toBe(true)
  view.receive(withAttempt({ id: 'waiting', phase: 'cancelled' }))
  expect(view.button('#sign-in').closest('[hidden]')).toBeNull()
})

it('cancels the current attempt once and keeps it visible when cancelling fails', async () => {
  const view = mount()
  view.receive(withAttempt({ id: 'waiting', phase: 'waiting-browser' }))
  const cancelled = Promise.withResolvers<HubAccountView>()
  view.api.cancelSignIn.mockReturnValueOnce(cancelled.promise)
  fireEvent.click(view.button('#auth-cancel'))
  fireEvent.click(view.button('#auth-cancel'))
  expect(view.api.cancelSignIn).toHaveBeenCalledExactlyOnceWith('waiting')
  await act(async () => { cancelled.resolve(withAttempt({ id: 'waiting', phase: 'cancelled' })); await cancelled.promise })
  expect(view.button('#sign-in').closest('[hidden]')).toBeNull()
  view.receive(withAttempt({ id: 'second', phase: 'waiting-browser' }))
  view.api.cancelSignIn.mockRejectedValueOnce(new Error('closed'))
  await act(async () => { fireEvent.click(view.button('#auth-cancel')) })
  expect(view.document.querySelector('#auth-status')!.textContent).toBe(view.api.messages.welcomeAuthWaiting)
  expect(view.button('#auth-cancel').disabled).toBe(false)
})

it('keeps a newer sign-in notification when the start response arrives late', async () => {
  const view = mount()
  const started = Promise.withResolvers<HubAccountView>()
  view.api.startSignIn.mockReturnValueOnce(started.promise)
  fireEvent.click(view.button('#sign-in'))
  view.receive(withAttempt({ id: 'attempt', phase: 'failed', error: 'expired' }))
  await act(async () => { started.resolve(withAttempt({ id: 'attempt', phase: 'waiting-browser' })); await started.promise })
  expect(view.document.querySelector('#auth-status')!.textContent).toBe(view.api.messages.welcomeAuthExpired)
  expect(view.button('#auth-retry').hidden).toBe(false)
})

it('does not restore a copied-link status after leaving the waiting phase', async () => {
  const view = mount()
  const copied = Promise.withResolvers<undefined>()
  view.api.copySignInLink.mockReturnValueOnce(copied.promise)
  view.receive(withAttempt({ id: 'attempt', phase: 'waiting-browser' }))
  fireEvent.click(view.button('#auth-copy'))
  expect(view.button('#auth-copy').disabled).toBe(true)
  view.receive(withAttempt({ id: 'attempt', phase: 'exchanging' }))
  await act(async () => { copied.resolve(undefined); await copied.promise })
  expect(view.button('#auth-copy').hidden).toBe(true)
  expect(view.button('#auth-copy').textContent).toBe(view.api.messages.welcomeAuthCopyLink)
})

it('ignores attempt-less frames on the entry and releases the subscription on unmount', () => {
  const view = mount()
  view.receive(signedOut)
  expect(view.button('#sign-in').closest('[hidden]')).toBeNull()
  view.unmount()
  expect(view.stopAccount).toHaveBeenCalledOnce()
})

it.each(['zh-CN', 'en'])('keeps the expiry notice visible after returning to Welcome: %s', async (language) => {
  vi.useFakeTimers()
  try {
    const takeNotice = vi.fn<() => Promise<WelcomeNotice | undefined>>().mockResolvedValue(undefined).mockResolvedValueOnce('session-expired')
    const view = mount(language, takeNotice)
    await act(async () => {})
    const publish = view.api.onAccountState.mock.calls[0]![0]
    const expired: HubAccountView = { ...signedOut, reason: 'expired' }
    await act(async () => { publish(expired) })
    const notice = screen.getByRole('alert')
    expect(notice.textContent).toBe(view.api.messages.welcomeSessionExpired)
    await expect(`${notice.textContent}\n`).toMatchFileSnapshot(`./expected/welcome/${language}-expired.expected.txt`)
    expect(view.button('#sign-in').closest('[hidden]')).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
    expect(screen.queryByRole('alert')).toBeNull()
    await act(async () => { publish(expired) })
    expect(screen.queryByRole('alert')).toBeNull()
    view.unmount()
    mount(language, takeNotice)
    await act(async () => {})
    expect(screen.queryByRole('alert')).toBeNull()
  } finally { cleanup(); vi.useRealTimers() }
})

it('keeps the entry usable when notification IPC fails', async () => {
  const view = mount('en', vi.fn<() => Promise<WelcomeNotice | undefined>>().mockRejectedValue(new Error('closed')))
  await act(async () => {})
  expect(screen.queryByRole('alert')).toBeNull()
  expect(view.button('#sign-in').disabled).toBe(false)
})

it('ignores a notification received after its renderer unmounts', async () => {
  const pending = Promise.withResolvers<WelcomeNotice | undefined>()
  const view = mount('en', vi.fn<() => Promise<WelcomeNotice | undefined>>().mockReturnValue(pending.promise))
  view.unmount()
  mount('en')
  await act(async () => { pending.resolve('session-expired') })
  expect(screen.queryByRole('alert')).toBeNull()
})

it.each(['zh-CN', 'en'])('returns from a completed sign-in to the initial page after sign-out: %s', async (language) => {
  const view = mount(language)
  view.receive({ ...withAttempt({ id: 'completed', phase: 'succeeded' }), status: 'signed-in' })
  expect(view.document.querySelector<HTMLElement>('#auth-page')!.hidden).toBe(false)
  view.receive({ ...signedOut, attempt: { id: 'completed', phase: 'cancelled' } })
  expect(view.button('#sign-in').closest('[hidden]')).toBeNull()
  expect(view.document.querySelector<HTMLElement>('#auth-page')!.hidden).toBe(true)
  await expect(view.copy()).toMatchFileSnapshot(`./expected/welcome/${language}.expected.txt`)
})

it('reports each return to the welcome entry once and focuses the sign-in button', async () => {
  const view = mount()
  expect(view.api.analytics).not.toHaveBeenCalled()
  const pending = Promise.withResolvers<HubAccountView>()
  view.api.startSignIn.mockReturnValueOnce(pending.promise)
  fireEvent.click(view.button('#sign-in'))
  await act(async () => { pending.resolve(withAttempt({ id: 'a', phase: 'cancelled' })) })
  expect(view.api.analytics.mock.calls.map(([action]) => action)).toEqual(['auth_page_click', 'auth_page_view'])
  expect(view.document.activeElement).toBe(view.button('#sign-in'))
})

it.each(['copied', 'failed'] as const)('restores the copy action after %s feedback and cleans up on unmount', async (result) => {
  vi.useFakeTimers()
  try {
    const view = mount('en')
    if (result === 'failed') view.api.copySignInLink.mockRejectedValue(new Error('clipboard unavailable'))
    view.receive(withAttempt({ id: 'waiting', phase: 'waiting-browser' }))
    const feedback = result === 'copied' ? view.api.messages.welcomeAuthCopied : view.api.messages.welcomeAuthCopyFailed
    await act(async () => { fireEvent.click(view.button('#auth-copy')) })
    expect(view.button('#auth-copy').textContent).toBe(feedback)
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(view.button('#auth-copy').textContent).toBe(view.api.messages.welcomeAuthCopyLink)
    expect(view.button('#auth-copy').disabled).toBe(false)
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    cleanup()
    vi.useRealTimers()
  }
})

it('offers the entry after sign-out even though the Host keeps the last completed attempt', () => {
  const view = mount()
  view.receive({ ...withAttempt({ id: 'done', phase: 'succeeded' }), status: 'signed-in' })
  expect(view.document.querySelector<HTMLElement>('#auth-page')!.hidden).toBe(false)
  view.receive({ ...withAttempt({ id: 'done', phase: 'succeeded' }), reason: 'expired' })
  expect(view.button('#sign-in').closest('[hidden]')).toBeNull()
  expect(view.document.querySelector<HTMLElement>('#auth-page')!.hidden).toBe(true)
})
