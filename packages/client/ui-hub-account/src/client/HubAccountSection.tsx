/** The Skill Hub account section in Settings: who is signed in, to which tenant, and the way in or out. */

import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { HubAccountInjected } from './hub-source.ts'
import css from './HubAccountSection.module.css'

/** Props the section reads from its `settings.section` registration: the translator and the sign-in face. */
export type HubAccountSectionProps = PropsLocale<'hub-account'> & InjectFace<HubAccountInjected>

/**
 * Render the signed-in nickname and tenant with tenant switching and sign-out, or, while signed
 * out, the sign-in state with a way to sign in.
 * @param props - the `hub-account` translator and the sign-in face.
 * @returns the section.
 */
export function HubAccountSection(props: HubAccountSectionProps) {
  const { t, useHub, onSwitchTenant, onSignOut } = props
  const profile = useHub(snapshot => snapshot.view?.profile ?? null)
  const busy = useHub(snapshot => snapshot.busy)
  const failure = useHub(snapshot => snapshot.failure)
  return (
    <section className={css.section} aria-label={t('section')}>
      {profile === null ? <SignedOut {...props} /> : (
        <>
          <div className={css.card}>
            <span className={css.avatar} aria-hidden="true">{profile.nickname.slice(0, 1)}</span>
            <div className={css.identity}>
              <span className={css.name}>{profile.nickname}</span>
              <span className={css.meta}>{t('tenant')}：{profile.tenantName ?? t('noTenant')}</span>
              <span className={css.meta}>{t('phone')}：{profile.phone}</span>
            </div>
          </div>
          {failure !== null && <p className={css.error} role="alert">{t('actionFailed', { message: failure })}</p>}
          <div className={css.actions}>
            <Button variant="outline" disabled={busy} onClick={() => { void onSwitchTenant() }}>{t('switchTenant')}</Button>
            <Button variant="ghost" disabled={busy} onClick={() => { void onSignOut() }}>{t('signOut')}</Button>
          </div>
        </>
      )}
    </section>
  )
}

function SignedOut({ t, useHub, onSignIn, onCancel, onReopen }: HubAccountSectionProps) {
  const view = useHub(snapshot => snapshot.view)
  const busy = useHub(snapshot => snapshot.busy)
  const failure = useHub(snapshot => snapshot.failure)
  if (view === undefined) return <p className={css.meta} role="status">{t('checking')}</p>
  const attempt = view.attempt
  const running = attempt?.phase === 'waiting-browser' || attempt?.phase === 'exchanging'
  const error = attempt?.phase === 'failed' && attempt.error !== undefined ? t(`error.${attempt.error}`) : null
  return (
    <>
      <div className={css.card}>
        <div className={css.identity}>
          <span className={css.name}>{t('signedOut')}</span>
          <span className={css.meta}>{t('signedOutIntro')}</span>
        </div>
      </div>
      {view.reason === 'expired' && <p className={css.error} role="alert">{t('expired')}</p>}
      {failure !== null && <p className={css.error} role="alert">{t('actionFailed', { message: failure })}</p>}
      {error !== null && <p className={css.error} role="alert">{error}</p>}
      {running ? (
        <>
          <p className={css.meta} role="status">{attempt.phase === 'exchanging' ? t('exchanging') : t('waiting')}</p>
          <div className={css.actions}>
            {attempt.authorizeUrl !== undefined && <Button variant="outline" onClick={onReopen}>{t('reopen')}</Button>}
            <Button variant="ghost" disabled={busy} onClick={() => { void onCancel() }}>{t('cancel')}</Button>
          </div>
        </>
      ) : (
        <div className={css.actions}>
          <Button variant="primary" disabled={busy} onClick={() => { void onSignIn() }}>{error !== null ? t('retry') : t('signIn')}</Button>
        </div>
      )}
    </>
  )
}
