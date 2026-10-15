/**
 * Knowledge base sync with the user center of the Hub sign-in (`/api/client/sync/knowledge`): each
 * knowledge base's name, embedding model, and settings, and each item with its copy (a file's copy,
 * a fetched page, a note). Vectors are never synced; every computer processes what it pulls. A pass
 * sends the deletions made here, uploads what changed here since its last upload, and then pulls the
 * other computers' changes. Passes run after local changes, on an interval, on sign-in, and when asked.
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  refuseSync, SyncNotAllowed as NotAllowed, SyncPasses, SyncRetryLater as RetryLater, SyncSignIn,
} from '@deepseek-ai/dsh-hub-account'
import { z } from 'zod'
import { settingsShape } from './settings.ts'
import type { ItemRow } from './store.ts'
import { KnowledgeSyncState, type PendingDelete, type SyncedItemRecord, type SyncedRecord } from './sync-state.ts'
import type { KnowledgeBaseSettings, KnowledgeItemKind } from './types.ts'

/** Uploads of one knowledge base or item within one pass, before leaving it to the next pass. */
const PUT_ATTEMPTS = 3
const ITEM_NAME_MAX = 1000

/** A knowledge base of the signed-in tenant as stored here. */
export interface LocalBase {
  readonly id: string
  readonly name: string
  readonly embeddingModelId: string
  readonly settings: KnowledgeBaseSettings
  readonly createdAt: string
  /** Its items, each with the path of its copy; null for a folder, which has none. */
  readonly items: readonly { readonly row: ItemRow; readonly copy: string | null }[]
}

/** A knowledge base pulled from the user center. */
export interface RemoteBase {
  readonly id: string
  readonly name: string
  readonly embeddingModelId: string
  readonly settings: KnowledgeBaseSettings
  readonly createdAt: string
}

/** An item pulled from the user center. */
export interface RemoteItem {
  readonly id: string
  readonly baseId: string
  readonly kind: KnowledgeItemKind
  readonly parentId: string | null
  readonly name: string
  readonly source: string | null
  readonly size: number
  readonly addedAt: string
}

/** What the knowledge base service lets the sync read and change; each call runs in its edit order. */
export interface SyncHost {
  /** The signed-in tenant and its knowledge bases, or null while there is none. */
  snapshot(): Promise<{ readonly tenantId: string | null; readonly bases: readonly LocalBase[] }>
  /** Whether a knowledge base of the tenant still has its directory, opened or not. */
  baseExists(tenantId: string, baseId: string): Promise<boolean>
  /** Create or update a knowledge base; false when the tenant changed meanwhile. */
  applyBase(tenantId: string, base: RemoteBase): Promise<boolean>
  /** Create or update an item with its copy; false when its knowledge base or folder is not here. */
  applyItem(tenantId: string, item: RemoteItem, content: Uint8Array | null): Promise<boolean>
  /** Delete a knowledge base with its items; nothing when it is not here. */
  removeBase(tenantId: string, baseId: string): Promise<void>
  /** Delete an item (a folder with its files); nothing when it is not here. */
  removeItem(tenantId: string, baseId: string, itemId: string): Promise<void>
}

/** Timings and identity of the sync. */
export interface SyncOptions {
  readonly statePath: string
  readonly device: string
  readonly debounceMs: number
  readonly intervalMs: number
  readonly retryMs: number
  readonly requestTimeoutMs: number
}

const settingsSchema = z.object(settingsShape)

const baseEntry = z.object({
  type: z.literal('base'), baseId: z.string(), revision: z.number().int().nonnegative(), device: z.string(), name: z.string(),
  embeddingModelId: z.string(), settings: z.record(z.string(), z.unknown()), createdAt: z.string(), deleted: z.boolean(),
})
const itemEntry = z.object({
  type: z.literal('item'), itemId: z.string(), baseId: z.string(), revision: z.number().int().nonnegative(), device: z.string(),
  kind: z.enum(['file', 'folder', 'url', 'note']), parentId: z.string().nullable(), name: z.string(), source: z.string().nullable(),
  sha256: z.string().nullable(), sizeBytes: z.number().int().nonnegative(), addedAt: z.string(), deleted: z.boolean(),
})
const listSchema = z.object({
  changes: z.array(z.discriminatedUnion('type', [baseEntry, itemEntry])),
  cursor: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  reset: z.boolean(),
})
const conflictSchema = z.object({ code: z.string(), revision: z.number().int().nonnegative().optional() })
const checkSchema = z.object({ missing: z.array(z.string()) })

type ListedBase = z.infer<typeof baseEntry>
type ListedItem = z.infer<typeof itemEntry>

/** Media types the user center's admin view previews; other files are only downloaded. */
const MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.md': 'text/markdown', '.markdown': 'text/markdown', '.txt': 'text/plain',
}

/**
 * An item's media type as uploaded: pages and notes are Markdown, a folder has none.
 * @param kind - the item's kind.
 * @param name - its name; a file's extension names its type.
 * @returns the media type, or null when the admin view only offers the file for download.
 */
export function mediaTypeOf(kind: KnowledgeItemKind, name: string): string | null {
  if (kind === 'folder') return null
  if (kind !== 'file') return 'text/markdown'
  return MEDIA_TYPES[extname(name).toLowerCase()] ?? null
}

const sha256Of = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')

/** Digest of what a knowledge base uploads. */
function baseDigest(base: Pick<RemoteBase, 'name' | 'embeddingModelId' | 'settings'>): string {
  const { chunkStrategy, chunkSeparator, chunkSize, chunkOverlap, documentCount, threshold } = base.settings
  const fields = [base.name, base.embeddingModelId, chunkStrategy, chunkSeparator, chunkSize, chunkOverlap, documentCount, threshold]
  return sha256Of(JSON.stringify(fields))
}

/** What an item uploads, without its knowledge base's id. */
interface ItemFields {
  readonly kind: KnowledgeItemKind
  readonly parentId: string | null
  readonly name: string
  readonly source: string | null
  readonly sha256: string | null
  readonly size: number
  readonly addedAt: string
}

/** Digest of what an item uploads. */
function itemDigest(baseId: string, item: ItemFields): string {
  return sha256Of(JSON.stringify([baseId, item.kind, item.parentId, item.name, item.source, item.sha256, item.size, item.addedAt]))
}

const tenantOf = (account: string): string => account.slice(0, account.lastIndexOf('/'))

/** Host owner of knowledge base sync for one knowledge base service. */
export class KnowledgeSync {
  private readonly state: KnowledgeSyncState
  /** The account of the current sign-in, and the user-center calls as it. */
  private readonly signIn: SyncSignIn
  private notAllowed = false
  private pullWanted = false
  private readonly lifetime = new AbortController()
  /** One pass at a time; disposal waits for the running one, so nothing is written after it. */
  private readonly passes = new SyncPasses(() => this.work(), this.lifetime.signal)

  /**
   * @param ctx - Host with the Hub sign-in; the sync's timers and pass end with it.
   * @param host - the knowledge base service's reads and changes.
   * @param options - record file, device name, and timings.
   */
  constructor(private readonly ctx: Context, private readonly host: SyncHost, private readonly options: SyncOptions) {
    this.state = new KnowledgeSyncState(options.statePath)
    this.signIn = new SyncSignIn(ctx.hubAccount, this.lifetime.signal, options.requestTimeoutMs)
    ctx.effect(() => {
      const interval = setInterval(() => { this.refresh() }, options.intervalMs)
      return () => {
        clearInterval(interval)
        this.lifetime.abort()
        return this.passes.stop()
      }
    }, 'knowledge-base: sync schedule')
  }

  /** Load the record and follow the sign-in. */
  async start(): Promise<void> {
    await this.state.load((message) => { this.ctx.logger.warn(message) })
    await this.signIn.follow(() => { this.follow() })
  }

  /** A knowledge base changed here: upload shortly after, once quick successive changes settle. */
  touched(): void {
    this.passes.schedule(this.options.debounceMs, true)
  }

  /** Pull the other computers' changes and upload this one's now, as when the Knowledge page opens. */
  refresh(): void {
    this.pullWanted = true
    this.passes.schedule(0, true)
  }

  /**
   * The computer an item was pulled from, for the signed-in account.
   * @param itemId - an item.
   * @returns that computer's name; null for an item made here or not synced.
   */
  cameFrom(itemId: string): string | null {
    // Signed out, no account's record names it.
    return this.state.account(this.signIn.account ?? '').items[itemId]?.from ?? null
  }

  private follow(): void {
    this.notAllowed = false
    this.refresh()
  }

  private async work(): Promise<void> {
    const account = this.signIn.account
    if (account === null || this.notAllowed || this.lifetime.signal.aborted) return
    const pull = this.pullWanted
    this.pullWanted = false
    let failed = false
    try {
      const tenantId = tenantOf(account)
      let snapshot = await this.host.snapshot()
      // The knowledge base service follows the sign-in too; its switch announces a change that runs the pass again.
      if (snapshot.tenantId !== tenantId) {
        this.pullWanted ||= pull
        return
      }
      await this.findDeletes(account, tenantId, snapshot.bases)
      await this.sendDeletes(account)
      // Uploads before the pull, so an edit made here is never overwritten by an older one pulled before it was sent.
      failed = await this.upload(account, tenantId, snapshot.bases)
      if (pull) {
        snapshot = await this.host.snapshot()
        if (snapshot.tenantId !== tenantId) {
          this.pullWanted = true
          return
        }
        const here = new Set(snapshot.bases.flatMap(base => [base.id, ...base.items.map(item => item.row.id)]))
        // A listing that starts over forgets this computer's records: the next pass uploads them again.
        if (await this.pull(account, tenantId, here)) this.touched()
      }
    } catch (error) {
      if (error instanceof NotAllowed) {
        this.notAllowed = true
        this.ctx.logger.warn(`knowledge-base: this sign-in does not sync: ${error.message}`)
        return
      }
      this.pullWanted ||= pull
      if (!(error instanceof RetryLater)) this.ctx.logger.warn(`knowledge-base: sync pass failed: ${String(error)}`)
      failed = true
    }
    if (failed) this.passes.schedule(this.options.retryMs, true)
  }

  /**
   * Queue the deletion of the knowledge bases and items the record holds that are gone here. A
   * knowledge base whose directory remains (its index did not open) is not gone.
   */
  private async findDeletes(account: string, tenantId: string, bases: readonly LocalBase[]): Promise<void> {
    const record = this.state.account(account)
    const here = new Map(bases.map(base => [base.id, new Set(base.items.map(item => item.row.id))]))
    const deletes: PendingDelete[] = []
    for (const baseId of Object.keys(record.bases)) {
      if (here.has(baseId) || await this.host.baseExists(tenantId, baseId)) continue
      deletes.push({ kind: 'base', id: baseId })
    }
    for (const [itemId, entry] of Object.entries(record.items)) {
      const items = here.get(entry.baseId)
      if (items === undefined || items.has(itemId)) continue
      deletes.push({ kind: 'item', id: itemId })
    }
    if (deletes.length > 0) await this.state.queueDeletes(account, deletes)
  }

  private async sendDeletes(account: string): Promise<void> {
    for (const entry of this.state.account(account).deletes) {
      const res = await this.signIn.call(`/api/client/sync/knowledge/${entry.kind === 'base' ? 'bases' : 'items'}/${encodeURIComponent(entry.id)}`, { method: 'DELETE' }, account)
      await res.body?.cancel()
      if (!res.ok) refuseSync(res)
      await this.state.doneDelete(account, entry)
    }
  }

  /**
   * Pull the account's changes since the last pull and apply them once every page has arrived, as
   * an item can be listed before its knowledge base: knowledge bases first, then deleted items,
   * then folders before other items, and deleted knowledge bases last. A listing that starts over
   * (the user center was restored from a backup) also removes what was pulled and is no longer
   * listed, and uploads again what was made here and is no longer listed. The cursor moves past the
   * changes only when all of them applied, so one that could not be applied is listed again.
   * @param here - the knowledge bases and items stored here before the pull; one of them listed
   *   without a record was made here, whatever computer name the listing gives.
   * @returns whether the listing started over.
   */
  private async pull(account: string, tenantId: string, here: ReadonlySet<string>): Promise<boolean> {
    let cursor = this.state.account(account).cursor
    let reset = false
    const changes: (ListedBase | ListedItem)[] = []
    for (let more = true; more;) {
      const res = await this.signIn.call(`/api/client/sync/knowledge?since=${String(cursor)}`, { method: 'GET' }, account)
      if (!res.ok) {
        await res.body?.cancel()
        refuseSync(res)
      }
      const page = listSchema.parse(await res.json())
      if (page.reset) {
        reset = true
        changes.length = 0
      }
      changes.push(...page.changes)
      cursor = page.cursor
      more = page.hasMore
    }
    const bases = changes.filter((change): change is ListedBase => change.type === 'base')
    const items = changes.filter((change): change is ListedItem => change.type === 'item')
    const live = items.filter(entry => !entry.deleted)
    const steps = [
      ...bases.filter(entry => !entry.deleted).map(base => [base.baseId, () => this.applyBase(account, tenantId, base, here)] as const),
      ...items.filter(entry => entry.deleted).map(item => [item.itemId, () => this.removeItem(account, tenantId, item)] as const),
      ...[...live.filter(entry => entry.kind === 'folder'), ...live.filter(entry => entry.kind !== 'folder')]
        .map(item => [item.itemId, () => this.applyItem(account, tenantId, item, here)] as const),
      ...bases.filter(entry => entry.deleted).map(base => [base.baseId, () => this.removeBase(account, tenantId, base.baseId)] as const),
    ]
    let complete = true
    for (const [id, step] of steps) complete = await this.isolated(id, step) && complete
    if (reset) await this.dropUnlisted(account, tenantId, new Set(changes.filter(change => !change.deleted).map(change => (change.type === 'base' ? change.baseId : change.itemId))))
    if (complete) await this.state.setCursor(account, cursor)
    return reset
  }

  /**
   * Apply one pulled change; a failure that is not about reaching the user center skips it, so it
   * holds up nothing else.
   * @returns whether it applied, or needed nothing here.
   */
  private async isolated(id: string, run: () => Promise<boolean>): Promise<boolean> {
    try {
      return await run()
    } catch (error) {
      if (error instanceof RetryLater || error instanceof NotAllowed) throw error
      this.ctx.logger.warn(`knowledge-base: ${id} not pulled: ${String(error)}`)
      return false
    }
  }

  private async applyBase(account: string, tenantId: string, entry: ListedBase, here: ReadonlySet<string>): Promise<boolean> {
    const known = this.state.account(account).bases[entry.baseId]
    // This computer's own uploads come back in the list.
    if (known !== undefined && known.revision >= entry.revision) return true
    const owner = this.state.ownerOf(entry.baseId)
    if (owner !== undefined && owner !== account) return true
    const base: RemoteBase = {
      id: entry.baseId, name: entry.name, embeddingModelId: entry.embeddingModelId, createdAt: entry.createdAt,
      settings: settingsSchema.parse(entry.settings),
    }
    if (!await this.host.applyBase(tenantId, base)) return false
    const from = known?.from ?? (here.has(entry.baseId) ? null : entry.device)
    await this.state.setBase(account, entry.baseId, { revision: entry.revision, digest: baseDigest(base), from })
    return true
  }

  private async applyItem(account: string, tenantId: string, entry: ListedItem, here: ReadonlySet<string>): Promise<boolean> {
    const record = this.state.account(account)
    const known = record.items[entry.itemId]
    if (known !== undefined && known.revision >= entry.revision) return true
    if (record.bases[entry.baseId] === undefined) return false
    let content: Uint8Array | null = null
    if (entry.sha256 !== null) {
      const res = await this.signIn.call(`/api/client/sync/knowledge/items/${encodeURIComponent(entry.itemId)}/content`, { method: 'GET' }, account)
      // Changed or deleted meanwhile: listed again, with what happened.
      if (res.status === 404 || res.status === 410) {
        await res.body?.cancel()
        return true
      }
      if (!res.ok) {
        await res.body?.cancel()
        refuseSync(res)
      }
      content = new Uint8Array(await res.arrayBuffer())
      if (sha256Of(content) !== entry.sha256) throw new Error('the content from the user center does not match its digest')
    }
    const item: RemoteItem = {
      id: entry.itemId, baseId: entry.baseId, kind: entry.kind, parentId: entry.parentId, name: entry.name, source: entry.source,
      size: entry.sizeBytes, addedAt: entry.addedAt,
    }
    if (!await this.host.applyItem(tenantId, item, content)) return false
    await this.state.setItem(account, entry.itemId, {
      baseId: entry.baseId, revision: entry.revision, from: known?.from ?? (here.has(entry.itemId) ? null : entry.device),
      digest: itemDigest(entry.baseId, { ...item, sha256: entry.sha256 }),
    })
    return true
  }

  /** An item deleted elsewhere goes here too, recorded or not (this computer's record may have been lost). */
  private async removeItem(account: string, tenantId: string, entry: ListedItem): Promise<boolean> {
    await this.host.removeItem(tenantId, entry.baseId, entry.itemId)
    await this.state.setItem(account, entry.itemId, undefined)
    return true
  }

  /** A knowledge base deleted elsewhere goes here too, recorded or not. */
  private async removeBase(account: string, tenantId: string, baseId: string): Promise<boolean> {
    const owner = this.state.ownerOf(baseId)
    if (owner !== undefined && owner !== account) return true
    await this.host.removeBase(tenantId, baseId)
    await this.state.forgetBase(account, baseId)
    return true
  }

  /** After a listing that starts over: remove pulled copies it does not name, and forget this computer's, so they upload again. */
  private async dropUnlisted(account: string, tenantId: string, listed: ReadonlySet<string>): Promise<void> {
    const record = this.state.account(account)
    for (const [itemId, entry] of Object.entries(record.items)) {
      if (listed.has(itemId)) continue
      if (entry.from !== null) await this.host.removeItem(tenantId, entry.baseId, itemId)
      await this.state.setItem(account, itemId, undefined)
    }
    for (const [baseId, entry] of Object.entries(record.bases)) {
      if (listed.has(baseId)) continue
      if (entry.from !== null) await this.host.removeBase(tenantId, baseId)
      await this.state.forgetBase(account, baseId)
    }
  }

  /**
   * Upload the knowledge bases, and their items, that changed since their last upload: a knowledge
   * base before its items, a folder before its files. Another account's knowledge bases stay.
   * @returns whether something failed, so the pass is retried.
   */
  private async upload(account: string, tenantId: string, bases: readonly LocalBase[]): Promise<boolean> {
    let failed = false
    for (const base of bases) {
      const owner = this.state.ownerOf(base.id)
      if (owner !== undefined && owner !== account) continue
      try {
        if (!await this.uploadBase(account, tenantId, base)) {
          // Not refused for good, nor deleted elsewhere: an unresolved conflict, tried again later.
          failed ||= this.state.account(account).bases[base.id]?.held === undefined
          continue
        }
        const items = [...base.items.filter(item => item.row.kind === 'folder'), ...base.items.filter(item => item.row.kind !== 'folder')]
        for (const item of items) {
          try {
            failed = !await this.uploadItem(account, tenantId, base.id, item.row, item.copy) || failed
          } catch (error) {
            if (error instanceof RetryLater || error instanceof NotAllowed) throw error
            this.ctx.logger.warn(`knowledge-base: item ${item.row.id} not synced: ${String(error)}`)
            failed = true
          }
        }
      } catch (error) {
        if (error instanceof RetryLater || error instanceof NotAllowed) throw error
        this.ctx.logger.warn(`knowledge-base: ${base.id} not synced: ${String(error)}`)
        failed = true
      }
    }
    return failed
  }

  /** @returns whether the knowledge base is on the user center, so its items can follow. */
  private async uploadBase(account: string, tenantId: string, base: LocalBase): Promise<boolean> {
    const known = this.state.account(account).bases[base.id]
    const digest = baseDigest(base)
    if (known?.digest === digest) return known.held === undefined
    const from = known?.from ?? null
    const body = (revision: number) => JSON.stringify({
      revision, device: this.options.device, name: base.name, embeddingModelId: base.embeddingModelId,
      settings: base.settings, createdAt: base.createdAt,
    })
    return this.put(account, `/api/client/sync/knowledge/bases/${encodeURIComponent(base.id)}`, known, body, async (record) => {
      await this.state.setBase(account, base.id, { ...record, digest, from })
    }, () => this.removeBase(account, tenantId, base.id))
  }

  /** @returns false when the item should be tried again on a later pass. */
  private async uploadItem(account: string, tenantId: string, baseId: string, row: ItemRow, copy: string | null): Promise<boolean> {
    const record = this.state.account(account)
    const known = record.items[row.id]
    // A file of a folder the user center refused for good waits with it.
    if (row.parentId !== null && record.items[row.parentId]?.held !== undefined) return true
    const content = copy === null ? undefined : await this.contentOf(copy, known)
    const fields: ItemFields = {
      kind: row.kind, parentId: row.parentId, name: row.name.slice(0, ITEM_NAME_MAX), source: row.source,
      sha256: content?.sha256 ?? null, size: content?.size ?? row.size, addedAt: row.addedAt,
    }
    const digest = itemDigest(baseId, fields)
    const from = known?.from ?? null
    if (known?.digest === digest) {
      if (content !== undefined && known.copy?.mtimeMs !== content.mtimeMs) {
        await this.state.setItem(account, row.id, { ...known, copy: content })
      }
      return true
    }
    // The copy to upload: an item with content always has one.
    const upload = copy !== null && content !== undefined ? { path: copy, sha256: content.sha256 } : undefined
    if (upload !== undefined && !await this.ensureContent(account, upload.path, upload.sha256)) {
      await this.state.setItem(account, row.id, { baseId, revision: known?.revision ?? 0, digest, from, held: 'refused', copy: content })
      return true
    }
    const body = (revision: number) => JSON.stringify({
      baseId, revision, device: this.options.device, kind: fields.kind, parentId: fields.parentId, name: fields.name, source: fields.source,
      mediaType: mediaTypeOf(fields.kind, fields.name), sha256: fields.sha256, sizeBytes: fields.size, addedAt: fields.addedAt,
    })
    const gone = async (code: string) => {
      if (code === 'base_deleted') await this.removeBase(account, tenantId, baseId)
      else if (code === 'parent_deleted' && row.parentId !== null) await this.host.removeItem(tenantId, baseId, row.parentId)
      else await this.host.removeItem(tenantId, baseId, row.id)
      await this.state.setItem(account, row.id, undefined)
    }
    return this.put(account, `/api/client/sync/knowledge/items/${encodeURIComponent(row.id)}`, known, body, async (accepted) => {
      await this.state.setItem(account, row.id, { ...accepted, baseId, digest, from, copy: content })
    }, gone, async (code) => {
      if (code === 'missing_content' && upload !== undefined) return this.ensureContent(account, upload.path, upload.sha256)
      // The knowledge base or folder is not on the user center yet: the next pass uploads it first.
      if (code === 'base_missing') await this.state.setBase(account, baseId, undefined)
      return false
    })
  }

  /**
   * Upload one knowledge base or item, raising the revision past the user center's on a conflict.
   * @param record - writes the accepted or refused record.
   * @param gone - removes here what the user center says another computer deleted, by its answer's code.
   * @param conflict - handles a conflict other than a stale revision; true retries the upload.
   * @returns whether the upload was accepted; a refusal for good is recorded and also counts as done.
   */
  private async put(
    account: string, path: string, known: SyncedRecord | undefined, body: (revision: number) => string,
    record: (entry: Pick<SyncedRecord, 'revision' | 'held'>) => Promise<void>,
    gone: (code: string) => Promise<unknown>,
    conflict: (code: string) => Promise<boolean> = () => Promise.resolve(false),
  ): Promise<boolean> {
    let revision = (known?.revision ?? 0) + 1
    for (let attempt = 0; attempt < PUT_ATTEMPTS; attempt += 1) {
      const res = await this.signIn.call(path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: body(revision) }, account)
      if (res.ok) {
        await res.body?.cancel()
        await record({ revision })
        return true
      }
      if (res.status === 409) {
        const answer = conflictSchema.parse(await res.json())
        if (answer.code === 'stale_revision' && answer.revision !== undefined) revision = answer.revision + 1
        else if (!await conflict(answer.code)) return false
        continue
      }
      if (res.status === 410) {
        // Deleted on another computer, which this one has not pulled yet: deleted here too.
        await gone(conflictSchema.parse(await res.json()).code)
        return false
      }
      if (res.status === 400 || res.status === 413) {
        this.ctx.logger.warn(`knowledge-base: ${path} refused by the user center (${String(res.status)}): ${await res.text()}`)
        await record({ revision: known?.revision ?? 0, held: 'refused' })
        return true
      }
      await res.body?.cancel()
      refuseSync(res)
    }
    throw new Error(`the user center kept answering conflicts after ${String(PUT_ATTEMPTS)} uploads`)
  }

  /** The copy's size and sha256, read again only when its size or modification time changed; undefined when it is missing. */
  private async contentOf(copy: string, known: SyncedItemRecord | undefined): Promise<SyncedItemRecord['copy']> {
    const info = await stat(copy).catch(() => undefined)
    if (info?.isFile() !== true) return undefined
    if (known?.copy?.size === info.size && known.copy.mtimeMs === info.mtimeMs) return known.copy
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(copy)) hash.update(chunk as Buffer)
    return { size: info.size, mtimeMs: info.mtimeMs, sha256: hash.digest('hex') }
  }

  /**
   * Make sure the user center holds a copy's bytes: ask, and upload them when it lacks them.
   * @returns false when the user center refuses them for good (too large, or invalid).
   */
  private async ensureContent(account: string, copy: string, sha256: string): Promise<boolean> {
    const res = await this.signIn.call('/api/client/sync/blobs/check', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sha256: [sha256] }),
    }, account)
    if (!res.ok) {
      await res.body?.cancel()
      refuseSync(res)
    }
    if (!checkSchema.parse(await res.json()).missing.includes(sha256)) return true
    const bytes = await readFile(copy)
    // Changed since it was read: the next pass reads it again.
    if (sha256Of(bytes) !== sha256) throw new Error('the copy changed while it was uploaded')
    const form = new FormData()
    form.set('file', new Blob([bytes]), sha256)
    const put = await this.signIn.call(`/api/client/sync/blobs/${sha256}`, { method: 'PUT', body: form }, account)
    if (put.status === 400 || put.status === 413) {
      this.ctx.logger.warn(`knowledge-base: content ${sha256} refused by the user center (${String(put.status)}): ${await put.text()}`)
      return false
    }
    await put.body?.cancel()
    if (!put.ok) refuseSync(put)
    return true
  }

}
