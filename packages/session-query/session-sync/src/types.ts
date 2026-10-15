/**
 * Pure types of Session sync: the conversation bundle one machine uploads for a Session and its
 * subagent Sessions, which another machine of the same employee downloads. Free of host-side value
 * imports.
 *
 * @module @deepseek-ai/dsh-session-sync/types
 */
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'

/** One Session's complete log inside a bundle. */
export interface SessionSyncLog {
  readonly header: SessionHeader
  /** Number of leading events inherited from the Session's fork parent. */
  readonly inheritedEventCount: number
  /** Contiguous events from seq 0. */
  readonly events: readonly SessionEvent[]
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
}
