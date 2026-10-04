/**
 * Skill Hub market for Desktop: the `market` skill source under
 * `<dshHome>/skills-market/<tenantId>/<name>/` (only the signed-in tenant's directory is discovered),
 * the `skillMarket` Remote that browses the Hub as the signed-in employee, and one-click install
 * that validates the downloaded package before it lands. Market Skills are switched off per tenant.
 *
 * @module @deepseek-ai/dsh-skill-market
 */

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, parse, relative, sep } from 'node:path'
import { Context, Service, type Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-hub-account'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import {
  isSkillName, type SkillCandidate, type SkillDefinition, type SkillInvocationPolicy, type SkillLookupOptions,
  type SkillProvider, type SkillProviderControl, type SkillProviderObservation,
} from '@deepseek-ai/dsh-skill'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import Schema from '@deepseek-ai/schemastery'
import { unzipSync } from 'fflate'
import { z } from 'zod'
import type {
  MarketCategory, MarketInstalledStatus, MarketInstallOptions, MarketInstallRecord, MarketSkillCard, MarketSkillDetail,
  MarketSkillPage, MarketSkillQuery,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Skill Hub market: the `market` skill source, its per-tenant switches, and the `skillMarket` Remote. */
    skillMarket: SkillMarket
  }
}

/** Discovery source of Skills installed from the Skill Hub. */
export const MARKET_SOURCE = 'market'
/** After the user roots (400, 500) and before bundled Skills (600): project Skills still win in their project. */
const MARKET_RANK = 550
/** Install record kept inside each market Skill directory. */
export const INSTALL_RECORD = '.hub-install.json'
/** Sources of the Skills the user placed on this machine; a market install may not shadow them. */
const CUSTOM_SOURCES: ReadonlySet<string> = new Set(['user-dsh', 'user-agents'])
/** A never-created child of the filesystem root: user-level lookups see no project roots. */
const NEUTRAL_CWD = join(parse(homedir()).root, '.dsh-skill-market-neutral')
const DISABLED: SkillInvocationPolicy = Object.freeze({ modelInvocable: false, userInvocable: false })

/** Market configuration. */
export interface Config {
  /** DeepSeek Harness home; market Skills live under `<dshHome>/skills-market`. Defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string
  /** Market Skills switched off, as `<tenantId>/<name>`; edited live through `setDisabled()`. */
  disabledSkills?: Volatile<readonly string[]>
  /** Watch the tenant directory for changes made outside DSH. */
  watch?: boolean
  /** Largest Skill package accepted for install, in bytes. */
  maxPackageBytes?: number
}

/** Validated market configuration. */
export const Config = Schema.object({
  dshHome: Schema.string(),
  disabledSkills: Schema.array(Schema.string()).default([]).volatile()
    .description('Market Skills switched off, as `<tenantId>/<name>`. A switched-off Skill stays installed, but neither the model nor the user can invoke it.'),
  watch: Schema.boolean().default(true),
  maxPackageBytes: Schema.number().min(1).default(64 * 1024 * 1024),
})

const versionInfo = z.object({ version: z.string(), uploadedAt: z.string() })
const category = z.object({ id: z.string(), name: z.string() }).nullable()
const summary = z.object({ id: z.string(), name: z.string(), category, currentVersion: versionInfo })
const page = z.object({ items: z.array(summary), total: z.number(), page: z.number(), pageSize: z.number() })
const detail = summary.extend({
  description: z.string(),
  ownerName: z.string(),
  updatedAt: z.string(),
  skillMd: z.string(),
  files: z.array(z.object({ path: z.string(), size: z.number(), sha256: z.string() })),
})
const listItem = summary.extend({ currentVersion: versionInfo.extend({ description: z.string() }) })
const record = z.object({
  hubSkillId: z.string(), name: z.string(), version: z.string(), installedAt: z.string(),
  files: z.array(z.object({ path: z.string(), sha256: z.string() })),
})

const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex')

/**
 * Order two `x.y.z` versions numerically, part by part.
 * @param left - one version.
 * @param right - the other version.
 * @returns a positive number when `left` is newer, negative when older, zero when equal.
 */
export function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/**
 * Files of an installed market Skill that differ from its install record: edited, removed, or added.
 * @param dir - the installed Skill directory.
 * @param installed - its install record, or undefined when the directory is not a market install.
 * @returns the differing paths relative to the Skill root, sorted.
 */
async function localChanges(dir: string, installed: MarketInstallRecord | undefined): Promise<string[]> {
  const recorded = new Map((installed?.files ?? []).map(file => [file.path, file.sha256]))
  const changed = new Set<string>()
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  const present = new Set<string>()
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const path = relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/')
    if (path === INSTALL_RECORD) continue
    present.add(path)
    if (recorded.get(path) !== sha256(await readFile(join(dir, path)))) changed.add(path)
  }
  for (const path of recorded.keys()) if (!present.has(path)) changed.add(path)
  return [...changed].sort((a, b) => Number(a > b) - Number(a < b))
}

function invalid(reason: string): RemoteError {
  return new RemoteError('skill-market/invalid-package', `the Skill package is invalid: ${reason}`, { reason })
}

/**
 * Read the package entries under `<name>/`, refusing anything that could escape the Skill directory.
 * @param zip - downloaded package.
 * @param name - Skill name the package must contain.
 * @param maxBytes - largest total uncompressed size accepted; checked before anything is inflated.
 * @returns file bytes keyed by path relative to the Skill root.
 */
function packageFiles(zip: Uint8Array, name: string, maxBytes: number): Map<string, Uint8Array> {
  let entries: Record<string, Uint8Array>
  let total = 0
  try {
    entries = unzipSync(zip, { filter: file => (total += file.originalSize) <= maxBytes })
  } catch {
    throw invalid('not a zip archive')
  }
  if (total > maxBytes) throw invalid('the package is too large')
  const files = new Map<string, Uint8Array>()
  for (const [path, data] of Object.entries(entries)) {
    if (path.endsWith('/')) continue
    const relative = path.startsWith(`${name}/`) ? path.slice(name.length + 1) : ''
    const segments = relative.split('/')
    if (relative === '' || path.includes('\\') || segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
      throw invalid(`unexpected entry ${JSON.stringify(path)}`)
    }
    files.set(relative, data)
  }
  if (!files.has('SKILL.md')) throw invalid('SKILL.md is missing')
  return files
}

/**
 * The `market` skill provider: the signed-in tenant's directory through the filesystem provider,
 * with the tenant's switched-off Skills closed for both the model and the user.
 */
class MarketProvider implements SkillProvider {
  readonly name = 'skill-market'
  private inner: { tenantId: string; provider: FileSystemSkillProvider } | undefined

  constructor(private readonly ctx: Context, private readonly market: SkillMarket, private readonly control: SkillProviderControl) {
    control.signal.addEventListener('abort', () => { void this.inner?.provider.dispose() }, { once: true })
  }

  async list(options: SkillLookupOptions): Promise<readonly SkillCandidate[] | SkillProviderObservation> {
    const provider = this.current()
    if (provider === undefined) return []
    const listed = await provider.list(options)
    const close = (candidate: SkillCandidate): SkillCandidate =>
      this.market.isDisabled(candidate.name) ? { ...candidate, invocation: DISABLED } : candidate
    // Discovery that could not start its watcher keeps its incomplete flag.
    /* v8 ignore start */
    if (!Array.isArray(listed)) {
      const observation = listed as SkillProviderObservation
      return { candidates: observation.candidates.map(close), complete: observation.complete }
    }
    /* v8 ignore stop */
    return (listed as readonly SkillCandidate[]).map(close)
  }

  async get(candidate: SkillCandidate, options: SkillLookupOptions): Promise<SkillDefinition | undefined> {
    const definition = await this.current()?.get(candidate, options)
    if (definition === undefined || !this.market.isDisabled(definition.name)) return definition
    return { ...definition, invocation: DISABLED }
  }

  invalidate(): void { this.control.invalidate() }

  /** The filesystem provider of the signed-in tenant's directory, replaced when the tenant changes. */
  private current(): FileSystemSkillProvider | undefined {
    const tenantId = this.market.tenantId
    if (this.inner !== undefined && this.inner.tenantId === tenantId) return this.inner.provider
    void this.inner?.provider.dispose()
    this.inner = undefined
    if (tenantId === undefined) return undefined
    const provider = new FileSystemSkillProvider(this.ctx, this.control, {
      providerName: this.name, includeDefaultRoots: false, customSkillDirs: [this.market.tenantDir(tenantId)],
      customSource: MARKET_SOURCE, customRank: MARKET_RANK, watch: this.market.watch,
    })
    this.inner = { tenantId, provider }
    return provider
  }
}

/** Host owner of the market source and of the `skillMarket` Remote namespace. */
export class SkillMarket extends TypertRemoteService {
  static inject = ['skills', 'hubAccount']
  static Config = Config

  /** Tenant of the current Hub sign-in; undefined while signed out. */
  tenantId: string | undefined
  /** Whether the tenant directory is watched for changes made outside DSH. */
  readonly watch: boolean
  private readonly root: string
  private readonly maxPackageBytes: number
  private readonly disabledSkills: Volatile<readonly string[]> | undefined
  private readonly entryId: string | undefined
  private provider: MarketProvider | undefined
  private disabledWrites: Promise<void> = Promise.resolve()
  private readonly lifetime = new AbortController()

  /** @param ctx - Host with the skill registry and Hub sign-in. @param config - market options. */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'skillMarket', { namespace: 'skillMarket' })
    this.root = join(resolveDshHome(config.dshHome), 'skills-market')
    this.watch = config.watch ?? true
    this.maxPackageBytes = config.maxPackageBytes ?? 64 * 1024 * 1024
    this.disabledSkills = config.disabledSkills
    this.entryId = ctx.fiber.entry?.options.id
    ctx.skills.registerProvider((control) => {
      this.provider = new MarketProvider(ctx, this, control)
      return this.provider
    })
    ctx.on('loader/volatile-update', () => { this.provider?.invalidate() })
    ctx.effect(() => () => { this.lifetime.abort() }, 'skill-market: tenant watch')
  }

  async [Service.init](): Promise<void> {
    this.tenantId = (await this.ctx.hubAccount.getState()).profile?.tenantId ?? undefined
    // Follow sign-in changes: a tenant switch swaps the discovered directory.
    void (async () => {
      for await (const state of this.ctx.hubAccount.watch(this.lifetime.signal)) {
        const tenantId = state.profile?.tenantId ?? undefined
        if (tenantId === this.tenantId) continue
        this.tenantId = tenantId
        this.provider?.invalidate()
      }
    })()
  }

  /**
   * Directory holding one tenant's market Skills.
   * @param tenantId - Skill Hub tenant.
   * @returns `<dshHome>/skills-market/<tenantId>`.
   */
  tenantDir(tenantId: string): string {
    return join(this.root, tenantId)
  }

  /**
   * Whether the signed-in tenant switched this market Skill off.
   * @param name - Skill name.
   * @returns true when switched off.
   */
  isDisabled(name: string): boolean {
    return this.tenantId !== undefined && (this.disabledSkills?.get() ?? []).includes(`${this.tenantId}/${name}`)
  }

  /**
   * Switch one market Skill of the signed-in tenant on or off, persisting the profile's list.
   * @param name - Skill name.
   * @param disabled - whether to switch it off.
   * @throws when signed out, or when mounted without Settings or a profile entry.
   */
  setDisabled(name: string, disabled: boolean): Promise<void> {
    const tenantId = this.tenantId
    if (tenantId === undefined) return Promise.reject(new RemoteError('hub-account/signed-out', 'sign in to the Skill Hub first', {}))
    const key = `${tenantId}/${name}`
    const write = this.disabledWrites.then(async () => {
      const current = this.disabledSkills?.get() ?? []
      if (current.includes(key) === disabled) return
      const settings = this.ctx.get('settings')
      if (settings === undefined || this.entryId === undefined) throw new Error('switching market Skills requires the settings service and a profile entry')
      await settings.update(this.entryId, { disabledSkills: disabled ? [...current, key].sort() : current.filter(item => item !== key) })
    })
    this.disabledWrites = write.catch(() => {})
    return write
  }

  /**
   * List the market as the signed-in employee sees it on the Skill Hub.
   * @param query - search text, category, and page.
   * @param signal - caller lifetime.
   * @returns one page of cards with their install state.
   */
  @Remote
  async list(query: MarketSkillQuery, signal: AbortSignal): Promise<MarketSkillPage> {
    const params = new URLSearchParams()
    if (query.q !== undefined && query.q.trim() !== '') params.set('q', query.q.trim())
    if (query.categoryId !== undefined) params.set('categoryId', query.categoryId)
    params.set('page', String(query.page ?? 1))
    params.set('pageSize', String(query.pageSize ?? 20))
    const value = page.extend({ items: z.array(listItem) }).parse(await this.hubJson(`/api/client/skills?${params}`, signal))
    const [installed, custom] = await Promise.all([this.records(), this.customNames()])
    const items = value.items.map(item => card(item, item.currentVersion.description, item.currentVersion.uploadedAt, installed, custom))
    return { ...value, items }
  }

  /**
   * The signed-in tenant's Skill categories.
   * @param signal - caller lifetime.
   * @returns categories in Hub order.
   */
  @Remote
  async categories(signal: AbortSignal): Promise<readonly MarketCategory[]> {
    return z.array(z.object({ id: z.string(), name: z.string() })).parse(await this.hubJson('/api/client/skills/categories', signal))
  }

  /**
   * One market Skill with its SKILL.md and file list.
   * @param id - Skill Hub Skill id.
   * @param signal - caller lifetime.
   * @returns the detail with its install state.
   */
  @Remote
  async detail(id: string, signal: AbortSignal): Promise<MarketSkillDetail> {
    const value = await this.fetchDetail(id, signal)
    const [installed, custom] = await Promise.all([this.records(), this.customNames()])
    return {
      ...card(value, value.description, value.updatedAt, installed, custom),
      ownerName: value.ownerName, skillMd: value.skillMd, files: value.files.map(({ path, size }) => ({ path, size })),
    }
  }

  /**
   * Install the current version of a market Skill for the signed-in tenant. The package is
   * downloaded and validated (layout and every file's sha256) in a staging directory beside the
   * target, then moved into place in one rename; a failure leaves no partial Skill behind. An
   * installed copy is replaced the same way (an update), unless its files differ from its install
   * record and the caller did not ask to overwrite them.
   * @param id - Skill Hub Skill id.
   * @param options - whether local edits of an installed copy may be overwritten.
   * @param signal - caller lifetime.
   * @returns the card after install.
   * @throws RemoteError on a name conflict with a user Skill, local edits that would be overwritten,
   *   an invalid package, or an unreachable Hub.
   */
  @Remote
  async installSkill(id: string, options: MarketInstallOptions, signal: AbortSignal): Promise<MarketSkillCard> {
    const tenantId = this.tenantId
    if (tenantId === undefined) throw new RemoteError('hub-account/signed-out', 'sign in to the Skill Hub first', {})
    const value = await this.fetchDetail(id, signal)
    if (!isSkillName(value.name)) throw invalid(`invalid Skill name ${JSON.stringify(value.name)}`)
    if ((await this.customNames()).has(value.name)) {
      throw new RemoteError('skill-market/name-conflict', `a Skill named "${value.name}" is already installed on this machine`, { name: value.name })
    }
    const res = await this.hubRequest(`/api/client/skills/${encodeURIComponent(id)}/download`, signal)
    const zip = new Uint8Array(await res.arrayBuffer())
    if (zip.byteLength > this.maxPackageBytes) throw invalid('the package is too large')
    const files = packageFiles(zip, value.name, this.maxPackageBytes)
    const expected = new Map(value.files.map(file => [file.path, file.sha256]))
    if (expected.size !== files.size || [...files].some(([path, data]) => expected.get(path) !== sha256(data))) {
      throw invalid('the files do not match the published version')
    }
    const tenantDir = this.tenantDir(tenantId)
    const target = join(tenantDir, value.name)
    if (options.overwriteLocalChanges !== true && await exists(target)) {
      const changed = await localChanges(target, (await this.records()).get(value.name))
      if (changed.length > 0) {
        throw new RemoteError('skill-market/local-changes', `local edits to "${value.name}" would be overwritten`, { name: value.name, files: changed })
      }
    }
    await mkdir(tenantDir, { recursive: true })
    const staging = await mkdtemp(join(tenantDir, '.installing-'))
    try {
      const skillDir = join(staging, value.name)
      for (const [path, data] of files) {
        await mkdir(dirname(join(skillDir, path)), { recursive: true })
        await writeFile(join(skillDir, path), data)
      }
      const installRecord: MarketInstallRecord = {
        hubSkillId: value.id, name: value.name, version: value.currentVersion.version, installedAt: new Date().toISOString(),
        files: [...files].map(([path, data]) => ({ path, sha256: sha256(data) }))
          .sort((a, b) => Number(a.path > b.path) - Number(a.path < b.path)),
      }
      await writeFile(join(skillDir, INSTALL_RECORD), `${JSON.stringify(installRecord, null, 2)}\n`)
      if (await exists(target)) await rename(target, join(staging, '.replaced'))
      await rename(skillDir, target)
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
    this.provider?.invalidate()
    return card(value, value.description, value.updatedAt, await this.records(), new Set())
  }

  /**
   * Ask the Skill Hub where each installed market Skill of the signed-in tenant stands. A Skill the
   * Hub no longer shows the employee is `unavailable`; its local copy stays installed and usable.
   * @param signal - caller lifetime.
   * @returns one status per installed market Skill, sorted by name.
   */
  @Remote
  async installedStatus(signal: AbortSignal): Promise<readonly MarketInstalledStatus[]> {
    const installed = [...(await this.records()).values()].sort((a, b) => Number(a.name > b.name) - Number(a.name < b.name))
    return Promise.all(installed.map(async (local): Promise<MarketInstalledStatus> => {
      const base = { name: local.name, hubSkillId: local.hubSkillId, installedVersion: local.version }
      try {
        const latest = (await this.fetchDetail(local.hubSkillId, signal)).currentVersion.version
        return { ...base, latestVersion: latest, state: compareVersions(latest, local.version) > 0 ? 'update' : 'current' }
      } catch (error: unknown) {
        if (signal.aborted) throw error
        const notFound = error instanceof RemoteError && error.code === 'skill-market/not-found'
        return { ...base, latestVersion: null, state: notFound ? 'unavailable' : 'unknown' }
      }
    }))
  }

  /**
   * Install records of the signed-in tenant's market Skills, keyed by Skill name.
   * @returns the readable records; a directory without one is not a market install.
   */
  async records(): Promise<Map<string, MarketInstallRecord>> {
    const records = new Map<string, MarketInstallRecord>()
    if (this.tenantId === undefined) return records
    const dir = this.tenantDir(this.tenantId)
    let names: string[]
    try { names = await readdir(dir) } catch { return records }
    for (const name of names) {
      try {
        const parsed = record.safeParse(JSON.parse(await readFile(join(dir, name, INSTALL_RECORD), 'utf8')))
        if (parsed.success && parsed.data.name === name) records.set(name, parsed.data)
      } catch {
        // Not a market install (staging directory, stray file, or a record that cannot be read).
      }
    }
    return records
  }

  private async fetchDetail(id: string, signal: AbortSignal): Promise<z.infer<typeof detail>> {
    return detail.parse(await this.hubJson(`/api/client/skills/${encodeURIComponent(id)}`, signal, id))
  }

  private async hubJson(path: string, signal: AbortSignal, id?: string): Promise<unknown> {
    return (await this.hubRequest(path, signal, id)).json()
  }

  private async hubRequest(path: string, signal: AbortSignal, id?: string): Promise<Response> {
    let res: Response
    try {
      res = await this.ctx.hubAccount.request(path, { signal })
    } catch (error: unknown) {
      if (error instanceof RemoteError || signal.aborted) throw error
      throw new RemoteError('skill-market/unavailable', 'the Skill Hub cannot be reached', { status: null }, { cause: error })
    }
    if (res.status === 404 && id !== undefined) throw new RemoteError('skill-market/not-found', `Skill ${id} is not available`, { id })
    if (!res.ok) throw new RemoteError('skill-market/unavailable', `the Skill Hub answered ${res.status}`, { status: res.status })
    return res
  }

  /** Names of the Skills the user placed on this machine, as the default agent preset discovers them. */
  private async customNames(): Promise<Set<string>> {
    const presets = this.ctx.get('agentPresets')
    await using lease: ({ key: ScopeKey } & AsyncDisposable) | undefined = presets === undefined ? undefined : await presets.acquireScope()
    const skills = await this.ctx.skills.list({ cwd: NEUTRAL_CWD, ...lease === undefined ? {} : { scope: lease.key } })
    return new Set(skills.filter(skill => CUSTOM_SOURCES.has(skill.source)).map(skill => skill.name))
  }
}

function card(
  value: z.infer<typeof summary>, description: string, updatedAt: string,
  installed: ReadonlyMap<string, MarketInstallRecord>, custom: ReadonlySet<string>,
): MarketSkillCard {
  const local = installed.get(value.name)
  const installedVersion = local?.hubSkillId === value.id ? local.version : null
  return {
    id: value.id, name: value.name, description, category: value.category, version: value.currentVersion.version, updatedAt,
    installedVersion,
    updateAvailable: installedVersion !== null && compareVersions(value.currentVersion.version, installedVersion) > 0,
    conflict: custom.has(value.name),
  }
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true } catch { return false }
}

export default SkillMarket
