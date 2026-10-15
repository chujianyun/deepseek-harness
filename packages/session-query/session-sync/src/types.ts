/**
 * Pure types of Session sync: the conversation bundle one machine uploads for a Session and its
 * subagent Sessions, which another machine of the same employee downloads, and the `sessionSync`
 * Remote's view of the conversations pulled here. Free of host-side value
 * imports.
 *
 * @module @deepseek-ai/dsh-session-sync/types
 */
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session/types'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The conversation came from another computer; it can be read here, not continued. */
    'session-sync/view-only': { readonly sessionId: SessionId }
  }
}

/** One Session's complete log inside a bundle. */
export interface SessionSyncLog {
  readonly header: SessionHeader
  /** Number of leading events inherited from the Session's fork parent. */
  readonly inheritedEventCount: number
  /** Contiguous events from seq 0. */
  readonly events: readonly SessionEvent[]
}

/** An assistant a bundle's conversation is bound to, as its computer knows it. */
export interface SessionSyncAssistant {
  readonly id: string
  readonly name: string
  /** Template it was created from, or null. */
  readonly templateId: string | null
}

/**
 * A Session's conversation as uploaded: the Session's own log first, then the logs of its subagent
 * Sessions (and theirs), ordered by id. Attachment bytes travel separately, keyed by the sha256 hex
 * digest that each `sha256:<hex>` attachment id in the events names.
 */
export interface SessionSyncBundle {
  /** Version of the bundle layout; a reader refuses a bundle with another. */
  readonly format: 1
  readonly sessions: readonly [SessionSyncLog, ...SessionSyncLog[]]
  /**
   * The assistants its `assistant/selected` events name, so another computer, whose own assistants
   * have other ids, can map them to the matching one.
   */
  readonly assistants?: readonly SessionSyncAssistant[]
}

/** One conversation pulled from another machine of the signed-in employee. */
export interface SessionSyncPulled {
  /** Its top-level Session here. */
  readonly sessionId: SessionId
  /** Name of the machine it comes from. */
  readonly device: string
  /** Revision of the copy here; it grows when the other machine changes the conversation. */
  readonly revision: number
}

/** The `sessionSync` Remote's state. */
export interface SessionSyncView {
  /** An employee of a tenant is signed in, so syncing runs. */
  readonly signedIn: boolean
  /** Grows with every change the sync makes to the Sessions stored here, so the client reloads its list. */
  readonly changes: number
  /** The conversations pulled from other computers; they are view-only here. */
  readonly pulled: readonly SessionSyncPulled[]
}
