/**
 * Browser-safe failure vocabulary of the configuration surfaces this package
 * serves, and the views of the `authorization` namespace. The redacted settings
 * views live with their seam in `@deepseek-ai/dsh-settings/types`, whose Cordis
 * event declarations already register that file for the Client compilation face.
 *
 * @module @deepseek-ai/dsh-api-settings-controller/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type {
  AuthorizationMethod, AuthorizationNotice, AuthorizationPromptOption,
} from '@deepseek-ai/dsh-authorization/types'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /**
     * Every seam refusal that is not a stale write: an unregistered or malformed
     * namespace, a read-only provider, schema validation, storage.
     */
    'settings/rejected': { readonly ns: string }
    /**
     * The stored revision moved after the caller read it. Its own outcome rather
     * than an invalid request: the caller must re-read and re-apply.
     */
    'settings/conflict': { readonly ns: string; readonly expected: number; readonly actual: number }
    /**
     * The provider refused a valid credential write, for example because a
     * read-only source shadows the reference. The details name only the
     * reference, never the value.
     */
    'credential/rejected': { readonly ref: string }
    /**
     * The authorization seam refused to start a sign-in or sign out: no flow is
     * registered for the key, or the flow offers no such method.
     */
    'authorization/rejected': { readonly key: string }
    /** The named sign-in attempt, or the named question in it, is no longer waiting. */
    'authorization/not-found': { readonly attemptId: string }
  }
}

/** Confirmation that the settings document was handed to the native editor. */
export interface SettingsDocumentOpenValue {
  readonly opened: true
}

/** Identity of one sign-in attempt, issued when it starts. */
export type AuthorizationAttemptId = Branded<'AuthorizationAttemptId'>

/** Identity of one question a sign-in attempt is waiting on, unique within its attempt. */
export type AuthorizationPromptId = Branded<'AuthorizationPromptId'>

/** Where a sign-in attempt is. */
export type AuthorizationAttemptPhase = 'running' | 'authorized' | 'cancelled' | 'failed'

/** A question a running sign-in is waiting on; answered with `answer`, declined with `decline`. */
export type AuthorizationPromptView = {
  readonly id: AuthorizationPromptId
  readonly message: string
} & ({
  readonly kind: 'text' | 'secret'
  readonly placeholder?: string
} | {
  readonly kind: 'select'
  readonly options: readonly AuthorizationPromptOption[]
})

/** The latest sign-in attempt for one credential, running or finished. */
export interface AuthorizationAttemptView {
  readonly id: AuthorizationAttemptId
  /** The flow method this attempt runs. */
  readonly method: string
  readonly phase: AuthorizationAttemptPhase
  /** What the flow reported, oldest first: pages to open and codes to enter. Never a secret. */
  readonly notices: readonly AuthorizationNotice[]
  /** Questions waiting for an answer, oldest first; empty once the attempt finishes. */
  readonly prompts: readonly AuthorizationPromptView[]
  /** Why the attempt failed, when `phase` is `failed`. */
  readonly error?: string
}

/** One credential a configuration surface can sign in to. */
export interface AuthorizationFlowView {
  /** Credential record key (`<scope>/<id>`) the flow writes. */
  readonly key: string
  /** User-facing name of what is signed in to. */
  readonly label: string
  /** The flow's methods, most preferred first. */
  readonly methods: readonly AuthorizationMethod[]
  /** Whether a credential is stored under the key. */
  readonly signedIn: boolean
  /** The latest attempt started through this namespace, or null when there was none. */
  readonly attempt: AuthorizationAttemptView | null
}
