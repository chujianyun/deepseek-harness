/** Sidebar brand row: the signed-in tenant's logo, or its name. */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { HubBrandInjected } from './brand-source.ts'
import css from './HubBrand.module.css'

/** Props of the `sidebar.brand.mark` occupant. */
export type HubBrandMarkProps = PropsRuntime<'sidebar.brand.mark'> & InjectFace<HubBrandInjected>

/** Props of the `sidebar.brand.name` occupant. */
export type HubBrandNameProps = PropsRuntime<'sidebar.brand.name'> & PropsLocale<'hub-account'> & InjectFace<HubBrandInjected>

/** Props of the `conversation.hero.brand.mark` occupant. */
export type HubHeroMarkProps = PropsRuntime<'conversation.hero.brand.mark'> & PropsLocale<'hub-account'> & InjectFace<HubBrandInjected>

/** Props of the `conversation.hero.brand.headline` occupant. */
export type HubHeroHeadlineProps = PropsRuntime<'conversation.hero.brand.headline'> & InjectFace<HubBrandInjected>

/**
 * Render the collapsed rail's brand: the tenant logo scaled into the square, or the company
 * name's first character. Beside the expanded name, which already carries the brand, nothing.
 * @param props - requested size and placement, and the branding hooks.
 * @returns the mark, or null.
 */
export function HubBrandMark({ size, placement, useHub, useBrand }: HubBrandMarkProps) {
  const tenantName = useHub(snapshot => snapshot.view?.profile?.tenantName ?? null)
  const logo = useBrand(brand => brand?.logo ?? null)
  if (placement === 'row') return null
  if (logo !== null) return <img className={css.mark} src={logo} alt="" width={size} height={size} draggable={false} />
  if (tenantName === null) return null
  return <span className={css.initial} style={{ width: size, height: size }}>{tenantName.slice(0, 1)}</span>
}

/**
 * Render the expanded brand: the tenant logo scaled into the sidebar width, or the company name.
 * The build version is not shown here; General Settings shows it.
 * @param props - the `hub-account` translator and the branding hooks.
 * @returns the brand name.
 */
export function HubBrandName({ t, useHub, useBrand }: HubBrandNameProps) {
  const tenantName = useHub(snapshot => snapshot.view?.profile?.tenantName ?? null)
  const logo = useBrand(brand => brand?.logo ?? null)
  return (
    <span className={css.name}>
      {logo === null
        ? <span className={css.tenant}>{tenantName}</span>
        : <img className={css.logo} src={logo} alt={tenantName ?? t('brandLogo')} draggable={false} />}
    </span>
  )
}

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

/**
 * Show the tenant's new-session slogan as written, whatever the UI language; without one, nothing.
 * @param props - the branding hooks.
 * @returns the slogan, or null.
 */
export function HubHeroHeadline({ useBrand }: HubHeroHeadlineProps) {
  const slogan = useBrand(brand => brand?.slogan ?? null)
  return slogan
}
