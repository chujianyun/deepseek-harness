/**
 * Connectors for Desktop, behind one Host service and the `connectors` Remote namespace. A
 * connector links DSH to an office platform through that platform's unmodified official CLI.
 * Feishu is supported and DingTalk is listed as coming soon.
 *
 * Installing a connector downloads the CLI version pinned by this release from the configured
 * mirrors in order, verifies the archive by size and sha256, unpacks only the executable, and
 * checks that it runs, into `<dshHome>/connectors/<id>/<version>`. One CLI serves every tenant
 * of the machine; nothing is installed globally, and a CLI the user installed themselves is never
 * read or changed.
 *
 * The connection belongs to the tenant of the current Hub sign-in: each tenant signs in to the
 * platform with its own CLI directories under `<dshHome>/connectors/<id>/tenants/<tenantId>`.
 * Connecting runs the CLI's own agent sign-in (for Feishu, creating the tenant's app and then
 * authorizing the user), reporting each step's address; a health check of the sign-in decides the
 * connection's color at startup, on request, after a sign-in, and periodically. Disconnecting
 * deletes the tenant's sign-in; uninstalling deletes every tenant's and the CLI.
 *
 * While a connector is installed and enabled for the tenant, the model shell finds a `lark-cli`
 * script under `<dshHome>/connectors/<id>/bin/<tenantId>` ahead of `PATH`: connected, it runs the
 * installed CLI with the tenant's directories; otherwise it refuses and points to the Connectors
 * page. A bash call of `lark-cli` that fails triggers a health check. While connected, the Skills the CLI embeds
 * reach the model through the skill registry.
 *
 * @module @deepseek-ai/dsh-connectors
 */

import { readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service, type Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-hub-account'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-shell-env'
import type {} from '@deepseek-ai/dsh-skill'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { bytesOnDisk } from '@deepseek-ai/dsh-verified-download'
import Schema from '@deepseek-ai/schemastery'
import { LARK_CLI } from './catalog.ts'
import { cliInstalled, executableName, installCli, platformKey, type InstallError } from './install.ts'
import {
  checkHealth, cliEnv, LoginError, qrCode, removeTenant, runLoginStep, wrapperScript, writeWrapper,
  type Health, type LoginStep, type TenantCli, type WrapperMode,
} from './lark.ts'
import { classify, helpRiskReader, invocations, type Classification, type RiskReader } from './risk.ts'
import { ConnectorSkillProvider, type ConnectorSkill, type SkillSource } from './skills.ts'
import type {
  ConnectorId, ConnectorInstallError, ConnectorLoginError, ConnectorLoginView, ConnectorsState, ConnectorStatus, ConnectorView,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Built-in connectors, the install state of their CLIs, and the signed-in tenant's connections. */
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
  /** Time between periodic health checks of the connections, in milliseconds. */
  checkIntervalMs?: number
  /** Connectors switched off, as `<tenantId>/<id>`; edited live through `setEnabled()`. */
  disabled?: Volatile<readonly string[]>
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
  checkIntervalMs: Schema.natural().min(1000).default(30 * 60 * 1000),
  disabled: Schema.array(Schema.string()).default([]).volatile()
    .description('Connectors switched off, as `<tenantId>/<id>`. A switched-off connector stays signed in, but the model gets neither its Skills nor its CLI.'),
}) as Schema<Config>

/** The variable that names, one per line, the high-risk commands of a shell call the user approved, such as `drive +delete`. */
const CONFIRMED_KEY = 'DSH_CONNECTOR_CONFIRMED'

/** Longest command text an approval names. */
const APPROVAL_COMMAND_CHARS = 200

/**
 * The command of a bash call.
 * @param exec - a tool call.
 * @returns its command, or undefined for another tool.
 */
function bashCommand(exec: Pick<ToolExecution, 'name' | 'arguments'>): string | undefined {
  const command = (exec.arguments as { command?: unknown }).command
  return exec.name === 'bash' && typeof command === 'string' ? command : undefined
}

/**
 * The approval a bash call that writes through Feishu asks for: the audit reason names the
 * commands, and the user sees what will happen as them — with a warning for a high-risk command.
 * @param classification - the call's lark-cli commands and their highest risk.
 * @returns the pre-execution decision.
 */
function approvalAsk(classification: Classification): PreToolDecision {
  const listed = classification.invocations.filter(item => item.risk !== 'read').map(item => `lark-cli ${item.command}`.trim()).join('; ')
  const commands = listed.length > APPROVAL_COMMAND_CHARS ? `${listed.slice(0, APPROVAL_COMMAND_CHARS)}…` : listed
  const reason = `Feishu connector ${classification.risk} command: ${commands}`
  switch (classification.risk) {
    case 'high-risk-write':
      return {
        kind: 'ask', reason,
        displayReason: {
          en: `⚠️ High-risk operation: the Feishu connector will run ${commands} as you. It may delete data or make changes that cannot be undone. If you allow it, DSH adds --yes for this run.`,
          zh: `⚠️ 高风险操作：飞书连接器将以你的身份执行 ${commands}，可能删除数据或造成无法撤销的修改。同意后 DSH 会为本次执行加上 --yes。`,
        },
      }
    case 'unknown':
      return {
        kind: 'ask', reason,
        displayReason: {
          en: `The risk of this Feishu command cannot be determined, so it is confirmed like a write: ${commands}. Allow it to run as you once?`,
          zh: `无法确定这条飞书命令的风险，按写操作确认：${commands}。允许以你的身份执行一次吗？`,
        },
      }
    default:
      return {
        kind: 'ask', reason,
        displayReason: {
          en: `The Feishu connector will write as you: ${commands}. Allow it to run once?`,
          zh: `飞书连接器将以你的身份执行写操作：${commands}。允许执行一次吗？`,
        },
      }
  }
}

/** A failing command's check waits this long for more failures. */
const FAILURE_CHECK_DELAY_MS = 500

/** Progress frames are published at most this often while bytes stream in. */
const PROGRESS_INTERVAL_MS = 250

/** Display order of the connector cards. */
const ORDER: readonly ConnectorId[] = ['feishu', 'dingtalk']

/** The signed-in tenant's connection to one platform. */
interface Connection {
  state: 'disconnected' | 'connecting' | 'connected' | 'degraded'
  account: string | null
  problem: string | null
  login: ConnectorLoginView | null
  loginError: ConnectorLoginError | null
  /** Stops the sign-in under way. */
  controller: AbortController | undefined
  running: Promise<void> | undefined
  /** Grows with every tenant switch, sign-in, and disconnect, so a health check that started before one is dropped. */
  epoch: number
}

/** A connector DSH supports: its CLI's install state and the signed-in tenant's connection. */
interface Installable {
  readonly id: ConnectorId
  readonly spec: CliSpec
  /** `<dshHome>/connectors/<id>`. */
  readonly root: string
  install: 'not-installed' | 'installing' | 'installed'
  error: ConnectorInstallError | null
  received: number
  running: Promise<void> | undefined
  controller: AbortController | undefined
  connection: Connection
  /** The Skills the installed CLI embeds; empty until listed. */
  skills: readonly ConnectorSkill[]
  /** What the model shell's `lark-cli` was last written for, as `<tenantId>:<mode>`; undefined while it gets none. */
  wrapper: string | undefined
  /** Set while uninstalling: the connector is hidden from the model and refuses a new install until its files are gone. */
  removing: boolean
}

/** The tenant and script mode the model shell gets for one connector now, if any. */
interface Exposure {
  readonly tenant: string
  readonly mode: WrapperMode
}

function idle(epoch: number): Connection {
  return { state: 'disconnected', account: null, problem: null, login: null, loginError: null, controller: undefined, running: undefined, epoch }
}

/** Host owner of the connectors and of the `connectors` Remote namespace. */
export class ConnectorsService extends TypertRemoteService {
  static inject = ['hubAccount', 'skills', 'shellEnv']
  static Config = Config

  private readonly installables = new Map<ConnectorId, Installable>()
  private readonly checkIntervalMs: number
  private readonly disabled: Volatile<readonly string[]> | undefined
  private readonly entryId: string | undefined
  private provider: ConnectorSkillProvider | undefined
  /** Calls whose high-risk connector commands wait for, or have, the user's approval, with those commands one per line. */
  private readonly confirmed = new Map<ToolCallId, string>()
  /** Reads a command's stated risk from the installed CLI, per CLI. */
  private readonly riskReaders = new Map<string, RiskReader>()
  /** What the skill provider was last told about, so it is invalidated only on a change. */
  private skillKey = ''
  private writes: Promise<void> = Promise.resolve()
  private disabledWrites: Promise<void> = Promise.resolve()
  private failureTimer: ReturnType<typeof setTimeout> | undefined
  private tenantId: string | null = null
  private progressTimer: ReturnType<typeof setTimeout> | undefined
  private readonly listeners = new Set<() => void>()
  private readonly lifetime = new AbortController()

  /** @param ctx - Host context with the Hub sign-in. @param config - home, pinned CLIs, and the check interval. */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'connectors', { namespace: 'connectors' })
    // The live disabled list arrives as a Volatile handle; the schema validates the rest.
    const { disabled, ...rest } = config
    const resolved = Config(rest) as Config & { feishu: CliSpec; checkIntervalMs: number }
    this.checkIntervalMs = resolved.checkIntervalMs
    this.disabled = disabled
    this.entryId = ctx.fiber.entry?.options.id
    const root = join(resolveDshHome(resolved.dshHome), 'connectors')
    const feishu: Installable = {
      id: 'feishu', spec: resolved.feishu, root: join(root, 'feishu'), install: 'not-installed', error: null, received: 0,
      running: undefined, controller: undefined, connection: idle(0), skills: [], wrapper: undefined, removing: false,
    }
    this.installables.set('feishu', feishu)
    // Every layer: a preset's local Skill discovery must not replace the connectors' Skills with the user's own copies.
    ctx.skills.registerProvider((control) => {
      this.provider = new ConnectorSkillProvider(() => this.skillSources(), control)
      return this.provider
    }, { everyLayer: true })
    ctx.shellEnv.registerPath({ name: 'connectors-feishu', resolve: () => this.scriptDir(feishu) })
    ctx.on('loader/volatile-update', () => { this.changed() })
    // A bash call of a connector's CLI that fails may mean the sign-in broke: check it.
    ctx.on('tools/result', (exec, result) => {
      this.confirmed.delete(exec.callId)
      const command = bashCommand(exec)
      const found = command === undefined ? [] : invocations(command)
      if (found !== 'opaque' && found.length === 0) return
      const exitCode = result.isError ? null : (result.value as { exitCode?: unknown }).exitCode
      if (exitCode !== 0) this.failed(feishu)
    })
    // A bash call that would write through a connected connector waits for the user's approval.
    ctx.on('tools/pre-execute', async (exec, next) => {
      const decision = await next()
      const command = bashCommand(exec)
      if (decision.kind !== 'allow' || command === undefined || this.exposure(feishu)?.mode !== 'run') return decision
      const classification = await classify(command, this.riskReader(feishu))
      if (classification.risk === 'none' || classification.risk === 'read') return decision
      if (classification.risk === 'high-risk-write') {
        const risky = classification.invocations.filter(item => item.risk === 'high-risk-write').map(item => item.command)
        this.confirmed.set(exec.callId, risky.join('\n'))
      }
      return approvalAsk(classification)
    })
    ctx.shellEnv.register({
      name: 'connectors',
      variables: { [CONFIRMED_KEY]: { description: 'The high-risk connector commands, one per line, the user approved for this shell call.' } },
      resolve: (exec): Readonly<Partial<Record<typeof CONFIRMED_KEY, string>>> => {
        const commands = this.confirmed.get(exec.callId)
        return commands === undefined ? {} : { [CONFIRMED_KEY]: commands }
      },
    })
    ctx.effect(() => async () => {
      this.lifetime.abort()
      for (const entry of this.installables.values()) {
        entry.controller?.abort()
        entry.connection.controller?.abort()
      }
      clearTimeout(this.progressTimer)
      clearTimeout(this.failureTimer)
      this.changed()
      // A script write still under way would recreate files in a directory its owner is deleting.
      await this.writes
    }, 'connectors: lifetime')
  }

  async [Service.init](): Promise<void> {
    for (const entry of this.installables.values()) {
      if (this.archive(entry) !== undefined && await cliInstalled(this.versionDir(entry), entry.spec)) {
        entry.install = 'installed'
        void this.listSkills(entry)
      }
    }
    this.tenantId = (await this.ctx.hubAccount.getState()).profile?.tenantId ?? null
    void this.checkAll()
    void (async () => {
      for await (const state of this.ctx.hubAccount.watch(this.lifetime.signal)) {
        const tenantId = state.profile?.tenantId ?? null
        if (tenantId !== this.tenantId) await this.switchTenant(tenantId)
      }
    })()
    const timer = setInterval(() => { void this.checkAll() }, this.checkIntervalMs)
    timer.unref()
    this.ctx.effect(() => () => { clearInterval(timer) }, 'connectors: periodic check')
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
   * Install a connector's CLI in the background; installing an installed, installing, or uninstalling connector changes nothing.
   * @param id - the connector.
   * @returns the state with the install running.
   * @throws RemoteError `connectors/not-found` for an unknown id, `connectors/unavailable` when it cannot be installed here.
   */
  @Remote
  async installConnector(id: string): Promise<ConnectorsState> {
    const { entry, archive } = this.installable(id)
    if (entry.install === 'not-installed' && !entry.removing) entry.running = this.run(entry, archive)
    return this.getState()
  }

  /**
   * Stop a running install or sign-in, delete every tenant's sign-in, and delete the connector's CLI, downloads included.
   * @param id - the connector.
   * @returns the state with the connector not installed.
   * @throws RemoteError `connectors/not-found` for an unknown id, `connectors/unavailable` when it cannot be installed here.
   */
  @Remote
  async uninstallConnector(id: string): Promise<ConnectorsState> {
    const { entry } = this.installable(id)
    entry.removing = true
    entry.controller?.abort('uninstalled')
    await entry.running
    await this.stopLogin(entry)
    if (entry.install === 'installed') {
      for (const tenant of await readdir(join(entry.root, 'tenants')).catch(() => [])) await removeTenant(this.cliAt(entry, tenant))
    }
    this.changed()
    await this.writes
    await rm(entry.root, { recursive: true, force: true })
    entry.install = 'not-installed'
    entry.removing = false
    entry.received = 0
    entry.skills = []
    entry.error = null
    entry.connection = idle(entry.connection.epoch + 1)
    this.changed()
    return this.getState()
  }

  /**
   * Sign the current tenant in to the connector's platform in the background, through the CLI's own
   * agent sign-in; a sign-in under way or a connected connector changes nothing. A tenant without an
   * app first creates one, then the user authorizes; each step's address appears in the view's
   * `login` until the step ends. A failed or cancelled sign-in leaves no app it created behind.
   * @param id - the connector.
   * @returns the state with the sign-in started.
   * @throws RemoteError `connectors/not-found`, `connectors/unavailable`, `connectors/not-installed`, or `hub-account/signed-out`.
   */
  @Remote
  async connect(id: string): Promise<ConnectorsState> {
    const { entry } = this.installable(id)
    if (entry.install !== 'installed') throw new RemoteError('connectors/not-installed', `the connector ${id} is not installed`, { id })
    const tenant = this.requireTenant()
    const { connection } = entry
    if (connection.state === 'disconnected' || connection.state === 'degraded') {
      const controller = new AbortController()
      entry.connection = { ...idle(connection.epoch + 1), state: 'connecting', controller, login: { step: 'authorize', url: null, qrCode: null } }
      entry.connection.running = this.login(entry, this.cliAt(entry, tenant), controller)
      this.changed()
    }
    return this.getState()
  }

  /**
   * Cancel the sign-in under way; an app it created is deleted.
   * @param id - the connector.
   * @returns the state once the sign-in has stopped.
   * @throws RemoteError `connectors/not-found` or `connectors/unavailable`.
   */
  @Remote
  async cancelConnect(id: string): Promise<ConnectorsState> {
    const { entry } = this.installable(id)
    await this.stopLogin(entry)
    return this.getState()
  }

  /**
   * Sign the current tenant out of the connector's platform and delete its sign-in; the CLI stays.
   * @param id - the connector.
   * @returns the state with the connector disconnected.
   * @throws RemoteError `connectors/not-found`, `connectors/unavailable`, or `hub-account/signed-out`.
   */
  @Remote
  async disconnect(id: string): Promise<ConnectorsState> {
    const { entry } = this.installable(id)
    const tenant = this.requireTenant()
    await this.stopLogin(entry)
    entry.connection = idle(entry.connection.epoch + 1)
    if (entry.install === 'installed') await removeTenant(this.cliAt(entry, tenant))
    this.changed()
    return this.getState()
  }

  /**
   * Check every installed connector's connection now, as opening the Connectors page does.
   * @returns the state once the checks have finished.
   */
  @Remote
  async check(): Promise<ConnectorsState> {
    await this.checkAll()
    return this.getState()
  }

  /**
   * Switch a connector on or off for the current tenant, persisting the profile's list. A switched-off
   * connector stays signed in, but the model gets neither its Skills nor its CLI.
   * @param id - the connector.
   * @param enabled - whether the model may use it.
   * @returns the state once the setting is saved.
   * @throws RemoteError `connectors/not-found`, `connectors/unavailable`, or `hub-account/signed-out`;
   *   Error when mounted without Settings or a profile entry.
   */
  @Remote
  async setEnabled(id: string, enabled: boolean): Promise<ConnectorsState> {
    this.installable(id)
    const key = `${this.requireTenant()}/${id}`
    const write = this.disabledWrites.then(async () => {
      const current = this.disabledList()
      if (current.includes(key) !== enabled) return
      const settings = this.ctx.get('settings')
      if (settings === undefined || this.entryId === undefined) throw new Error('switching connectors requires the settings service and a profile entry')
      await settings.update(this.entryId, { disabled: enabled ? current.filter(item => item !== key) : [...current, key].sort() })
    })
    this.disabledWrites = write.catch(() => {})
    await write
    this.changed()
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

  private requireTenant(): string {
    if (this.tenantId === null) throw new RemoteError('hub-account/signed-out', 'sign in to use connectors', {})
    return this.tenantId
  }

  private view(id: ConnectorId): ConnectorView {
    const entry = this.installables.get(id)
    if (entry === undefined) {
      return {
        id, status: 'coming-soon', cli: null, version: null, receivedBytes: 0, totalBytes: 0, error: null,
        login: null, loginError: null, account: null, problem: null, enabled: true, skills: [],
      }
    }
    const archive = this.archive(entry)
    const { connection } = entry
    const status: ConnectorStatus = archive === undefined ? 'unsupported' : entry.install === 'installed' ? connection.state : entry.install
    return {
      id, status, cli: entry.spec.binary, version: entry.spec.version, receivedBytes: entry.received, totalBytes: archive?.size ?? 0,
      error: entry.error, login: status === 'connecting' ? connection.login : null, loginError: connection.loginError,
      account: status === 'connected' ? connection.account : null, problem: status === 'degraded' ? connection.problem : null,
      enabled: this.enabled(entry), skills: entry.skills,
    }
  }

  private disabledList(): readonly string[] {
    // Every mount passes the Volatile handle; the optional type comes from the Config interface.
    /* v8 ignore next */
    return this.disabled?.get() ?? []
  }

  /** Whether the current tenant leaves the connector on; signed out, nothing is switched off. */
  private enabled(entry: Installable): boolean {
    return this.tenantId === null || !this.disabledList().includes(`${this.tenantId}/${entry.id}`)
  }

  /** The tenant and script the model shell gets for a connector now: installed, signed in to the Hub, and switched on. */
  private exposure(entry: Installable): Exposure | undefined {
    if (entry.install !== 'installed' || entry.removing || this.tenantId === null || !this.enabled(entry)) return undefined
    const live = entry.connection.state === 'connected' || entry.connection.state === 'degraded'
    return { tenant: this.tenantId, mode: live ? 'run' : 'not-connected' }
  }

  /** The directory put ahead of the model shell's PATH for a connector, while it is exposed. */
  private scriptDir(entry: Installable): string | undefined {
    const exposure = this.exposure(entry)
    return exposure === undefined ? undefined : join(entry.root, 'bin', exposure.tenant)
  }

  /** The connectors whose Skills reach the model: exposed with a live connection. */
  private skillSources(): SkillSource[] {
    return [...this.installables.values()].flatMap((entry) => {
      const exposure = this.exposure(entry)
      return exposure?.mode === 'run'
        ? [{ source: `connector-${entry.id}`, version: entry.spec.version, cli: this.cliAt(entry, exposure.tenant) }]
        : []
    })
  }

  /** List the installed CLI's Skills for the card; the tenant-free catalog directory keeps tenants out of it. */
  private async listSkills(entry: Installable): Promise<void> {
    /* v8 ignore next -- the skill registry builds the provider synchronously inside registerProvider(). */
    if (this.provider === undefined) return
    const cli = { bin: join(this.versionDir(entry), executableName(entry.spec)), dir: join(entry.root, 'catalog') }
    const skills = await this.provider.skills({ source: `connector-${entry.id}`, version: entry.spec.version, cli })
    // An uninstall that finished meanwhile keeps the card empty.
    if (entry.install !== 'installed' || entry.removing) return
    entry.skills = skills
    this.changed()
  }

  /**
   * Bring the model shell's script and the Skill catalog in line with the connections. Runs after
   * every change; only an actual change writes or invalidates.
   */
  private sync(): void {
    const skillKey = JSON.stringify(this.skillSources().map(source => source.cli.dir))
    if (skillKey !== this.skillKey) {
      this.skillKey = skillKey
      this.provider?.invalidate()
    }
    for (const entry of this.installables.values()) {
      const exposure = this.exposure(entry)
      const wrapper = exposure === undefined ? undefined : `${exposure.tenant}:${exposure.mode}`
      if (wrapper === entry.wrapper) continue
      entry.wrapper = wrapper
      if (exposure === undefined) continue
      const logs = join(tmpdir(), 'dsh-connectors', entry.id, exposure.tenant, 'logs')
      const script = wrapperScript(this.cliAt(entry, exposure.tenant), exposure.mode, logs)
      this.writes = this.writes.then(() => writeWrapper(join(entry.root, 'bin', exposure.tenant), script))
        .catch((error: unknown) => { console.info('[connectors] could not write the lark-cli script', { error: String(error) }) })
    }
  }

  /** The stated-risk reader of a connector's installed CLI, created once per CLI version. */
  private riskReader(entry: Installable): RiskReader {
    const bin = join(this.versionDir(entry), executableName(entry.spec))
    let reader = this.riskReaders.get(bin)
    if (reader === undefined) {
      reader = helpRiskReader(bin, cliEnv({ bin, dir: join(entry.root, 'catalog') }))
      this.riskReaders.set(bin, reader)
    }
    return reader
  }

  /** A command of the connector's CLI failed: check the connection once the failures settle. */
  private failed(entry: Installable): void {
    clearTimeout(this.failureTimer)
    this.failureTimer = setTimeout(() => { void this.checkOne(entry) }, FAILURE_CHECK_DELAY_MS)
  }

  private archive(entry: Installable) {
    return entry.spec.archives.find(archive => archive.platform === platformKey())
  }

  private versionDir(entry: Installable): string { return join(entry.root, entry.spec.version) }

  private cliAt(entry: Installable, tenant: string): TenantCli {
    return { bin: join(this.versionDir(entry), executableName(entry.spec)), dir: join(entry.root, 'tenants', tenant) }
  }

  private changed(): void {
    for (const listener of this.listeners) listener()
    if (!this.lifetime.signal.aborted) this.sync()
  }

  private setInstall(entry: Installable, install: Installable['install'], error: ConnectorInstallError | null): void {
    entry.install = install
    entry.error = error
    clearTimeout(this.progressTimer)
    this.progressTimer = undefined
    this.changed()
  }

  private async run(entry: Installable, archive: CliArchive): Promise<void> {
    const controller = new AbortController()
    entry.controller = controller
    entry.received = 0
    this.setInstall(entry, 'installing', null)
    const onBytes = (bytes: number): void => {
      entry.received += bytes
      this.progressTimer ??= setTimeout(() => { this.progressTimer = undefined; this.changed() }, PROGRESS_INTERVAL_MS)
    }
    try {
      // A download an earlier install left unfinished resumes, so progress starts from its bytes.
      entry.received = await bytesOnDisk(join(entry.root, 'downloads', archive.file))
      this.changed()
      await installCli(entry.root, entry.spec, archive, onBytes, AbortSignal.any([controller.signal, this.lifetime.signal]))
      this.setInstall(entry, 'installed', null)
      void this.listSkills(entry)
      void this.checkOne(entry)
    } catch (error) {
      if (controller.signal.aborted || this.lifetime.signal.aborted) return
      // Unless aborted, installCli fails only with an InstallError.
      const { code } = error as InstallError
      console.info('[connectors] install failed', { connector: entry.spec.binary, errorCode: code, error: String(error) })
      entry.received = 0
      this.setInstall(entry, 'not-installed', code)
    } finally {
      entry.controller = undefined
      entry.running = undefined
    }
  }

  /** Stop the sign-in under way, waiting for its clean-up. */
  private async stopLogin(entry: Installable): Promise<void> {
    entry.connection.controller?.abort('cancelled')
    await entry.connection.running
  }

  private async switchTenant(tenantId: string | null): Promise<void> {
    // A connect() while a sign-in stops changes nothing, as the connection still reads `connecting`
    // until that sign-in settles, so no sign-in can start for the old tenant before the replacement.
    for (const entry of this.installables.values()) await this.stopLogin(entry)
    this.tenantId = tenantId
    for (const entry of this.installables.values()) entry.connection = idle(entry.connection.epoch + 1)
    this.changed()
    await this.checkAll()
  }

  private async checkAll(): Promise<void> {
    await Promise.all([...this.installables.values()].map(entry => this.checkOne(entry)))
  }

  /** Check the current tenant's connection, unless a sign-in is under way; a result outdated by then is dropped. */
  private async checkOne(entry: Installable): Promise<void> {
    if (entry.install !== 'installed' || this.tenantId === null || entry.connection.state === 'connecting') return
    const { epoch } = entry.connection
    let health: Health
    try {
      health = await checkHealth(this.cliAt(entry, this.tenantId), this.lifetime.signal)
    } catch {
      // Only the plugin's disposal stops a check.
      return
    }
    // A sign-in, disconnect, or tenant switch since the check started replaced the connection's epoch.
    if (entry.connection.epoch !== epoch) return
    this.apply(entry, health)
  }

  private apply(entry: Installable, health: Health): void {
    const { connection } = entry
    switch (health.kind) {
      case 'connected':
        Object.assign(connection, { state: 'connected', account: health.account, problem: null, loginError: null })
        break
      case 'degraded':
        Object.assign(connection, { state: 'degraded', account: null, problem: health.problem })
        break
      default:
        Object.assign(connection, { state: 'disconnected', account: null, problem: null })
    }
    this.changed()
  }

  /** One sign-in: create the tenant's app when it has none, authorize the user, then check the result. */
  private async login(entry: Installable, cli: TenantCli, controller: AbortController): Promise<void> {
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal])
    const connection = entry.connection
    let created = false
    try {
      const before = await checkHealth(cli, signal)
      if (before.kind === 'connected') {
        this.finish(entry, connection, before)
        return
      }
      if (before.kind === 'unconfigured') {
        created = true
        await this.step(cli, connection, 'create-app', signal)
      }
      await this.step(cli, connection, 'authorize', signal)
      this.finish(entry, connection, await checkHealth(cli, signal))
    } catch (error) {
      if (this.lifetime.signal.aborted) return
      // A sign-in that created the tenant's app and did not finish leaves nothing half done behind.
      if (created) await removeTenant(cli)
      const failure = error instanceof LoginError ? { step: error.step, message: error.message } : null
      if (failure !== null) console.info('[connectors] sign-in failed', { connector: entry.id, step: failure.step, error: failure.message })
      Object.assign(connection, { state: 'disconnected', login: null, loginError: failure, controller: undefined })
      this.changed()
    } finally {
      connection.running = undefined
    }
  }

  private finish(entry: Installable, connection: Connection, health: Health): void {
    Object.assign(connection, { login: null, controller: undefined, state: 'disconnected' })
    this.apply(entry, health)
  }

  /** Run one sign-in step, publishing its address and QR code as they become known. */
  private async step(cli: TenantCli, connection: Connection, step: LoginStep, signal: AbortSignal): Promise<void> {
    connection.login = { step, url: null, qrCode: null }
    this.changed()
    await runLoginStep(cli, step, (url) => {
      connection.login = { step, url, qrCode: null }
      this.changed()
      void qrCode(cli, url, signal).then((image) => {
        if (connection.login?.step !== step || connection.login.url !== url) return
        connection.login = { step, url, qrCode: image }
        this.changed()
      })
    }, signal)
  }
}

export default ConnectorsService
