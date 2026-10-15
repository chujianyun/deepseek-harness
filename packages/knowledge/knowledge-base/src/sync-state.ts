/**
 * What this machine has synced of its knowledge bases, kept in `<dshHome>/knowledge-sync.json`, per
 * account (tenant and phone of the sign-in): how far it has pulled; for each knowledge base and item
 * it knows on the user center, the revision and content digest last uploaded or pulled and the
 * computer it came from; and the deletions the user center has not acknowledged yet. The file is
 * read once and rewritten after each change; a change that cannot be written is not applied.
 */
import { SyncRecordFile, withEntry } from '@deepseek-ai/dsh-hub-account'
import { z } from 'zod'

/** A knowledge base or item as the user center last held it from this machine's view. */
export interface SyncedRecord {
  /** Revision last uploaded or pulled; the next upload sends a higher one. */
  readonly revision: number
  /** Digest of what was uploaded or pulled; a different local digest means a change to upload. */
  readonly digest: string
  /** Name of the computer it was pulled from; null when it was made here. */
  readonly from: string | null
  /** Set when the user center refused the content with `digest` for good (too large, or invalid); absent once it holds it. */
  readonly held?: 'refused' | undefined
}

/** An item's record, with its knowledge base and the digest of its copy's bytes. */
export interface SyncedItemRecord extends SyncedRecord {
  readonly baseId: string
  /** The copy's sha256 when it had this size and modification time, so an unchanged copy is not read again. */
  readonly copy?: { readonly size: number; readonly mtimeMs: number; readonly sha256: string } | undefined
}

/** A deletion to send. */
export interface PendingDelete {
  readonly kind: 'base' | 'item'
  readonly id: string
}

const recordShape = {
  revision: z.number().int().nonnegative(),
  digest: z.string(),
  from: z.string().nullable(),
  held: z.literal('refused').optional(),
}

const accountSchema = z.object({
  cursor: z.number().int().nonnegative().default(0),
  bases: z.record(z.string(), z.object(recordShape)).default({}),
  items: z.record(z.string(), z.object({
    ...recordShape,
    baseId: z.string(),
    copy: z.object({ size: z.number().nonnegative(), mtimeMs: z.number(), sha256: z.string() }).optional(),
  })).default({}),
  deletes: z.array(z.object({ kind: z.enum(['base', 'item']), id: z.string() })).default([]),
})

const stateFile = z.object({ version: z.literal(1), accounts: z.record(z.string(), accountSchema) })

type AccountData = z.infer<typeof accountSchema>
type StateData = z.infer<typeof stateFile>

const EMPTY: AccountData = { cursor: 0, bases: {}, items: {}, deletes: [] }

/** The knowledge sync record of this machine, loaded once and written through. */
export class KnowledgeSyncState {
  private readonly file: SyncRecordFile<StateData>

  /** @param path - the record file. */
  constructor(path: string) {
    this.file = new SyncRecordFile(path, stateFile, { version: 1, accounts: {} })
  }

  /**
   * Read the record file; a missing, unreadable, or damaged one reads as empty, so every knowledge
   * base is uploaded and pulled again.
   * @param warn - told about a damaged file.
   */
  load(warn: (message: string) => void): Promise<void> {
    return this.file.load(warn, 'knowledge-base')
  }

  /**
   * Which account knows a knowledge base.
   * @param baseId - a knowledge base.
   * @returns the account whose record holds it, or undefined.
   */
  ownerOf(baseId: string): string | undefined {
    return Object.entries(this.file.data.accounts).find(([, account]) => baseId in account.bases)?.[0]
  }

  /**
   * Read an account's record.
   * @param account - the account.
   * @returns its cursor, knowledge bases, items, and pending deletions.
   */
  account(account: string): Readonly<AccountData> {
    return this.file.data.accounts[account] ?? EMPTY
  }

  /**
   * Record how far an account's changes have been pulled.
   * @param account - the account.
   * @param cursor - the user center's cursor after the last change pulled.
   * @returns once written.
   */
  setCursor(account: string, cursor: number): Promise<void> {
    return this.change(account, data => ({ ...data, cursor }))
  }

  /**
   * Record or forget a knowledge base.
   * @param account - the account.
   * @param baseId - the knowledge base.
   * @param record - its record, or undefined to forget it.
   * @returns once written.
   */
  setBase(account: string, baseId: string, record: SyncedRecord | undefined): Promise<void> {
    return this.change(account, data => ({ ...data, bases: withEntry(data.bases, baseId, record) }))
  }

  /**
   * Record or forget an item.
   * @param account - the account.
   * @param itemId - the item.
   * @param record - its record, or undefined to forget it.
   * @returns once written.
   */
  setItem(account: string, itemId: string, record: SyncedItemRecord | undefined): Promise<void> {
    return this.change(account, data => ({ ...data, items: withEntry(data.items, itemId, record) }))
  }

  /**
   * Forget a knowledge base with its items, sending no deletion.
   * @param account - the account.
   * @param baseId - the knowledge base.
   * @returns once written.
   */
  forgetBase(account: string, baseId: string): Promise<void> {
    return this.change(account, data => ({
      ...data,
      bases: withEntry<SyncedRecord>(data.bases, baseId, undefined),
      items: Object.fromEntries(Object.entries(data.items).filter(([, item]) => item.baseId !== baseId)),
    }))
  }

  /**
   * Forget knowledge bases or items and queue their deletion on the user center.
   * @param account - the account.
   * @param deletes - what was deleted here; a knowledge base's items are forgotten with it.
   * @returns once written.
   */
  queueDeletes(account: string, deletes: readonly PendingDelete[]): Promise<void> {
    return this.change(account, (data) => {
      const bases = new Set(deletes.filter(entry => entry.kind === 'base').map(entry => entry.id))
      const items = new Set(deletes.filter(entry => entry.kind === 'item').map(entry => entry.id))
      return {
        ...data,
        bases: Object.fromEntries(Object.entries(data.bases).filter(([id]) => !bases.has(id))),
        items: Object.fromEntries(Object.entries(data.items).filter(([id, item]) => !items.has(id) && !bases.has(item.baseId))),
        // A knowledge base's deletion covers its items on the user center.
        deletes: [...data.deletes, ...deletes.filter(entry => entry.kind === 'base' || !bases.has(entry.id))],
      }
    })
  }

  /**
   * Drop a deletion the user center acknowledged.
   * @param account - the account.
   * @param entry - the deletion.
   * @returns once written.
   */
  doneDelete(account: string, entry: PendingDelete): Promise<void> {
    const other = (item: PendingDelete) => item.kind !== entry.kind || item.id !== entry.id
    return this.change(account, data => ({ ...data, deletes: data.deletes.filter(other) }))
  }

  /** Apply one change to an account after the earlier ones; the record reads it only once it is written. */
  private change(account: string, update: (data: AccountData) => AccountData): Promise<void> {
    return this.file.write(data => ({ ...data, accounts: { ...data.accounts, [account]: update(data.accounts[account] ?? EMPTY) } }))
  }
}
