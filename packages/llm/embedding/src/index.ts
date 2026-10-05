/**
 * Embedding models for Desktop knowledge bases, behind one Host service and the `embedding`
 * Remote namespace:
 *
 * - The **local embedding model** (Qwen3-Embedding-0.6B by default) and the onnxruntime-node
 *   runtime that runs it are not shipped. At startup the service checks them and, when missing,
 *   downloads them in the background: model files from the configured mirrors in order
 *   (ModelScope, then HuggingFace), the runtime as npm tarballs (npmmirror, then npmjs), each
 *   resumable and verified by size and sha256. A download can be paused, resumed, and deleted.
 * - **API embedding models** reuse a provider route configured under Settings → Models whose
 *   endpoint speaks an OpenAI protocol; adding one measures its vector size with one request.
 *
 * Host consumers embed text with {@link EmbeddingService.embed}; credentials never leave the Host.
 *
 * @module @deepseek-ai/dsh-embedding
 */

import { rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Context, Service, type Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import Schema from '@deepseek-ai/schemastery'
import { OPENAI_PROTOCOLS, requestEmbeddings } from './api.ts'
import { ONNX_RUNTIME, QWEN3_EMBEDDING } from './catalog.ts'
import { bytesOnDisk, DownloadError, downloadFile, sha256File } from './download.ts'
import { loadEmbedder, type LocalEmbedder } from './embedder.ts'
import { installRuntime, loadRuntime, platformKey, runtimeInstalled } from './runtime.ts'
import type {
  ApiEmbeddingModelView, EmbeddingProviderView, EmbeddingState, LocalModelError, LocalModelStatus, LocalModelView,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Embedding models: the local model's install state, API embedding models, and `embed()`. */
    embedding: EmbeddingService
  }
}

/** One file of the local model. */
export interface LocalModelFile {
  /** Path inside the model repository and the install directory. */
  path: string
  /** Size in bytes. */
  size: number
  /** Lowercase hex sha256. */
  sha256: string
}

/** The local embedding model: a decoder-only ONNX export with a Hugging Face tokenizer. */
export interface LocalModelSpec {
  /** Embedding model id; starts with `local/`. */
  id: string
  /** Display name. */
  name: string
  /** Repository the mirrors serve it under. */
  repo: string
  /** Path of the ONNX weights among {@link files}. */
  weights: string
  /** Longest token sequence fed to the model. */
  maxTokens: number
  /** Every file the model needs, each verified by size and sha256. */
  files: LocalModelFile[]
}

/** One npm tarball of the runtime. */
export interface RuntimePackage {
  /** npm package name. */
  name: string
  /** Tarball size. */
  size: number
  /** Tarball sha256, lowercase hex. */
  sha256: string
}

/** The onnxruntime-node runtime. */
export interface RuntimeSpec {
  /** Version shared by its packages. */
  version: string
  /** `<platform>-<arch>` keys it has native builds for. */
  platforms: string[]
  /** The npm tarballs to install. */
  packages: RuntimePackage[]
}

/** An API embedding model as stored in the user's settings. */
export interface StoredApiModel {
  /** Provider route key. */
  provider: string
  /** Model id on the provider. */
  model: string
  /** Vector size measured when it was added. */
  dimensions: number
}

/** Plugin configuration. */
export interface Config {
  /** DeepSeek Harness home; models live under `<dshHome>/models`. Defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string
  /** Download the local model at startup when it is missing. */
  autoDownload?: boolean
  /** Model file URL templates tried in order; `{repo}` and `{file}` are substituted. */
  modelMirrors?: string[]
  /** npm registry origins tried in order for the runtime tarballs. */
  npmRegistries?: string[]
  /** The local model. */
  localModel?: LocalModelSpec
  /** The runtime that runs it. */
  runtime?: RuntimeSpec
  /** API embedding models the user added; edited live through `addApiModel()` / `removeApiModel()`. */
  apiModels?: Volatile<readonly StoredApiModel[]>
  /** Deadline of each embedding API request. */
  requestTimeoutMs?: number
}

const sha256 = Schema.string().pattern(/^[0-9a-f]{64}$/u).required()
const file = Schema.object({ path: Schema.string().required(), size: Schema.natural().required(), sha256 })

/** Validated plugin configuration. */
export const Config = Schema.object({
  dshHome: Schema.string(),
  autoDownload: Schema.boolean().default(true),
  modelMirrors: Schema.array(Schema.string()).default([
    'https://www.modelscope.cn/models/{repo}/resolve/master/{file}',
    'https://huggingface.co/{repo}/resolve/main/{file}',
  ]),
  npmRegistries: Schema.array(Schema.string()).default(['https://registry.npmmirror.com', 'https://registry.npmjs.org']),
  localModel: Schema.object({
    id: Schema.string().pattern(/^local\/[\w.-]+$/u).required(),
    name: Schema.string().required(),
    repo: Schema.string().required(),
    weights: Schema.string().required(),
    maxTokens: Schema.natural().min(2).required(),
    files: Schema.array(file).required(),
  }).default(QWEN3_EMBEDDING),
  runtime: Schema.object({
    version: Schema.string().required(),
    platforms: Schema.array(Schema.string()).required(),
    packages: Schema.array(Schema.object({ name: Schema.string().required(), size: Schema.natural().required(), sha256 })).required(),
  }).default(ONNX_RUNTIME),
  apiModels: Schema.array(Schema.object({
    provider: Schema.string().required(), model: Schema.string().required(), dimensions: Schema.natural().required(),
  }))
    .default([]).volatile()
    .description('API embedding models added under Settings → Embedding models, each served by a configured provider route.'),
  requestTimeoutMs: Schema.number().min(1).max(600_000).default(30_000),
}) as Schema<Config>

/** Progress frames are published at most this often while bytes stream in. */
const PROGRESS_INTERVAL_MS = 250

/** Host owner of the embedding models and of the `embedding` Remote namespace. */
export class EmbeddingService extends TypertRemoteService {
  static inject = ['llm']
  static Config = Config

  private readonly config: Required<Omit<Config, 'dshHome' | 'apiModels'>>
  private readonly apiModels: Volatile<readonly StoredApiModel[]> | undefined
  private readonly entryId: string | undefined
  private readonly modelDir: string
  private readonly runtimeDir: string
  private status: LocalModelStatus = 'missing'
  private error: LocalModelError | null = null
  private received = 0
  private dimensions: number | null = null
  private download: AbortController | undefined
  private running: Promise<void> | undefined
  private embedder: Promise<LocalEmbedder> | undefined
  private progressTimer: ReturnType<typeof setTimeout> | undefined
  private apiWrites: Promise<void> = Promise.resolve()
  private readonly usages = new Set<(id: string) => Promise<readonly string[]>>()
  private readonly listeners = new Set<() => void>()
  private readonly lifetime = new AbortController()

  /** @param ctx - Host with the model router. @param config - model sources and stored API models. */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'embedding', { namespace: 'embedding' })
    // The live API model list arrives as a Volatile handle; the schema validates the rest.
    const { apiModels, ...rest } = config
    const resolved = Config(rest)
    this.config = resolved as Required<Omit<Config, 'dshHome' | 'apiModels'>>
    this.apiModels = apiModels
    this.entryId = ctx.fiber.entry?.options.id
    const home = resolveDshHome(resolved.dshHome)
    this.modelDir = join(home, 'models', 'embedding', this.config.localModel.id.slice('local/'.length))
    this.runtimeDir = join(home, 'models', 'runtime', `onnxruntime-${this.config.runtime.version}`)
    ctx.on('loader/volatile-update', () => { this.changed() })
    ctx.effect(() => () => {
      this.lifetime.abort()
      this.download?.abort()
      clearTimeout(this.progressTimer)
      this.changed()
    }, 'embedding: lifetime')
  }

  async [Service.init](): Promise<void> {
    if (!this.config.runtime.platforms.includes(platformKey())) {
      this.status = 'unsupported'
      return
    }
    this.received = await this.bytesReceived()
    if (await this.localInstalled()) {
      this.status = 'installed'
      void this.warmUp()
    } else if (await this.wrongSizeFile() !== undefined) {
      this.status = 'damaged'
    } else if (this.config.autoDownload) {
      void this.startDownload()
    }
  }

  /**
   * Read the local model's install state and the API embedding models.
   * @returns the state Settings → Embedding models shows.
   */
  @Remote
  getState(): Promise<EmbeddingState> {
    return Promise.resolve({ local: this.localView(), apiModels: this.apiModelViews() })
  }

  /**
   * Stream the state.
   * @param signal - stream lifetime.
   * @returns the current state, then every change; download progress at most four times a second.
   */
  @Remote({ mode: 'stream' })
  async *watch(signal: AbortSignal): AsyncIterable<EmbeddingState> {
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
   * Pause the local model download; partial files are kept.
   * @returns the state once the transfer has stopped.
   */
  @Remote
  async pauseDownload(): Promise<EmbeddingState> {
    if (this.status === 'downloading') {
      this.download?.abort('paused')
      await this.running
    }
    return this.getState()
  }

  /**
   * Start, resume, retry, or repair the local model download. Repairing first checks every
   * installed file's sha256 and downloads again the ones that do not match.
   * @returns the state with the download running.
   * @throws RemoteError `embedding/local-model-unavailable` on a platform the runtime does not support.
   */
  @Remote
  async startDownload(): Promise<EmbeddingState> {
    if (this.status === 'unsupported') throw new RemoteError('embedding/local-model-unavailable', 'this platform cannot run the local embedding model', {})
    if (this.status !== 'downloading' && this.status !== 'installed') this.running = this.run(this.status === 'damaged')
    return this.getState()
  }

  /**
   * Delete the local model's files; the next startup downloads them again. The runtime stays:
   * once loaded, its native library cannot be deleted on Windows.
   * @returns the state.
   */
  @Remote
  async removeLocalModel(): Promise<EmbeddingState> {
    if (this.status === 'unsupported') return this.getState()
    await this.assertUnused(this.config.localModel.id)
    this.download?.abort('removed')
    await this.running
    this.embedder = undefined
    this.dimensions = null
    await rm(this.modelDir, { recursive: true, force: true })
    this.received = await this.bytesReceived()
    this.setLocal('missing', null)
    return this.getState()
  }

  /**
   * Configured provider routes that can serve API embedding models: those with an OpenAI-protocol endpoint.
   * @returns the routes, in directory order.
   */
  @Remote
  listProviders(): Promise<EmbeddingProviderView[]> {
    return Promise.resolve(this.ctx.llm.listConfigurableProviders()
      .filter(entry => this.endpoint(entry.provider) !== undefined)
      .map(entry => ({ provider: entry.provider, displayName: entry.displayName })))
  }

  /**
   * Add an API embedding model after measuring its vector size with one request.
   * @param provider - configured provider route.
   * @param model - model id on the provider.
   * @returns the state with the model added.
   * @throws RemoteError `embedding/duplicate-model`, `embedding/provider-unavailable`, or `embedding/request-failed`.
   */
  @Remote
  async addApiModel(provider: string, model: string): Promise<EmbeddingState> {
    const name = model.trim()
    const id = `${provider}/${name}`
    if (this.storedApiModels().some(entry => `${entry.provider}/${entry.model}` === id)) {
      throw new RemoteError('embedding/duplicate-model', `the embedding model ${id} is already added`, { id })
    }
    const endpoint = this.endpoint(provider)
    if (endpoint === undefined || name.length === 0) {
      throw new RemoteError('embedding/provider-unavailable', `provider ${provider} has no configured OpenAI-compatible endpoint`, { provider })
    }
    const vectors = await requestEmbeddings(endpoint, name, ['dimension probe'], this.requestSignal())
    // One input, one vector: its length is the model's vector size.
    const dimensions = Math.max(...vectors.map(vector => vector.length))
    // Checked again inside the serialized write: an overlapping add of the same model may have landed meanwhile.
    await this.writeApiModels((current) => {
      if (current.some(entry => `${entry.provider}/${entry.model}` === id)) {
        throw new RemoteError('embedding/duplicate-model', `the embedding model ${id} is already added`, { id })
      }
      return [...current, { provider, model: name, dimensions }]
    })
    return this.getState()
  }

  /**
   * Remove an API embedding model.
   * @param id - `<provider>/<model>`.
   * @returns the state without it.
   * @throws RemoteError `embedding/model-not-found` when no API model has this id, `embedding/model-in-use` while something uses it.
   */
  @Remote
  async removeApiModel(id: string): Promise<EmbeddingState> {
    if (!this.storedApiModels().some(entry => `${entry.provider}/${entry.model}` === id)) {
      throw new RemoteError('embedding/model-not-found', `no embedding model ${id}`, { id })
    }
    await this.assertUnused(id)
    await this.writeApiModels(current => current.filter(entry => `${entry.provider}/${entry.model}` !== id))
    return this.getState()
  }

  /**
   * Declare a user of embedding models: while it names users of a model, that model cannot be removed. Host only;
   * withdrawn with the caller's fiber.
   * @param usage - names of what uses an embedding model id, empty when nothing does.
   */
  registerUsage(usage: (id: string) => Promise<readonly string[]>): void {
    this.ctx.effect(() => {
      this.usages.add(usage)
      return () => { this.usages.delete(usage) }
    }, 'embedding.registerUsage()')
  }

  /**
   * Embed texts with one embedding model. Host only.
   * @param id - the local model's id, or an API model's `<provider>/<model>`.
   * @param texts - inputs, in order.
   * @param signal - cancels the work.
   * @returns one vector per text, in input order.
   * @throws RemoteError `embedding/model-not-found`, `embedding/local-model-unavailable`,
   *   `embedding/provider-unavailable`, or `embedding/request-failed`.
   */
  async embed(id: string, texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    if (id === this.config.localModel.id) {
      if (this.status !== 'installed') throw new RemoteError('embedding/local-model-unavailable', 'the local embedding model is not installed', {})
      return (await this.localEmbedder()).embed(texts, signal)
    }
    const stored = this.storedApiModels().find(entry => `${entry.provider}/${entry.model}` === id)
    if (stored === undefined) throw new RemoteError('embedding/model-not-found', `no embedding model ${id}`, { id })
    const endpoint = this.endpoint(stored.provider)
    if (endpoint === undefined) {
      throw new RemoteError('embedding/provider-unavailable', `provider ${stored.provider} has no configured OpenAI-compatible endpoint`, { provider: stored.provider })
    }
    return requestEmbeddings(endpoint, stored.model, texts, this.requestSignal(signal))
  }

  private changed(): void { for (const listener of this.listeners) listener() }

  private async assertUnused(id: string): Promise<void> {
    const users = (await Promise.all([...this.usages].map(usage => usage(id)))).flat()
    if (users.length > 0) {
      throw new RemoteError('embedding/model-in-use', `the embedding model ${id} is used by ${String(users.length)} knowledge base(s)`, { id, users })
    }
  }

  private setLocal(status: LocalModelStatus, error: LocalModelError | null): void {
    this.status = status
    this.error = error
    clearTimeout(this.progressTimer)
    this.progressTimer = undefined
    this.changed()
  }

  private addBytes(bytes: number): void {
    this.received += bytes
    this.progressTimer ??= setTimeout(() => { this.progressTimer = undefined; this.changed() }, PROGRESS_INTERVAL_MS)
  }

  private totalBytes(): number {
    return [...this.config.localModel.files, ...this.config.runtime.packages].reduce((sum, item) => sum + item.size, 0)
  }

  private localView(): LocalModelView {
    const { id, name } = this.config.localModel
    return {
      id, name, status: this.status, receivedBytes: this.received, totalBytes: this.totalBytes(),
      dimensions: this.dimensions, error: this.error,
    }
  }

  private storedApiModels(): readonly StoredApiModel[] {
    // Every mount passes the Volatile handle; the optional type comes from the Config interface.
    /* v8 ignore next */
    return this.apiModels?.get() ?? []
  }

  private apiModelViews(): ApiEmbeddingModelView[] {
    const names = new Map(this.ctx.llm.listConfigurableProviders().map(entry => [entry.provider, entry.displayName]))
    return this.storedApiModels().map(entry => ({
      id: `${entry.provider}/${entry.model}`, provider: entry.provider, providerName: names.get(entry.provider) ?? entry.provider,
      model: entry.model, dimensions: entry.dimensions, available: this.endpoint(entry.provider) !== undefined,
    }))
  }

  private endpoint(provider: string) {
    const endpoint = this.ctx.llm.routeEndpoint(provider)
    return endpoint !== undefined && OPENAI_PROTOCOLS.has(endpoint.api) ? endpoint : undefined
  }

  private requestSignal(signal?: AbortSignal): AbortSignal {
    const deadline = AbortSignal.timeout(this.config.requestTimeoutMs)
    return AbortSignal.any([this.lifetime.signal, deadline, ...signal === undefined ? [] : [signal]])
  }

  private writeApiModels(update: (current: readonly StoredApiModel[]) => StoredApiModel[]): Promise<void> {
    const write = this.apiWrites.then(async () => {
      const settings = this.ctx.get('settings')
      if (settings === undefined || this.entryId === undefined) throw new Error('editing API embedding models requires the settings service and a profile entry')
      await settings.update(this.entryId, { apiModels: update(this.storedApiModels()) })
    })
    this.apiWrites = write.catch(() => undefined)
    return write
  }

  private modelPath(path: string): string { return join(this.modelDir, path) }

  private tarballPath(name: string): string { return join(this.runtimeDir, 'downloads', `${name}-${this.config.runtime.version}.tgz`) }

  /** Bytes already downloaded, counting an installed runtime package as its whole tarball. */
  private async bytesReceived(): Promise<number> {
    let total = 0
    for (const item of this.config.localModel.files) total += await bytesOnDisk(this.modelPath(item.path))
    const runtimeDone = await runtimeInstalled(this.runtimeDir, this.config.runtime)
    for (const pkg of this.config.runtime.packages) total += runtimeDone ? pkg.size : await bytesOnDisk(this.tarballPath(pkg.name))
    return total
  }

  private async localInstalled(): Promise<boolean> {
    if (!await runtimeInstalled(this.runtimeDir, this.config.runtime)) return false
    for (const item of this.config.localModel.files) {
      if ((await stat(this.modelPath(item.path)).catch(() => undefined))?.size !== item.size) return false
    }
    return true
  }

  /** A finished model file whose size is not the expected one. */
  private async wrongSizeFile(): Promise<string | undefined> {
    for (const item of this.config.localModel.files) {
      const size = (await stat(this.modelPath(item.path)).catch(() => undefined))?.size
      if (size !== undefined && size !== item.size) return item.path
    }
    return undefined
  }

  /** Download whatever is missing; when repairing, first drop finished files that fail verification. */
  private async run(repair: boolean): Promise<void> {
    const controller = new AbortController()
    this.download = controller
    this.embedder = undefined
    this.setLocal('downloading', null)
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal])
    try {
      if (repair) {
        for (const item of this.config.localModel.files) {
          const path = this.modelPath(item.path)
          const present = (await stat(path).catch(() => undefined)) !== undefined
          if (present && await sha256File(path) !== item.sha256) await rm(path, { force: true })
        }
        this.received = await this.bytesReceived()
        this.changed()
      }
      const onBytes = (bytes: number): void => { this.addBytes(bytes) }
      await installRuntime(this.runtimeDir, this.config.runtime, this.config.npmRegistries, onBytes, signal)
      for (const item of this.config.localModel.files) {
        const dest = this.modelPath(item.path)
        if ((await stat(dest).catch(() => undefined))?.size === item.size) continue
        const urls = this.config.modelMirrors.map(template => template.replace('{repo}', this.config.localModel.repo).replace('{file}', item.path))
        await downloadFile({ urls, dest, size: item.size, sha256: item.sha256 }, onBytes, signal)
      }
      this.download = undefined
      this.setLocal('installed', null)
      void this.warmUp()
    } catch (error) {
      this.download = undefined
      if (this.lifetime.signal.aborted || controller.signal.reason === 'removed') return
      if (controller.signal.aborted) { this.setLocal('paused', null); return }
      const code = error instanceof DownloadError ? error.code : 'storage'
      console.info('[embedding] local model download failed', { errorCode: code, error: String(error) })
      this.received = await this.bytesReceived()
      this.setLocal('failed', code)
    }
  }

  private localEmbedder(): Promise<LocalEmbedder> {
    const { weights, maxTokens } = this.config.localModel
    this.embedder ??= loadEmbedder(loadRuntime(this.runtimeDir), this.modelDir, weights, maxTokens)
    return this.embedder
  }

  /**
   * Load the installed model once, learning its vector size; a model that does not load is damaged.
   * A deletion or a new download while it loads makes the outcome moot.
   */
  private async warmUp(): Promise<void> {
    const loading = this.localEmbedder()
    try {
      const { dimensions } = await loading
      if (this.embedder !== loading) return
      this.dimensions = dimensions
      this.changed()
    } catch (error) {
      if (this.embedder !== loading) return
      console.info('[embedding] local model does not load', { error: String(error) })
      this.embedder = undefined
      this.setLocal('damaged', null)
    }
  }
}

export default EmbeddingService
