/**
 * Browser-safe wire shapes of the `hubAccount` Remote namespace: Hub sign-in state as the
 * Desktop sign-in gate and the account section render it. Tokens never appear here.
 *
 * @module @deepseek-ai/dsh-hub-account/types
 */

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** A new prompt was refused because Hub sign-in is missing or expired. */
    'hub-account/signed-out': Record<string, never>
    /** The named sign-in attempt is not the current one. */
    'hub-account/attempt-not-found': { readonly attemptId: string }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * The user center refused to refresh the stored sign-in (employee or tenant disabled, grant
     * revoked); the local grant is already removed.
     * @mode emit
     */
    'hub-account/session-expired'(): void
  }
}

/** The signed-in employee profile, as the user center's userinfo reports it. */
export interface HubProfile {
  /** Display nickname. */
  readonly nickname: string
  /** Masked or full phone number the user signs in with. */
  readonly phone: string
  /** Tenant this sign-in is bound to. */
  readonly tenantId: string | null
  /** Display name of that tenant. */
  readonly tenantName: string | null
  /** Whether the employee administers that tenant. */
  readonly isTenantAdmin: boolean | null
}

/** Where a sign-in attempt is. */
export type HubSignInPhase = 'waiting-browser' | 'exchanging' | 'succeeded' | 'cancelled' | 'failed'

/** Why a sign-in attempt failed. */
export type HubSignInError = 'denied' | 'expired' | 'protocol' | 'network' | 'storage'

/** One browser sign-in attempt. */
export interface HubSignInAttemptView {
  readonly id: string
  readonly phase: HubSignInPhase
  /** User-center authorization page to open in the system browser, while waiting for it. */
  readonly authorizeUrl?: string
  /** Failure reason when `phase` is `failed`. */
  readonly error?: HubSignInError
}

/** Hub sign-in state. */
export interface HubAccountView {
  readonly status: 'signed-out' | 'signed-in'
  /** Profile of the signed-in employee; null while signed out. */
  readonly profile: HubProfile | null
  /** `expired` when the last sign-in ended because the user center refused to refresh it. */
  readonly reason: 'expired' | null
  /** The current or last-settled sign-in attempt. */
  readonly attempt: HubSignInAttemptView | null
}
