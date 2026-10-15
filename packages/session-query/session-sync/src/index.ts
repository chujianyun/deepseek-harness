/**
 * Session sync for Desktop: uploads every top-level Session's conversation, with its subagent
 * Sessions and attachments, to the user center of the current Hub sign-in, so the employee's other
 * machines can read it. A Session uploads after each turn ends and whenever a scan finds it changed;
 * the first scan after sign-in uploads the Sessions already on this machine. Deleting a Session
 * deletes it on the user center. Failed requests are retried later.
 *
 * @module @deepseek-ai/dsh-session-sync
 */

import { hostname } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-attachment'
import type { HubAccountView } from '@deepseek-ai/dsh-hub-account'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-query'
import { foldSessionTitle } from '@deepseek-ai/dsh-session-title'
import Schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { boundAssistant, bundleAttachments, bundleGroups, encodeBundle, lastChange, rootOf, type BundleAttachment } from './bundle.ts'
import { SyncState, type SyncedEntry } from './state.ts'
import type { SessionSyncBundle, SessionSyncLog } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Session sync over the Hub sign-in. */
    sessionSync: SessionSync
  }
}

/** The user center's limits on one upload (new-dsh-ms `SYNC_*`); it refuses a larger conversation itself. */
const BLOB_MAX_BYTES = 100 * 1024 * 1024
const ATTACHMENTS_MAX = 1000
const TITLE_MAX = 200
const CWD_MAX = 1000
const DEVICE_MAX = 100
/** Uploads of one Session within one pass, before leaving it to the next pass. */
const PUT_ATTEMPTS = 3

/** Deployment configuration. */
export interface Config {
  /** Deadline of each user-center request, in milliseconds. */
  requestTimeoutMs?: number
  /** DeepSeek Harness home; the sync record lives at `<dshHome>/session-sync.json`. Defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string
  /** Name of this machine as other machines show it. Defaults to the host name without `.local`. */
  deviceName?: string
  /** Wait after a turn ends before uploading, so turns in quick succession upload once, in milliseconds. */
  debounceMs?: number
  /** Interval of the scan that uploads Sessions changed without a turn ending, in milliseconds. */
  scanIntervalMs?: number
  /** Wait before retrying after the user center could not be reached, in milliseconds. */
  retryMs?: number
}

/** Validated deployment configuration. */
export const Config: Schema<Config> = Schema.object({
  requestTimeoutMs: Schema.number().min(1).max(3_600_000).default(300_000).description('Deadline of each user-center request, in milliseconds.'),
  dshHome: Schema.string().description('DeepSeek Harness home; the sync record lives at `<dshHome>/session-sync.json`. Defaults to `$DSH_HOME` or `~/.dsh`.'),
  deviceName: Schema.string().description('Name of this machine as other machines show it. Defaults to the host name without `.local`.'),
  debounceMs: Schema.number().min(0).max(600_000).default(2_000).description('Wait after a turn ends before uploading, so turns in quick succession upload once, in milliseconds.'),
  scanIntervalMs: Schema.number().min(100).max(86_400_000).default(300_000).description('Interval of the scan that uploads Sessions changed without a turn ending, in milliseconds.'),
  retryMs: Schema.number().min(100).max(86_400_000).default(60_000).description('Wait before retrying after the user center could not be reached, in milliseconds.'),
})

/** The user center could not take the request now, or the sign-in changed; the pass stops and is retried later. */
class RetryLater extends Error {}

/** The sign-in may not sync (not a company member); syncing stops until the sign-in changes. */
class NotAllowed extends Error {}

const conflictSchema = z.discriminatedUnion('code', [
  z.object({ code: z.literal('stale_revision'), revision: z.number().int().nonnegative() }),
  z.object({ code: z.literal('missing_attachments') }),
])

const checkSchema = z.object({ missing: z.array(z.string()) })

/**
 * The account a sign-in syncs as: its tenant and phone number, which name one employee. Null while
 * signed out or signed in without a tenant.
 */
function accountOf(state: HubAccountView): string | null {
  const profile = state.profile
  return state.status === 'signed-in' && profile?.tenantId != null ? `${profile.tenantId}/${profile.phone}` : null
}

/** Host owner of Session sync. */
export class SessionSync extends Service {
  static inject = ['hubAccount', 'sessionQuery', 'sessionPersistence']
  static Config = Config

  private readonly config: Required<Omit<Config, 'dshHome' | 'deviceName'>>
  private readonly device: string
  private readonly state: SyncState
  /** Account of the current sign-in, or null while there is none to sync as. */
  private account: string | null = null
  /** The current sign-in was refused as a non-member; reset when the sign-in changes. */
  private notAllowed = false
  /** Sessions whose turn ended since the last pass. */
  private readonly dirty = new Set<SessionId>()
  /** The next pass looks at every top-level Session. */
  private scanWanted = false
  /** Storage tokens of Sessions left out unread or empty, so scans skip them until they change. */
  private readonly skipped = new Map<SessionId, string>()
  /** Session being synced, so a deletion meanwhile is sent after it. */
  private syncing: SessionId | undefined
  private running = false
  /** Passes asked for; a pass that ends with more asked for than it saw runs again. */
  private requests = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly lifetime = new AbortController()

  /** @param ctx - Host with the Hub sign-in and Session storage. @param config - timings, home, and device name. */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'sessionSync')
    const resolved = Config(config) as Required<Omit<Config, 'dshHome' | 'deviceName'>> & Pick<Config, 'dshHome' | 'deviceName'>
    this.config = resolved
    this.device = (resolved.deviceName ?? hostname().replace(/\.local$/u, '')).trim().slice(0, DEVICE_MAX)
    if (this.device === '') throw new Error('session-sync: the device name is empty; set deviceName')
    this.state = new SyncState(join(resolveDshHome(resolved.dshHome), 'session-sync.json'))
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'turn/end') return
      this.dirty.add(session.id)
      this.schedule(this.config.debounceMs)
    })
    ctx.on('session/deleted', (sessionId) => {
      void this.deleted(sessionId).catch((error: unknown) => {
        this.ctx.logger.warn(`session-sync: deletion of ${sessionId} not recorded: ${String(error)}`)
      })
    })
    ctx.effect(() => {
      const scan = setInterval(() => {
        this.scanWanted = true
        this.schedule(0)
      }, this.config.scanIntervalMs)
      return () => {
        clearInterval(scan)
        clearTimeout(this.timer)
        this.lifetime.abort()
      }
    }, 'session-sync: schedule')
  }

  async [Service.init](): Promise<void> {
    await this.state.load((message) => { this.ctx.logger.warn(message) })
    const hub = this.ctx.hubAccount
    this.follow(accountOf(await hub.getState()))
    void (async () => {
      for await (const state of hub.watch(this.lifetime.signal)) {
        if (accountOf(state) !== this.account) this.follow(accountOf(state))
      }
    })()
  }

  /** Sync as another account (or none), starting with a scan. */
  private follow(account: string | null): void {
    this.account = account
    this.notAllowed = false
    this.skipped.clear()
    this.scanWanted = true
    this.schedule(0)
  }

  /** Run a pass after `delay`, replacing a pass already waiting. */
  private schedule(delay: number): void {
    if (this.lifetime.signal.aborted) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.pass()
    }, delay)
  }

  /** One pass at a time; a pass asked for meanwhile runs right after. */
  private async pass(): Promise<void> {
    this.requests += 1
    if (this.running) return
    this.running = true
    try {
      let seen: number
      do {
        seen = this.requests
        await this.work()
      } while (seen !== this.requests)
    } finally {
      this.running = false
    }
  }

  /** Send pending deletions, then upload the Sessions that turned or, on a scan, every changed one. */
  private async work(): Promise<void> {
    const account = this.account
    if (account === null || this.notAllowed || this.lifetime.signal.aborted) return
    const dirty = [...this.dirty]
    this.dirty.clear()
    const scan = this.scanWanted
    this.scanWanted = false
    let failed = false
    try {
      await this.sendDeletes(account)
      const snapshots = await this.ctx.sessionPersistence.list()
      const headers = new Map(snapshots.map(snapshot => [snapshot.header.id, snapshot.header]))
      const forced = new Set<SessionId>()
      for (const id of dirty) {
        const root = rootOf(id, headers)
        if (root === undefined) this.scanWanted = true
        else forced.add(root)
      }
      const groups = bundleGroups(snapshots).filter(([head]) => scan || forced.has(head.header.id))
      for (const members of groups) {
        const root = members[0].header.id
        try {
          await this.syncSession(root, account, members, forced.has(root))
        } catch (error) {
          if (error instanceof RetryLater || error instanceof NotAllowed) throw error
          // One Session's failure leaves the others to sync; it is tried again later.
          this.ctx.logger.warn(`session-sync: ${root} not synced: ${String(error)}`)
          failed = true
        }
      }
      // A turn that ended before its Session reached storage is picked up by a scan shortly after.
      if (this.scanWanted) this.schedule(this.config.debounceMs)
    } catch (error) {
      if (error instanceof NotAllowed) {
        this.notAllowed = true
        this.ctx.logger.warn(`session-sync: this sign-in does not sync: ${error.message}`)
        return
      }
      for (const id of dirty) this.dirty.add(id)
      this.scanWanted ||= scan
      if (!(error instanceof RetryLater)) this.ctx.logger.warn(`session-sync: pass failed: ${String(error)}`)
      failed = true
    }
    if (failed) {
      this.scanWanted = true
      this.schedule(this.config.retryMs)
    }
  }

  /** Delete on the user center the Sessions deleted here under this account. */
  private async sendDeletes(account: string): Promise<void> {
    for (const [sessionId, owner] of this.state.deletes()) {
      if (owner !== account) continue
      const res = await this.call(`/api/client/sync/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }, account)
      await res.body?.cancel()
      if (res.ok || res.status === 404) await this.state.setDelete(sessionId, undefined)
      else this.refuse(res)
    }
  }

  /**
   * Upload one top-level Session when its content changed since its last upload. Unless `forced`,
   * an unchanged storage token skips reading it.
   */
  private async syncSession(
    root: SessionId, account: string, members: readonly SessionPersistenceSnapshot[], forced: boolean,
  ): Promise<void> {
    const entry = this.state.entry(root)
    if ((entry !== undefined && entry.account !== account) || entry?.held === 'deleted') return
    const token = changeToken(members)
    if (!forced && (entry?.token ?? this.skipped.get(root)) === token) return
    this.syncing = root
    try {
      const bundle = await this.read(root, members.map(member => member.header.id))
      if (bundle === undefined) {
        this.skipped.set(root, token)
        return
      }
      const { bytes, digest } = await encodeBundle(bundle)
      if (entry?.digest === digest) {
        await this.state.recordEntry(root, { ...entry, token })
        return
      }
      const base: SyncedEntry = { account, revision: entry?.revision ?? 0, digest, token }
      await this.upload(root, account, base, bundle, bytes)
    } finally {
      this.syncing = undefined
    }
  }

  /** Upload a changed bundle, with its attachments, and record the user center's answer. */
  private async upload(root: SessionId, account: string, base: SyncedEntry, bundle: SessionSyncBundle, bytes: Uint8Array): Promise<void> {
    const found = bundleAttachments(bundle)
    let attachments = await this.uploadAttachments(found, account)
    const head = bundle.sessions[0]
    const title = foldSessionTitle(head.events)?.title.slice(0, TITLE_MAX) ?? null
    const cwd = head.header.cwd !== undefined && head.header.cwd.length <= CWD_MAX ? head.header.cwd : null
    let revision = base.revision + 1
    for (let attempt = 0; attempt < PUT_ATTEMPTS; attempt += 1) {
      const meta = {
        revision, cwd, device: this.device, title, assistantId: boundAssistant(head.events),
        attachments: attachments.map(attachment => attachment.sha256), updatedAt: new Date(lastChange(bundle)).toISOString(),
      }
      const form = new FormData()
      form.set('meta', JSON.stringify(meta))
      form.set('file', new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/gzip' }), 'bundle.json.gz')
      const res = await this.call(`/api/client/sync/sessions/${encodeURIComponent(root)}`, { method: 'PUT', body: form }, account)
      if (res.ok) {
        await res.body?.cancel()
        await this.state.recordEntry(root, { ...base, revision })
        return
      }
      if (res.status === 409) {
        const conflict = conflictSchema.parse(await res.json())
        // An attachment expired on the user center between its check and this upload: check again.
        if (conflict.code === 'missing_attachments') attachments = await this.uploadAttachments(found, account)
        else revision = conflict.revision + 1
        continue
      }
      if (res.status === 410) {
        await res.body?.cancel()
        await this.state.recordEntry(root, { ...base, held: 'deleted' })
        return
      }
      if (res.status === 400 || res.status === 413) {
        this.ctx.logger.warn(`session-sync: ${root} refused by the user center (${String(res.status)}): ${await res.text()}`)
        await this.state.recordEntry(root, { ...base, held: 'refused' })
        return
      }
      await res.body?.cancel()
      this.refuse(res)
    }
    throw new Error(`the user center kept answering conflicts after ${String(PUT_ATTEMPTS)} uploads`)
  }

  /**
   * The bundle of the given Sessions; undefined when the top-level Session has no user message, or
   * when one of them cannot be read, which leaves the whole conversation out until it changes.
   */
  private async read(root: SessionId, members: readonly SessionId[]): Promise<SessionSyncBundle | undefined> {
    const sessions: SessionSyncLog[] = []
    for (const id of members) {
      try {
        const { session, inheritedEventCount, events } = await this.ctx.sessionQuery.readSession(id)
        sessions.push({ header: session, inheritedEventCount, events })
      } catch (error) {
        this.ctx.logger.warn(`session-sync: ${root} not uploaded: ${id} cannot be read: ${String(error)}`)
        return undefined
      }
    }
    const [head, ...below] = sessions
    if (head?.events.some(event => event.type === 'user/message') !== true) return undefined
    return { format: 1, sessions: [head, ...below] }
  }

  /**
   * Make sure the user center holds the attachments: ask which it lacks and upload those.
   * @returns the attachments it holds, which the upload lists; unreadable, refused, and oversized ones are left out.
   */
  private async uploadAttachments(found: readonly BundleAttachment[], account: string): Promise<BundleAttachment[]> {
    const store = this.ctx.get('attachments')
    const candidates = found.filter(attachment => attachment.ref.bytes <= BLOB_MAX_BYTES).slice(0, ATTACHMENTS_MAX)
    if (store === undefined || candidates.length === 0) return []
    const res = await this.call('/api/client/sync/blobs/check', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sha256: candidates.map(attachment => attachment.sha256) }),
    }, account)
    if (!res.ok) {
      await res.body?.cancel()
      this.refuse(res)
    }
    const missing = new Set(checkSchema.parse(await res.json()).missing)
    const failed = new Set<string>()
    for (const attachment of candidates) {
      if (!missing.has(attachment.sha256)) continue
      let bytes: Uint8Array
      try {
        // The store verifies the bytes against the digest the attachment id names.
        bytes = attachment.kind === 'image'
          ? (await store.readImage(attachment.ref, this.lifetime.signal)).data
          : await readAll(store.readFileStream(attachment.ref, this.lifetime.signal))
      } catch (error) {
        this.ctx.logger.warn(`session-sync: attachment ${attachment.sha256} not read: ${String(error)}`)
        failed.add(attachment.sha256)
        continue
      }
      const form = new FormData()
      form.set('file', new Blob([bytes as Uint8Array<ArrayBuffer>]), attachment.sha256)
      const put = await this.call(`/api/client/sync/blobs/${attachment.sha256}`, { method: 'PUT', body: form }, account)
      await put.body?.cancel()
      if (put.status === 400 || put.status === 413) {
        this.ctx.logger.warn(`session-sync: attachment ${attachment.sha256} refused by the user center (${String(put.status)})`)
        failed.add(attachment.sha256)
      } else if (!put.ok) this.refuse(put)
    }
    return candidates.filter(attachment => !failed.has(attachment.sha256))
  }

  /** Record a deleted Session's deletion for the user center; a subagent Session's deletion rescans its parent instead. */
  private async deleted(sessionId: SessionId): Promise<void> {
    const entry = this.state.entry(sessionId)
    const account = entry?.account ?? (this.syncing === sessionId ? this.account : null)
    if (account === null) {
      this.scanWanted = true
      this.schedule(this.config.debounceMs)
      return
    }
    // The deletion first: a sync finishing meanwhile then records no entry.
    await this.state.setDelete(sessionId, account)
    await this.state.setEntry(sessionId, undefined)
    this.schedule(0)
  }

  /** Throw for a refused request: a non-member sign-in stops syncing, anything else is retried later. */
  private refuse(res: Response): never {
    if (res.status === 403) throw new NotAllowed(`the user center answered ${String(res.status)}`)
    throw new RetryLater(`the user center answered ${String(res.status)}`)
  }

  /**
   * One user-center call as `account`; a changed sign-in, signed out, unreachable, or past the
   * deadline reads as retry later.
   */
  private async call(path: string, init: RequestInit, account: string): Promise<Response> {
    if (this.account !== account) throw new RetryLater('the sign-in changed')
    try {
      return await this.ctx.hubAccount.request(path, {
        ...init, signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.config.requestTimeoutMs)]),
      })
    } catch (error: unknown) {
      throw new RetryLater(`the user center cannot be reached: ${String(error)}`, { cause: error })
    }
  }
}

/**
 * Storage change token of a bundle's Sessions: their ids with the byte sizes of their append-only
 * logs, or the backend's revision where it reports no size.
 */
function changeToken(members: readonly SessionPersistenceSnapshot[]): string {
  return members.map(member => `${member.header.id}:${String(member.sizeBytes ?? member.revision)}`).join('|')
}

async function readAll(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  for await (const chunk of chunks) parts.push(chunk)
  return Buffer.concat(parts)
}

export default SessionSync
