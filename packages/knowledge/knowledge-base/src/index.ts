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
 * @module @deepseek-ai/dsh-knowledge-base
 */

import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { EmbeddingState } from '@deepseek-ai/dsh-embedding'
import type {} from '@deepseek-ai/dsh-hub-account'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import Schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { chunkText } from './chunk.ts'
import { isSupported, readDocument } from './readers.ts'
import { BaseStore, type SearchHit } from './store.ts'
import type {
  KnowledgeAddResult, KnowledgeBaseView, KnowledgeItemError, KnowledgeRejectReason, KnowledgeState,
} from './types.ts'

export type * from './types.ts'
export type { SearchHit } from './store.ts'

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
  /** Chunk size of a new knowledge base, in estimated tokens. */
  chunkSize?: number
  /** Tokens a new knowledge base's chunks carry over from the previous chunk. */
  chunkOverlap?: number
  /** Chunks embedded per embedding call. */
  embedBatch?: number
  /** Longest knowledge base name, in characters. */
  maxNameLength?: number
}

/** Validated plugin configuration. */
export const Config: Schema<Config> = Schema.object({
  dshHome: Schema.string(),
  maxFileBytes: Schema.natural().min(1).default(100 * 1024 * 1024),
  chunkSize: Schema.natural().min(16).default(1024),
  chunkOverlap: Schema.natural().default(200),
  embedBatch: Schema.natural().min(1).max(256).default(16),
  maxNameLength: Schema.natural().min(1).default(50),
})

const settingsFile = z.object({
  version: z.literal(1),
  id: z.string(),
  name: z.string(),
  embeddingModelId: z.string(),
  chunkSize: z.number().int().positive(),
  chunkOverlap: z.number().int().nonnegative(),
  createdAt: z.string(),
})
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

  private readonly config: Required<Omit<Config, 'dshHome'>>
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
  private readonly listeners = new Set<() => void>()
  private readonly lifetime = new AbortController()

  /** @param ctx - Host with embedding models and the Hub sign-in. @param config - storage and chunking options. */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'knowledgeBases', { namespace: 'knowledgeBases' })
    const resolved = Config(config) as Required<Omit<Config, 'dshHome'>> & Pick<Config, 'dshHome'>
    this.config = resolved
    this.root = join(resolveDshHome(resolved.dshHome), 'knowledge')
    ctx.embedding.registerUsage(id => this.users(id))
    ctx.effect(() => () => {
      this.lifetime.abort()
      this.job?.controller.abort()
      this.closeBases()
      this.changed()
    }, 'knowledge-base: lifetime')
  }

  async [Service.init](): Promise<void> {
    this.embedding = await this.ctx.embedding.getState()
    await this.switchTenant((await this.ctx.hubAccount.getState()).profile?.tenantId ?? null)
    void (async () => {
      for await (const state of this.ctx.hubAccount.watch(this.lifetime.signal)) {
        const tenantId = state.profile?.tenantId ?? null
        if (tenantId !== this.tenantId) await this.serialized(() => this.switchTenant(tenantId))
      }
    })()
    void (async () => {
      for await (const state of this.ctx.embedding.watch(this.lifetime.signal)) {
        this.embedding = state
        this.changed()
        this.kick()
      }
    })()
  }

  /**
   * Read the signed-in tenant's knowledge bases with their items.
   * @returns the state the Knowledge page shows.
   */
  @Remote
  getState(): Promise<KnowledgeState> {
    return Promise.resolve({ tenantId: this.tenantId, bases: [...this.bases.values()].map(base => this.view(base)) })
  }

  /**
   * Stream the state.
   * @param signal - stream lifetime.
   * @returns the current state, then every change.
   */
  @Remote({ mode: 'stream' })
  async *watch(signal: AbortSignal): AsyncIterable<KnowledgeState> {
    let dirty = true
    let wake: (() => void) | undefined
    const changed = (): void => { dirty = true; wake?.() }
    this.listeners.add(changed)
    signal.addEventListener('abort', changed, { once: true })
    try {
      while (!this.lifetime.signal.aborted && !signal.aborted) {
        if (dirty) { dirty = false; yield await this.getState(); continue }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      this.listeners.delete(changed)
      signal.removeEventListener('abort', changed)
    }
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
      const embedding = await this.ctx.embedding.getState()
      const offered = (embedding.local.status !== 'unsupported' && embedding.local.id === embeddingModelId)
        || embedding.apiModels.some(model => model.id === embeddingModelId)
      if (!offered) throw new RemoteError('knowledge/embedding-model-unavailable', `embedding model ${embeddingModelId} is not available`, { id: embeddingModelId })
      const id = randomUUID()
      const settings: BaseSettings = {
        version: 1, id, name: trimmed, embeddingModelId,
        chunkSize: this.config.chunkSize, chunkOverlap: Math.min(this.config.chunkOverlap, this.config.chunkSize - 1),
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
   * Delete a knowledge base with its files and index.
   * @param id - knowledge base id.
   * @returns the state without it.
   * @throws RemoteError `knowledge/not-found`.
   */
  @Remote
  deleteBase(id: string): Promise<KnowledgeState> {
    return this.serialized(async () => {
      const base = this.base(id)
      await this.stopJob(job => job.baseId === id)
      base.store.close()
      this.bases.delete(id)
      await rm(base.dir, { recursive: true, force: true })
      this.changed()
      this.kick()
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
          await copyFile(path, this.filePath(base, itemId, name))
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
   * Process an item again from its stored copy.
   * @param id - knowledge base id.
   * @param itemId - item id.
   * @returns the state with the item pending.
   * @throws RemoteError `knowledge/not-found`.
   */
  @Remote
  reprocessItem(id: string, itemId: string): Promise<KnowledgeState> {
    return this.serialized(async () => {
      const base = this.base(id)
      this.item(base, itemId)
      await this.stopJob(job => job.itemId === itemId)
      base.store.setStatus(itemId, 'pending', null)
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
      const item = this.item(base, itemId)
      await this.stopJob(job => job.itemId === itemId)
      base.store.deleteItem(itemId)
      await rm(this.filePath(base, itemId, item.name), { force: true })
      this.changed()
      this.kick()
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
   * @throws RemoteError `knowledge/not-found`, or the embedding model's failure.
   */
  async search(id: string, query: string, options: { limit: number; threshold: number }, signal?: AbortSignal): Promise<SearchHit[]> {
    const base = this.base(id)
    // One text in, one vector out.
    const [vector] = await this.ctx.embedding.embed(base.settings.embeddingModelId, [query], signal) as [number[]]
    // The base may have been deleted, or the tenant switched, while the query was embedding.
    if (this.bases.get(id) !== base) throw new RemoteError('knowledge/not-found', `no knowledge base ${id}`, { id })
    return base.store.search(vector, query, options.limit, options.threshold)
  }

  private changed(): void { for (const listener of this.listeners) listener() }

  /** Run state changes one at a time, so a tenant switch never interleaves with an edit. */
  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const run = this.writes.then(work)
    this.writes = run.catch(() => undefined)
    return run
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

  private filePath(base: OpenBase, itemId: string, name: string): string {
    return join(base.dir, 'files', `${itemId}${extname(name).toLowerCase()}`)
  }

  private async writeSettings(dir: string, settings: BaseSettings): Promise<void> {
    const path = join(dir, 'base.json')
    await writeFile(`${path}.tmp`, JSON.stringify(settings, null, 2))
    await rename(`${path}.tmp`, path)
  }

  private modelReady(modelId: string): boolean {
    if (modelId !== this.embedding?.local.id) return true
    return this.embedding.local.status === 'installed'
  }

  private view(base: OpenBase): KnowledgeBaseView {
    const { id, name, embeddingModelId, createdAt } = base.settings
    const local = this.embedding?.local
    const api = this.embedding?.apiModels.find(model => model.id === embeddingModelId)
    const embeddingModelName = local?.id === embeddingModelId ? local.name : api?.model ?? embeddingModelId
    return {
      id, name, embeddingModelId, embeddingModelName, createdAt,
      status: this.modelReady(embeddingModelId) ? 'ready' : 'unavailable',
      items: base.store.items().map(item => ({ ...item, kind: 'file' as const })),
    }
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
      await this.process(next.base, next.itemId, next.name)
    }
  }

  private nextItem(): { base: OpenBase; itemId: string; name: string } | undefined {
    for (const base of this.bases.values()) {
      if (!this.modelReady(base.settings.embeddingModelId)) continue
      const item = base.store.items().find(entry => entry.status === 'pending')
      if (item !== undefined) return { base, itemId: item.id, name: item.name }
    }
    return undefined
  }

  private async process(base: OpenBase, itemId: string, name: string): Promise<void> {
    const controller = new AbortController()
    const job: Job = { baseId: base.settings.id, itemId, controller }
    this.job = job
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal])
    base.store.setStatus(itemId, 'processing', null)
    this.changed()
    const fail = (error: KnowledgeItemError, detail: unknown): void => {
      console.info('[knowledge-base] item failed', { error, detail: String(detail) })
      base.store.setStatus(itemId, 'failed', error)
    }
    try {
      await this.processSteps(base, itemId, name, signal, fail)
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
      this.changed()
    }
  }

  /** Read, chunk, embed, and index one item; expected failures are recorded through `fail`. */
  private async processSteps(
    base: OpenBase, itemId: string, name: string, signal: AbortSignal,
    fail: (error: KnowledgeItemError, detail: unknown) => void,
  ): Promise<void> {
    let text: string
    try {
      text = await readDocument(this.filePath(base, itemId, name))
    } catch (error) {
      fail('unreadable', error)
      return
    }
    const chunks = chunkText(text, base.settings.chunkSize, base.settings.chunkOverlap)
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
      if (signal.aborted) return
      fail('embedding', error)
      return
    }
    base.store.complete(itemId, embedded)
  }
}

export default KnowledgeBaseService
