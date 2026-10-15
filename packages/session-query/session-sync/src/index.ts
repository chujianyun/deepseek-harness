/**
 * Session sync for Desktop: uploads every top-level Session's conversation, with its subagent
 * Sessions and attachments, to the user center of the current Hub sign-in, and pulls the
 * conversations the employee's other machines uploaded, which this machine keeps view-only. A
 * Session uploads after each turn ends and whenever a scan finds it changed; the first scan after
 * sign-in uploads the Sessions already on this machine. Deleting a Session here deletes it on the
 * user center, and one deleted elsewhere is deleted here. Failed requests are retried later.
 *
 * @module @deepseek-ai/dsh-session-sync
 */

import { stat } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-attachment'
import { changeStream } from '@deepseek-ai/dsh-change-stream'
import type { HubAccountView } from '@deepseek-ai/dsh-hub-account'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionLogOffset, type SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import { foldSessionTitle } from '@deepseek-ai/dsh-session-title'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import Schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import {
  boundAssistant, bundleAttachments, bundleGroups, encodeBundle, lastChange, mapAssistants, rootOf, selectedAssistants,
  type BundleAttachment,
} from './bundle.ts'
import { decodeBundle, hasAttachment, isLocalAbsolutePath, removeLogs, storeAttachment, writeLogs } from './pull.ts'
import { SyncState, type PulledEntry, type SyncedEntry } from './state.ts'
import type {
  SessionSyncAssistant, SessionSyncBundle, SessionSyncContinueInfo, SessionSyncContinueRequest, SessionSyncLog, SessionSyncView,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Session sync over the Hub sign-in, and its Remote namespace. */
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

const listSchema = z.object({
  items: z.array(z.object({
    sessionId: z.string(),
    revision: z.number().int().nonnegative(),
    device: z.string(),
    attachments: z.array(z.string()),
    deleted: z.boolean(),
  })),
  cursor: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  reset: z.boolean(),
})

type ListedSession = z.infer<typeof listSchema>['items'][number]

/**
 * The account a sign-in syncs as: its tenant and phone number, which name one employee. Null while
 * signed out or signed in without a tenant.
 */
function accountOf(state: HubAccountView): string | null {
  const profile = state.profile
  return state.status === 'signed-in' && profile?.tenantId != null ? `${profile.tenantId}/${profile.phone}` : null
}

/** Host owner of Session sync. */
export class SessionSync extends TypertRemoteService {
  static inject = ['hubAccount', 'sessionQuery', 'sessionPersistence', 'sessionController']
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
  /** The next pass pulls the other machines' changes. */
  private pullWanted = false
  /** Sessions this service deletes itself, whose `session/deleted` it ignores. */
  private readonly removing = new Set<SessionId>()
  /** Session being synced, so a deletion meanwhile is sent after it. */
  private syncing: SessionId | undefined
  private readonly listeners = new Set<() => void>()
  /** Changes to the Sessions stored here that the sync made; the client reloads its list when it grows. */
  private changes = 0
  /** The running pass; disposal waits for it, so nothing is written after it. */
  private running: Promise<void> | undefined
  /** Passes asked for; a pass that ends with more asked for than it saw runs again. */
  private requests = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly lifetime = new AbortController()

  /** @param ctx - Host with the Hub sign-in and Session storage. @param config - timings, home, and device name. */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'sessionSync', { namespace: 'sessionSync' })
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
    // A conversation from another machine is view-only here: it is never continued or written to.
    ctx.on('api-session/prompt-admission', sessionId => (this.state.pulledOwner(sessionId) === undefined
      ? undefined
      : new RemoteError('session-sync/view-only', 'a conversation from another computer is view-only', { sessionId })))
    ctx.on('api-session/view-only', sessionId => (this.state.pulledOwner(sessionId) === undefined ? undefined : true))
    ctx.on('session/deleted', (sessionId) => {
      void this.deleted(sessionId).catch((error: unknown) => {
        this.ctx.logger.warn(`session-sync: deletion of ${sessionId} not recorded: ${String(error)}`)
      })
    })
    ctx.effect(() => {
      const scan = setInterval(() => {
        this.scanWanted = true
        this.pullWanted = true
        this.schedule(0)
      }, this.config.scanIntervalMs)
      return () => {
        clearInterval(scan)
        clearTimeout(this.timer)
        this.lifetime.abort()
        this.changed()
        return this.running
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

  /**
   * The conversations pulled from the signed-in employee's other machines.
   * @returns whether syncing is possible, and each pulled conversation with its machine.
   */
  @Remote
  getState(): Promise<SessionSyncView> {
    return Promise.resolve({
      signedIn: this.account !== null,
      changes: this.changes,
      pulled: this.state.pulledSessions()
        .map(([sessionId, entry]) => ({ sessionId: sessionId as SessionId, device: entry.device, revision: entry.revision })),
      continuations: this.state.continuations()
        .filter(([, entry]) => entry.account === this.account)
        .map(([sessionId, entry]) => ({
          sessionId: sessionId as SessionId, sourceId: entry.sourceId as SessionId, title: entry.title, device: entry.device,
        })),
    })
  }

  /**
   * Read where a pulled conversation worked, to offer that directory for continuing it here.
   * @param request - the pulled conversation.
   * @returns its working directory on the other computer and whether it exists here.
   * @throws RemoteError `session-sync/not-pulled` for any other Session.
   */
  @Remote
  async continueInfo(request: { readonly sessionId: SessionId }): Promise<SessionSyncContinueInfo> {
    this.requirePulled(request.sessionId)
    const folder = (await this.ctx.sessionPersistence.stat(request.sessionId))?.header.cwd ?? null
    // A folder recorded on another operating system can name an unrelated directory here: it counts only in this system's form.
    return { folder, folderHere: folder !== null && isLocalAbsolutePath(folder, process.platform) && await isDirectory(folder) }
  }

  /**
   * Continue a pulled conversation here: a new conversation of this computer, in the given
   * directory, that starts with the whole pulled conversation. The pulled one stays as it is.
   * @param request - the pulled conversation and the directory.
   * @returns the new conversation's top-level Session.
   * @throws RemoteError `session-sync/not-pulled` for any other Session, and the fork's own errors,
   *   such as `session/fork-folder-unavailable` for a directory that does not exist here.
   */
  @Remote
  async continueConversation(request: SessionSyncContinueRequest): Promise<{ readonly sessionId: SessionId }> {
    const pulled = this.requirePulled(request.sessionId)
    const title = (await this.ctx.sessionQuery.readTitle(request.sessionId))?.title ?? null
    const forked = await this.ctx.sessionController.fork({ sessionId: request.sessionId, cwd: request.cwd })
    // The new conversation exists from here on: failing to record what it continues costs only its label.
    try {
      const continuation = { account: pulled.account, sourceId: request.sessionId, title, device: pulled.device }
      await this.state.setContinuation(forked.sessionId, continuation)
      this.changed()
    } catch (error) {
      this.ctx.logger.warn(`session-sync: continuation ${forked.sessionId} not recorded: ${String(error)}`)
    }
    return { sessionId: forked.sessionId }
  }

  private requirePulled(sessionId: SessionId): PulledEntry {
    const pulled = this.state.pulled(sessionId)
    if (pulled === undefined) throw new RemoteError('session-sync/not-pulled', 'only a conversation from another computer is continued this way', { sessionId })
    return pulled
  }

  /**
   * Stream the pulled conversations.
   * @param signal - stream lifetime.
   * @returns the current state, then every change.
   */
  @Remote({ mode: 'stream' })
  watch(signal: AbortSignal): AsyncIterable<SessionSyncView> {
    return changeStream(this.listeners, () => this.getState(), signal, this.lifetime.signal)
  }

  /** Pull the other machines' changes and look for changes here now, as when the window comes back to the front. */
  @Remote
  refresh(): Promise<void> {
    this.pullWanted = true
    this.scanWanted = true
    this.schedule(0)
    return Promise.resolve()
  }

  private changed(): void {
    this.changes += 1
    for (const listener of this.listeners) listener()
  }

  /** Sync as another account (or none), starting with a scan and a pull. */
  private follow(account: string | null): void {
    this.account = account
    this.notAllowed = false
    this.skipped.clear()
    this.scanWanted = true
    this.pullWanted = true
    this.changed()
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
    if (this.running !== undefined) return
    const run = async () => {
      let seen: number
      do {
        seen = this.requests
        await this.work()
      } while (seen !== this.requests)
    }
    this.running = run().finally(() => { this.running = undefined })
    await this.running
  }

  /** Send pending deletions, then upload the Sessions that turned or, on a scan, every changed one. */
  private async work(): Promise<void> {
    const account = this.account
    if (this.notAllowed || this.lifetime.signal.aborted) return
    const dirty = [...this.dirty]
    this.dirty.clear()
    const scan = this.scanWanted
    this.scanWanted = false
    const pull = this.pullWanted
    this.pullWanted = false
    let failed = false
    try {
      if (account === null) {
        // Signed out: the copies pulled for any account go; signing in pulls them again.
        await this.dropOtherAccounts(null)
        return
      }
      await this.sendDeletes(account)
      await this.dropOtherAccounts(account)
      if (pull) await this.pullChanges(account)
      await this.removeDeletedHere(account)
      const snapshots = await this.ctx.sessionPersistence.list()
      const headers = new Map(snapshots.map(snapshot => [snapshot.header.id, snapshot.header]))
      // A continuation deleted while the sync was not running leaves its record behind; a scan forgets it.
      if (scan) await this.forgetGoneContinuations(headers)
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
      this.pullWanted ||= pull
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
    if (this.state.pulled(root) !== undefined) return
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
    const bundle: SessionSyncBundle = { format: 1, sessions: [head, ...below] }
    const selected = new Set(selectedAssistants(bundle))
    const assistants = (await this.localAssistants()).filter(assistant => selected.has(assistant.id))
    return assistants.length === 0 ? bundle : { ...bundle, assistants }
  }

  /** The signed-in tenant's assistants on this computer; none where assistants are not composed. */
  private async localAssistants(): Promise<SessionSyncAssistant[]> {
    const service = this.ctx.get('assistants')
    if (service === undefined) return []
    return (await service.getState()).assistants.map(item => ({ id: item.id, name: item.name, templateId: item.templateId ?? null }))
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
    if (this.removing.delete(sessionId)) return
    if (this.state.continuation(sessionId) !== undefined) {
      await this.state.setContinuation(sessionId, undefined)
      this.changed()
    }
    const pulled = this.state.pulled(sessionId)
    if (pulled !== undefined) {
      // Deleting another machine's conversation here deletes it there too.
      await this.state.setDelete(sessionId, pulled.account)
      await this.state.setPulled(sessionId, undefined)
      this.changed()
      this.schedule(0)
      return
    }
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

  /**
   * Pull the account's changes since the last pull: conversations other machines uploaded or
   * changed are written here, and deletions are applied here. Then the conversations whose newer
   * revision waited because they were open are tried again. A listing that starts over (the user
   * center was restored from a backup) also removes the copies it no longer names.
   */
  private async pullChanges(account: string): Promise<void> {
    let changed = false
    const tried = new Set<string>()
    try {
      let more = true
      let listed: Set<string> | undefined
      while (more) {
        const res = await this.call(`/api/client/sync/sessions?since=${String(this.state.cursor(account))}`, { method: 'GET' }, account)
        if (!res.ok) {
          await res.body?.cancel()
          this.refuse(res)
        }
        const page = listSchema.parse(await res.json())
        if (page.reset) listed = new Set()
        for (const item of page.items) {
          listed?.add(item.sessionId)
          tried.add(item.sessionId)
          changed = await this.isolated(item.sessionId, () => this.applyChange(account, item)) || changed
        }
        await this.state.setCursor(account, page.cursor)
        more = page.hasMore
      }
      for (const [sessionId, entry] of this.state.pulledSessions()) {
        if (entry.account !== account) continue
        if (entry.gone === true || (listed !== undefined && !listed.has(sessionId))) {
          changed = await this.removePulled(sessionId as SessionId, entry) || changed
        } else if (entry.behind !== undefined && !tried.has(sessionId)) {
          const behind = entry.behind
          changed = await this.isolated(sessionId, () => this.fetch(account, sessionId as SessionId, entry.device, behind)) || changed
        }
      }
    } finally {
      if (changed) this.changed()
    }
  }

  /**
   * Apply one conversation's change. A failure that is not about reaching the user center (a bundle
   * this build cannot read or store) is logged and skips the conversation, so it holds up nothing else.
   */
  private async isolated(sessionId: string, run: () => Promise<boolean>): Promise<boolean> {
    try {
      return await run()
    } catch (error) {
      if (error instanceof RetryLater || error instanceof NotAllowed) throw error
      this.ctx.logger.warn(`session-sync: ${sessionId} not pulled: ${String(error)}`)
      const entry = this.state.pulled(sessionId)
      // A revision that cannot be stored is not fetched again until a newer one is listed.
      if (entry?.behind !== undefined) await this.state.setPulled(sessionId, { ...entry, behind: undefined })
      return false
    }
  }

  /** Apply one listed change; returns whether a pulled conversation was written or removed. */
  private async applyChange(account: string, item: ListedSession): Promise<boolean> {
    const sessionId = item.sessionId as SessionId
    const pulled = this.state.pulled(sessionId)
    if (item.deleted) {
      if (pulled !== undefined) return this.removePulled(sessionId, pulled)
      const entry = this.state.entry(sessionId)
      if (entry !== undefined && entry.account === account) await this.state.setEntry(sessionId, { ...entry, held: 'deleted' })
      return false
    }
    // This machine's own conversation comes back in the list; it is never pulled.
    if (this.state.entry(sessionId) !== undefined) return false
    if (pulled === undefined && await this.ctx.sessionPersistence.stat(sessionId) !== undefined) return false
    if (pulled !== undefined && pulled.revision >= item.revision) return false
    return this.fetch(account, sessionId, item.device, item.revision)
  }

  /**
   * Remove a pulled copy deleted on the user center. An open copy stays, view-only, and is marked
   * so a later pass removes it.
   */
  private async removePulled(sessionId: SessionId, entry: PulledEntry): Promise<boolean> {
    if (await this.remove(entry.members as SessionId[]) === 'busy') {
      if (entry.gone !== true) await this.state.setPulled(sessionId, { ...entry, gone: true })
      return false
    }
    await this.state.setPulled(sessionId, undefined)
    return true
  }

  /**
   * Download one conversation with its attachments and write it here. A copy open here waits:
   * its entry records the revision to fetch on a later pass. A conversation the user deletes here
   * meanwhile is left deleted.
   */
  private async fetch(account: string, sessionId: SessionId, device: string, revision: number): Promise<boolean> {
    const res = await this.call(`/api/client/sync/sessions/${encodeURIComponent(sessionId)}/bundle`, { method: 'GET' }, account)
    // Replaced or deleted meanwhile: the next listing names what happened.
    if (res.status === 404) {
      await res.body?.cancel()
      return false
    }
    if (!res.ok) {
      await res.body?.cancel()
      this.refuse(res)
    }
    const bundle = mapAssistants(await decodeBundle(new Uint8Array(await res.arrayBuffer())), await this.localAssistants())
    await this.downloadAttachments(account, bundle)
    const members = bundle.sessions.map(log => log.header.id)
    const entry: PulledEntry = { account, device, revision, members }
    // Recorded first, so the logs are view-only from the moment they are stored.
    const previous = this.state.pulled(sessionId)
    if (!await this.state.recordPulled(sessionId, { ...previous ?? entry, behind: revision })) return false
    const written = await writeLogs(this.ctx.sessionPersistence, bundle.sessions, async (id) => { await this.remove([id]) })
    if (written === 'busy') return false
    if (!await this.state.recordPulled(sessionId, entry)) {
      // Deleted here while it was being written: what was written goes too.
      await this.remove(members)
      return false
    }
    // The sidebar reads a cold Session's title and assistant from the projection cache, which only
    // Sessions that ran here have; fold the pulled log into it once.
    const cache = this.ctx.get('sessionProjectionCache')
    for (const log of bundle.sessions) {
      try {
        cache?.coldSnapshot(log.header, SessionLogOffset(log.inheritedEventCount), log.events)
      } catch (error) {
        this.ctx.logger.warn(`session-sync: projections of ${log.header.id} not cached: ${String(error)}`)
      }
    }
    return true
  }

  /** Download the attachments a pulled bundle references that this machine does not hold. */
  private async downloadAttachments(account: string, bundle: SessionSyncBundle): Promise<void> {
    const store = this.ctx.get('attachments')
    if (store === undefined) return
    for (const attachment of bundleAttachments(bundle)) {
      if (await hasAttachment(store, attachment)) continue
      const res = await this.call(`/api/client/sync/blobs/${attachment.sha256}`, { method: 'GET' }, account)
      // Not uploaded by the other machine: the conversation shows it as missing.
      if (res.status === 404) {
        await res.body?.cancel()
        continue
      }
      if (!res.ok) {
        await res.body?.cancel()
        this.refuse(res)
      }
      if (!await storeAttachment(store, attachment, new Uint8Array(await res.arrayBuffer()))) {
        this.ctx.logger.warn(`session-sync: attachment ${attachment.sha256} from the user center does not match its digest`)
      }
    }
  }

  /** Remove the copies pulled for other accounts, or all of them while signed out; signing in as it again pulls them again. */
  private async dropOtherAccounts(account: string | null): Promise<void> {
    let changed = false
    for (const [sessionId, entry] of this.state.pulledSessions()) {
      if (entry.account === account || await this.remove(entry.members as SessionId[]) === 'busy') continue
      await this.state.setPulled(sessionId, undefined)
      await this.state.setCursor(entry.account, undefined)
      changed = true
    }
    if (changed) this.changed()
  }

  /** Delete here this machine's own conversations that were deleted on another machine; an open one waits for a later pass. */
  private async removeDeletedHere(account: string): Promise<void> {
    let changed = false
    for (const [sessionId, entry] of this.state.entries()) {
      if (entry.account !== account || entry.held !== 'deleted' || await this.ctx.sessionPersistence.stat(sessionId as SessionId) === undefined) continue
      const snapshots = await this.ctx.sessionPersistence.list()
      const group = bundleGroups(snapshots).filter(([head]) => head.header.id === sessionId).flat()
      if (await this.remove(group.map(member => member.header.id)) === 'removed') {
        await this.state.setEntry(sessionId, undefined)
        changed = true
      }
    }
    if (changed) this.changed()
  }

  /** Forget the continuation records whose conversation is no longer stored here. */
  private async forgetGoneContinuations(headers: ReadonlyMap<SessionId, SessionHeader>): Promise<void> {
    const gone = this.state.continuations().filter(([sessionId]) => !headers.has(sessionId as SessionId))
    for (const [sessionId] of gone) await this.state.setContinuation(sessionId, undefined)
    if (gone.length > 0) this.changed()
  }

  /** Delete stored Sessions without treating it as the user's deletion. */
  private async remove(ids: readonly SessionId[]): Promise<'removed' | 'busy'> {
    for (const id of ids) this.removing.add(id)
    try {
      return await removeLogs(this.ctx.sessionPersistence, ids)
    } finally {
      for (const id of ids) this.removing.delete(id)
    }
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

/** Whether the path names an existing directory here. */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    // Missing or unreadable: not a directory to work in.
    return false
  }
}

async function readAll(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  for await (const chunk of chunks) parts.push(chunk)
  return Buffer.concat(parts)
}

export default SessionSync
