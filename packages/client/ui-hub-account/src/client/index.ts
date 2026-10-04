/**
 * Hub sign-in gate, browser half: the full-screen sign-in page over the whole application while
 * the Host reports no Hub sign-in, and the Settings section showing the signed-in employee and
 * tenant with tenant switching and sign-out. State streams from the `hubAccount` Remote.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { HubAccountView } from '@deepseek-ai/dsh-hub-account/types'
import { createHubSource } from './hub-source.ts'
import { HubAccountSection } from './HubAccountSection.tsx'
import { HubGate } from './HubGate.tsx'
import { en, zh, type HubAccountLocaleKey } from './locales.ts'

export type { HubAccountInjected, HubSnapshot } from './hub-source.ts'
export type { HubAccountLocaleKey } from './locales.ts'
export type { HubGateProps } from './HubGate.tsx'
export type { HubAccountSectionProps } from './HubAccountSection.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Hub sign-in gate and account section copy. */
    'hub-account': HubAccountLocaleKey
  }
}

const NS = 'hub-account'

/** Services the gate reads: the `hubAccount` Remote, the overlay and Settings slots. */
export const inject = ['slots', 'locale', 'remote', 'remote.hubAccount']

/**
 * Contribute the sign-in gate and the account section in the Desktop renderer.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  // Desktop only: a browser tab of the same roster has no Hub sign-in to gate.
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
  const stream = ctx.remote.$stream<HubAccountView>({
    name: 'hubAccount', open: signal => remote.watch(signal), ended: () => new Error('hub account stream ended'),
  })
  ctx.effect(() => () => stream.dispose(), 'ui-hub-account: state stream')
  void (async () => {
    for await (const frame of stream) {
      source.publish(frame.value)
      frame.accept()
    }
  })().catch(() => {
    // The stream reconnects on its own; a disposed plugin simply stops listening.
  })
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'hub-gate', locale: NS, inject: () => source,
  }, HubGate))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'hub-account', order: -20, label: () => t('section'), locale: NS, inject: () => source,
  }, HubAccountSection))
}
