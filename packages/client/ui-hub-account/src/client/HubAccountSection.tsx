/** The Skill Hub account section in Settings: who is signed in, to which tenant, and the way out. */

import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { HubAccountInjected } from './hub-source.ts'
import css from './HubAccountSection.module.css'

/** Props the section reads from its `settings.section` registration: the translator and the sign-in face. */
export type HubAccountSectionProps = PropsLocale<'hub-account'> & InjectFace<HubAccountInjected>

/**
 * Render the signed-in nickname and tenant with tenant switching and sign-out.
 * @param props - the `hub-account` translator and the sign-in face.
 * @returns the section, or null while signed out (the gate covers the application then).
 */
export function HubAccountSection({ t, useHub, onSwitchTenant, onSignOut }: HubAccountSectionProps) {
  const profile = useHub(snapshot => snapshot.view?.profile ?? null)
  const busy = useHub(snapshot => snapshot.busy)
  const failure = useHub(snapshot => snapshot.failure)
  if (profile === null) return null
  return (
    <section className={css.section} aria-label={t('section')}>
      <div className={css.card}>
        <span className={css.avatar} aria-hidden="true">{profile.nickname.slice(0, 1)}</span>
        <div className={css.identity}>
          <span className={css.name}>{profile.nickname}</span>
          <span className={css.meta}>{t('tenant')}：{profile.tenantName ?? '—'}</span>
          <span className={css.meta}>{t('phone')}：{profile.phone}</span>
        </div>
      </div>
      {failure !== null && <p className={css.error} role="alert">{t('actionFailed', { message: failure })}</p>}
      <div className={css.actions}>
        <Button variant="outline" disabled={busy} onClick={() => { void onSwitchTenant() }}>{t('switchTenant')}</Button>
        <Button variant="ghost" disabled={busy} onClick={() => { void onSignOut() }}>{t('signOut')}</Button>
      </div>
    </section>
  )
}
