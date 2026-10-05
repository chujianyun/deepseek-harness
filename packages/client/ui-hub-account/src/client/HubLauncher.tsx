/** The sidebar account launcher: the signed-in employee and company, with Settings and sign-out. */

import { useRef, useState } from 'react'
import { IconSettingsOutlineMedium, IconUserOutlineMedium, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { HubAccountInjected } from './hub-source.ts'
import css from './HubLauncher.module.css'

/** Props the launcher reads from its `settings.launcher` registration: sidebar geometry, Settings navigation, and the sign-in face. */
export type HubLauncherProps = PropsRuntime<'settings.launcher'> & PropsLocale<'hub-account'> & InjectFace<HubAccountInjected>

/**
 * Render the employee's initial, nickname and company; its menu opens Settings or signs out.
 * @param props - sidebar geometry, Settings navigation, the `hub-account` translator and the sign-in face.
 * @returns the launcher.
 */
export function HubLauncher({ t, wide, settingsShortcut, openSettings, useHub, onSignOut }: HubLauncherProps) {
  const profile = useHub(snapshot => snapshot.view?.profile ?? null)
  const busy = useHub(snapshot => snapshot.busy)
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  return (
    <div className={css.root}>
      <Menu open={open} side="top" portal autoFocus className={css.anchor}
        anchor={(
          <button ref={trigger} type="button" className={css.trigger} data-collapsed={!wide} aria-label={t('menu')}
            aria-haspopup="menu" aria-expanded={open} onClick={() => { setOpen(value => !value) }}>
            <span className={css.avatar} aria-hidden="true">
              {profile === null ? <IconUserOutlineMedium size={16} /> : profile.nickname.slice(0, 1)}
            </span>
            {wide && (
              <span className={css.identity}>
                <span className={css.name}>{profile?.nickname ?? t('signedOut')}</span>
                {profile !== null && <span className={css.tenant}>{profile.tenantName ?? t('noTenant')}</span>}
              </span>
            )}
          </button>
        )}
        items={[
          { id: 'settings', label: t('settings'), icon: <IconSettingsOutlineMedium size={16} />,
            ...settingsShortcut === undefined ? {} : { shortcut: settingsShortcut } },
          ...profile === null ? [] : [{ id: 'signout', label: t('signOut'), icon: <IconUserOutlineMedium size={16} />, disabled: busy }],
        ]}
        onClose={() => { setOpen(false) }}
        onSelect={(id) => {
          setOpen(false)
          if (id === 'settings') { trigger.current?.focus(); openSettings() }
          else void onSignOut()
        }} />
    </div>
  )
}
