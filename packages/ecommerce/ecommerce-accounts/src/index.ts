/**
 * E-commerce accounts for Desktop, behind one Host service and the `ecommerceAccounts` Remote
 * namespace. An account is one platform account the user signs in to in the system Google Chrome,
 * on that account's own browser data; Chrome keeps the sign-in and DSH stores no password or
 * cookie. Accounts belong to the tenant of the current Hub sign-in and live under
 * `<dshHome>/ecommerce/<tenantId>/`: `accounts.json` lists them, and `browsers/<accountId>/` holds
 * each one's browser data and the record of its running Chrome.
 *
 * Signing in opens the platform's sign-in page in the account's Chrome. DSH watches that tab and,
 * once it leaves the sign-in page or every half minute, opens the platform's business page in a
 * background tab and reads the platform's own sign-in response there, retrying once. A signed-in
 * account's Chrome keeps running with its windows minimized, and survives DSH: the next DSH
 * reattaches to it, or, when it is gone, starts it again minimized, restoring the last session.
 *
 * @module @deepseek-ai/dsh-ecommerce-accounts
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-hub-account'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import Schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { Cdp, closeBlankTabs, hideWindows, pageTabs, probe, showSignIn, type ProbeResult } from './cdp.ts'
import { alive, closeChrome, ensureTab, findChrome, launchChrome, readRecord, type ChromeInfo } from './chrome.ts'
import { PLATFORMS, type PlatformSpec } from './platforms.ts'
import type {
  AddEcommerceAccountInput, AddEcommerceAccountResult, ChromeView, EcommerceAccountsState, EcommerceAccountStatus, EcommerceAccountView,
} from './types.ts'

export type * from './types.ts'
export { mtopUserNick, matchesCheckApi, parseJsonOrJsonp, PLATFORMS, TMALL, type PlatformSpec } from './platforms.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The signed-in tenant's e-commerce accounts and their Chrome sign-ins. */
    ecommerceAccounts: EcommerceAccountsService
  }
}

/** Plugin configuration. */
export interface Config {
  /** DeepSeek Harness home; accounts live under `<dshHome>/ecommerce`. Defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string
  /** Chrome executable to use instead of the platform's standard Google Chrome install. */
  chromePath?: string
  /** Oldest Chrome major version accounts run on. */
  minChromeVersion?: number
  /** How long a sign-in waits for the user before giving up, in milliseconds. */
  signInTimeoutMs?: number
  /** How long one check waits for the platform's response, in milliseconds. */
  checkTimeoutMs?: number
  /** How long DSH waits for Chrome to start or close, in milliseconds. */
  chromeTimeoutMs?: number
  /** Time between looks at the sign-in tab, in milliseconds. */
  signInPollMs?: number
  /** Time after which a sign-in is checked even before its tab leaves the sign-in page, in milliseconds. */
  signInCheckEveryMs?: number
  /** Longest store or account name, in characters. */
  maxNameLength?: number
}

/** Runtime schema for {@link Config}. */
export const Config: Schema<Config> = Schema.object({
  dshHome: Schema.string().description('DeepSeek Harness home; accounts live under `<dshHome>/ecommerce`. Defaults to `$DSH_HOME` or `~/.dsh`.'),
  chromePath: Schema.string().description("Chrome executable to use instead of the platform's standard Google Chrome install."),
  minChromeVersion: Schema.natural().min(1).default(120).description('Oldest Chrome major version accounts run on.'),
  signInTimeoutMs: Schema.natural().min(1).default(600_000).description('How long a sign-in waits for the user before giving up, in milliseconds.'),
  checkTimeoutMs: Schema.natural().min(1).default(20_000).description("How long one check waits for the platform's response, in milliseconds."),
  chromeTimeoutMs: Schema.natural().min(1).default(20_000).description('How long DSH waits for Chrome to start or close, in milliseconds.'),
  signInPollMs: Schema.natural().min(1).default(3000).description('Time between looks at the sign-in tab, in milliseconds.'),
  signInCheckEveryMs: Schema.natural().min(1).default(30_000).description('Time after which a sign-in is checked even before its tab leaves the sign-in page, in milliseconds.'),
  maxNameLength: Schema.natural().min(1).default(64).description('Longest store or account name, in characters.'),
})

/** Where to get Google Chrome. */
export const CHROME_DOWNLOAD_URL = 'https://www.google.com/chrome/'

/** Which platforms and kinds can be added now, as `<platform>/<kind>`. */
const ADDABLE: ReadonlySet<string> = new Set(['tmall/merchant'])

/** What makes two accounts the same: platform, kind, and account name. */
const identity = (item: Pick<EcommerceAccountView, 'platform' | 'kind' | 'account'>): string => `${item.platform}/${item.kind}/${item.account}`

const ledgerSchema = z.object({
  version: z.literal(1),
  accounts: z.array(z.object({
    id: z.string().min(1),
    platform: z.enum(['tmall']),
    kind: z.enum(['merchant', 'buyer']),
    storeName: z.string(),
    account: z.string().min(1),
    createdAt: z.string(),
    signedInAs: z.string().optional(),
    checkedAt: z.string().optional(),
    /** Whether a sign-in ever succeeded; a Chrome gone since then is started again to restore it. */
    everSignedIn: z.boolean().optional(),
  })),
})

type Entry = z.infer<typeof ledgerSchema>['accounts'][number]

/** Host owner of the e-commerce accounts and of the `ecommerceAccounts` Remote namespace. */
export class EcommerceAccountsService extends TypertRemoteService {
  static inject = ['hubAccount']
  static Config = Config

  private readonly root: string
  private readonly options: Required<Omit<Config, 'dshHome' | 'chromePath'>> & Pick<Config, 'chromePath'>
  private tenantId: string | null = null
  private entries: Entry[] = []
  private readonly statuses = new Map<string, EcommerceAccountStatus>()
  /** Sign-ins waiting for the user, by account. */
  private readonly signIns = new Map<string, AbortController>()
  /** One operation at a time per account, so two never drive its Chrome together. */
  private readonly queues = new Map<string, Promise<unknown>>()
  private writes: Promise<unknown> = Promise.resolve()
  private chrome: ChromeInfo | undefined
  private revision = Date.now()
  private readonly listeners = new Set<() => void>()
  private readonly lifetime = new AbortController()

  /** @param ctx - Host with the Hub sign-in. @param config - storage, Chrome, and timing options. */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'ecommerceAccounts', { namespace: 'ecommerceAccounts' })
    const { dshHome, ...resolved } = Config(config) as Config & Required<Omit<Config, 'dshHome' | 'chromePath'>>
    this.root = join(resolveDshHome(dshHome), 'ecommerce')
    this.options = resolved
    // Chrome keeps running after DSH stops: that keeps the sign-ins.
    ctx.effect(() => () => {
      this.lifetime.abort()
      for (const controller of this.signIns.values()) controller.abort()
      this.changed()
    }, 'ecommerce-accounts: lifetime')
  }

  async [Service.init](): Promise<void> {
    this.chrome = await findChrome(this.options.chromePath)
    await this.serialized(async () => this.switchTenant((await this.ctx.hubAccount.getState()).profile?.tenantId ?? null))
    void (async () => {
      for await (const state of this.ctx.hubAccount.watch(this.lifetime.signal)) {
        const tenantId = state.profile?.tenantId ?? null
        if (tenantId !== this.tenantId) await this.serialized(() => this.switchTenant(tenantId))
      }
    })()
  }

  /**
   * Read the signed-in tenant's accounts and whether Chrome can run them.
   * @returns the state the settings page shows.
   */
  @Remote
  getState(): Promise<EcommerceAccountsState> {
    return Promise.resolve({
      revision: this.revision, tenantId: this.tenantId, chrome: this.chromeView(),
      accounts: this.entries.map(entry => this.view(entry)),
    })
  }

  /**
   * Stream the state.
   * @param signal - stream lifetime.
   * @returns the current state, then every change.
   */
  @Remote({ mode: 'stream' })
  async *watch(signal: AbortSignal): AsyncIterable<EcommerceAccountsState> {
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
   * Add an account for the signed-in tenant; it starts signed out.
   * @param input - platform, kind, store name, and account.
   * @returns the new account's id and the state with it last.
   * @throws RemoteError `hub-account/signed-out`, `ecommerce-accounts/unsupported`,
   *   `ecommerce-accounts/invalid-field`, or `ecommerce-accounts/duplicate`.
   */
  @Remote
  addAccount(input: AddEcommerceAccountInput): Promise<AddEcommerceAccountResult> {
    return this.serialized(async () => {
      const tenantId = this.requireTenant()
      // The wire may carry a platform or kind this build does not offer.
      if (!ADDABLE.has(`${input.platform}/${input.kind}`)) {
        throw new RemoteError('ecommerce-accounts/unsupported', 'This platform or account kind cannot be added yet', { platform: input.platform, kind: input.kind })
      }
      const max = this.options.maxNameLength
      const account = checkName('account', input.account, max)
      const storeName = checkName('storeName', input.storeName ?? '', max)
      const existing = this.entries.find(entry => identity(entry) === identity({ ...input, account }))
      if (existing !== undefined) throw new RemoteError('ecommerce-accounts/duplicate', 'This account is already added', { accountId: existing.id })
      const entry: Entry = {
        id: randomUUID(), platform: input.platform, kind: input.kind, storeName, account, createdAt: new Date().toISOString(),
      }
      this.entries = [...this.entries, entry]
      this.statuses.set(entry.id, 'signed-out')
      await this.saveLedger(tenantId)
      this.changed()
      return { accountId: entry.id, state: await this.getState() }
    })
  }

  /**
   * Open the platform's sign-in page in the account's own Chrome and wait for the user to sign in;
   * the account turns signed in by itself once the platform says so.
   * @param accountId - the account.
   * @returns the state with the account signing in.
   * @throws RemoteError `hub-account/signed-out`, `ecommerce-accounts/not-found`,
   *   `ecommerce-accounts/chrome-missing`, `ecommerce-accounts/chrome-outdated`, or `ecommerce-accounts/browser-failed`.
   */
  @Remote
  async startSignIn(accountId: string): Promise<EcommerceAccountsState> {
    const entry = this.find(accountId)
    const chrome = await this.requireChrome()
    this.signIns.get(entry.id)?.abort()
    const controller = new AbortController()
    this.signIns.set(entry.id, controller)
    this.setStatus(entry.id, 'signing-in')
    const spec = PLATFORMS[entry.platform]
    let tab: string
    try {
      tab = await this.queued(entry.id, async () => {
        const port = await this.ensureChrome(entry, chrome, false, 'about:blank')
        const cdp = await Cdp.connect(port, this.options.chromeTimeoutMs)
        try {
          return await showSignIn(cdp, spec.loginUrl)
        } finally {
          cdp.close()
        }
      })
    } catch (error) {
      this.signIns.delete(entry.id)
      this.setStatus(entry.id, 'signed-out')
      throw new RemoteError('ecommerce-accounts/browser-failed', 'Chrome could not open the sign-in page', { accountId, reason: String(error) })
    }
    void this.watchSignIn(entry, spec, tab, controller.signal)
    return this.getState()
  }

  /**
   * Check now whether the user finished signing in, as the "I have signed in" button asks.
   * @param accountId - the account.
   * @returns the state after the check.
   * @throws RemoteError `hub-account/signed-out` or `ecommerce-accounts/not-found`.
   */
  @Remote
  async confirmSignIn(accountId: string): Promise<EcommerceAccountsState> {
    const entry = this.find(accountId)
    const signingIn = this.signIns.get(entry.id)
    const result = await this.check(entry)
    if (signingIn !== undefined && result.kind === 'signed-in') {
      signingIn.abort()
      this.signIns.delete(entry.id)
    } else if (signingIn !== undefined) {
      this.setStatus(entry.id, 'signing-in')
    }
    return this.getState()
  }

  /**
   * Check every account that is not signing in, and look for Chrome again.
   * @returns the state after the checks.
   */
  @Remote
  async refresh(): Promise<EcommerceAccountsState> {
    this.chrome = await findChrome(this.options.chromePath)
    this.changed()
    await Promise.all(this.entries.filter(entry => !this.signIns.has(entry.id)).map(entry => this.check(entry)))
    return this.getState()
  }

  /**
   * Delete an account and its browser data, closing its Chrome first.
   * @param accountId - the account.
   * @returns the state without it.
   * @throws RemoteError `hub-account/signed-out` or `ecommerce-accounts/not-found`.
   */
  @Remote
  async deleteAccount(accountId: string): Promise<EcommerceAccountsState> {
    const entry = this.find(accountId)
    this.signIns.get(entry.id)?.abort()
    this.signIns.delete(entry.id)
    const dir = this.dirOf(entry.id)
    return this.queued(entry.id, async () => {
      await closeChrome(dir, this.options.chromeTimeoutMs)
      await rm(dir, { recursive: true, force: true })
      return this.serialized(async () => {
        const tenantId = this.requireTenant()
        this.entries = this.entries.filter(item => item.id !== entry.id)
        this.statuses.delete(entry.id)
        await this.saveLedger(tenantId)
        this.changed()
        return this.getState()
      })
    })
  }

  /** Watch the sign-in tab until the platform says the account is signed in, or time runs out. */
  private async watchSignIn(entry: Entry, spec: PlatformSpec, tab: string, signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + this.options.signInTimeoutMs
    let lastCheck = Date.now()
    try {
      for (;;) {
        await sleep(this.options.signInPollMs, signal)
        if (signal.aborted || Date.now() >= deadline) break
        // Checking opens a background tab; only do it once the sign-in tab moved on, or now and then,
        // so a scan in progress is not interrupted.
        const left = await this.queued(entry.id, () => this.leftSignInPage(entry, spec, tab))
        if (!left && Date.now() - lastCheck < this.options.signInCheckEveryMs) continue
        lastCheck = Date.now()
        if ((await this.check(entry)).kind === 'signed-in') return
        this.setStatus(entry.id, 'signing-in')
      }
      if (!signal.aborted) this.setStatus(entry.id, 'signed-out')
    } finally {
      if (this.signIns.get(entry.id)?.signal === signal) this.signIns.delete(entry.id)
    }
  }

  private async leftSignInPage(entry: Entry, spec: PlatformSpec, tab: string): Promise<boolean> {
    const record = await readRecord(this.dirOf(entry.id))
    if (record === undefined || !await alive(record.port)) return false
    const cdp = await Cdp.connect(record.port, this.options.chromeTimeoutMs)
    try {
      const url = (await pageTabs(cdp)).find(item => item.targetId === tab)?.url
      // A closed sign-in tab counts as moved on, so the account is checked.
      return url === undefined || !spec.isLoginPage(url)
    } finally {
      cdp.close()
    }
  }

  /**
   * Ask the platform whether the account is signed in, retrying once, and record the answer. A
   * signed-in account's Chrome is minimized. A Chrome gone since an earlier sign-in is started
   * again minimized, restoring its last session; an account never signed in starts no Chrome.
   */
  private check(entry: Entry): Promise<ProbeResult> {
    this.setStatus(entry.id, 'checking')
    return this.queued(entry.id, async () => {
      let result: ProbeResult
      try {
        result = await this.probeAccount(entry)
      } catch (error) {
        this.ctx.logger.warn(`ecommerce-accounts: checking ${entry.id} failed: ${String(error)}`)
        result = { kind: 'no-response' }
      }
      return this.serialized(async () => {
        const current = this.entries.find(item => item.id === entry.id)
        // The account was deleted, or the tenant switched, while the platform was asked.
        if (current === undefined) return result
        if (result.kind === 'no-response') {
          this.setStatus(entry.id, 'check-failed')
          return result
        }
        const { signedInAs: _old, ...rest } = current
        const next: Entry = {
          ...rest, checkedAt: new Date().toISOString(),
          ...(result.kind === 'signed-in' ? { signedInAs: result.nick, everSignedIn: true } : {}),
        }
        this.entries = this.entries.map(item => item.id === entry.id ? next : item)
        await this.saveLedger(this.requireTenant())
        this.setStatus(entry.id, result.kind)
        return result
      })
    })
  }

  private async probeAccount(entry: Entry): Promise<ProbeResult> {
    const dir = this.dirOf(entry.id)
    const record = await readRecord(dir)
    let port = record !== undefined && await alive(record.port) ? record.port : undefined
    // A Chrome started here in the background is minimized whatever the platform answers.
    const started = port === undefined
    if (port === undefined) {
      if (entry.everSignedIn !== true || this.chrome === undefined) return { kind: 'signed-out' }
      port = await this.ensureChrome(entry, this.chrome, true, 'about:blank')
    }
    await ensureTab(port)
    const cdp = await Cdp.connect(port, this.options.chromeTimeoutMs)
    try {
      const spec = PLATFORMS[entry.platform]
      let result = await probe(cdp, spec, this.options.checkTimeoutMs)
      if (result.kind !== 'signed-in') result = await probe(cdp, spec, this.options.checkTimeoutMs)
      if (started || result.kind === 'signed-in') await hideWindows(cdp)
      return result
    } finally {
      cdp.close()
    }
  }

  /** Reattach to the account's running Chrome, or start one; returns its port. */
  private async ensureChrome(entry: Entry, chrome: ChromeInfo, hidden: boolean, url: string): Promise<number> {
    const dir = this.dirOf(entry.id)
    const record = await readRecord(dir)
    if (record !== undefined && await alive(record.port)) return record.port
    const timeoutMs = this.options.chromeTimeoutMs
    const started = await launchChrome({ chrome: chrome.path, dir, url, hidden, timeoutMs, env: scrubbedParentEnv() })
    const cdp = await Cdp.connect(started.port, timeoutMs)
    try {
      await closeBlankTabs(cdp)
    } finally {
      cdp.close()
    }
    return started.port
  }

  private chromeView(): ChromeView {
    const base = { minVersion: this.options.minChromeVersion, downloadUrl: CHROME_DOWNLOAD_URL }
    if (this.chrome === undefined) return { ...base, status: 'missing' }
    const version = this.chrome.version === undefined ? {} : { version: this.chrome.version }
    const outdated = this.chrome.major !== undefined && this.chrome.major < this.options.minChromeVersion
    return { ...base, ...version, status: outdated ? 'outdated' : 'ready' }
  }

  private async requireChrome(): Promise<ChromeInfo> {
    this.chrome = await findChrome(this.options.chromePath)
    const view = this.chromeView()
    this.changed()
    if (this.chrome === undefined) throw new RemoteError('ecommerce-accounts/chrome-missing', 'Google Chrome is not installed', {})
    if (view.status === 'outdated') {
      throw new RemoteError('ecommerce-accounts/chrome-outdated', 'Google Chrome is too old', { version: String(view.version), minVersion: view.minVersion })
    }
    return this.chrome
  }

  private view(entry: Entry): EcommerceAccountView {
    return {
      id: entry.id, platform: entry.platform, kind: entry.kind, storeName: entry.storeName, account: entry.account,
      createdAt: entry.createdAt,
      // Every listed account gets a status when it is added or loaded.
      status: this.statuses.get(entry.id) as EcommerceAccountStatus,
      ...(entry.signedInAs === undefined ? {} : { signedInAs: entry.signedInAs }),
      ...(entry.checkedAt === undefined ? {} : { checkedAt: entry.checkedAt }),
    }
  }

  private find(accountId: string): Entry {
    this.requireTenant()
    const entry = this.entries.find(item => item.id === accountId)
    if (entry === undefined) throw new RemoteError('ecommerce-accounts/not-found', 'This account no longer exists', { accountId })
    return entry
  }

  private async switchTenant(tenantId: string | null): Promise<void> {
    for (const controller of this.signIns.values()) controller.abort()
    this.signIns.clear()
    this.tenantId = tenantId
    this.entries = []
    this.statuses.clear()
    if (tenantId !== null) {
      // A tenant that never added an account has no ledger yet.
      const raw = await readFile(join(this.root, tenantId, 'accounts.json'), 'utf8').catch(() => undefined)
      const parsed = raw === undefined ? undefined : ledgerSchema.safeParse(JSON.parse(raw))
      if (parsed?.success === false) this.ctx.logger.warn(`ecommerce-accounts: ignored malformed ${join(this.root, tenantId, 'accounts.json')}`)
      this.entries = parsed?.success === true ? parsed.data.accounts : []
    }
    this.changed()
    // Each account is checked in the background: a Chrome still running from an earlier DSH is reattached.
    for (const entry of this.entries) void this.check(entry)
  }

  private dirOf(accountId: string): string {
    return join(this.root, this.requireTenant(), 'browsers', accountId)
  }

  private async saveLedger(tenantId: string): Promise<void> {
    const path = join(this.root, tenantId, 'accounts.json')
    await mkdir(join(this.root, tenantId), { recursive: true })
    await writeFile(`${path}.tmp`, `${JSON.stringify({ version: 1, accounts: this.entries }, null, 2)}\n`)
    await rename(`${path}.tmp`, path)
  }

  private setStatus(accountId: string, status: EcommerceAccountStatus): void {
    if (this.statuses.get(accountId) === status) return
    this.statuses.set(accountId, status)
    this.changed()
  }

  private requireTenant(): string {
    if (this.tenantId === null) throw new RemoteError('hub-account/signed-out', 'Sign in to the user center first', {})
    return this.tenantId
  }

  private queued<T>(accountId: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.queues.get(accountId) ?? Promise.resolve()).then(operation)
    this.queues.set(accountId, result.catch(() => undefined))
    return result
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writes.then(operation)
    this.writes = result.catch(() => undefined)
    return result
  }

  private changed(): void {
    this.revision = Math.max(this.revision + 1, Date.now())
    for (const listener of this.listeners) listener()
  }
}

/**
 * Wait, or stop waiting as soon as the signal aborts.
 * @param ms - how long to wait.
 * @param signal - stops the wait.
 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
  })
}

/**
 * Trim a name the user typed and check it.
 * @param field - which field.
 * @param raw - what the user typed.
 * @param max - the longest allowed, in characters.
 * @returns the trimmed name.
 * @throws RemoteError `ecommerce-accounts/invalid-field` when empty or longer than allowed.
 */
function checkName(field: 'storeName' | 'account', raw: string, max: number): string {
  const value = raw.trim()
  if (value === '' || Array.from(value).length > max) {
    throw new RemoteError('ecommerce-accounts/invalid-field', `The ${field} must be 1 to ${String(max)} characters`, { field })
  }
  return value
}

export default EcommerceAccountsService
