/** E-commerce accounts state and actions over the `ecommerceAccounts` Remote, for the Settings section. */

import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  AddEcommerceAccountInput, AddEcommerceAccountResult, EcommerceAccountsState, RenameEcommerceAccountInput,
} from '@deepseek-ai/dsh-ecommerce-accounts/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

/** State the section renders: the latest Host state, undefined until the first frame. */
export interface AccountsSnapshot {
  readonly state: EcommerceAccountsState | undefined
}

/** A refused action, as the section words it. */
export type Refusal =
  | { readonly kind: 'chrome-missing' }
  | { readonly kind: 'chrome-outdated'; readonly version: string; readonly minVersion: number }
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'browser-busy' }
  | { readonly kind: 'in-use' }
  | { readonly kind: 'delete-failed' }
  | { readonly kind: 'other'; readonly message: string }

/** Remote calls the source drives. */
export interface AccountsDependencies {
  readonly add: (input: AddEcommerceAccountInput) => Promise<RemoteResult<AddEcommerceAccountResult>>
  readonly startSignIn: (accountId: string) => Promise<RemoteResult<EcommerceAccountsState>>
  readonly confirmSignIn: (accountId: string) => Promise<RemoteResult<EcommerceAccountsState>>
  readonly rename: (accountId: string, changes: RenameEcommerceAccountInput) => Promise<RemoteResult<EcommerceAccountsState>>
  readonly refresh: () => Promise<RemoteResult<EcommerceAccountsState>>
  readonly setDailyPages: (pages: number) => Promise<RemoteResult<EcommerceAccountsState>>
  readonly remove: (accountId: string) => Promise<RemoteResult<EcommerceAccountsState>>
  /** Open an address in the default browser. */
  readonly openUrl: (url: string) => void
}

/** Business face injected into the section. */
export interface AccountsInjected {
  readonly hooks: { readonly accounts: HostObservable<AccountsSnapshot> }
  /** Add an account; resolves to its id, or the refusal. */
  readonly onAdd: (input: AddEcommerceAccountInput) => Promise<{ readonly accountId: string } | Refusal>
  /** Open the sign-in page; resolves to the refusal, or undefined once it is open. */
  readonly onStartSignIn: (accountId: string) => Promise<Refusal | undefined>
  readonly onConfirmSignIn: (accountId: string) => Promise<Refusal | undefined>
  /** Change the account or store name, such as to the one the platform reports; resolves to the refusal, or undefined. */
  readonly onRename: (accountId: string, changes: RenameEcommerceAccountInput) => Promise<Refusal | undefined>
  /** Check every account again, as the section does when it opens. */
  readonly onRefresh: () => Promise<void>
  /** Set the tenant's daily page limit for buyer accounts; resolves to the refusal, or undefined. */
  readonly onSetDailyPages: (pages: number) => Promise<Refusal | undefined>
  readonly onDelete: (accountId: string) => Promise<Refusal | undefined>
  readonly onOpenUrl: (url: string) => void
}

/** The face plus the entry point of the Host stream. */
export interface AccountsSource extends AccountsInjected {
  readonly publish: (state: EcommerceAccountsState) => void
}

/**
 * Word a Remote failure.
 * @param error - the failure.
 * @returns the refusal.
 */
function refusalOf(error: Extract<RemoteResult<unknown>, { ok: false }>['error']): Refusal {
  switch (error.code) {
    case 'ecommerce-accounts/chrome-missing': return { kind: 'chrome-missing' }
    case 'ecommerce-accounts/chrome-outdated': return { kind: 'chrome-outdated', version: error.details.version, minVersion: error.details.minVersion }
    case 'ecommerce-accounts/duplicate': return { kind: 'duplicate' }
    case 'ecommerce-accounts/browser-busy': return { kind: 'browser-busy' }
    case 'ecommerce-accounts/in-use': return { kind: 'in-use' }
    case 'ecommerce-accounts/delete-failed': return { kind: 'delete-failed' }
    default: return { kind: 'other', message: error.message }
  }
}

/**
 * Create the source.
 * @param deps - Remote calls and the browser opener.
 * @returns the source.
 */
export function createAccountsSource(deps: AccountsDependencies): AccountsSource {
  const store = createSnapshotStore<AccountsSnapshot>({ state: undefined })
  // A call's state and the stream's frames may arrive in either order; keep the newer one.
  const adopt = (state: EcommerceAccountsState): void => {
    const current = store.getSnapshot().state
    if (current === undefined || state.revision > current.revision) store.set({ state })
  }
  const settle = async (call: Promise<RemoteResult<EcommerceAccountsState>>): Promise<Refusal | undefined> => {
    const result = await call
    if (!result.ok) return refusalOf(result.error)
    adopt(result.value)
    return undefined
  }
  return {
    hooks: { accounts: store },
    publish: adopt,
    onAdd: async (input) => {
      const result = await deps.add(input)
      if (!result.ok) return refusalOf(result.error)
      adopt(result.value.state)
      return { accountId: result.value.accountId }
    },
    onStartSignIn: accountId => settle(deps.startSignIn(accountId)),
    onConfirmSignIn: accountId => settle(deps.confirmSignIn(accountId)),
    onRename: (accountId, changes) => settle(deps.rename(accountId, changes)),
    onRefresh: async () => { await settle(deps.refresh()) },
    onSetDailyPages: pages => settle(deps.setDailyPages(pages)),
    onDelete: accountId => settle(deps.remove(accountId)),
    onOpenUrl: (url) => { deps.openUrl(url) },
  }
}
