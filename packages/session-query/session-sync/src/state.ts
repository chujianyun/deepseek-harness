/**
 * What this machine has synced, kept in `<dshHome>/session-sync.json`: for each top-level Session
 * it uploads, the account it syncs as, the revision and content digest of its last upload; the
 * deletions the user center has not acknowledged yet; for each Session it pulled from another
 * machine, its account, device, and revision; how far it has pulled for each account; and the
 * conversations of this computer that carry on pulled ones. The file is read once and rewritten
 * after each change;
 * a change that cannot be written is not applied.
 */
import { SyncRecordFile, withEntry } from '@deepseek-ai/dsh-hub-account'
import { z } from 'zod'

/** One top-level Session as this machine last synced it. */
export interface SyncedEntry {
  /** Account it syncs as (tenant and phone of the sign-in); another account's sign-in leaves it alone. */
  readonly account: string
  /** Revision of the last accepted upload; the next upload sends a higher one. */
  readonly revision: number
  /** Content digest of the last accepted upload, or of a bundle the user center refused for good. */
  readonly digest: string
  /** Storage change token the digest was read at; equal tokens skip reading the Session again. */
  readonly token: string
  /**
   * Why the bundle with `digest` is not on the user center: deleted on another machine, or refused
   * (too large, or invalid). Absent once it is.
   */
  readonly held?: 'deleted' | 'refused' | undefined
}

/** One top-level Session pulled from another machine of the same account. */
export interface PulledEntry {
  /** Account it was pulled for; another account's sign-in removes this machine's copy. */
  readonly account: string
  /** Name of the machine it comes from. */
  readonly device: string
  /** Revision of the copy written here. */
  readonly revision: number
  /** Ids of its stored Sessions here: the top-level Session first, then its subagent Sessions. */
  readonly members: readonly string[]
  /** Revision waiting on the user center because this copy was open when it arrived. */
  readonly behind?: number | undefined
  /** Deleted on the user center while this copy was open; it is removed on a later pass. */
  readonly gone?: true | undefined
}

const pulledSchema = z.object({
  account: z.string(),
  device: z.string(),
  revision: z.number().int().nonnegative(),
  members: z.array(z.string()).readonly(),
  behind: z.number().int().nonnegative().optional(),
  gone: z.literal(true).optional(),
})

/** A conversation of this computer that carries on a pulled one. */
export interface ContinuationEntry {
  /** Account it was continued under; the state lists it only for that account. */
  readonly account: string
  /** The pulled top-level Session it continues. */
  readonly sourceId: string
  /** Title of that conversation when it was continued, or null. */
  readonly title: string | null
  /** Name of the computer that conversation came from. */
  readonly device: string
}

const continuationSchema = z.object({ account: z.string(), sourceId: z.string(), title: z.string().nullable(), device: z.string() })

const entrySchema = z.object({
  account: z.string(),
  revision: z.number().int().nonnegative(),
  digest: z.string(),
  token: z.string(),
  held: z.enum(['deleted', 'refused']).optional(),
})

const stateFile = z.object({
  version: z.literal(2),
  sessions: z.record(z.string(), entrySchema),
  /** Deleted Sessions whose deletion the user center has not acknowledged, with their account. */
  deletes: z.record(z.string(), z.string()),
  pulled: z.record(z.string(), pulledSchema).default({}),
  /** How far each account's changes on the user center have been pulled. */
  cursors: z.record(z.string(), z.number().int().nonnegative()).default({}),
  /** Conversations of this computer that carry on pulled ones, by their top-level Session. */
  continuations: z.record(z.string(), continuationSchema).default({}),
})

type StateData = z.infer<typeof stateFile>

/** The sync record of this machine, loaded once and written through. */
export class SyncState {
  private readonly file: SyncRecordFile<StateData>

  /** @param path - the record file. */
  constructor(path: string) {
    this.file = new SyncRecordFile(path, stateFile, { version: 2, sessions: {}, deletes: {}, pulled: {}, cursors: {}, continuations: {} })
  }

  private get data(): StateData {
    return this.file.data
  }

  /**
   * Read the record file; a missing, unreadable, or damaged one reads as empty and is replaced on the
   * next write, so every Session is read and compared again.
   * @param warn - told about a damaged file.
   */
  load(warn: (message: string) => void): Promise<void> {
    return this.file.load(warn, 'session-sync')
  }

  /**
   * Read an uploaded Session's entry.
   * @param sessionId - a top-level Session.
   * @returns its entry, or undefined when it never synced.
   */
  entry(sessionId: string): SyncedEntry | undefined {
    return this.data.sessions[sessionId]
  }

  /**
   * List the uploaded Sessions.
   * @returns every uploaded Session, as Session id and entry.
   */
  entries(): [sessionId: string, entry: SyncedEntry][] {
    return Object.entries(this.data.sessions)
  }

  /**
   * List the deletions not acknowledged yet.
   * @returns the pending deletions, as Session id and account.
   */
  deletes(): [sessionId: string, account: string][] {
    return Object.entries(this.data.deletes)
  }

  /**
   * Record or forget a Session's entry.
   * @param sessionId - a top-level Session.
   * @param entry - its entry, or undefined to forget it.
   * @returns once written.
   */
  setEntry(sessionId: string, entry: SyncedEntry | undefined): Promise<void> {
    return this.apply(data => ({ ...data, sessions: withEntry(data.sessions, sessionId, entry) }))
  }

  /**
   * Record what a sync found, unless the Session was deleted meanwhile: its pending deletion then
   * removes it from the user center, and no entry is kept.
   * @param sessionId - a top-level Session.
   * @param entry - its entry.
   * @returns once written.
   */
  recordEntry(sessionId: string, entry: SyncedEntry): Promise<void> {
    return this.apply(data => (sessionId in data.deletes ? data : { ...data, sessions: withEntry(data.sessions, sessionId, entry) }))
  }

  /**
   * Record or forget a pending deletion.
   * @param sessionId - the deleted Session.
   * @param account - the account to delete it as, or undefined once the user center acknowledged it.
   * @returns once written.
   */
  setDelete(sessionId: string, account: string | undefined): Promise<void> {
    return this.apply(data => ({ ...data, deletes: withEntry(data.deletes, sessionId, account) }))
  }

  /**
   * Read a pulled Session's entry.
   * @param sessionId - a top-level Session.
   * @returns its pulled entry, or undefined when it was not pulled from another machine.
   */
  pulled(sessionId: string): PulledEntry | undefined {
    return this.data.pulled[sessionId]
  }

  /**
   * Find the pulled conversation a stored Session belongs to: the top-level Session or one of its
   * subagent Sessions.
   * @param sessionId - a stored Session.
   * @returns the pulled entry, or undefined when it is not part of a pulled conversation.
   */
  pulledOwner(sessionId: string): PulledEntry | undefined {
    return this.data.pulled[sessionId] ?? Object.values(this.data.pulled).find(entry => entry.members.includes(sessionId))
  }

  /**
   * List the pulled Sessions.
   * @returns every pulled Session, as Session id and entry.
   */
  pulledSessions(): [sessionId: string, entry: PulledEntry][] {
    return Object.entries(this.data.pulled)
  }

  /**
   * Record or forget a pulled Session.
   * @param sessionId - a top-level Session.
   * @param entry - its entry, or undefined to forget it.
   * @returns once written.
   */
  setPulled(sessionId: string, entry: PulledEntry | undefined): Promise<void> {
    return this.apply(data => ({ ...data, pulled: withEntry(data.pulled, sessionId, entry) }))
  }

  /**
   * Record a pulled Session, unless the user deleted it here meanwhile.
   * @param sessionId - a top-level Session.
   * @param entry - its entry.
   * @returns false when it was deleted here, so nothing was recorded.
   */
  async recordPulled(sessionId: string, entry: PulledEntry): Promise<boolean> {
    let recorded = false
    await this.apply((data) => {
      recorded = !(sessionId in data.deletes)
      return recorded ? { ...data, pulled: withEntry(data.pulled, sessionId, entry) } : data
    })
    return recorded
  }

  /**
   * Read what a conversation of this computer carries on.
   * @param sessionId - a top-level Session.
   * @returns its continuation entry, or undefined when it continues nothing pulled.
   */
  continuation(sessionId: string): ContinuationEntry | undefined {
    return this.data.continuations[sessionId]
  }

  /**
   * List the conversations that carry on pulled ones.
   * @returns each continuing top-level Session with what it continues.
   */
  continuations(): [sessionId: string, entry: ContinuationEntry][] {
    return Object.entries(this.data.continuations)
  }

  /**
   * Record or forget a conversation that carries on a pulled one.
   * @param sessionId - the continuing top-level Session.
   * @param entry - what it continues, or undefined to forget it.
   * @returns once written.
   */
  setContinuation(sessionId: string, entry: ContinuationEntry | undefined): Promise<void> {
    return this.apply(data => ({ ...data, continuations: withEntry(data.continuations, sessionId, entry) }))
  }

  /**
   * Read how far an account's changes have been pulled.
   * @param account - an account.
   * @returns the user center's cursor; 0 before the first pull.
   */
  cursor(account: string): number {
    return this.data.cursors[account] ?? 0
  }

  /**
   * Record how far an account's changes have been pulled.
   * @param account - the account.
   * @param cursor - the user center's cursor after the last change pulled, or undefined to pull from the start again.
   * @returns once written.
   */
  setCursor(account: string, cursor: number | undefined): Promise<void> {
    return this.apply(data => ({ ...data, cursors: withEntry(data.cursors, account, cursor) }))
  }

  /** Apply one change after the earlier ones; the record reads the change only once it is written. */
  private apply(change: (data: StateData) => StateData): Promise<void> {
    return this.file.write(change)
  }
}
