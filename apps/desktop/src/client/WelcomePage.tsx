/** Desktop welcome presentation; user-center sign-in operations stay in the preload. */
import { useEffect, useRef, useState } from 'react'
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives/src/Toast.tsx'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives/src/StateDot.tsx'
import type { HubAccountView, HubBrandingView } from '@deepseek-ai/dsh-hub-account/types'
import type { WelcomeApi } from '../welcome-api.ts'

type Page = 'entry' | 'account'

/** Product logo shown when no tenant branding is cached; `renderer/welcome.html` loads from `renderer/`. */
const MO_LOGO = 'assets/mo-logo.png'

/**
 * Render the standalone welcome flow: the workspace opens only after a user-center sign-in.
 * Clearing or cancelling the attempt returns the sign-in status page to the entry page. The logo
 * and welcome title are the last-signed-in tenant's cached branding; without it the page shows the
 * bundled MO WorkAI logo and no title. The entry page stacks logo, prompt, and sign-in button in the centre.
 * @param props.api - isolated preload API; no tokens reach the renderer.
 * @returns welcome pages with fixed bottom actions.
 */
export function Welcome({ api }: { api: WelcomeApi }) {
  const { messages: m } = api
  const [expiryNotice, setExpiryNotice] = useState(false)
  /** Undefined until the first read, so the page never flashes a layout without the branding. */
  const [branding, setBranding] = useState<HubBrandingView | null | undefined>(undefined)
  const [page, setPage] = useState<Page>('entry')
  const pageRef = useRef<Page>('entry')
  const visiblePage = useRef<Page>('entry')
  const [attempt, setAttempt] = useState<HubAccountView['attempt']>(null)
  const attemptRef = useRef<HubAccountView['attempt']>(null)
  const [starting, setStarting] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [copyState, setCopyState] = useState<'idle' | 'busy' | 'copied' | 'failed'>('idle')
  const mounted = useRef(true)
  const revision = useRef(0)
  const signInButton = useRef<HTMLButtonElement>(null)

  function navigate(next: Page) {
    pageRef.current = next
    setPage(next)
  }
  function showAccount(state: HubAccountView) {
    // The Host keeps the last completed attempt after sign-out or expiry; signed out, it is no attempt to show.
    const current = state.attempt?.phase === 'succeeded' && state.status !== 'signed-in' ? null : state.attempt
    if (current === null && pageRef.current === 'entry') return
    attemptRef.current = current
    setAttempt(current)
    setStarting(false)
    setCopyState('idle')
    navigate(current === null || current.phase === 'cancelled' ? 'entry' : 'account')
  }

  useEffect(() => {
    mounted.current = true
    document.documentElement.lang = api.id
    document.title = m.welcomeTitle
    const takeNotice = (): void => {
      void api.takeNotice().then((notice) => {
        if (mounted.current && notice === 'session-expired') setExpiryNotice(true)
      }).catch((_closedChannel: unknown) => {
        // A closed Welcome IPC channel must not interrupt the sign-in page.
      })
    }
    takeNotice()
    // Signing in elsewhere can replace the cache. A failed read shows no branding rather than no page.
    const readBranding = (): void => {
      void api.branding().catch((_closedChannel: unknown) => null).then((value) => { if (mounted.current) setBranding(value) })
    }
    readBranding()
    const stop = api.onAccountState((state) => {
      revision.current++
      takeNotice()
      if (state.status === 'signed-out') readBranding()
      showAccount(state)
    })
    return () => { mounted.current = false; stop() }
  }, [api, m.welcomeTitle])

  useEffect(() => {
    if (page === 'entry' && visiblePage.current !== 'entry') {
      void api.analytics?.('auth_page_view', {})
      signInButton.current?.focus()
    }
    visiblePage.current = page
  }, [page, api])

  useEffect(() => {
    if (copyState !== 'copied' && copyState !== 'failed') return
    const timer = setTimeout(() => { setCopyState('idle') }, 2000)
    return () => { clearTimeout(timer) }
  }, [copyState])

  async function start() {
    void api.analytics?.('auth_page_click', { button_name: 'sign_in' })
    navigate('account')
    setStarting(true)
    setAttempt(null)
    attemptRef.current = null
    const current = ++revision.current
    try {
      const state = await api.startSignIn()
      if (mounted.current && revision.current === current) showAccount(state)
    } catch {
      if (mounted.current && revision.current === current) setStarting(false)
    }
  }
  async function cancel() {
    if (cancelling || attemptRef.current === null) return
    setCancelling(true)
    const current = ++revision.current
    try {
      const state = await api.cancelSignIn(attemptRef.current.id)
      if (mounted.current && revision.current === current) showAccount(state)
    } catch {
      // The current attempt remains visible so cancellation can be retried.
    } finally {
      if (mounted.current) setCancelling(false)
    }
  }
  async function copyLink() {
    const current = attemptRef.current
    if (current?.phase !== 'waiting-browser' || copyState === 'busy' || copyState === 'copied') return
    setCopyState('busy')
    try {
      await api.copySignInLink(current.id)
      if (mounted.current && attemptRef.current === current) setCopyState('copied')
    } catch {
      if (mounted.current && attemptRef.current === current) setCopyState('failed')
    }
  }

  const phase = starting ? 'starting' : attempt?.phase ?? 'failed'
  const waiting = phase === 'waiting-browser'
  const failed = phase === 'failed'
  const expired = failed && attempt?.error === 'expired'
  const title = phase === 'starting' ? m.welcomeAuthStarting
    : waiting ? m.welcomeAuthWaiting
      : !failed ? m.welcomeAuthExchanging
        : expired ? m.welcomeAuthExpired
          : attempt?.error === 'denied' ? m.welcomeAuthDenied
            : attempt?.error === 'network' ? m.welcomeAuthNetwork
              : attempt?.error === 'storage' ? m.welcomeAuthStorage : m.welcomeAuthFailed

  const heading = branding?.title ?? null
  const logo = branding?.logo ?? MO_LOGO
  return <>
    {expiryNotice && <Toast text={m.welcomeSessionExpired} onDone={() => { setExpiryNotice(false) }} />}
    <div className="titlebar" aria-hidden="true" />
    <main className={['welcome', page === 'entry' ? 'entry' : '', branding === undefined ? 'pending' : ''].filter(Boolean).join(' ')}
      aria-labelledby={page !== 'entry' ? 'auth-status' : heading === null ? 'welcome-description' : 'welcome-heading'}>
      <img className="brand" src={logo} alt={m.welcomeLogo} draggable={false} />
      <div id="tagline" className="tagline" hidden={page !== 'entry'}>
        {heading !== null && <h1 id="welcome-heading">{heading}</h1>}
        <p id="welcome-description">{m.welcomeDescription}</p>
      </div>
      <section id="auth-page" className={`key-heading ${waiting ? 'auth-waiting' : expired ? 'auth-expired' : ''}`}
        hidden={page !== 'account'} aria-live="polite">
        <h1 id="auth-status">{title}</h1>
        <p id="auth-description" hidden={!waiting && !expired}>{waiting ? m.welcomeAuthWaitingDescription : m.welcomeAuthExpiredDescription}</p>
        <button id="auth-copy" className="copy-link" type="button" hidden={!waiting} disabled={!waiting || copyState === 'busy' || copyState === 'copied'} onClick={() => { void copyLink() }}>
          {copyState === 'copied' ? m.welcomeAuthCopied : copyState === 'failed' ? m.welcomeAuthCopyFailed : m.welcomeAuthCopyLink}
        </button>
      </section>
      <div id="auth-actions" className="actions" hidden={page !== 'account'}>
        <button id="auth-loading" className="primary" type="button" hidden={failed} disabled aria-label={m.welcomeAuthExchanging}>
          <StateDot state="ongoing" size={16} className="welcome-loading" />
        </button>
        <button id="auth-retry" className="primary" type="button" hidden={!failed} onClick={() => { void start() }}>{m.welcomeAuthRetry}</button>
        <button id="auth-cancel" className="secondary" type="button" hidden={failed}
          disabled={cancelling || phase === 'exchanging' || phase === 'succeeded' || (phase === 'starting' && attempt === null)}
          onClick={() => { void cancel() }}>{m.welcomeAuthCancel}</button>
      </div>
      <div id="entry-actions" className="actions" hidden={page !== 'entry'}>
        <button ref={signInButton} id="sign-in" className="primary" type="button" onClick={() => { void start() }}>{m.welcomeSignIn}</button>
      </div>
    </main>
  </>
}
