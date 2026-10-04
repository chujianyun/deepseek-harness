/** The Hub sign-in gate: a full-screen page covering the whole application until the user signs in. */

import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { HubAccountInjected } from './hub-source.ts'
import css from './HubGate.module.css'

/** Props the gate reads from its `shell.overlay` registration: the translator and the sign-in face. */
export type HubGateProps = PropsLocale<'hub-account'> & InjectFace<HubAccountInjected>

/**
 * Render the gate while the Host reports no sign-in; nothing once signed in. Running sessions keep
 * going underneath; the Host refuses new prompts until the user signs in again.
 * @param props - the `hub-account` translator and the sign-in face.
 * @returns the body-portaled gate, or null.
 */
export function HubGate({ t, useHub, onSignIn, onCancel, onReopen }: HubGateProps) {
  const view = useHub(snapshot => snapshot.view)
  const busy = useHub(snapshot => snapshot.busy)
  const failure = useHub(snapshot => snapshot.failure)
  const primary = useRef<HTMLButtonElement>(null)
  const open = view?.status !== 'signed-in'
  const attempt = view?.attempt
  const running = attempt?.phase === 'waiting-browser' || attempt?.phase === 'exchanging'
  useEffect(() => { if (open && !running) primary.current?.focus() }, [open, running])
  if (!open) return null

  let body
  if (view === undefined) body = <p className={css.status} role="status">{t('checking')}</p>
  else if (running) {
    body = (
      <>
        <p className={css.status} role="status">{attempt.phase === 'exchanging' ? t('exchanging') : t('waiting')}</p>
        <div className={css.actions}>
          {attempt.authorizeUrl !== undefined && <Button variant="outline" onClick={onReopen}>{t('reopen')}</Button>}
          <Button variant="ghost" disabled={busy} onClick={() => { void onCancel() }}>{t('cancel')}</Button>
        </div>
      </>
    )
  } else {
    const error = attempt?.phase === 'failed' && attempt.error !== undefined ? t(`error.${attempt.error}`) : null
    body = (
      <>
        {error !== null && <p className={css.error} role="alert">{error}</p>}
        <div className={css.actions}>
          <Button ref={primary} variant="primary" disabled={busy} onClick={() => { void onSignIn() }}>
            {error !== null ? t('retry') : t('signIn')}
          </Button>
        </div>
      </>
    )
  }
  return createPortal((
    <div className={css.overlay} role="dialog" aria-modal="true" aria-labelledby="hub-gate-title">
      <div className={css.dragBand} data-window-drag aria-hidden="true" />
      <section className={css.panel}>
        <div className={css.mark} aria-hidden="true">{t('mark')}</div>
        <h1 id="hub-gate-title" className={css.title}>{t('title')}</h1>
        <p className={css.intro}>{t('intro')}</p>
        {view?.reason === 'expired' && <p className={css.notice} role="alert">{t('expired')}</p>}
        {failure !== null && <p className={css.error} role="alert">{t('actionFailed', { message: failure })}</p>}
        {body}
      </section>
    </div>
  ), document.body)
}
