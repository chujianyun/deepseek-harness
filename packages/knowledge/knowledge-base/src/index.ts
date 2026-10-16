/**
 * Local knowledge bases for Desktop, behind one Host service and the `knowledgeBases` Remote
 * namespace. Each belongs to the tenant of the current Hub sign-in and lives under
 * `<dshHome>/knowledge/<tenantId>/<baseId>`: its settings, copies of the files added to it, and an
 * SQLite index of their chunks, embedding vectors, and keyword terms.
 *
 * Added files queue as items. One worker processes the signed-in tenant's items in order: read
 * the text, chunk it, embed the chunks with the base's embedding model, and index them. When a
 * tenant becomes the signed-in one (at startup or on sign-in), items left pending or processing
 * resume for the local embedding model, which costs nothing, and fail as `interrupted` for API
 * models, so nothing is billed without the user asking. Another tenant's sign-in stops the worker.
 *
 * The knowledge bases sync with the user center of the Hub sign-in (`sync.ts`): names, settings, and
 * item copies upload, and the employee's other computers' knowledge bases are pulled and processed
 * here. What is pulled for an API embedding model waits for the user to process it.
 *
 * @module @deepseek-ai/dsh-knowledge-base
 */

import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type { WebError } from '@deepseek-ai/dsh-web'
import { Context, Service } from '@deepseek-ai/cordis'
import type { EmbeddingState } from '@deepseek-ai/dsh-embedding'
import { followTenant, syncDeviceName } from '@deepseek-ai/dsh-hub-account'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { canOpenNativePath, openNativeAssociatedPath } from '@deepseek-ai/dsh-native-command'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import Schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { chunkText } from './chunk.ts'
import { scanFolder, type FolderFile } from './folder.ts'
import { pageToMarkdown } from './page.ts'
import { isSupported, readDocument } from './readers.ts'
import { settingsShape } from './settings.ts'
import { BaseStore, type ItemRow } from './store.ts'
import { KnowledgeSync, type LocalBase, type RemoteBase, type RemoteItem } from './sync.ts'
import type {
  KnowledgeAddResult, KnowledgeBaseSettings, KnowledgeBaseView, KnowledgeItemError, KnowledgeRecallResult, KnowledgeRejectReason,
  KnowledgeItemView, KnowledgeNote, KnowledgeSearchHit, KnowledgeSettingsPatch, KnowledgeState,
} from './types.ts'
import { changeStream } from '@deepseek-ai/dsh-change-stream'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The signed-in tenant's knowledge bases: management, processing, and search. */
    knowledgeBases: KnowledgeBaseService
  }
}

/** Plugin configuration. */
export interface Config {
  /** DeepSeek Harness home; knowledge bases live under `<dshHome>/knowledge`. Defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string
  /** Largest file accepted, in bytes. */
  maxFileBytes?: number
  /** Most data rows read from one Excel workbook; later rows are left out and its text says so. */
  maxWorkbookRows?: number
  /** Chunk size of a new knowledge base, in estimated tokens. */
  chunkSize?: number
  /** Tokens a new knowledge base's chunks carry over from the previous chunk. */
  chunkOverlap?: number
  /** Chunks embedded per embedding call. */
  embedBatch?: number
  /** Longest knowledge base name, in characters. */
  maxNameLength?: number
  /** Most files a folder contributes; the rest are skipped. */
  maxFolderFiles?: number
  /** Longest note title, in characters. */
  maxNoteTitleLength?: number
  /** Longest note body, in characters. */
  maxNoteChars?: number
  /** Name of this computer as the employee's other computers show it. Defaults to the host name without `.local`. */
  deviceName?: string
  /** Wait after a change before uploading, so changes in quick succession upload once, in milliseconds. */
  syncDebounceMs?: number
  /** Interval of the pull and upload pass, in milliseconds. */
  syncIntervalMs?: number
  /** Wait before retrying after the user center could not be reached, in milliseconds. */
  syncRetryMs?: number
  /** Deadline of each user-center request, in milliseconds. */
  requestTimeoutMs?: number
}

/** Validated plugin configuration. */
export const Config: Schema<Config> = Schema.object({
  dshHome: Schema.string(),
  maxFileBytes: Schema.natural().min(1).default(100 * 1024 * 1024),
  maxWorkbookRows: Schema.natural().min(1).default(50_000),
  chunkSize: Schema.natural().min(16).default(1024),
  chunkOverlap: Schema.natural().default(200),
  embedBatch: Schema.natural().min(1).max(256).default(16),
  maxNameLength: Schema.natural().min(1).default(50),
  maxFolderFiles: Schema.natural().min(1).default(1000),
  maxNoteTitleLength: Schema.natural().min(1).default(100),
  maxNoteChars: Schema.natural().min(1).default(1_000_000),
  deviceName: Schema.string(),
  syncDebounceMs: Schema.number().min(0).max(600_000).default(2_000),
  syncIntervalMs: Schema.number().min(100).max(86_400_000).default(300_000),
  syncRetryMs: Schema.number().min(100).max(86_400_000).default(60_000),
  requestTimeoutMs: Schema.number().min(1).max(3_600_000).default(300_000),
})


/** The cross-field rules: overlap below size, and a separator for delimiter chunking. */
function crossFieldProblem(settings: KnowledgeBaseSettings): keyof KnowledgeBaseSettings | undefined {
  if (settings.chunkOverlap >= settings.chunkSize) return 'chunkOverlap'
  if (settings.chunkStrategy === 'delimiter' && settings.chunkSeparator === '') return 'chunkSeparator'
  return undefined
}

const settingsFile = z.object({
  version: z.literal(1),
  id: z.string(),
  name: z.string(),
  embeddingModelId: z.string(),
  // Knowledge bases created before these settings existed read with the defaults.
  dimensions: z.number().int().positive().nullable().default(null),
  chunkStrategy: settingsShape.chunkStrategy.default('structured'),
  chunkSeparator: settingsShape.chunkSeparator.default('\\n\\n'),
  chunkSize: settingsShape.chunkSize,
  chunkOverlap: settingsShape.chunkOverlap,
  documentCount: settingsShape.documentCount.default(6),
  threshold: settingsShape.threshold.default(0),
  /** Set while items are processed again for a new embedding model. */
  rebuilding: z.boolean().default(false),
  createdAt: z.string(),
})

const settingsPatch = z.object({ ...settingsShape, embeddingModelId: z.string() }).partial().strict()
type BaseSettings = z.infer<typeof settingsFile>

interface OpenBase {
  readonly dir: string
  settings: BaseSettings
  readonly store: BaseStore
}

/** The item being processed, and how to stop it. */
interface Job {
  readonly baseId: string
  readonly itemId: string
  readonly controller: AbortController
}

/** Host owner of the knowledge bases and of the `knowledgeBases` Remote namespace. */
export class KnowledgeBaseService extends TypertRemoteService {
  static inject = ['embedding', 'hubAccount']
  static Config = Config

  private readonly config: Required<Omit<Config, 'dshHome' | 'deviceName'>>
  private readonly root: string
  private tenantId: string | null = null
  private bases = new Map<string, OpenBase>()
  private embedding: EmbeddingState | undefined
  private job: Job | undefined
  private working: Promise<void> | undefined
  private rerun = false
  /** Set while a stop waits for the worker: it finishes the aborted item and looks no further. */
  private halting = false
  private writes: Promise<unknown> = Promise.resolve()
  /** Grows with every change, so a reader keeps the newer of two states that arrive out of order. */
  private revision = Date.now()
  private readonly listeners = new Set<() => void>()
  private readonly lifetime = new AbortController()
  private readonly sync: KnowledgeSync
  /** Pages pulled with their fetched copy, processed from it once; reprocessing fetches them again. */
  private readonly pulledPages = new Set<string>()

  /** @param ctx - Host with embedding models and the Hub sign-in. @param config - storage and chunking options. */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'knowledgeBases', { namespace: 'knowledgeBases' })
    const resolved = Config(config) as Required<Omit<Config, 'dshHome' | 'deviceName'>> & Pick<Config, 'dshHome' | 'deviceName'>
    this.config = resolved
    const home = resolveDshHome(resolved.dshHome)
    this.root = join(home, 'knowledge')
    const device = syncDeviceName(resolved.deviceName, 'knowledge-base')
    ctx.embedding.registerUsage(id => this.users(id))
    ctx.effect(() => () => {
      this.lifetime.abort()
      this.job?.controller.abort()
      this.closeBases()
      this.changed(false)
    }, 'knowledge-base: lifetime')
    this.sync = new KnowledgeSync(ctx, {
      snapshot: () => this.serialized(() => Promise.resolve(this.syncSnapshot())),
      baseExists: (tenantId, baseId) => stat(join(this.root, tenantId, baseId)).then(info => info.isDirectory(), () => false),
      applyBase: (tenantId, base) => this.serialized(() => this.applyBase(tenantId, base)),
      applyItem: (tenantId, item, content) => this.serialized(() => this.applyItem(tenantId, item, content)),
      removeBase: (tenantId, baseId) => this.serialized(() => this.removePulledBase(tenantId, baseId)),
      removeItem: (tenantId, baseId, itemId) => this.serialized(() => this.removePulledItem(tenantId, baseId, itemId)),
    }, {
      statePath: join(home, 'knowledge-sync.json'), device, debounceMs: resolved.syncDebounceMs, intervalMs: resolved.syncIntervalMs,
      retryMs: resolved.syncRetryMs, requestTimeoutMs: resolved.requestTimeoutMs,
    })
  }

  async [Service.init](): Promise<void> {
    this.embedding = await this.ctx.embedding.getState()
    await followTenant(
      this.ctx.hubAccount, this.lifetime.signal, () => this.tenantId, tenantId => this.serialized(() => this.switchTenant(tenantId)),
      this.ctx.logger, 'knowledge-base',
    )
    void (async () => {
      for await (const state of this.ctx.embedding.watch(this.lifetime.signal)) {
        this.embedding = state
        this.changed(false)
        this.kick()
      }
    })()
    await this.sync.start()
  }

  /**
   * Read the signed-in tenant's knowledge bases with their items.
   * @returns the state the Knowledge page shows.
   */
  @Remote
  getState(): Promise<KnowledgeState> {
    const bases = [...this.bases.values()].map(base => this.view(base))
    return Promise.resolve({ revision: this.revision, tenantId: this.tenantId, bases })
  }

  /**
   * Stream the state.
   * @param signal - stream lifetime.
   * @returns the current state, then every change.
   */
  @Remote({ mode: 'stream' })
  watch(signal: AbortSignal): AsyncIterable<KnowledgeState> {
    return changeStream(this.listeners, () => this.getState(), signal, this.lifetime.signal)
  }

  /**
   * Pull the employee's other computers' knowledge base changes and upload this computer's now, as
   * when the Knowledge page opens or the window comes back to the front.
   */
  @Remote
  syncNow(): Promise<void> {
    this.sync.refresh()
    return Promise.resolve()
  }

  /**
   * Create a knowledge base for the signed-in tenant.
   * @param name - display name, unique within the tenant.
   * @param embeddingModelId - an embedding model Settings → Embedding models offers.
   * @returns the state with the new knowledge base last.
   * @throws RemoteError `hub-account/signed-out`, `knowledge/invalid-name`, `knowledge/duplicate-name`,
   *   or `knowledge/embedding-model-unavailable`.
   */
  @Remote
  createBase(name: string, embeddingModelId: string): Promise<KnowledgeState> {
    return this.serialized(async () => {
      const tenant = this.requireTenant()
      const trimmed = this.validName(name)
      const dimensions = await this.offeredDimensions(embeddingModelId)
      const id = randomUUID()
      const settings: BaseSettings = {
        version: 1, id, name: trimmed, embeddingModelId, dimensions,
        chunkStrategy: 'structured', chunkSeparator: '\\n\\n',
        chunkSize: this.config.chunkSize, chunkOverlap: Math.min(this.config.chunkOverlap, this.config.chunkSize - 1),
        documentCount: 6, threshold: 0, rebuilding: false,
        createdAt: new Date().toISOString(),
      }
      const dir = join(this.root, tenant, id)
      await mkdir(join(dir, 'files'), { recursive: true })
      await this.writeSettings(dir, settings)
      this.bases.set(id, { dir, settings, store: new BaseStore(join(dir, 'index.sqlite')) })
      this.changed()
      return this.getState()
    })
  }

  /**
   * Rename a knowledge base.
   * @param id - knowledge base id.
   * @param name - new name, unique within the tenant.
   * @returns the state.
   * @throws RemoteError `knowledge/not-found`, `knowledge/invalid-name`, or `knowledge/duplicate-name`.
   */
  @Remote
  renameBase(id: string, name: string): Promise<KnowledgeState> {
    return this.serialized(async () => {
      const base = this.base(id)
      const trimmed = this.validName(name, id)
      base.settings = { ...base.settings, name: trimmed }
      await this.writeSettings(base.dir, base.settings)
      this.changed()
      return this.getState()
    })
  }

  /**
   * Change a knowledge base's embedding model, chunking, or retrieval settings. A new embedding
   * model must embed a trial text first, which measures its vector length; with items present the
   * knowledge base is then rebuilt in place: every chunk is dropped and every item processed again,
   * and it cannot be searched until that ends. Chunking changes apply to items processed afterwards.
   * @param id - knowledge base id.
   * @param patch - settings to change.
   * @returns the state.
   * @throws RemoteError `knowledge/not-found`, `knowledge/invalid-settings`, `knowledge/embedding-model-unavailable`,
   *   or `knowledge/embedding-probe-failed`.
   */
  @Remote
  updateSettings(id: string, patch: KnowledgeSettingsPatch): Promise<KnowledgeState> {
    return this.serialized(async () => {
      const base = this.base(id)
      const parsed = settingsPatch.safeParse(patch)
      if (!parsed.success) {
        const field = String(parsed.error.issues[0]?.path[0] ?? 'settings')
        throw new RemoteError('knowledge/invalid-settings', `invalid knowledge base setting ${field}`, { field })
      }
      const { embeddingModelId = base.settings.embeddingModelId, ...changes } = parsed.data
      // The schema admits only these keys; a key passed as undefined changes nothing.
      const defined = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined))
      const next = { ...base.settings, ...(defined as Partial<KnowledgeBaseSettings>) }
      const problem = crossFieldProblem(next)
      if (problem !== undefined) throw new RemoteError('knowledge/invalid-settings', `invalid knowledge base setting ${problem}`, { field: problem })
      let { dimensions, rebuilding } = base.settings
      let rebuild = false
      if (embeddingModelId !== base.settings.embeddingModelId) {
        await this.offeredDimensions(embeddingModelId)
        dimensions = await this.probe(embeddingModelId)
        rebuild = base.store.items().length > 0
        if (rebuild) {
          await this.stopJob(job => job.baseId === id)
          rebuilding = true
        }
      }
      const settings = { ...next, embeddingModelId, dimensions, rebuilding }
      await this.writeSettings(base.dir, settings)
      if (rebuild) base.store.requeueAll(true)
      base.settings = settings
      this.changed()
      this.kick()
      return this.getState()
    })
  }

  /**
   * Process every item of a knowledge base again, as after a chunking change. Old chunks stay
   * searchable until each item's new ones replace them.
   * @param id - knowledge base id.
   * @returns the state with every item pending.
   * @throws RemoteError `knowledge/not-found`.
   */
  @Remote
  reprocessAll(id: string): Promise<KnowledgeState> {
    return this.serialized(async () => {
      const base = this.base(id)
      await this.stopJob(job => job.baseId === id)
      base.store.requeueAll(false)
      this.changed()
      this.kick()
      return this.getState()
    })
  }

  /**
   * Recall test: search a knowledge base under its own retrieval settings, outside any session.
   * @param id - knowledge base id.
   * @param query - question or keywords.
   * @returns the hits and how long the search took.
   * @throws RemoteError `knowledge/not-found`, `knowledge/rebuilding`, or the embedding model's failure.
   */
  @Remote
  async recall(id: string, query: string): Promise<KnowledgeRecallResult> {
    const { documentCount, threshold } = this.base(id).settings
    const started = performance.now()
    const hits = await this.search(id, query, { limit: documentCount, threshold })
    return { hits, durationMs: Math.round(performance.now() - started) }
  }

  /**
   * Delete a knowledge base with its files and index.
   * @param id - knowledge base id.
   * @returns the state without it.
   * @throws RemoteError `knowledge/not-found`.
   */
  @Remote
  deleteBase(id: string): Promise<KnowledgeState> {
    return this.serialized(async () => {
      await this.dropBase(id, this.base(id))
      return this.getState()
    })
  }

  /**
   * Add files to a knowledge base: each supported file within the size limit is copied in and queued.
   * @param id - knowledge base id.
   * @param paths - absolute paths of files on this machine.
   * @returns how many were added and which were refused.
   * @throws RemoteError `knowledge/not-found`.
   */
  @Remote
  addFiles(id: string, paths: readonly string[]): Promise<KnowledgeAddResult> {
    return this.serialized(async () => {
      const base = this.base(id)
      let added = 0
      const rejected: { name: string; reason: KnowledgeRejectReason }[] = []
      for (const path of paths) {
        const name = basename(path)
        if (!isSupported(name)) { rejected.push({ name, reason: 'unsupported' }); continue }
        const info = await stat(path).catch(() => undefined)
        if (info?.isFile() !== true) { rejected.push({ name, reason: 'unreadable' }); continue }
        if (info.size > this.config.maxFileBytes) { rejected.push({ name, reason: 'too-large' }); continue }
        const itemId = randomUUID()
        try {
          await copyFile(path, this.copyPath(base, { id: itemId, kind: 'file', name }))
        } catch (_unreadable: unknown) {
          // A file that vanished or is not readable since stat is refused like a missing one.
          rejected.push({ name, reason: 'unreadable' })
          continue
        }
        base.store.addItem({ id: itemId, name, size: info.size, status: 'pending', error: null, chunkCount: 0, addedAt: new Date().toISOString() })
        added++
      }
      this.changed()
      this.kick()
      return { added, rejected }
    })
  }

  /**
   * Add a folder: each supported file in it and its subfolders, up to `maxFolderFiles`, is copied in
   * as a file item of the folder; unsupported files and those past the limit are listed as skipped.
   * The folder is not watched; reprocessing it scans it again.
   * @param id - knowledge base id.
   * @param path - absolute path of a folder on this machine.
   * @returns the state with the folder last.
   * @throws RemoteError `knowledge/not-found` or `knowledge/not-a-folder`.
   */
  @Remote
  addFolder(id: string, path: string): Promise<KnowledgeState> {
    return this.serialized(async () => {
      const base = this.base(id)
      const scan = await scanFolder(path, this.config.maxFolderFiles).catch(() => undefined)
      if (scan === undefined) throw new RemoteError('knowledge/not-a-folder', `${path} is not a folder`, { path })
      const folderId = randomUUID()
      const addedAt = new Date().toISOString()
      base.store.addItem({
        id: folderId, kind: 'folder', name: basename(path), source: path, skipped: scan.skipped, skippedCount: scan.skippedCount,
        size: scan.files.reduce((sum, file) => sum + file.size, 0), status: 'completed', error: null, chunkCount: 0, addedAt,
      })
      for (const file of scan.files) await this.addFolderFile(base, folderId, path, file, addedAt)
      this.changed()
      this.kick()
      return this.getState()
    })
  }

  /**
   * Add a web page, fetched on this machine when processed; only that page is read.
   * @param id - knowledge base id.
   * @param url - an http or https address.
   * @returns the state with the page last.
   * @throws RemoteError `knowledge/not-found`, `knowledge/invalid-url`, or `knowledge/credentials-in-url` for an
   *   address carrying a user name or password.
   */
  @Remote
  addUrl(id: string, url: string): Promise<KnowledgeState> {
    return this.serialized(async () => {
      const base = this.base(id)
      let parsed: URL
      try {
        parsed = new URL(url.trim())
      } catch (_invalid: unknown) {
        // An unparsable address is refused like one of another scheme.
        throw new RemoteError('knowledge/invalid-url', `${url} is not an http or https address`, { url })
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new RemoteError('knowledge/invalid-url', `${url} is not an http or https address`, { url })
      }
      // Never fetched by the web service, and not to be kept or shown: the error does not repeat the address.
      if (parsed.username !== '' || parsed.password !== '') {
        throw new RemoteError('knowledge/credentials-in-url', 'A web address must not carry a user name or password', {})
      }
      base.store.addItem({
        id: randomUUID(), kind: 'url', name: parsed.href, source: parsed.href, size: 0,
        status: 'pending', error: null, chunkCount: 0, addedAt: new Date().toISOString(),
      })
      this.changed()
      this.kick()
      return this.getState()
    })
  }

  /**
   * Write a new note.
   * @param id - knowledge base id.
   * @param title - 1 to `maxNoteTitleLength` characters.
   * @param content - Markdown body of at most `maxNoteChars` characters.
   * @returns the state with the note last.
   * @throws RemoteError `knowledge/not-found` or `knowledge/invalid-note`.
   */
  @Remote
  createNote(id: string, title: string, content: string): Promise<KnowledgeState> {
    return this.serialized(async () => {
      const base = this.base(id)
      const name = this.validNote(title, content)
      const item = { id: randomUUID(), kind: 'note' as const, name }
      await writeFile(this.copyPath(base, item), content)
      base.store.addItem({ ...item, size: Buffer.byteLength(content), status: 'pending', error: null, chunkCount: 0, addedAt: new Date().toISOString() })
      this.changed()
      this.kick()
      return this.getState()
    })
  }

  /**
   * Change a note; only that note is processed again.
   * @param id - knowledge base id.
   * @param itemId - the note.
   * @param title - 1 to `maxNoteTitleLength` characters.
   * @param content - Markdown body of at most `maxNoteChars` characters.
   * @returns the state.
   * @throws RemoteError `knowledge/not-found` or `knowledge/invalid-note`.
   */
  @Remote
  updateNote(id: string, itemId: string, title: string, content: string): Promise<KnowledgeState> {
    return this.serialized(async () => {
      const base = this.base(id)
      const item = this.note(base, itemId)
      const name = this.validNote(title, content)
      await this.stopJob(job => job.itemId === itemId)
      await writeFile(this.copyPath(base, item), content)
      base.store.updateItem(itemId, { name, size: Buffer.byteLength(content) })
      base.store.setStatus(itemId, 'pending', null)
      this.changed()
      this.kick()
      return this.getState()
    })
  }

  /**
   * Read a note for editing.
   * @param id - knowledge base id.
   * @param itemId - the note.
   * @returns its title and body.
   * @throws RemoteError `knowledge/not-found`.
   */
  @Remote
  async getNote(id: string, itemId: string): Promise<KnowledgeNote> {
    const base = this.base(id)
    const item = this.note(base, itemId)
    return { title: item.name, content: await readFile(this.copyPath(base, item), 'utf8') }
  }

  /**
   * Open an item's own copy with this machine's default application: a file's copy, a page's
   * fetched Markdown, or a note. A page's address is the caller's to open in a browser.
   * @param id - knowledge base id.
   * @param itemId - item id.
   * @throws RemoteError `knowledge/not-found`, or `knowledge/cannot-open` for a folder, a page never
   *   fetched, or a Host that cannot open files.
   */
  @Remote
  async openItem(id: string, itemId: string): Promise<void> {
    const base = this.base(id)
    const item = this.item(base, itemId)
    const path = this.copyPath(base, item)
    const present = item.kind !== 'folder' && await stat(path).then(info => info.isFile(), () => false)
    if (!present || !canOpenNativePath()) throw new RemoteError('knowledge/cannot-open', `item ${itemId} cannot be opened here`, { id: itemId })
    await openNativeAssociatedPath(path, this.lifetime.signal)
  }

  /**
   * Process an item again from its stored copy; a folder is scanned again, on the computer it was added on only.
   * @param id - knowledge base id.
   * @param itemId - item id.
   * @returns the state with the item pending.
   * @throws RemoteError `knowledge/not-found`, or `knowledge/folder-elsewhere` for a folder another computer added.
   */
  @Remote
  reprocessItem(id: string, itemId: string): Promise<KnowledgeState> {
    return this.serialized(async () => {
      const base = this.base(id)
      const item = this.item(base, itemId)
      if (item.kind === 'folder') {
        const device = this.sync.cameFrom(item.id)
        if (device !== null) throw new RemoteError('knowledge/folder-elsewhere', `folder ${itemId} is scanned on ${device}`, { id: itemId, device })
        await this.syncFolder(base, item)
      } else {
        await this.stopJob(job => job.itemId === itemId)
        base.store.setStatus(itemId, 'pending', null)
      }
      this.changed()
      this.kick()
      return this.getState()
    })
  }

  /**
   * Delete an item with its copy and chunks.
   * @param id - knowledge base id.
   * @param itemId - item id.
   * @returns the state without it.
   * @throws RemoteError `knowledge/not-found`.
   */
  @Remote
  deleteItem(id: string, itemId: string): Promise<KnowledgeState> {
    return this.serialized(async () => {
      const base = this.base(id)
      await this.dropItem(base, this.item(base, itemId))
      return this.getState()
    })
  }

  /**
   * Search one of the signed-in tenant's knowledge bases. Host only.
   * @param id - knowledge base id.
   * @param query - question or keywords.
   * @param options - most hits, and least blended score (0–1).
   * @param signal - cancels the query embedding.
   * @returns hits, best first.
   * @throws RemoteError `knowledge/not-found`, `knowledge/rebuilding`, or the embedding model's failure.
   */
  async search(
    id: string, query: string, options: { limit: number; threshold: number }, signal?: AbortSignal,
  ): Promise<KnowledgeSearchHit[]> {
    const base = this.base(id)
    this.ensureSearchable(id, base)
    // One text in, one vector out.
    const [vector] = await this.ctx.embedding.embed(base.settings.embeddingModelId, [query], signal) as [number[]]
    // The base may have been deleted, the tenant switched, or a rebuild started while the query was embedding.
    this.ensureSearchable(id, base)
    return base.store.search(vector, query, options.limit, options.threshold)
  }

  /** @param uploads - whether the change can be one to upload; progress and model state are not. */
  private changed(uploads = true): void {
    // Clock-based, so a restarted Host still answers with revisions above those a page already holds.
    this.revision = Math.max(this.revision + 1, Date.now())
    for (const listener of this.listeners) listener()
    if (uploads) this.sync.touched()
  }

  /** Run state changes one at a time, so a tenant switch never interleaves with an edit. */
  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const run = this.writes.then(work)
    this.writes = run.catch(() => undefined)
    return run
  }

  /** Refuse a search of a knowledge base that is gone or being rebuilt. */
  private ensureSearchable(id: string, base: OpenBase): void {
    if (this.bases.get(id) !== base) throw new RemoteError('knowledge/not-found', `no knowledge base ${id}`, { id })
    if (base.settings.rebuilding) throw new RemoteError('knowledge/rebuilding', `knowledge base ${id} is being rebuilt`, { id })
  }

  private requireTenant(): string {
    if (this.tenantId === null) throw new RemoteError('hub-account/signed-out', 'sign in to use knowledge bases', {})
    return this.tenantId
  }

  private base(id: string): OpenBase {
    const base = this.bases.get(id)
    if (base === undefined) throw new RemoteError('knowledge/not-found', `no knowledge base ${id}`, { id })
    return base
  }

  private item(base: OpenBase, itemId: string) {
    const item = base.store.items().find(entry => entry.id === itemId)
    if (item === undefined) throw new RemoteError('knowledge/not-found', `no item ${itemId}`, { id: itemId })
    return item
  }

  private validName(name: string, self?: string): string {
    const trimmed = name.trim()
    if (trimmed.length === 0 || trimmed.length > this.config.maxNameLength) {
      throw new RemoteError('knowledge/invalid-name', 'a knowledge base needs a name of 1 to 50 characters', { name })
    }
    if ([...this.bases.values()].some(base => base.settings.id !== self && base.settings.name === trimmed)) {
      throw new RemoteError('knowledge/duplicate-name', `a knowledge base named ${trimmed} already exists`, { name: trimmed })
    }
    return trimmed
  }

  /** Where an item's own copy lives: a file's copy, a fetched page, or a note, the last two as Markdown. */
  private copyPath(base: OpenBase, item: Pick<ItemRow, 'id' | 'kind' | 'name'>): string {
    const extension = item.kind === 'file' ? extname(item.name).toLowerCase() : '.md'
    return join(base.dir, 'files', `${item.id}${extension}`)
  }

  private note(base: OpenBase, itemId: string): ItemRow {
    const item = this.item(base, itemId)
    if (item.kind !== 'note') throw new RemoteError('knowledge/not-found', `no note ${itemId}`, { id: itemId })
    return item
  }

  /** @returns the trimmed title of a valid note. */
  private validNote(title: string, content: string): string {
    const trimmed = title.trim()
    const { maxNoteTitleLength, maxNoteChars } = this.config
    if (trimmed.length === 0 || trimmed.length > maxNoteTitleLength) {
      throw new RemoteError('knowledge/invalid-note', `a note needs a title of 1 to ${String(maxNoteTitleLength)} characters`, { field: 'title', max: maxNoteTitleLength })
    }
    if (content.length > maxNoteChars) {
      throw new RemoteError('knowledge/invalid-note', `a note's body holds at most ${String(maxNoteChars)} characters`, { field: 'content', max: maxNoteChars })
    }
    return trimmed
  }

  /** Copy a folder's file in and queue it; a file that cannot be copied fails as unreadable. */
  private async addFolderFile(base: OpenBase, folderId: string, root: string, file: FolderFile, addedAt: string): Promise<void> {
    const item = { id: randomUUID(), kind: 'file' as const, name: basename(file.path) }
    const copied = await copyFile(join(root, file.path), this.copyPath(base, item)).then(() => true, () => false)
    base.store.addItem({
      ...item, parentId: folderId, source: file.path, size: file.size, modifiedAt: file.modifiedAt, addedAt,
      status: copied ? 'pending' : 'failed', error: copied ? null : 'unreadable', chunkCount: 0,
    })
  }

  /**
   * Scan a folder again: files new to it are added, files gone from it removed, and changed or failed
   * ones copied and queued again. A folder that is gone fails, keeping its files as they were.
   */
  private async syncFolder(base: OpenBase, folder: ItemRow): Promise<void> {
    // A folder item always records its path.
    const root = folder.source as string
    const scan = await scanFolder(root, this.config.maxFolderFiles).catch(() => undefined)
    if (scan === undefined) { base.store.setStatus(folder.id, 'failed', 'folder-missing'); return }
    const children = new Map(base.store.items().filter(item => item.parentId === folder.id).map(item => [item.source, item]))
    const addedAt = new Date().toISOString()
    for (const file of scan.files) {
      const child = children.get(file.path)
      children.delete(file.path)
      if (child === undefined) { await this.addFolderFile(base, folder.id, root, file, addedAt); continue }
      const changed = child.size !== file.size || child.modifiedAt !== file.modifiedAt
      if (!changed && child.status !== 'failed') continue
      await this.stopJob(job => job.itemId === child.id)
      const copied = await copyFile(join(root, file.path), this.copyPath(base, child)).then(() => true, () => false)
      base.store.updateItem(child.id, { size: file.size, modifiedAt: file.modifiedAt })
      base.store.setStatus(child.id, copied ? 'pending' : 'failed', copied ? null : 'unreadable')
    }
    for (const gone of children.values()) await this.removeItem(base, gone)
    const size = scan.files.reduce((sum, file) => sum + file.size, 0)
    base.store.updateItem(folder.id, { skipped: scan.skipped, skippedCount: scan.skippedCount, size })
    base.store.setStatus(folder.id, 'completed', null)
  }

  /** Stop, then delete an item with its copy and chunks; a folder has no copy. */
  private async removeItem(base: OpenBase, item: ItemRow): Promise<void> {
    await this.stopJob(job => job.itemId === item.id)
    base.store.deleteItem(item.id)
    if (item.kind !== 'folder') await rm(this.copyPath(base, item), { force: true })
  }

  private async writeSettings(dir: string, settings: BaseSettings): Promise<void> {
    const path = join(dir, 'base.json')
    await writeFile(`${path}.tmp`, JSON.stringify(settings, null, 2))
    await rename(`${path}.tmp`, path)
  }

  /**
   * Check that Settings → Embedding models offers a model.
   * @returns its vector length as Settings reports it.
   */
  private async offeredDimensions(modelId: string): Promise<number | null> {
    const embedding = await this.ctx.embedding.getState()
    if (embedding.local.status !== 'unsupported' && embedding.local.id === modelId) return embedding.local.dimensions
    const api = embedding.apiModels.find(model => model.id === modelId)
    if (api === undefined) throw new RemoteError('knowledge/embedding-model-unavailable', `embedding model ${modelId} is not available`, { id: modelId })
    return api.dimensions
  }

  /** Embed a trial text with a model, measuring its vector length. */
  private async probe(modelId: string): Promise<number> {
    try {
      const [vector] = await this.ctx.embedding.embed(modelId, ['知识库嵌入模型测试 / embedding probe'])
      if (vector === undefined || vector.length === 0) throw new Error('the model returned no vector')
      return vector.length
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new RemoteError('knowledge/embedding-probe-failed', `embedding model ${modelId} failed: ${message}`, { id: modelId, message })
    }
  }

  /** Whether a knowledge base's embedding model can run here: the local model installed, or an API model Settings offers. */
  private modelReady(modelId: string): boolean {
    if (modelId === this.embedding?.local.id) return this.embedding.local.status === 'installed'
    return !this.modelMissing(modelId)
  }

  /**
   * Whether an embedding model is neither this computer's local model nor one Settings offers, as
   * for a knowledge base pulled from another computer.
   */
  private modelMissing(modelId: string): boolean {
    if (modelId === this.embedding?.local.id) return this.embedding.local.status === 'unsupported'
    return this.embedding?.apiModels.some(model => model.id === modelId) === false
  }

  private view(base: OpenBase): KnowledgeBaseView {
    const { id, name, embeddingModelId, createdAt, dimensions, rebuilding } = base.settings
    const { chunkStrategy, chunkSeparator, chunkSize, chunkOverlap, documentCount, threshold } = base.settings
    const local = this.embedding?.local
    const api = this.embedding?.apiModels.find(model => model.id === embeddingModelId)
    const embeddingModelName = local?.id === embeddingModelId ? local.name : api?.model ?? embeddingModelId
    return {
      id, name, embeddingModelId, embeddingModelName, createdAt, dimensions, modelMissing: this.modelMissing(embeddingModelId),
      status: !this.modelReady(embeddingModelId) ? 'unavailable' : rebuilding ? 'rebuilding' : 'ready',
      settings: { chunkStrategy, chunkSeparator, chunkSize, chunkOverlap, documentCount, threshold },
      items: this.itemViews(base.store.items()),
    }
  }

  /** Items as shown: a folder takes its progress and chunk count from its files. */
  private itemViews(items: readonly ItemRow[]): KnowledgeItemView[] {
    return items.map(({ modifiedAt: _modifiedAt, ...item }) => {
      if (item.kind !== 'folder') return { ...item, scannedOn: null }
      const files = items.filter(entry => entry.parentId === item.id)
      const busy = files.some(file => file.status === 'pending' || file.status === 'processing')
      return {
        ...item,
        scannedOn: this.sync.cameFrom(item.id),
        status: item.status === 'failed' ? 'failed' : busy ? 'processing' : 'completed',
        chunkCount: files.reduce((sum, file) => sum + file.chunkCount, 0),
      }
    })
  }

  /** Names of the knowledge bases, of any tenant on this machine, using an embedding model. */
  private async users(modelId: string): Promise<string[]> {
    const names: string[] = []
    for (const tenant of await readdir(this.root).catch(() => [])) {
      for (const base of await readdir(join(this.root, tenant)).catch(() => [])) {
        const settings = await this.readSettings(join(this.root, tenant, base))
        if (settings?.embeddingModelId === modelId) names.push(settings.name)
      }
    }
    return names
  }

  private async readSettings(dir: string): Promise<BaseSettings | undefined> {
    try {
      return settingsFile.parse(JSON.parse(await readFile(join(dir, 'base.json'), 'utf8')))
    } catch (_unreadable: unknown) {
      // A directory without readable settings is not a knowledge base.
      return undefined
    }
  }

  /** The signed-in tenant's knowledge bases as the sync uploads them. */
  private syncSnapshot(): { tenantId: string | null; bases: LocalBase[] } {
    const bases = [...this.bases.values()].map((base): LocalBase => {
      const { id, name, embeddingModelId, createdAt } = base.settings
      const { chunkStrategy, chunkSeparator, chunkSize, chunkOverlap, documentCount, threshold } = base.settings
      return {
        id, name, embeddingModelId, createdAt,
        settings: { chunkStrategy, chunkSeparator, chunkSize, chunkOverlap, documentCount, threshold },
        items: base.store.items().map(row => ({ row, copy: row.kind === 'folder' ? null : this.copyPath(base, row) })),
      }
    })
    return { tenantId: this.tenantId, bases }
  }

  /** Whether pulled items of a knowledge base process on their own: only for the local model, which costs nothing. */
  private processesOnItsOwn(modelId: string): boolean {
    return modelId === this.embedding?.local.id
  }

  /**
   * Create or update a knowledge base pulled from another computer. A new embedding model drops the
   * old chunks; its items process again for the local model, or wait for the user for an API model.
   */
  private async applyBase(tenantId: string, pulled: RemoteBase): Promise<boolean> {
    if (this.tenantId !== tenantId) return false
    const existing = this.bases.get(pulled.id)
    const dimensions = await this.offeredDimensions(pulled.embeddingModelId).catch(() => null)
    const own = this.processesOnItsOwn(pulled.embeddingModelId)
    if (existing === undefined) {
      const dir = join(this.root, tenantId, pulled.id)
      const settings: BaseSettings = {
        version: 1, id: pulled.id, name: pulled.name, embeddingModelId: pulled.embeddingModelId, dimensions, ...pulled.settings,
        rebuilding: false, createdAt: pulled.createdAt,
      }
      await mkdir(join(dir, 'files'), { recursive: true })
      await this.writeSettings(dir, settings)
      this.bases.set(pulled.id, { dir, settings, store: new BaseStore(join(dir, 'index.sqlite')) })
      this.bases = new Map([...this.bases].sort(([, a], [, b]) => a.settings.createdAt.localeCompare(b.settings.createdAt)))
    } else {
      const modelChanged = pulled.embeddingModelId !== existing.settings.embeddingModelId
      if (modelChanged) await this.stopJob(job => job.baseId === pulled.id)
      const rebuilding = modelChanged ? own && existing.store.items().length > 0 : existing.settings.rebuilding
      const settings: BaseSettings = {
        ...existing.settings, ...pulled.settings, name: pulled.name, embeddingModelId: pulled.embeddingModelId,
        dimensions: modelChanged ? dimensions : existing.settings.dimensions, rebuilding,
      }
      await this.writeSettings(existing.dir, settings)
      if (modelChanged) {
        existing.store.requeueAll(true)
        if (!own) this.awaitUser(existing.store, existing.store.items())
      }
      existing.settings = settings
    }
    this.changed()
    this.kick()
    return true
  }

  /** Leave items for the user to process, as pulled ones of an API embedding model are. */
  private awaitUser(store: BaseStore, items: readonly ItemRow[]): void {
    for (const item of items) if (item.kind !== 'folder') store.setStatus(item.id, 'failed', 'synced')
  }

  /** Create or update an item pulled from another computer, with its copy; it is processed here again. */
  private async applyItem(tenantId: string, pulled: RemoteItem, content: Uint8Array | null): Promise<boolean> {
    if (this.tenantId !== tenantId) return false
    const base = this.bases.get(pulled.baseId)
    if (base === undefined) return false
    const items = base.store.items()
    if (pulled.parentId !== null && !items.some(item => item.id === pulled.parentId && item.kind === 'folder')) return false
    const existing = items.find(item => item.id === pulled.id)
    if (existing !== undefined && existing.kind !== pulled.kind) return false
    // The same content again (the other computer uploaded it anew): its chunks stay as they are.
    if (existing !== undefined && await this.unchanged(base, existing, pulled, content)) return true
    if (pulled.kind !== 'folder') {
      await this.stopJob(job => job.itemId === pulled.id)
      const copy = this.copyPath(base, pulled)
      // A renamed file may change its copy's extension.
      if (existing !== undefined && this.copyPath(base, existing) !== copy) await rm(this.copyPath(base, existing), { force: true })
      if (content !== null) await writeFile(copy, content)
      if (pulled.kind === 'url' && content !== null) this.pulledPages.add(pulled.id)
    }
    const fields = { name: pulled.name, source: pulled.source, size: pulled.size }
    if (existing === undefined) {
      base.store.addItem({
        id: pulled.id, kind: pulled.kind, parentId: pulled.parentId, ...fields, addedAt: pulled.addedAt, chunkCount: 0,
        status: pulled.kind === 'folder' ? 'completed' : 'pending', error: null,
      })
    } else {
      base.store.updateItem(pulled.id, fields)
      if (pulled.kind !== 'folder') base.store.setStatus(pulled.id, 'pending', null)
    }
    if (pulled.kind !== 'folder' && !this.processesOnItsOwn(base.settings.embeddingModelId)) {
      this.awaitUser(base.store, base.store.items().filter(item => item.id === pulled.id))
    }
    this.changed()
    this.kick()
    return true
  }

  /** Whether a pulled item matches the stored one: its fields and its copy's bytes. */
  private async unchanged(base: OpenBase, existing: ItemRow, pulled: RemoteItem, content: Uint8Array | null): Promise<boolean> {
    const same = existing.name === pulled.name && existing.source === pulled.source && existing.size === pulled.size
    if (!same || existing.parentId !== pulled.parentId) return false
    if (content === null) return true
    const copy = await readFile(this.copyPath(base, existing)).catch(() => undefined)
    return copy !== undefined && Buffer.compare(copy, content) === 0
  }

  /** Delete a knowledge base another computer deleted. */
  private async removePulledBase(tenantId: string, baseId: string): Promise<void> {
    const base = this.tenantId === tenantId ? this.bases.get(baseId) : undefined
    if (base !== undefined) await this.dropBase(baseId, base)
  }

  /** Delete an item another computer deleted, a folder with its files. */
  private async removePulledItem(tenantId: string, baseId: string, itemId: string): Promise<void> {
    const base = this.tenantId === tenantId ? this.bases.get(baseId) : undefined
    const item = base?.store.items().find(entry => entry.id === itemId)
    if (base !== undefined && item !== undefined) await this.dropItem(base, item)
  }

  /** Delete an item, a folder with its files, and end a rebuild it was the last one of. */
  private async dropItem(base: OpenBase, item: ItemRow): Promise<void> {
    for (const gone of [...base.store.items().filter(entry => entry.parentId === item.id), item]) await this.removeItem(base, gone)
    await this.settle(base)
    this.changed()
    this.kick()
  }

  /** Close and delete a knowledge base with its files and index. */
  private async dropBase(id: string, base: OpenBase): Promise<void> {
    await this.stopJob(job => job.baseId === id)
    base.store.close()
    this.bases.delete(id)
    await rm(base.dir, { recursive: true, force: true })
    this.changed()
    this.kick()
  }

  private closeBases(): void {
    for (const base of this.bases.values()) base.store.close()
    this.bases = new Map()
  }

  /**
   * Make a tenant the current one: stop the worker, open its knowledge bases, and settle the
   * items an earlier run left unfinished.
   */
  private async switchTenant(tenantId: string | null): Promise<void> {
    await this.stopJob(() => true)
    this.closeBases()
    this.tenantId = tenantId
    if (tenantId !== null) {
      const opened: OpenBase[] = []
      for (const entry of await readdir(join(this.root, tenantId)).catch(() => [])) {
        const dir = join(this.root, tenantId, entry)
        const settings = await this.readSettings(dir)
        if (settings === undefined) continue
        try {
          opened.push({ dir, settings, store: new BaseStore(join(dir, 'index.sqlite')) })
        } catch (error) {
          // A damaged index hides only its own base; the others still open.
          console.warn('[knowledge-base] skipped a base whose index cannot be opened', { dir, error: String(error) })
        }
      }
      opened.sort((a, b) => a.settings.createdAt.localeCompare(b.settings.createdAt))
      for (const base of opened) {
        this.bases.set(base.settings.id, base)
        const local = base.settings.embeddingModelId === this.embedding?.local.id
        for (const item of base.store.items()) {
          if (item.status !== 'pending' && item.status !== 'processing') continue
          // The local model costs nothing to resume; an API model waits for the user to retry.
          base.store.setStatus(item.id, local ? 'pending' : 'failed', local ? null : 'interrupted')
        }
        await this.settle(base)
      }
    }
    this.changed()
    this.kick()
  }

  /** Stop the running job if it matches, and wait for the worker to let go of it. */
  private async stopJob(matches: (job: Job) => boolean): Promise<void> {
    if (this.job !== undefined && matches(this.job)) {
      this.halting = true
      this.job.controller.abort()
      await this.working
      this.halting = false
    }
  }

  /** Start the worker, or have it look again once it finishes the current item. */
  private kick(): void {
    if (this.working !== undefined) { this.rerun = true; return }
    this.working = this.work().finally(() => {
      this.working = undefined
      if (this.rerun) { this.rerun = false; this.kick() }
    })
  }

  private async work(): Promise<void> {
    for (;;) {
      const next = this.halting ? undefined : this.nextItem()
      if (next === undefined) return
      await this.process(next.base, next.item)
    }
  }

  private nextItem(): { base: OpenBase; item: ItemRow } | undefined {
    for (const base of this.bases.values()) {
      if (!this.modelReady(base.settings.embeddingModelId)) continue
      const item = base.store.items().find(entry => entry.status === 'pending')
      if (item !== undefined) return { base, item }
    }
    return undefined
  }

  private async process(base: OpenBase, item: ItemRow): Promise<void> {
    const itemId = item.id
    const controller = new AbortController()
    const job: Job = { baseId: base.settings.id, itemId, controller }
    this.job = job
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal])
    base.store.setStatus(itemId, 'processing', null)
    this.changed(false)
    const fail = (error: KnowledgeItemError, detail: unknown): void => {
      console.info('[knowledge-base] item failed', { error, detail: String(detail) })
      base.store.setStatus(itemId, 'failed', error)
    }
    try {
      await this.processSteps(base, item, signal, fail)
    } catch (error) {
      // Anything unexpected, such as the index refusing a write, fails the item and keeps the queue going.
      try {
        fail('storage', error)
      } catch (unrecorded) {
        // The index cannot even record the failure; the next tenant activation settles the item still marked processing.
        console.warn('[knowledge-base] could not record a failure', { error: String(error), unrecorded: String(unrecorded) })
      }
    } finally {
      this.job = undefined
      // Fetching a page renames it and replaces its copy.
      this.changed(item.kind === 'url')
      void this.serialized(() => this.settle(base)).catch((error: unknown) => {
        // The rebuild stays on; the next item finished or deleted, or the next activation of this tenant, tries again.
        console.warn('[knowledge-base] could not end a rebuild', { error: String(error) })
      })
    }
  }

  /** End a rebuild once none of the knowledge base's items is left to process. */
  private async settle(base: OpenBase): Promise<void> {
    if (!base.settings.rebuilding || this.bases.get(base.settings.id) !== base) return
    if (base.store.items().some(item => item.status === 'pending' || item.status === 'processing')) return
    const settings = { ...base.settings, rebuilding: false }
    await this.writeSettings(base.dir, settings)
    base.settings = settings
    this.changed(false)
  }

  /** Read, chunk, embed, and index one item; expected failures are recorded through `fail`. */
  private async processSteps(
    base: OpenBase, item: ItemRow, signal: AbortSignal,
    fail: (error: KnowledgeItemError, detail: unknown) => void,
  ): Promise<void> {
    const itemId = item.id
    // A page that cannot be fetched again is indexed from its last fetched copy, then marked failed.
    // A page pulled with its copy is indexed from it, not fetched again, so computers do not trade newer copies of a changing page.
    const fetch = item.kind === 'url' && !this.pulledPages.delete(itemId)
    const unfetched = fetch ? await this.fetchPage(base, item, signal) : undefined
    let text: string
    try {
      text = await readDocument(this.copyPath(base, item), { maxWorkbookRows: this.config.maxWorkbookRows })
    } catch (error) {
      if (unfetched === undefined) fail('unreadable', error)
      else fail(unfetched.reason, unfetched.error)
      return
    }
    // A note's title is part of what it says.
    if (item.kind === 'note') text = `# ${item.name}\n\n${text}`
    // Read each time: the signal can abort during any await.
    const stopped = (): boolean => signal.aborted
    // Stopped while reading: the item stays as it is for whoever resumes it.
    if (stopped()) return
    const { chunkSize: size, chunkOverlap: overlap, chunkStrategy: strategy, chunkSeparator: separator } = base.settings
    const chunks = chunkText(text, { size, overlap, strategy, separator })
    if (chunks.length === 0) { fail('empty', 'no text'); return }
    const embedded: { text: string; vector: number[] }[] = []
    try {
      for (let start = 0; start < chunks.length; start += this.config.embedBatch) {
        const batch = chunks.slice(start, start + this.config.embedBatch)
        const vectors = await this.ctx.embedding.embed(base.settings.embeddingModelId, batch, signal)
        if (vectors.length !== batch.length) throw new Error(`expected ${String(batch.length)} vectors, got ${String(vectors.length)}`)
        embedded.push(...batch.map((text, index) => ({ text, vector: vectors[index] as number[] })))
      }
    } catch (error) {
      // Stopped by a switch, a deletion, or shutdown: the item stays as it is for whoever resumes it.
      if (stopped()) return
      fail('embedding', error)
      return
    }
    base.store.complete(itemId, embedded)
    if (unfetched !== undefined) fail(unfetched.reason, unfetched.error)
  }

  /**
   * Fetch a page into its copy, renaming the item to the page title.
   * @returns why it could not be fetched, `blocked` when the web service refused its address by policy;
   *   undefined when it was fetched.
   */
  private async fetchPage(
    base: OpenBase, item: ItemRow, signal: AbortSignal,
  ): Promise<{ reason: 'blocked' | 'unreachable'; error: unknown } | undefined> {
    // A page item always records its address.
    const url = item.source as string
    try {
      const web = this.ctx.get('web')
      if (web === undefined) throw new Error('web fetching is not available')
      const page = await web.fetch({ url }, signal)
      if (page.statusCode < 200 || page.statusCode >= 300) throw new Error(`HTTP ${String(page.statusCode)}`)
      const { title, markdown } = page.body.kind === 'html' ? pageToMarkdown(page.body.content, page.url) : { title: '', markdown: page.body.content }
      await writeFile(this.copyPath(base, item), markdown)
      base.store.updateItem(item.id, { name: title === '' ? url : title, size: Buffer.byteLength(markdown) })
      return undefined
    } catch (error) {
      // Matched by name and code, not instanceof: the web service and its providers may load another copy of dsh-web.
      const blocked = error instanceof Error && error.name === 'WebError' && (error as WebError).code === 'WEB_BLOCKED_URL'
      return { reason: blocked ? 'blocked' : 'unreachable', error }
    }
  }
}

export default KnowledgeBaseService
