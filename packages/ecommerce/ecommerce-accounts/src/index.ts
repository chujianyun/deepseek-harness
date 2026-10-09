/**
 * E-commerce accounts for Desktop, behind one Host service and the `ecommerceAccounts` Remote
 * namespace. An account is one platform account the user signs in to in the system Google Chrome,
 * on that account's own browser data; Chrome keeps the sign-in and DSH stores no password or
 * cookie. Accounts belong to the tenant of the current Hub sign-in and live under
 * `<dshHome>/ecommerce/<tenantId>/`: `accounts.json` lists them, `browsers/<accountId>/` holds
 * each one's browser data and the record of its running Chrome, and `publish-memory.json` holds what
 * the company confirmed while publishing (store information, categories of product lines, table
 * headers, and declarations), which the model reads and extends with `dsh-ecommerce memory` and
 * `dsh-ecommerce remember`.
 *
 * Signing in opens the platform's sign-in page in the account's Chrome. DSH watches that tab and,
 * once it leaves the sign-in page or every half minute, opens the platform's business page in a
 * background tab and reads the platform's own sign-in response there, retrying once. A signed-in
 * account's Chrome keeps running with its windows minimized, and survives DSH: the next DSH
 * reattaches to it, or, when it is gone, starts it again minimized, restoring the last session.
 *
 * The model and Skill scripts reach the accounts through the `dsh-ecommerce` command on the model
 * shell's `PATH`, which calls a loopback endpoint with a token valid for its bash call only, and
 * through the `ecommerce-accounts` Skill, which says how to pick a merchant account. Taking over an
 * account's browser reserves it for that bash call, so two tasks never drive it together.
 *
 * @module @deepseek-ai/dsh-ecommerce-accounts
 */

import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-hub-account'
import type {} from '@deepseek-ai/dsh-shell-env'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-tools'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import Schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { Bridge, SCRIPT, type BridgeReply, type Grant } from './bridge.ts'
import { writeJsonAtomic } from './files.ts'
import { applyUpdate, DamagedMemory, MemoryUpdate, readMemory } from './memory.ts'
import { Cdp, closeBlankTabs, hideWindows, pageTabs, probe, showSignIn, type ProbeResult } from './cdp.ts'
import { alive, closeChrome, ensureTab, findChrome, launchChrome, profileHolder, readRecord, type ChromeInfo } from './chrome.ts'
import { guardBrowser, type GuardRules } from './guard.ts'
import { ECOMMERCE_PLATFORMS, PUBLIC_PAGE, specOf, type PlatformSpec } from './platforms.ts'
import { SKILL_CONTENT, SKILL_DESCRIPTION, SKILL_NAME } from './skill.ts'
import type {
  AddEcommerceAccountInput, AddEcommerceAccountResult, ChromeView, EcommerceAccountsState, EcommerceAccountStatus, EcommerceAccountView,
  EcommerceCheckProblem, EcommercePlatform, RenameEcommerceAccountInput,
} from './types.ts'

export type * from './types.ts'
export {
  DOUDIAN, mtopUserNick, matchesCheckApi, parseJsonOrJsonp, PINDUODUO, PLATFORMS, PUBLIC_PAGE, specOf, TAOBAO, TAOBAO_BUYER, TMALL,
  type CheckAnswer, type PlatformSpec,
} from './platforms.ts'
export { RISK_PAGE } from './guard.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The signed-in tenant's e-commerce accounts and their Chrome sign-ins. */
    ecommerceAccounts: EcommerceAccountsService
  }
}

/** Largest daily page limit a tenant may set for buyer accounts. */
const MAX_DAILY_PAGES = 1000

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
  /** Time between background checks of every merchant account, in milliseconds. */
  checkIntervalMs?: number
  /** Most pages a task may open with one buyer account in a calendar day, until a tenant sets its own. */
  buyerDailyPages?: number
  /** How long a buyer account rests after the platform's risk control showed, in hours. */
  cooldownHours?: number
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
  checkIntervalMs: Schema.natural().min(1).default(30 * 60_000).description('Time between background checks of every merchant account, in milliseconds.'),
  buyerDailyPages: Schema.natural().min(1).max(MAX_DAILY_PAGES).default(20)
    .description('Most pages a task may open with one buyer account in a calendar day, until a tenant sets its own.'),
  cooldownHours: Schema.natural().min(1).default(72).description('How long a buyer account rests after the platform\'s risk control showed, in hours.'),
  maxNameLength: Schema.natural().min(1).default(64).description('Longest store or account name, in characters.'),
})

/** Where to get Google Chrome. */
export const CHROME_DOWNLOAD_URL = 'https://www.google.com/chrome/'

/** Which platforms and kinds can be added now, as `<platform>/<kind>`. */
const ADDABLE: ReadonlySet<string> = new Set(['tmall/merchant', 'taobao/merchant', 'pinduoduo/merchant', 'doudian/merchant', 'tmall/buyer', 'taobao/buyer'])

/** What asking about an account found: the platform's answer, or its browser data held by another Chrome. */
type AccountAnswer = ProbeResult | { readonly kind: 'busy' }

/**
 * The outcome of one check: the answer, or `gone` when the account was deleted, or the tenant
 * switched, while the check waited its turn.
 */
type CheckResult = AccountAnswer | { readonly kind: 'gone' }

/** The problem each failed check shows. */
const PROBLEMS = { 'no-response': 'timeout', 'network': 'network', 'busy': 'busy' } as const satisfies Record<Exclude<AccountAnswer['kind'], 'signed-in' | 'signed-out'>, EcommerceCheckProblem>

/** The variable that gives a bash call the address of the e-commerce accounts. */
const URL_KEY = 'DSH_ECOMMERCE_URL'

/** Each platform's name in what the model reads. */
const PLATFORM_NAMES = { tmall: 'Tmall', taobao: 'Taobao', pinduoduo: 'Pinduoduo', doudian: 'Douyin shop' } as const satisfies Record<EcommercePlatform, string>

/** Each check problem in what the model reads. */
const PROBLEM_TEXT = {
  timeout: 'the platform did not answer in time', network: 'its page could not be reached', busy: 'its browser is in use by another program',
} as const satisfies Record<EcommerceCheckProblem, string>

const SIGNED_OUT_OF_HUB = 'DSH: DSH is signed out of the user center, so there are no e-commerce accounts.'

/** The computer's calendar day, such as `2026-10-08`. */
const today = (): string => new Date().toLocaleDateString('sv')

/** A refusal the command prints to stderr. */
const refused = (message: string): BridgeReply => ({ status: 409, body: message })

/**
 * The reply for a memory file that cannot be read, which DSH leaves as it is.
 * @param error - what reading it threw, a {@link DamagedMemory}.
 * @returns the refusal.
 */
function damaged(error: unknown): BridgeReply {
  return refused(`DSH: the publishing memory file is damaged (${(error as DamagedMemory).message}), so nothing was read or changed. Tell the user; it is publish-memory.json beside the e-commerce accounts.`)
}

/** What makes two accounts the same: platform, kind, and account name. */
const identity = (item: Pick<EcommerceAccountView, 'platform' | 'kind' | 'account'>): string => `${item.platform}/${item.kind}/${item.account}`

const ledgerSchema = z.object({
  version: z.literal(1),
  accounts: z.array(z.object({
    id: z.string().min(1),
    platform: z.enum(ECOMMERCE_PLATFORMS),
    kind: z.enum(['merchant', 'buyer']),
    storeName: z.string(),
    account: z.string().min(1),
    createdAt: z.string(),
    signedInAs: z.string().optional(),
    signedInStore: z.string().optional(),
    checkedAt: z.string().optional(),
    /** Whether a sign-in ever succeeded; a Chrome gone since then is started again to restore it. */
    everSignedIn: z.boolean().optional(),
    /** Pages tasks opened with a buyer account on one calendar day. */
    usage: z.object({ date: z.string(), pages: z.number().int().min(0) }).optional(),
    /** ISO time a buyer account rests until, after the platform's risk control showed. */
    cooldownUntil: z.string().optional(),
  })),
  /** The tenant's daily page limit for buyer accounts, once set. */
  buyerDailyPages: z.number().int().min(1).optional(),
})

type Entry = z.infer<typeof ledgerSchema>['accounts'][number]

/** Host owner of the e-commerce accounts and of the `ecommerceAccounts` Remote namespace. */
export class EcommerceAccountsService extends TypertRemoteService {
  static inject = ['hubAccount', 'skills', 'shellEnv']
  static Config = Config

  private readonly root: string
  private readonly options: Required<Omit<Config, 'dshHome' | 'chromePath'>> & Pick<Config, 'chromePath'>
  private tenantId: string | null = null
  private entries: Entry[] = []
  private readonly statuses = new Map<string, EcommerceAccountStatus>()
  /** Why the last check of an account failed, while it is `check-failed`. */
  private readonly problems = new Map<string, EcommerceCheckProblem>()
  /** Sign-ins waiting for the user, by account. */
  private readonly signIns = new Map<string, AbortController>()
  /** One operation at a time per account, so two never drive its Chrome together. */
  private readonly queues = new Map<string, Promise<unknown>>()
  private writes: Promise<unknown> = Promise.resolve()
  private chrome: ChromeInfo | undefined
  private revision = Date.now()
  private readonly listeners = new Set<() => void>()
  private readonly lifetime = new AbortController()
  /** Accounts whose browser a bash call of the model is using, by account: the call, and the end of DSH's watch on the browser. */
  private readonly leases = new Map<string, { readonly callId: string; stop?: () => void }>()
  /** The tenant's own daily page limit for buyer accounts, once set. */
  private dailyPages: number | undefined
  private readonly bridge = new Bridge({
    accounts: grant => this.modelAccounts(grant),
    browser: (grant, id) => this.modelBrowser(grant, id),
    buyer: (grant, platform) => this.modelBuyer(grant, platform),
    risk: (grant, id) => this.modelRisk(grant, id),
    memory: grant => this.modelMemory(grant),
    remember: (grant, body) => this.modelRemember(grant, body),
  })
  /** Unregisters the Skill while a tenant is signed in. */
  private skill: (() => void) | undefined

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
      this.endLeases(() => true)
      this.skill?.()
      this.changed()
    }, 'ecommerce-accounts: lifetime')
    ctx.shellEnv.registerPath({ name: 'ecommerce-accounts', resolve: () => this.tenantId === null ? undefined : join(this.root, 'bin') })
    ctx.shellEnv.register({
      name: 'ecommerce-accounts',
      variables: { [URL_KEY]: { description: 'The address the dsh-ecommerce command reaches the e-commerce accounts at, valid for this shell call only.' } },
      resolve: exec => this.tenantId === null ? {} : { [URL_KEY]: this.bridge.urlFor({ callId: exec.callId, tenantId: this.tenantId }) },
    })
    // The call's token and its browser reservations end with the call.
    ctx.on('tools/result', (exec) => {
      this.bridge.revoke(exec.callId)
      this.endLeases(lease => lease.callId === exec.callId)
      this.changed()
    })
  }

  async [Service.init](): Promise<void> {
    this.chrome = await findChrome(this.options.chromePath)
    const stopBridge = await this.bridge.start()
    this.ctx.effect(() => () => { void stopBridge() }, 'ecommerce-accounts: command endpoint')
    await mkdir(join(this.root, 'bin'), { recursive: true })
    await writeFile(join(this.root, 'bin', 'dsh-ecommerce'), SCRIPT)
    await chmod(join(this.root, 'bin', 'dsh-ecommerce'), 0o755)
    await this.serialized(async () => this.switchTenant((await this.ctx.hubAccount.getState()).profile?.tenantId ?? null))
    void (async () => {
      for await (const state of this.ctx.hubAccount.watch(this.lifetime.signal)) {
        const tenantId = state.profile?.tenantId ?? null
        if (tenantId !== this.tenantId) await this.serialized(() => this.switchTenant(tenantId))
      }
    })()
    // Buyer accounts are checked only when used or when Settings opens: each check opens a page the platform counts.
    const timer = setInterval(() => { void this.checkIdle(entry => entry.kind === 'merchant') }, this.options.checkIntervalMs)
    timer.unref()
    this.ctx.effect(() => () => { clearInterval(timer) }, 'ecommerce-accounts: periodic check')
  }

  /**
   * Read the signed-in tenant's accounts and whether Chrome can run them.
   * @returns the state the settings page shows.
   */
  @Remote
  getState(): Promise<EcommerceAccountsState> {
    return Promise.resolve({
      revision: this.revision, tenantId: this.tenantId, chrome: this.chromeView(), buyerDailyPages: this.pageLimit(),
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
      // A buyer account belongs to no store.
      const storeName = input.kind === 'buyer' ? '' : checkName('storeName', input.storeName ?? '', max)
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
   *   `ecommerce-accounts/chrome-missing`, `ecommerce-accounts/chrome-outdated`, `ecommerce-accounts/browser-busy`,
   *   or `ecommerce-accounts/browser-failed`.
   */
  @Remote
  async startSignIn(accountId: string): Promise<EcommerceAccountsState> {
    const entry = this.find(accountId)
    this.requireIdle(entry)
    const chrome = await this.requireChrome()
    this.signIns.get(entry.id)?.abort()
    const controller = new AbortController()
    this.signIns.set(entry.id, controller)
    // Every listed account has a status (see view()).
    const before = this.statuses.get(entry.id) as EcommerceAccountStatus
    this.setStatus(entry.id, 'signing-in')
    const spec = specOf(entry.platform, entry.kind)
    let tab: string
    try {
      tab = await this.queued(entry.id, async () => {
        // The account as it is now, after whatever waited ahead of this in its queue, such as its deletion.
        const current = this.find(accountId)
        if (await this.heldElsewhere(current)) {
          throw new RemoteError('ecommerce-accounts/browser-busy', 'Another Chrome is using this account\'s browser data', { accountId })
        }
        const port = await this.ensureChrome(current, chrome, false, 'about:blank')
        const cdp = await Cdp.connect(port, this.options.chromeTimeoutMs)
        try {
          return await showSignIn(cdp, spec.loginUrl)
        } finally {
          cdp.close()
        }
      })
    } catch (error) {
      this.signIns.delete(entry.id)
      // Deleted, signed out of the Hub, or held by another Chrome: nothing was opened.
      if (error instanceof RemoteError) {
        this.setStatus(entry.id, before)
        throw error
      }
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
    if (result.kind === 'gone') return this.getState()
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
    await this.checkIdle(() => true)
    return this.getState()
  }

  /**
   * Set the tenant's daily page limit for buyer accounts.
   * @param pages - the most pages a task may open with one buyer account in a calendar day.
   * @returns the state with the new limit.
   * @throws RemoteError `hub-account/signed-out`, or `ecommerce-accounts/invalid-field` for a
   *   limit that is not a whole number from 1 to 1000.
   */
  @Remote
  setBuyerDailyPages(pages: number): Promise<EcommerceAccountsState> {
    return this.serialized(async () => {
      const tenantId = this.requireTenant()
      if (!Number.isInteger(pages) || pages < 1 || pages > MAX_DAILY_PAGES) {
        throw new RemoteError('ecommerce-accounts/invalid-field', `The daily page limit must be a whole number from 1 to ${String(MAX_DAILY_PAGES)}`, { field: 'buyerDailyPages' })
      }
      this.dailyPages = pages
      await this.saveLedger(tenantId)
      this.changed()
      return this.getState()
    })
  }

  /** Check the accounts that match, leaving those signing in or in a task's use to their owners. */
  private async checkIdle(matches: (entry: Entry) => boolean): Promise<void> {
    const idle = this.entries.filter(entry => matches(entry) && !this.signIns.has(entry.id) && !this.leases.has(entry.id))
    await Promise.all(idle.map(entry => this.check(entry)))
  }

  /**
   * Change the account or store name the user entered, such as to the name the platform reports.
   * @param accountId - the account.
   * @param changes - the new account name, store name, or both; a field left out stays.
   * @returns the state with the account renamed.
   * @throws RemoteError `hub-account/signed-out`, `ecommerce-accounts/not-found`,
   *   `ecommerce-accounts/invalid-field`, or `ecommerce-accounts/duplicate`.
   */
  @Remote
  renameAccount(accountId: string, changes: RenameEcommerceAccountInput): Promise<EcommerceAccountsState> {
    return this.serialized(async () => {
      const tenantId = this.requireTenant()
      const entry = this.find(accountId)
      const max = this.options.maxNameLength
      const account = changes.account === undefined ? entry.account : checkName('account', changes.account, max)
      // A buyer account keeps belonging to no store.
      const storeName = changes.storeName === undefined || entry.kind === 'buyer' ? entry.storeName : checkName('storeName', changes.storeName, max)
      const existing = this.entries.find(item => item.id !== entry.id && identity(item) === identity({ ...entry, account }))
      if (existing !== undefined) throw new RemoteError('ecommerce-accounts/duplicate', 'This account is already added', { accountId: existing.id })
      this.entries = this.entries.map(item => item.id === entry.id ? { ...item, account, storeName } : item)
      await this.saveLedger(tenantId)
      this.changed()
      return this.getState()
    })
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
    this.requireIdle(entry)
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
        this.problems.delete(entry.id)
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
   * again minimized, restoring its last session; an account never signed in starts no Chrome. A
   * check that gets no answer, cannot reach the page, or finds the browser data held by another
   * Chrome fails with that problem and keeps the last answer. The check works on the account as it is
   * once its turn comes: one deleted, or of another tenant, while it waited is `gone`, asks nothing,
   * and starts no Chrome.
   */
  private check(entry: Entry): Promise<CheckResult> {
    this.setStatus(entry.id, 'checking')
    return this.queued(entry.id, async () => {
      const now = this.entries.find(item => item.id === entry.id)
      if (now === undefined) return { kind: 'gone' }
      let result: AccountAnswer
      try {
        result = await this.probeAccount(now)
      } catch (error) {
        this.ctx.logger.warn(`ecommerce-accounts: checking ${entry.id} failed: ${String(error)}`)
        result = { kind: 'no-response' }
      }
      return this.serialized(async () => {
        const current = this.entries.find(item => item.id === entry.id)
        // The account was deleted, or the tenant switched, while the platform was asked.
        if (current === undefined) return result
        if (result.kind !== 'signed-in' && result.kind !== 'signed-out') {
          this.problems.set(entry.id, PROBLEMS[result.kind])
          this.statuses.set(entry.id, 'check-failed')
          this.changed()
          return result
        }
        const { signedInAs: _name, signedInStore: _store, ...rest } = current
        const next: Entry = {
          ...rest, checkedAt: new Date().toISOString(),
          ...result.kind === 'signed-in'
            ? {
              everSignedIn: true,
              ...result.name === undefined ? {} : { signedInAs: result.name },
              ...result.store === undefined ? {} : { signedInStore: result.store },
            }
            : {},
        }
        this.entries = this.entries.map(item => item.id === entry.id ? next : item)
        await this.saveLedger(this.requireTenant())
        // The check time changed even when the status did not.
        this.statuses.set(entry.id, result.kind)
        this.changed()
        return result
      })
    })
  }

  private async probeAccount(entry: Entry): Promise<AccountAnswer> {
    const dir = this.dirOf(entry.id)
    const record = await readRecord(dir)
    let port = record !== undefined && await alive(record.port) ? record.port : undefined
    // A Chrome started here in the background is minimized whatever the platform answers.
    const started = port === undefined
    if (port === undefined) {
      if (entry.everSignedIn !== true || this.chrome === undefined) return { kind: 'signed-out' }
      if (await profileHolder(dir) !== undefined) return { kind: 'busy' }
      port = await this.ensureChrome(entry, this.chrome, true, 'about:blank')
    }
    await ensureTab(port)
    const cdp = await Cdp.connect(port, this.options.chromeTimeoutMs)
    try {
      const spec = specOf(entry.platform, entry.kind)
      let result = await probe(cdp, spec, this.options.checkTimeoutMs)
      if (result.kind !== 'signed-in') result = await probe(cdp, spec, this.options.checkTimeoutMs)
      if (started || result.kind === 'signed-in') await hideWindows(cdp)
      return result
    } finally {
      cdp.close()
    }
  }

  /** Answer `dsh-ecommerce accounts`: the tenant's accounts, without anything secret. */
  private modelAccounts(grant: Grant): Promise<BridgeReply> {
    if (grant.tenantId !== this.tenantId) return Promise.resolve(refused(SIGNED_OUT_OF_HUB))
    const accounts = this.entries.map((entry) => {
      const view = this.view(entry)
      return {
        id: view.id, platform: view.platform, ...view.storeName === undefined ? {} : { store: view.storeName }, account: view.account,
        kind: view.kind, status: view.status,
        ...view.problem === undefined ? {} : { problem: view.problem },
        ...view.kind === 'buyer' ? { pagesToday: view.pagesToday, pageLimit: this.pageLimit() } : {},
        ...view.cooldownUntil === undefined ? {} : { cooldownUntil: view.cooldownUntil },
      }
    })
    return Promise.resolve({ status: 200, body: JSON.stringify(accounts, null, 2) })
  }

  /** Answer `dsh-ecommerce memory`: the tenant's publishing memory. */
  private async modelMemory(grant: Grant): Promise<BridgeReply> {
    if (grant.tenantId !== this.tenantId) return refused(SIGNED_OUT_OF_HUB)
    try {
      return { status: 200, body: JSON.stringify(await readMemory(this.memoryPath(grant.tenantId)), null, 2) }
    } catch (error) {
      return damaged(error)
    }
  }

  /**
   * Answer `dsh-ecommerce remember <file>`: merge the file's entries into the tenant's publishing memory.
   * @returns the memory after the change, or why the file was refused.
   */
  private modelRemember(grant: Grant, body: string): Promise<BridgeReply> {
    // Checked in the queue, so a switch of tenant queued ahead of this write signs the call's tenant out.
    return this.serialized(async () => {
      if (grant.tenantId !== this.tenantId) return refused(SIGNED_OUT_OF_HUB)
      let json: unknown
      try {
        json = JSON.parse(body)
      } catch (error) {
        return refused(`DSH: what to remember is not JSON: ${(error as Error).message}`)
      }
      const update = MemoryUpdate.safeParse(json)
      if (!update.success) {
        const problems = update.error.issues.map(issue => `${issue.path.join('.') || '(top level)'}: ${issue.message}`)
        return refused(`DSH: nothing was remembered, the file is not as described: ${problems.join('; ')}`)
      }
      const path = this.memoryPath(grant.tenantId)
      let memory
      try {
        memory = applyUpdate(await readMemory(path), update.data, new Date().toISOString())
      } catch (error) {
        return damaged(error)
      }
      await writeJsonAtomic(path, memory)
      return { status: 200, body: JSON.stringify(memory, null, 2) }
    })
  }

  private memoryPath(tenantId: string): string {
    return join(this.root, tenantId, 'publish-memory.json')
  }

  /** Answer `dsh-ecommerce browser <id>`: take over that account's browser for the call. */
  private async modelBrowser(grant: Grant, accountId: string): Promise<BridgeReply> {
    if (grant.tenantId !== this.tenantId) return refused(SIGNED_OUT_OF_HUB)
    const entry = this.entries.find(item => item.id === accountId)
    if (entry === undefined) return refused(`DSH: there is no e-commerce account "${accountId}". Run dsh-ecommerce accounts to list them.`)
    const result = await this.takeOver(grant, entry)
    return 'reply' in result ? result.reply : refused(`DSH: ${result.refusal}`)
  }

  /**
   * Answer `dsh-ecommerce buyer [platform]`: take over the buyer account that can be used and has
   * opened the fewest pages today, or say why none can.
   */
  private async modelBuyer(grant: Grant, platform: string): Promise<BridgeReply> {
    if (grant.tenantId !== this.tenantId) return refused(SIGNED_OUT_OF_HUB)
    if (platform !== '' && platform !== 'tmall' && platform !== 'taobao') {
      return refused(`DSH: buyer accounts are on tmall and taobao, not "${platform}".`)
    }
    const buyers = this.entries
      .filter(entry => entry.kind === 'buyer' && (platform === '' || entry.platform === platform))
      .sort((a, b) => this.pagesToday(a) - this.pagesToday(b))
    if (buyers.length === 0) {
      return refused('DSH: there is no buyer account for this. Stop, and ask the user to add one in DSH Settings → E-commerce accounts (设置 → 电商账号).')
    }
    const refusals: string[] = []
    for (const entry of buyers) {
      const result = await this.takeOver(grant, entry)
      if ('reply' in result) return result.reply
      refusals.push(`- ${result.refusal}`)
    }
    return refused(['DSH: no buyer account can be used now. Stop, and tell the user why:', ...refusals].join('\n'))
  }

  /**
   * Reserve an account's browser for a bash call, check that the account is still signed in, put
   * DSH's watch on the browser, and hand over its DevTools address. A buyer account resting after
   * the platform's risk control, or out of pages for today, is refused first; a failed check ends
   * the reservation.
   */
  private async takeOver(grant: Grant, entry: Entry): Promise<{ readonly reply: BridgeReply } | { readonly refusal: string }> {
    const name = this.nameOf(entry)
    if (this.signIns.has(entry.id)) return { refusal: `the ${name} is being signed in in DSH Settings. Tell the user and stop.` }
    const lease = this.leases.get(entry.id)
    if (lease !== undefined && lease.callId !== grant.callId) {
      return { refusal: `the ${name} is in use by another task. Tell the user and stop; do not switch to another account.` }
    }
    const resting = this.cooldownOf(entry)
    if (resting !== undefined) {
      return { refusal: `the ${name} is resting after the platform's risk control until ${resting}. Do not use it before then.` }
    }
    if (entry.kind === 'buyer' && this.pagesToday(entry) >= this.pageLimit()) {
      return { refusal: `the ${name} has opened its ${String(this.pageLimit())} pages for today. It can be used again tomorrow.` }
    }
    const held = lease ?? { callId: grant.callId }
    this.leases.set(entry.id, held)
    this.changed()
    const result = await this.check(entry)
    // The tenant switched while the platform was asked: the account is not this tenant's any more.
    if (grant.tenantId !== this.tenantId) return { refusal: SIGNED_OUT_OF_HUB.slice('DSH: '.length) }
    if (result.kind === 'gone') {
      this.leases.delete(entry.id)
      this.changed()
      return { refusal: `the ${name} was deleted in DSH Settings. Tell the user and stop; do not switch to another account.` }
    }
    if (result.kind !== 'signed-in') {
      if (lease === undefined) this.leases.delete(entry.id)
      this.changed()
      return {
        refusal: result.kind === 'signed-out'
          ? `the ${name} is signed out. Stop, and ask the user to sign in again in DSH Settings → E-commerce accounts (设置 → 电商账号).`
          : `the ${name} could not be checked: ${PROBLEM_TEXT[PROBLEMS[result.kind]]}. Stop, and tell the user; they can check it in DSH Settings → E-commerce accounts (设置 → 电商账号).`,
      }
    }
    // A signed-in check leaves the account's Chrome running and recorded.
    const { port } = await readRecord(this.dirOf(entry.id)) as { port: number }
    held.stop ??= await guardBrowser(port, this.options.chromeTimeoutMs, this.rulesFor(entry))
    const reply = {
      id: entry.id, platform: entry.platform, kind: entry.kind, ...entry.storeName === '' ? {} : { store: entry.storeName }, account: entry.account,
      cdpUrl: `http://127.0.0.1:${String(port)}`,
      ...entry.kind === 'buyer' ? { pagesLeft: this.pageLimit() - this.pagesToday(entry) } : {},
    }
    return { reply: { status: 200, body: JSON.stringify(reply, null, 2) } }
  }

  /**
   * What DSH's watch allows a task with an account: a merchant account opens no public product or
   * search page; a buyer account opens at most the day's pages left, each counted, and rests after
   * the platform's risk control shows.
   */
  private rulesFor(entry: Entry): GuardRules {
    if (entry.kind === 'merchant') return { page: url => !PUBLIC_PAGE.test(url), risk: () => {} }
    // The watch ends before its account can be deleted or its tenant switched, so the account is always listed.
    const current = (): Entry => this.entries.find(item => item.id === entry.id) as Entry
    return {
      page: () => {
        const account = current()
        if (this.pagesToday(account) >= this.pageLimit()) return false
        this.updateEntry({ ...account, usage: { date: today(), pages: this.pagesToday(account) + 1 } })
        return true
      },
      risk: (url) => {
        this.ctx.logger.warn(`ecommerce-accounts: risk control on ${entry.id} at ${url}`)
        this.rest(current())
      },
    }
  }

  /** Rest a buyer account for `cooldownHours` from now. */
  private rest(entry: Entry): Entry {
    const rested = { ...entry, cooldownUntil: new Date(Date.now() + this.options.cooldownHours * 3_600_000).toISOString() }
    this.updateEntry(rested)
    return rested
  }

  /**
   * Answer `dsh-ecommerce risk <id>`: a script met the platform's risk control through its APIs, which
   * DSH's watch does not see, so the buyer account this call took over rests like after a risk page.
   */
  private modelRisk(grant: Grant, accountId: string): Promise<BridgeReply> {
    if (grant.tenantId !== this.tenantId) return Promise.resolve(refused(SIGNED_OUT_OF_HUB))
    const entry = this.entries.find(item => item.id === accountId)
    if (entry === undefined || entry.kind !== 'buyer' || this.leases.get(entry.id)?.callId !== grant.callId) {
      return Promise.resolve(refused(`DSH: risk control can only be reported for a buyer account this shell call took over, not "${accountId}".`))
    }
    this.ctx.logger.warn(`ecommerce-accounts: risk control reported by a script on ${entry.id}`)
    const rested = this.rest(entry)
    const body = JSON.stringify({ id: rested.id, account: rested.account, cooldownUntil: rested.cooldownUntil }, null, 2)
    return Promise.resolve({ status: 200, body })
  }

  /** Replace an account's ledger row now, and save it. */
  private updateEntry(next: Entry): void {
    this.entries = this.entries.map(item => item.id === next.id ? next : item)
    this.changed()
    const tenantId = this.tenantId as string
    void this.serialized(() => this.saveLedger(tenantId))
  }

  /** End the reservations that match, and DSH's watch on their browsers. */
  private endLeases(matches: (lease: { readonly callId: string }) => boolean): void {
    for (const [accountId, lease] of this.leases) {
      if (!matches(lease)) continue
      lease.stop?.()
      this.leases.delete(accountId)
    }
  }

  /** How an account is named in what the model reads. */
  private nameOf(entry: Entry): string {
    return entry.kind === 'buyer'
      ? `${PLATFORM_NAMES[entry.platform]} buyer account "${entry.account}"`
      : `${PLATFORM_NAMES[entry.platform]} account "${entry.storeName}"`
  }

  /** The tenant's daily page limit for buyer accounts. */
  private pageLimit(): number {
    return this.dailyPages ?? this.options.buyerDailyPages
  }

  /** Pages tasks opened with an account today. */
  private pagesToday(entry: Entry): number {
    return entry.usage?.date === today() ? entry.usage.pages : 0
  }

  /** When an account's rest after the platform's risk control ends, while it lasts. */
  private cooldownOf(entry: Entry): string | undefined {
    return entry.cooldownUntil !== undefined && Date.parse(entry.cooldownUntil) > Date.now() ? entry.cooldownUntil : undefined
  }

  /** Refuse to sign in to or delete an account a task is using. */
  private requireIdle(entry: Entry): void {
    if (this.leases.has(entry.id)) throw new RemoteError('ecommerce-accounts/in-use', 'A task is using this account now', { accountId: entry.id })
  }

  /** Whether a Chrome that DSH did not start holds the account's browser data. */
  private async heldElsewhere(entry: Entry): Promise<boolean> {
    const dir = this.dirOf(entry.id)
    const record = await readRecord(dir)
    if (record !== undefined && await alive(record.port)) return false
    return await profileHolder(dir) !== undefined
  }

  /** Whether the signed-in tenant still has the account. */
  private listed(accountId: string): boolean {
    return this.entries.some(item => item.id === accountId)
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
    // Every listed account gets a status when it is added or loaded, and a problem whenever a check fails.
    const status = this.statuses.get(entry.id) as EcommerceAccountStatus
    const cooldownUntil = this.cooldownOf(entry)
    return {
      id: entry.id, platform: entry.platform, kind: entry.kind, ...entry.storeName === '' ? {} : { storeName: entry.storeName }, account: entry.account,
      createdAt: entry.createdAt, status, expired: status === 'signed-out' && entry.everSignedIn === true, inUse: this.leases.has(entry.id),
      ...entry.kind === 'buyer' ? { pagesToday: this.pagesToday(entry) } : {},
      ...cooldownUntil === undefined ? {} : { cooldownUntil },
      ...status === 'check-failed' ? { problem: this.problems.get(entry.id) as EcommerceCheckProblem } : {},
      ...(entry.signedInAs === undefined ? {} : { signedInAs: entry.signedInAs }),
      ...(entry.signedInStore === undefined ? {} : { signedInStore: entry.signedInStore }),
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
    this.endLeases(() => true)
    if (tenantId === null) {
      this.skill?.()
      this.skill = undefined
    } else {
      this.skill ??= this.ctx.skills.register({
        name: SKILL_NAME, description: SKILL_DESCRIPTION, source: SKILL_NAME, content: SKILL_CONTENT,
      })
    }
    this.tenantId = tenantId
    this.entries = []
    this.dailyPages = undefined
    this.statuses.clear()
    this.problems.clear()
    if (tenantId !== null) {
      // A tenant that never added an account has no ledger yet.
      const raw = await readFile(join(this.root, tenantId, 'accounts.json'), 'utf8').catch(() => undefined)
      const parsed = raw === undefined ? undefined : ledgerSchema.safeParse(JSON.parse(raw))
      if (parsed?.success === false) this.ctx.logger.warn(`ecommerce-accounts: ignored malformed ${join(this.root, tenantId, 'accounts.json')}`)
      this.entries = parsed?.success === true ? parsed.data.accounts : []
      this.dailyPages = parsed?.success === true ? parsed.data.buyerDailyPages : undefined
    }
    this.changed()
    // Each account is checked in the background: a Chrome still running from an earlier DSH is reattached.
    for (const entry of this.entries) void this.check(entry)
  }

  private dirOf(accountId: string): string {
    return join(this.root, this.requireTenant(), 'browsers', accountId)
  }

  private async saveLedger(tenantId: string): Promise<void> {
    const ledger = { version: 1, accounts: this.entries, ...this.dailyPages === undefined ? {} : { buyerDailyPages: this.dailyPages } }
    await writeJsonAtomic(join(this.root, tenantId, 'accounts.json'), ledger)
  }

  private setStatus(accountId: string, status: EcommerceAccountStatus): void {
    // A deleted account keeps no status.
    if (!this.listed(accountId) || this.statuses.get(accountId) === status) return
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
