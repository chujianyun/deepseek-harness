/**
 * Pure types of Session sharing: the `sessionShare` Remote's requests and results, the snapshot a
 * share carries, and its error details. Free of host-side value imports, so `./types` serves Host
 * consumers and `./client` re-exports it for Client code.
 *
 * @module @deepseek-ai/dsh-session-share/types
 */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** Sharing needs a user-center sign-in, and there is none. */
    'session-share/signed-out': Record<never, never>
    /** The Session has no user message or assistant reply to share. */
    'session-share/empty': { readonly sessionId: SessionId }
    /** The user center refused the request; `status` is its HTTP status and the message its own text. */
    'session-share/refused': { readonly status: number }
    /** The user center could not be reached. */
    'session-share/unreachable': Record<never, never>
  }
}

/** One tool call in a shared reply: the tool's name and a one-line summary of its arguments. */
export interface SessionShareToolCall {
  readonly name: string
  readonly summary?: string
}

/** One message of the shared snapshot. */
export interface SessionShareMessage {
  readonly role: 'user' | 'assistant'
  readonly text: string
  /** Tools the reply called, by name and summary only. */
  readonly tools?: readonly SessionShareToolCall[]
  /** ISO 8601 time of the message. */
  readonly at: string
}

/** Id of a share on the user center. */
export type SessionShareId = Branded<'SessionShareId'>

/** A share's link on the user center. */
export interface SessionShareLink {
  readonly shareId: SessionShareId
  /** The page a signed-in member of the same company opens. */
  readonly url: string
  readonly createdAt: string
  readonly updatedAt: string
}

/** Request naming one Session. */
export interface SessionShareTarget {
  readonly sessionId: SessionId
}

/** Whether sharing is possible now, and the Session's current share. */
export interface SessionShareStatus {
  /** A user-center sign-in exists. */
  readonly signedIn: boolean
  /** The Session's share, or null when it is not shared (or signed out). */
  readonly link: SessionShareLink | null
}

/** Share one Session, or refresh its existing share with the conversation as it is now. */
export interface SessionShareRequest extends SessionShareTarget {
  /** The Session's title as the user sees it, at most 200 characters after trimming. */
  readonly title: string
}
