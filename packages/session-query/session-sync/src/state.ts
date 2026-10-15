/**
 * What this machine has synced, kept in `<dshHome>/session-sync.json`: for each top-level Session,
 * the account it syncs as, the revision and content digest of its last upload, and the deletions
 * the user center has not acknowledged yet. The file is read once and rewritten after each change;
 * a change that cannot be written is not applied.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
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
})

type StateData = z.infer<typeof stateFile>

/** The sync record of this machine, loaded once and written through. */
export class SyncState {
  private data: StateData = { version: 2, sessions: {}, deletes: {} }
  private writes: Promise<void> = Promise.resolve()

  /** @param path - the record file. */
  constructor(private readonly path: string) {}

  /**
   * Read the record file; a missing, unreadable, or damaged one reads as empty and is replaced on the
   * next write, so every Session is read and compared again.
   * @param warn - told about a damaged file.
   */
  async load(warn: (message: string) => void): Promise<void> {
    // Missing on first start.
    const text = await readFile(this.path, 'utf8').catch(() => undefined)
    if (text === undefined) return
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      // Damaged JSON records nothing; the schema check below reports it.
      raw = undefined
    }
    const parsed = stateFile.safeParse(raw)
    if (parsed.success) this.data = parsed.data
    else warn(`session-sync: unreadable sync record ${this.path} ignored`)
  }

  /**
   * @param sessionId - a top-level Session.
   * @returns its entry, or undefined when it never synced.
   */
  entry(sessionId: string): SyncedEntry | undefined {
    return this.data.sessions[sessionId]
  }

  /** @returns the pending deletions, as Session id and account. */
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
    return this.apply(data => ({ ...data, sessions: replaced(data.sessions, sessionId, entry) }))
  }

  /**
   * Record what a sync found, unless the Session was deleted meanwhile: its pending deletion then
   * removes it from the user center, and no entry is kept.
   * @param sessionId - a top-level Session.
   * @param entry - its entry.
   * @returns once written.
   */
  recordEntry(sessionId: string, entry: SyncedEntry): Promise<void> {
    return this.apply(data => (sessionId in data.deletes ? data : { ...data, sessions: replaced(data.sessions, sessionId, entry) }))
  }

  /**
   * Record or forget a pending deletion.
   * @param sessionId - the deleted Session.
   * @param account - the account to delete it as, or undefined once the user center acknowledged it.
   * @returns once written.
   */
  setDelete(sessionId: string, account: string | undefined): Promise<void> {
    return this.apply(data => ({ ...data, deletes: replaced(data.deletes, sessionId, account) }))
  }

  /** Apply one change after the earlier ones; the record reads the change only once it is written. */
  private apply(change: (data: StateData) => StateData): Promise<void> {
    const write = this.writes.then(async () => {
      const next = change(this.data)
      if (next === this.data) return
      await mkdir(dirname(this.path), { recursive: true })
      const temporary = `${this.path}.${String(process.pid)}.tmp`
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`)
      await rename(temporary, this.path)
      this.data = next
    })
    this.writes = write.catch(() => undefined)
    return write
  }
}

/** The record with `key` set to `value`, or without `key` for undefined. */
function replaced<T>(record: Readonly<Record<string, T>>, key: string, value: T | undefined): Record<string, T> {
  const { [key]: _previous, ...rest } = record
  return value === undefined ? rest : { ...rest, [key]: value }
}
