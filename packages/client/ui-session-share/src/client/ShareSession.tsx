/**
 * The share action: a `sidebar.workspaces.session.menu.item` row that asks for the share dialog,
 * and the `shell.overlay` dialog that reads the Session's share, makes its link, copies it,
 * refreshes its content, and withdraws it. The dialog lives outside the row menu because the row
 * unmounts with the menu.
 */
import { useEffect, useState } from 'react'
import { Button, IconShareOutlineRegular, MenuItemButton, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { HostObservable, InjectFace, PropsHooks, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionShareLink, SessionShareStatus } from '@deepseek-ai/dsh-session-share/client'
import css from './ShareSession.module.css'

/** A share the menu row asked for; the dialog opens on it. */
export interface SessionShareTarget {
  readonly sessionId: SessionId
  /** The title the dialog names and the share carries. */
  readonly title: string
}

/** Menu row share: whether a sign-in exists, and the request the row raises. */
export interface ShareSessionInjected {
  hooks: {
    /** A user-center sign-in exists; the row hides without one. */
    signedIn: HostObservable<boolean>
  }
  /** Ask for the share dialog. */
  requestSessionShare: (target: SessionShareTarget) => void
}

/** Dialog share: the pending request, its settlement, and the Remote calls. */
export interface SessionShareDialogInjected {
  hooks: {
    /** The share asked for, until the dialog closes. */
    shareRequest: HostObservable<SessionShareTarget | null>
  }
  /** Close the dialog. */
  settleSessionShare: () => void
  /** Read the Session's current share. */
  loadStatus: (sessionId: SessionId) => Promise<RemoteResult<SessionShareStatus>>
  /** Share the Session, or replace its share's content with the conversation as it is now. */
  share: (target: SessionShareTarget) => Promise<RemoteResult<SessionShareLink>>
  /** Withdraw the Session's share. */
  revoke: (sessionId: SessionId) => Promise<RemoteResult<void>>
  /** Put the link on the clipboard; false when the host refused. */
  copyLink: (url: string) => Promise<boolean>
}

/** Props of the menu row. */
export type ShareSessionMenuItemProps =
  PropsRuntime<'sidebar.workspaces.session.menu.item'>
  & PropsLocale<'sessionShare'>
  & Omit<ShareSessionInjected, 'hooks'>
  & PropsHooks<ShareSessionInjected['hooks']>

/** Props of the dialog entry. */
export type SessionShareDialogProps =
  PropsRuntime<'shell.overlay'>
  & PropsLocale<'sessionShare'>
  & InjectFace<SessionShareDialogInjected>

/**
 * Menu row (order 350, between Fork and Archive): ask for the share dialog. Renders nothing
 * without a sign-in.
 * @param props - the row identity, the menu open state, the sign-in hook, and the request.
 * @returns the row, or null.
 */
export function ShareSessionMenuItem({
  sessionId, displayTitle, useMenuOpenState, useSignedIn, requestSessionShare, t,
}: ShareSessionMenuItemProps) {
  const [, setMenuOpen] = useMenuOpenState()
  const signedIn = useSignedIn(value => value)
  if (!signedIn) return null
  return (
    <MenuItemButton
      icon={<IconShareOutlineRegular size={14} />}
      onSelect={() => {
        setMenuOpen(false)
        // The row passes the stored title, which is empty until the Session is named.
        requestSessionShare({ sessionId, title: displayTitle === '' ? t('untitled') : displayTitle })
      }}
    >
      {t('menu.share')}
    </MenuItemButton>
  )
}

/**
 * The `shell.overlay` entry: nothing while no share is asked for, otherwise one dialog per request.
 * @param props - the request hook, its settlement, the Remote calls, and the locale seat.
 * @returns the open dialog, or null.
 */
export function SessionShareDialog({ useShareRequest, t, ...face }: SessionShareDialogProps) {
  const request = useShareRequest(pending => pending)
  if (request === null) return null
  return <ShareForm key={request.sessionId} request={request} face={face} t={t} />
}

/** What the dialog is doing; `idle` shows the buttons of the current share state. */
type Busy = 'loading' | 'creating' | 'updating' | 'revoking' | 'idle'

/** The words for a refusal, by its code. */
function failureText(error: RemoteFailure, t: SessionShareDialogProps['t']): string {
  switch (error.code) {
    case 'session-share/signed-out': return t('error.signedOut')
    case 'session-share/empty': return t('error.empty')
    case 'session-share/unreachable': return t('error.unreachable')
    case 'session-share/refused':
      return (error.details as { status?: number }).status === 413 ? t('error.tooLong') : t('error.refused', { reason: error.message })
    default: return t('error.failed', { reason: error.message })
  }
}

/** A time in the UI language, whose BCP 47 tag the dictionary carries. */
function formatTime(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso))
}

/** One request's dialog: the link, in-flight state, and notices die with it. */
function ShareForm({ request, face, t }: {
  request: SessionShareTarget
  face: Omit<SessionShareDialogProps, 'useShareRequest' | 't'>
  t: SessionShareDialogProps['t']
}) {
  const { settleSessionShare, loadStatus, share, revoke, copyLink } = face
  const [busy, setBusy] = useState<Busy>('loading')
  const [link, setLink] = useState<SessionShareLink | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let current = true
    void loadStatus(request.sessionId).then((result) => {
      if (!current) return
      if (result.ok) setLink(result.value.link)
      else setError(failureText(result.error, t))
      setBusy('idle')
    })
    return () => { current = false }
    // The dialog is keyed by the Session, so one read per mount is the read of this request.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const run = <T,>(doing: Busy, call: () => Promise<RemoteResult<T>>, done: (value: T) => void): void => {
    setBusy(doing)
    setNotice(null)
    setError(null)
    void call().then((result) => {
      if (result.ok) done(result.value)
      else setError(failureText(result.error, t))
      setBusy('idle')
    })
  }
  const upload = (doing: 'creating' | 'updating'): void => {
    run(doing, () => share(request), (value) => {
      setLink(value)
      if (doing === 'updating') setNotice(t('updated'))
    })
  }
  const working = busy !== 'idle'
  const status = busy === 'idle' ? notice : t(busy)
  const stop = (): void => {
    run('revoking', () => revoke(request.sessionId), () => {
      setLink(null)
      setNotice(t('revoked'))
    })
  }
  const footer = link === null
    ? (
      <>
        <Button variant="outline" disabled={busy === 'creating'} onClick={settleSessionShare}>{t('cancel')}</Button>
        <Button variant="primary" disabled={working} onClick={() => { upload('creating') }}>{t('create')}</Button>
      </>
    )
    : (
      <>
        <Button variant="outline" className={css.revoke} disabled={working} onClick={stop}>{t('revoke')}</Button>
        <Button variant="outline" disabled={working} onClick={() => { upload('updating') }}>{t('update')}</Button>
        <Button variant="primary" disabled={working} onClick={settleSessionShare}>{t('done')}</Button>
      </>
    )
  return (
    <Modal
      open
      onClose={() => { if (busy === 'idle' || busy === 'loading') settleSessionShare() }}
      closeLabel={t('close')}
      title={t('dialog.title')}
      description={t('dialog.desc', { title: request.title })}
      footer={footer}
    >
      {link !== null && (
        <>
          <div className={css.linkRow}>
            <input className={css.link} readOnly value={link.url} aria-label={t('link')} onFocus={(e) => { e.target.select() }} />
            <Button
              variant="outline"
              disabled={working}
              onClick={() => {
                setError(null)
                void copyLink(link.url).then((copied) => { setNotice(t(copied ? 'copied' : 'copyFailed')) })
              }}
            >
              {t('copy')}
            </Button>
          </div>
          <div className={css.meta}>{t('updatedAt', { time: formatTime(link.updatedAt, t('time.locale')) })}</div>
        </>
      )}
      {status !== null && <div className={css.status} role="status">{status}</div>}
      {error !== null && <div className={css.error} role="alert">{error}</div>}
    </Modal>
  )
}
