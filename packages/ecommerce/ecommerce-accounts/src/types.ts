/** Types of the `ecommerceAccounts` Host service and its Remote namespace. */

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** This platform or account kind cannot be added yet. */
    'ecommerce-accounts/unsupported': { readonly platform: string; readonly kind: string }
    /** A required field is empty or too long. */
    'ecommerce-accounts/invalid-field': { readonly field: 'storeName' | 'account' }
    /** The tenant already has this account on this platform as this kind. */
    'ecommerce-accounts/duplicate': { readonly accountId: string }
    /** The signed-in tenant has no account with this id. */
    'ecommerce-accounts/not-found': { readonly accountId: string }
    /** Google Chrome is not installed where DSH looks for it. */
    'ecommerce-accounts/chrome-missing': Record<string, never>
    /** The installed Google Chrome is older than DSH supports. */
    'ecommerce-accounts/chrome-outdated': { readonly version: string; readonly minVersion: number }
    /** Chrome could not be started or reached for this account. */
    'ecommerce-accounts/browser-failed': { readonly accountId: string; readonly reason: string }
  }
}

/** An e-commerce platform DSH supports. */
export type EcommercePlatform = 'tmall'

/** What an account is used for: a store's back office, or public pages as an ordinary buyer. */
export type EcommerceAccountKind = 'merchant' | 'buyer'

/**
 * Sign-in state of an account: `signing-in` while DSH waits for the user to sign in, `checking`
 * while DSH asks the platform, and `check-failed` when the platform could not be asked.
 */
export type EcommerceAccountStatus = 'signed-in' | 'signed-out' | 'signing-in' | 'checking' | 'check-failed'

/** One account as the settings page shows it; it holds no password or cookie. */
export interface EcommerceAccountView {
  /** Account id, unique within the tenant. */
  readonly id: string
  readonly platform: EcommercePlatform
  readonly kind: EcommerceAccountKind
  /** Store name of a merchant account. */
  readonly storeName?: string
  /** The account name the user entered. */
  readonly account: string
  readonly status: EcommerceAccountStatus
  /** Name the platform reported for the signed-in account at the last successful check. */
  readonly signedInAs?: string
  /** ISO time of the last check that reached the platform. */
  readonly checkedAt?: string
  /** ISO time the account was added. */
  readonly createdAt: string
}

/** Whether the system Google Chrome can run e-commerce accounts. */
export interface ChromeView {
  /** `ready`, `missing` when not installed, or `outdated` when older than {@link minVersion}. */
  readonly status: 'ready' | 'missing' | 'outdated'
  /** Version string Chrome reports, when installed. */
  readonly version?: string
  readonly minVersion: number
  /** Where to get Google Chrome. */
  readonly downloadUrl: string
}

/** The signed-in tenant's e-commerce accounts. */
export interface EcommerceAccountsState {
  /** Grows with every change, so a reader keeps the newer of two states that arrive out of order. */
  readonly revision: number
  /** Tenant of the current Hub sign-in; null while signed out. */
  readonly tenantId: string | null
  readonly chrome: ChromeView
  /** Accounts in the order they were added. */
  readonly accounts: readonly EcommerceAccountView[]
}

/** What the add-account form collects. */
export interface AddEcommerceAccountInput {
  readonly platform: EcommercePlatform
  readonly kind: EcommerceAccountKind
  /** Store name; required for a merchant account. */
  readonly storeName?: string
  readonly account: string
}

/** The result of adding an account. */
export interface AddEcommerceAccountResult {
  readonly accountId: string
  readonly state: EcommerceAccountsState
}
