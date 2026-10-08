/**
 * E-commerce accounts, browser half: the Settings section that lists the tenant's accounts, adds
 * one, and follows its sign-in in Google Chrome, and the app-wide notice that an account's sign-in
 * expired. The section is there only while the Desktop is signed in to the user center, because
 * accounts belong to its tenant.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { EcommerceAccountsState } from '@deepseek-ai/dsh-ecommerce-accounts/types'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { createAccountsSource } from './accounts-source.ts'
import { EcommerceAccountsSection } from './EcommerceAccountsSection.tsx'
import { createExpiredSource, ExpiredToast } from './ExpiredToast.tsx'
import { en, zh, type EcommerceLocaleKey } from './locales.ts'

export type { AccountsDependencies, AccountsInjected, AccountsSnapshot, Refusal } from './accounts-source.ts'
export type { EcommerceAccountsSectionProps } from './EcommerceAccountsSection.tsx'
export type { ExpiredNotice, ExpiredSource, ExpiredToastProps } from './ExpiredToast.tsx'
export type { EcommerceLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** E-commerce accounts section copy. */
    'ecommerce-accounts': EcommerceLocaleKey
  }
}

const NS = 'ecommerce-accounts'

/** Services the section reads: the `ecommerceAccounts` Remote and the Settings slots. */
export const inject = ['slots', 'locale', 'remote', 'remote.ecommerceAccounts']

/**
 * Contribute the E-commerce accounts section to Settings in the Desktop renderer, while signed in to the user center.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  // Desktop only: accounts sign in through the system Chrome, which only the Desktop host starts.
  if (!('dshDesktop' in globalThis)) return
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-ecommerce-accounts: dictionaries')
  const t = ctx.locale.bind(NS)
  const remote = ctx.remote.ecommerceAccounts
  const source = createAccountsSource({
    add: input => remote.addAccount(input),
    startSignIn: accountId => remote.startSignIn(accountId),
    confirmSignIn: accountId => remote.confirmSignIn(accountId),
    rename: (accountId, changes) => remote.renameAccount(accountId, changes),
    refresh: () => remote.refresh(),
    setDailyPages: pages => remote.setBuyerDailyPages(pages),
    remove: accountId => remote.deleteAccount(accountId),
    // The Desktop shell sends a new window's http(s) address to the default browser.
    openUrl: (url) => { globalThis.open(url, '_blank', 'noopener') },
  })
  let unregister: (() => void) | undefined
  const placeSection = (state: EcommerceAccountsState): void => {
    if (state.tenantId !== null && unregister === undefined) {
      unregister = ctx.slots.register({
        name: 'settings.section', id: 'ecommerce-accounts', order: -10, label: () => t('section'), locale: NS, inject: () => source,
      }, EcommerceAccountsSection)
    } else if (state.tenantId === null && unregister !== undefined) {
      unregister()
      unregister = undefined
    }
  }
  ctx.effect(() => () => { unregister?.() }, 'ui-ecommerce-accounts: settings section')
  const expired = createExpiredSource()
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'ecommerce-accounts.expired', locale: NS,
    inject: () => ({ hooks: expired.hooks, dismiss: expired.dismiss, openAccounts: () => { ctx.emit('settings/open-section', 'ecommerce-accounts') } }),
  }, ExpiredToast))
  const accounts = ctx.remote.$stream<EcommerceAccountsState>({
    name: 'ecommerceAccounts', open: signal => remote.watch(signal), ended: () => new Error('ecommerce accounts stream ended'),
  })
  ctx.effect(() => () => { void accounts.dispose() }, 'ui-ecommerce-accounts: state stream')
  void (async () => {
    for await (const frame of accounts) {
      source.publish(frame.value)
      expired.observe(frame.value)
      placeSection(frame.value)
      frame.accept()
    }
  })().catch(() => {
    // The stream reconnects on its own; a disposed plugin simply stops listening.
  })
}
