/**
 * Connectors for Desktop, behind one Host service and the `connectors` Remote namespace. A
 * connector links DSH to an office platform through that platform's unmodified official CLI.
 * Feishu is supported and DingTalk is listed as coming soon.
 *
 * Installing a connector downloads the CLI version pinned by this release from the configured
 * mirrors in order, verifies the archive by size and sha256, unpacks only the executable, and
 * checks that it runs, into `<dshHome>/connectors/<id>/<version>`. One CLI serves every tenant
 * of the machine; nothing is installed globally, and a CLI the user installed themselves is never
 * read or changed. Uninstalling deletes the connector's directory.
 *
 * @module @deepseek-ai/dsh-connectors
 */

import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { bytesOnDisk } from '@deepseek-ai/dsh-verified-download'
import Schema from '@deepseek-ai/schemastery'
import { LARK_CLI } from './catalog.ts'
import { cliInstalled, installCli, platformKey, type InstallError } from './install.ts'
import type { ConnectorId, ConnectorInstallError, ConnectorsState, ConnectorStatus, ConnectorView } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Built-in connectors and the install state of their CLIs. */
    connectors: ConnectorsService
  }
}

/** One platform's archive of a CLI release. */
export interface CliArchive {
  /** `<platform>-<arch>` of the process that runs it, as Node names them. */
  platform: string
  /** Archive file name; `.zip` or `.tar.gz`. */
  file: string
  /** Size in bytes. */
  size: number
  /** Lowercase hex sha256. */
  sha256: string
}

/** A connector CLI pinned to one release. */
export interface CliSpec {
  /** Executable name inside the archive, without `.exe`. */
  binary: string
  /** Version installed; `--version` must report it. */
  version: string
  /** Archive URL templates tried in order; `{version}` and `{file}` are substituted. */
  mirrors: string[]
  /** One archive per supported platform. */
  archives: CliArchive[]
}

/** Plugin configuration. */
export interface Config {
  /** DeepSeek Harness home; connector CLIs live under `<dshHome>/connectors`. Defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string
  /** The Feishu CLI. */
  feishu?: CliSpec
}

const cliSpec = Schema.object({
  binary: Schema.string().required(),
  version: Schema.string().required(),
  mirrors: Schema.array(Schema.string()).required(),
  archives: Schema.array(Schema.object({
    platform: Schema.string().required(),
    file: Schema.string().pattern(/\.(?:zip|tar\.gz)$/u).required(),
    size: Schema.natural().required(),
    sha256: Schema.string().pattern(/^[0-9a-f]{64}$/u).required(),
  })).required(),
})

/** Validated plugin configuration. */
export const Config = Schema.object({
  dshHome: Schema.string(),
  feishu: cliSpec.default(LARK_CLI),
}) as Schema<Config>

/** Progress frames are published at most this often while bytes stream in. */
const PROGRESS_INTERVAL_MS = 250

/** Display order of the connector cards. */
const ORDER: readonly ConnectorId[] = ['feishu', 'dingtalk']

/** A connector DSH supports, with its CLI's install state. */
interface Installable {
  readonly spec: CliSpec
  /** `<dshHome>/connectors/<id>`. */
  readonly root: string
  status: ConnectorStatus
  error: ConnectorInstallError | null
  received: number
  running: Promise<void> | undefined
  controller: AbortController | undefined
}

/** Host owner of the connectors and of the `connectors` Remote namespace. */
export class ConnectorsService extends TypertRemoteService {
  static Config = Config

  private readonly installables = new Map<ConnectorId, Installable>()
  private progressTimer: ReturnType<typeof setTimeout> | undefined
  private readonly listeners = new Set<() => void>()
  private readonly lifetime = new AbortController()

  /** @param ctx - Host context. @param config - home and pinned CLIs. */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'connectors', { namespace: 'connectors' })
    const resolved = Config(config) as Config & { feishu: CliSpec }
    const root = join(resolveDshHome(resolved.dshHome), 'connectors')
    this.installables.set('feishu', {
      spec: resolved.feishu, root: join(root, 'feishu'), status: 'not-installed', error: null, received: 0, running: undefined, controller: undefined,
    })
    ctx.effect(() => () => {
      this.lifetime.abort()
      for (const entry of this.installables.values()) entry.controller?.abort()
      clearTimeout(this.progressTimer)
      this.changed()
    }, 'connectors: lifetime')
  }

  async [Service.init](): Promise<void> {
    for (const entry of this.installables.values()) {
      if (this.archive(entry) !== undefined && await cliInstalled(this.versionDir(entry), entry.spec)) entry.status = 'disconnected'
    }
  }

  /**
   * Read every connector card.
   * @returns the connectors in display order.
   */
  @Remote
  getState(): Promise<ConnectorsState> {
    return Promise.resolve({ connectors: ORDER.map(id => this.view(id)) })
  }

  /**
   * Stream the state.
   * @param signal - stream lifetime.
   * @returns the current state, then every change; download progress at most four times a second.
   */
  @Remote({ mode: 'stream' })
  async *watch(signal: AbortSignal): AsyncIterable<ConnectorsState> {
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
   * Install a connector's CLI in the background; installing an installed or installing connector changes nothing.
   * @param id - the connector.
   * @returns the state with the install running.
   * @throws RemoteError `connectors/not-found` for an unknown id, `connectors/unavailable` when it cannot be installed here.
   */
  @Remote
  async installConnector(id: string): Promise<ConnectorsState> {
    const { entry, archive } = this.installable(id)
    if (entry.status === 'not-installed') entry.running = this.run(entry, archive)
    return this.getState()
  }

  /**
   * Stop a running install and delete the connector's CLI, downloads included.
   * @param id - the connector.
   * @returns the state with the connector not installed.
   * @throws RemoteError `connectors/not-found` for an unknown id, `connectors/unavailable` when it cannot be installed here.
   */
  @Remote
  async uninstallConnector(id: string): Promise<ConnectorsState> {
    const { entry } = this.installable(id)
    entry.controller?.abort('uninstalled')
    await entry.running
    await rm(entry.root, { recursive: true, force: true })
    entry.received = 0
    this.set(entry, 'not-installed', null)
    return this.getState()
  }

  /** A connector this platform can install, with its archive. */
  private installable(id: string): { entry: Installable; archive: CliArchive } {
    if (!ORDER.includes(id as ConnectorId)) throw new RemoteError('connectors/not-found', `no connector ${id}`, { id })
    const entry = this.installables.get(id as ConnectorId)
    const archive = entry === undefined ? undefined : this.archive(entry)
    if (entry === undefined || archive === undefined) {
      throw new RemoteError('connectors/unavailable', `the connector ${id} cannot be installed here`, { id })
    }
    return { entry, archive }
  }

  private view(id: ConnectorId): ConnectorView {
    const entry = this.installables.get(id)
    if (entry === undefined) return { id, status: 'coming-soon', cli: null, version: null, receivedBytes: 0, totalBytes: 0, error: null }
    const archive = this.archive(entry)
    return {
      id, status: archive === undefined ? 'unsupported' : entry.status, cli: entry.spec.binary, version: entry.spec.version,
      receivedBytes: entry.received, totalBytes: archive?.size ?? 0, error: entry.error,
    }
  }

  private archive(entry: Installable) {
    return entry.spec.archives.find(archive => archive.platform === platformKey())
  }

  private versionDir(entry: Installable): string { return join(entry.root, entry.spec.version) }

  private changed(): void { for (const listener of this.listeners) listener() }

  private set(entry: Installable, status: ConnectorStatus, error: ConnectorInstallError | null): void {
    entry.status = status
    entry.error = error
    clearTimeout(this.progressTimer)
    this.progressTimer = undefined
    this.changed()
  }

  private async run(entry: Installable, archive: CliArchive): Promise<void> {
    const controller = new AbortController()
    entry.controller = controller
    entry.received = 0
    this.set(entry, 'installing', null)
    const onBytes = (bytes: number): void => {
      entry.received += bytes
      this.progressTimer ??= setTimeout(() => { this.progressTimer = undefined; this.changed() }, PROGRESS_INTERVAL_MS)
    }
    try {
      // A download an earlier install left unfinished resumes, so progress starts from its bytes.
      entry.received = await bytesOnDisk(join(entry.root, 'downloads', archive.file))
      this.changed()
      await installCli(entry.root, entry.spec, archive, onBytes, AbortSignal.any([controller.signal, this.lifetime.signal]))
      this.set(entry, 'disconnected', null)
    } catch (error) {
      if (controller.signal.aborted || this.lifetime.signal.aborted) return
      // Unless aborted, installCli fails only with an InstallError.
      const { code } = error as InstallError
      console.info('[connectors] install failed', { connector: entry.spec.binary, errorCode: code, error: String(error) })
      entry.received = 0
      this.set(entry, 'not-installed', code)
    } finally {
      entry.controller = undefined
      entry.running = undefined
    }
  }
}

export default ConnectorsService
