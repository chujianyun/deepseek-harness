/** Types of the `ecommerceAccounts` Host service and its Remote namespace. */

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** This platform or account kind cannot be added yet. */
    'ecommerce-accounts/unsupported': { readonly platform: string; readonly kind: string }
    /** A required field is empty or too long. */
    'ecommerce-accounts/invalid-field': { readonly field: 'storeName' | 'account' | 'buyerDailyPages' }
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
    /** Another Chrome, not started by DSH, is using this account's browser data. */
    'ecommerce-accounts/browser-busy': { readonly accountId: string }
    /**
     * The account's browser data could not be removed, such as while files in it are still held open; the account
     * stays, signed out. `reason` is the error code.
     */
    'ecommerce-accounts/delete-failed': { readonly accountId: string; readonly reason: string }
    /** A task of the model is using this account's browser now. */
    'ecommerce-accounts/in-use': { readonly accountId: string }
  }
}

/** An e-commerce platform DSH supports: Tmall, Taobao, Pinduoduo, and Douyin shops (抖店). */
export type EcommercePlatform = 'tmall' | 'taobao' | 'pinduoduo' | 'doudian'

/** What an account is used for: a store's back office, or public pages as an ordinary buyer. */
export type EcommerceAccountKind = 'merchant' | 'buyer'

/**
 * Sign-in state of an account: `signing-in` while DSH waits for the user to sign in, `checking`
 * while DSH asks the platform, and `check-failed` when the platform could not be asked.
 */
export type EcommerceAccountStatus = 'signed-in' | 'signed-out' | 'signing-in' | 'checking' | 'check-failed'

/**
 * Why a check failed: the platform did not answer in time, its page could not be reached, or the
 * account's browser data is in use by a Chrome DSH did not start.
 */
export type EcommerceCheckProblem = 'timeout' | 'network' | 'busy'

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
  /** Why the last check failed, while the status is `check-failed`. */
  readonly problem?: EcommerceCheckProblem
  /** Name the platform reported for the signed-in account at the last successful check, when it reports one. */
  readonly signedInAs?: string
  /** Name the platform reported for the signed-in store at the last successful check, when it reports one. */
  readonly signedInStore?: string
  /** The account was signed in before and is signed out now: its sign-in expired or was ended. */
  readonly expired: boolean
  /** A task of the model is using the account's browser now. */
  readonly inUse: boolean
  /** Pages a task opened with a buyer account today, by the computer's calendar day. */
  readonly pagesToday?: number
  /** ISO time a buyer account's cooling down after the platform's risk control ends, while it lasts. */
  readonly cooldownUntil?: string
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
  /** Most pages a task may open with one buyer account in a calendar day, for this tenant. */
  readonly buyerDailyPages: number
  /** Accounts in the order they were added. */
  readonly accounts: readonly EcommerceAccountView[]
}

/** What the add-account form collects. */
export interface AddEcommerceAccountInput {
  readonly platform: EcommercePlatform
  readonly kind: EcommerceAccountKind
  /** Store name; required for a merchant account, ignored for a buyer account. */
  readonly storeName?: string
  readonly account: string
}

/** What `renameAccount` changes: the account name, the store name, or both. */
export interface RenameEcommerceAccountInput {
  readonly account?: string
  readonly storeName?: string
}

/** The result of adding an account. */
export interface AddEcommerceAccountResult {
  readonly accountId: string
  readonly state: EcommerceAccountsState
}
