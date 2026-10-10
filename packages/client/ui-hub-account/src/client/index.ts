/**
 * Hub sign-in, browser half: the sidebar account launcher (employee, Settings, sign-out),
 * the new-session hero's logo and slogan, and the Settings section showing the signed-in employee and
 * tenant with tenant switching and sign-out, or the sign-in state and a way to sign in. State streams from the `hubAccount` Remote.
 * The Desktop welcome window keeps the workspace closed while signed out.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { HubAccountView } from '@deepseek-ai/dsh-hub-account/types'
import { createBrandSource } from './brand-source.ts'
import { createHubSource } from './hub-source.ts'
import { HubHeroHeadline, HubHeroMark } from './HubBrand.tsx'
import { HubAccountSection } from './HubAccountSection.tsx'
import { HubLauncher } from './HubLauncher.tsx'
import { en, zh, type HubAccountLocaleKey } from './locales.ts'

export type { HubBrandInjected } from './brand-source.ts'
export type { HubAccountInjected, HubSnapshot } from './hub-source.ts'
export type { HubHeroHeadlineProps, HubHeroMarkProps } from './HubBrand.tsx'
export type { HubAccountLocaleKey } from './locales.ts'
export type { HubAccountSectionProps } from './HubAccountSection.tsx'
export type { HubLauncherProps } from './HubLauncher.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Hub account launcher and section copy. */
    'hub-account': HubAccountLocaleKey
  }
}

const NS = 'hub-account'

/** Services the launcher and section read: the `hubAccount` Remote and the Settings slots. */
export const inject = ['slots', 'locale', 'remote', 'remote.hubAccount']

/**
 * Contribute the sidebar account launcher and the account section in the Desktop renderer.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  // Desktop only: a browser tab of the same roster has no Hub sign-in.
  if (!('dshDesktop' in globalThis)) return
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-hub-account: dictionaries')
  const t = ctx.locale.bind(NS)
  const remote = ctx.remote.hubAccount
  const source = createHubSource({
    signIn: () => remote.signIn(),
    cancelSignIn: attemptId => remote.cancelSignIn(attemptId),
    signOut: () => remote.signOut(),
    switchTenant: () => remote.switchTenant(),
    open: (url) => { window.open(url, '_blank', 'noopener,noreferrer') },
  })
  const brand = createBrandSource(() => remote.getBranding())
  const stream = ctx.remote.$stream<HubAccountView>({
    name: 'hubAccount', open: signal => remote.watch(signal), ended: () => new Error('hub account stream ended'),
  })
  ctx.effect(() => () => stream.dispose(), 'ui-hub-account: state stream')
  void (async () => {
    for await (const frame of stream) {
      source.publish(frame.value)
      brand.publish(frame.value)
      frame.accept()
    }
  })().catch(() => {
    // The stream reconnects on its own; a disposed plugin simply stops listening.
  })
  ctx.slots.inject('settings.launcher', () => ctx.slots.register({
    name: 'settings.launcher', locale: NS, inject: () => source,
  }, HubLauncher))
  const brandFace = { hooks: { hub: source.hooks.hub, brand: brand.brand } }
  // The sidebar brand row belongs to the deployment's brand plugin (ui-brand-mo).
  // The new-session hero shows the same tenant's logo and slogan, or nothing at all.
  ctx.slots.inject('conversation.hero.brand.mark', () => ctx.slots.inject('conversation.hero.brand.headline', function* () {
    yield ctx.slots.register({ name: 'conversation.hero.brand.mark', locale: NS, inject: () => brandFace }, HubHeroMark)
    yield ctx.slots.register({ name: 'conversation.hero.brand.headline', inject: () => brandFace }, HubHeroHeadline)
  }))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'hub-account', order: -20, label: () => t('section'), locale: NS, inject: () => source,
  }, HubAccountSection))
}
