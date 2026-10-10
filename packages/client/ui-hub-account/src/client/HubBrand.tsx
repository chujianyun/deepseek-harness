/** New-session hero brand: the signed-in tenant's logo and slogan. */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { HubBrandInjected } from './brand-source.ts'
import css from './HubBrand.module.css'

/** Props of the `conversation.hero.brand.mark` occupant. */
export type HubHeroMarkProps = PropsRuntime<'conversation.hero.brand.mark'> & PropsLocale<'hub-account'> & InjectFace<HubBrandInjected>

/** Props of the `conversation.hero.brand.headline` occupant. */
export type HubHeroHeadlineProps = PropsRuntime<'conversation.hero.brand.headline'> & PropsLocale<'hub-account'> & InjectFace<HubBrandInjected>

/**
 * Lead the new-session hero with the tenant logo, scaled to the requested height. Without a logo,
 * nothing: the hero does not stand the company name in for it.
 * @param props - requested height, the `hub-account` translator, and the branding hooks.
 * @returns the logo, or null.
 */
export function HubHeroMark({ size, t, useHub, useBrand }: HubHeroMarkProps) {
  const tenantName = useHub(snapshot => snapshot.view?.profile?.tenantName ?? null)
  const logo = useBrand(brand => brand?.logo ?? null)
  if (logo === null) return null
  return <img className={css.heroLogo} src={logo} alt={tenantName ?? t('brandLogo')} height={size} draggable={false} />
}

/** Greeting key for an hour of the day: morning 5–11, noon 11–13, afternoon 13–18, evening otherwise. */
function greetingKey(hour: number): 'greetingMorning' | 'greetingNoon' | 'greetingAfternoon' | 'greetingEvening' {
  if (hour >= 5 && hour < 11) return 'greetingMorning'
  if (hour >= 11 && hour < 13) return 'greetingNoon'
  if (hour >= 13 && hour < 18) return 'greetingAfternoon'
  return 'greetingEvening'
}

/**
 * Show the tenant's new-session slogan as written, whatever the UI language; without one, greet the
 * signed-in employee by the time of day above a short prompt (the prompt alone for a blank nickname); signed out, nothing.
 * The greeting follows the hour of the render.
 * @param props - the `hub-account` translator and the branding hooks.
 * @returns the slogan, the greeting, or null.
 */
export function HubHeroHeadline({ t, useHub, useBrand }: HubHeroHeadlineProps) {
  const slogan = useBrand(brand => brand?.slogan ?? null)
  const nickname = useHub(snapshot => snapshot.view?.profile?.nickname ?? null)
  if (slogan !== null) return slogan
  if (nickname === null) return null
  const name = nickname.trim()
  return (
    <span className={css.greeting}>
      {name !== '' && <span data-hero-greeting="">{t(greetingKey(new Date().getHours()), { name })}</span>}
      <span className={css.greetingPrompt}>{t('greetingPrompt')}</span>
    </span>
  )
}
