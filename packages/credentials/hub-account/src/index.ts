/**
 * Hub sign-in: the user center's OAuth2 authorization code flow with PKCE (`S256`) as a public
 * client, received on a loopback callback (`http://127.0.0.1:<random port>/callback`) after the
 * human signs in in the system browser. The grant lives in the credential store and never leaves
 * the Host; the access token is refreshed before it expires. While signed out, new prompts are
 * refused; running turns continue. After each sign-in, and at startup while signed in, the tenant's
 * login-page branding is fetched and cached under `<dshHome>/cache/hub-branding` for the Desktop
 * welcome window and sidebar.
 *
 * @module @deepseek-ai/dsh-hub-account
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/types'
import type { AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import { credentialKey, type CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { dshCachePath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import Schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { checkedLogo, clearBrandingCache, logoDataUrl, readBrandingCache, writeBrandingCache, type CachedBranding } from './branding.ts'
import type { HubAccountView, HubBrandingStamp, HubBrandingView, HubProfile, HubSignInAttemptView, HubSignInError } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Hub sign-in state, its Remote namespace, and the Host-only access token. */
    hubAccount: HubAccount
  }
}

const KEY = credentialKey('hub-account', 'default')
const CALLBACK_PATH = '/callback'

/** Deployment configuration: which user center, as which registered client. */
export interface Config {
  /** User-center origin serving `/oauth/*`. */
  origin: string
  /** client_id of the public client registered for DSH. */
  clientId: string
  /** Scopes requested at sign-in. */
  scope?: string
  /** Allow an HTTP origin, only on loopback, for development and tests. */
  allowLoopbackHttp?: boolean
  /** Deadline of each user-center HTTP request. */
  requestTimeoutMs?: number
  /** Upper bound of one browser sign-in attempt. */
  attemptTimeoutMs?: number
  /** Refresh the access token this long before it expires. */
  refreshMarginMs?: number
  /** Retry delay after a refresh that failed without a verdict (network, server error). */
  refreshRetryMs?: number
  /** DeepSeek Harness home; the branding cache lives under `<dshHome>/cache/hub-branding`. Defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string
}

/** Validated deployment configuration. */
export const Config: Schema<Config> = Schema.object({
  origin: Schema.string().required(),
  clientId: Schema.string().required(),
  scope: Schema.string().default('profile skills:read skills:write'),
  allowLoopbackHttp: Schema.boolean().default(false),
  requestTimeoutMs: Schema.number().min(1).max(120_000).default(15_000),
  attemptTimeoutMs: Schema.number().min(1).max(3_600_000).default(600_000),
  refreshMarginMs: Schema.number().min(0).max(86_400_000).default(300_000),
  refreshRetryMs: Schema.number().min(1).max(3_600_000).default(60_000),
  dshHome: Schema.string(),
})

const tokenResponse = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
  refresh_token: z.string().min(1),
})
const userinfo = z.object({
  nickname: z.string(),
  phone: z.string(),
  tenantId: z.string().nullable(),
  tenantName: z.string().nullable(),
  isTenantAdmin: z.boolean().nullable(),
})
const clientBranding = z.object({
  tenantId: z.string(),
  title: z.string().nullable(),
  logo: z.object({ contentType: z.string(), sha256: z.string() }).nullable(),
})
const grant = z.object({
  version: z.literal(1),
  issuer: z.string(),
  clientId: z.string(),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.number(),
  profile: userinfo,
})
type Grant = z.infer<typeof grant>

/** The stored grant in this package's format, or undefined for any other record. */
function parseGrant(record: CredentialRecord | undefined): Grant | undefined {
  if (record?.kind !== 'grant') return undefined
  const parsed = grant.safeParse(record.payload)
  return parsed.success ? parsed.data : undefined
}

/** A failure with a sign-in error code; anything else is reported as `protocol`. */
class HubAuthError extends Error {
  constructor(readonly code: HubSignInError) { super(`hub sign-in failed: ${code}`) }
}

/** The user center answered a refresh with a verdict: the grant is no longer usable. */
class RefreshRefused extends Error {}

interface Attempt {
  view: HubSignInAttemptView
  readonly controller: AbortController
  /** Browser response held until the attempt settles, so the page reports the outcome. */
  callback?: ServerResponse | undefined
}

/**
 * Validate the configured origin: HTTPS, or HTTP on loopback when explicitly allowed.
 * @param value - configured origin.
 * @param allowLoopbackHttp - whether loopback HTTP is accepted.
 * @returns the normalized origin.
 */
function hubOrigin(value: string, allowLoopbackHttp: boolean): string {
  const url = new URL(value)
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
    || !(url.protocol === 'https:' || (url.protocol === 'http:' && allowLoopbackHttp && loopback))) {
    throw new Error('hub-account: origin must be an HTTPS origin (HTTP only on loopback with allowLoopbackHttp)')
  }
  return url.origin
}

function page(title: string): string {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${title}</title>`
    + '<body style="font-family:-apple-system,\'PingFang SC\',sans-serif;display:grid;place-items:center;height:90vh">'
    + `<p style="font-size:18px">${title}</p></body></html>`
}

/** Host owner of Hub sign-in and of the `hubAccount` Remote namespace. */
export class HubAccount extends TypertRemoteService {
  static inject = ['credentials', 'authorization']
  static Config = Config

  private readonly origin: string
  private readonly config: Required<Omit<Config, 'origin' | 'dshHome'>>
  private readonly brandingDir: string
  private branding: CachedBranding | undefined
  /** Tenant whose branding was fetched since it signed in; undefined until then and after sign-out. */
  private brandedTenant: string | null | undefined
  /** Latest branding fetch; an older one does not commit. */
  private brandingFetch = 0
  private attempt: Attempt | undefined
  private signedIn = false
  private reason: 'expired' | null = null
  private refreshTimer: ReturnType<typeof setTimeout> | undefined
  private refreshing: Promise<void> | undefined
  private readonly listeners = new Set<() => void>()
  private readonly lifetime = new AbortController()

  /** @param ctx - Host with credentials and authorization. @param config - user center and client. */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'hubAccount', { namespace: 'hubAccount' })
    const resolved = Config(config) as Required<Omit<Config, 'dshHome'>> & Pick<Config, 'dshHome'>
    this.origin = hubOrigin(resolved.origin, resolved.allowLoopbackHttp)
    this.config = resolved
    this.brandingDir = dshCachePath({ dshHome: resolveDshHome(resolved.dshHome) }, 'hub-branding')
    ctx.authorization.registerFlow({
      key: KEY, label: 'Skill Hub', methods: [{ id: 'browser', label: 'Skill Hub' }],
      run: session => this.run(session),
    })
    ctx.on('credentials/record-updated', (key) => {
      if (key === KEY) void this.reload()
    })
    // Refuse new prompts until signed in; running turns and queued work are untouched.
    ctx.on('api-session/prompt-admission', () => this.signedIn
      ? undefined
      : new RemoteError('hub-account/signed-out', 'sign in to the Skill Hub before sending messages', {}))
    ctx.effect(() => () => {
      this.lifetime.abort()
      clearTimeout(this.refreshTimer)
      this.attempt?.controller.abort()
      this.changed()
    }, 'hub-account: lifetime')
  }

  async [Service.init](): Promise<void> {
    this.branding = await readBrandingCache(this.brandingDir, this.origin)
    await this.reload()
  }

  /**
   * Read the sign-in state.
   * @returns status, profile, and the current attempt.
   */
  @Remote
  async getState(): Promise<HubAccountView> {
    const stored = await this.read()
    return {
      status: stored === undefined ? 'signed-out' : 'signed-in',
      profile: stored?.profile ?? null,
      reason: stored === undefined ? this.reason : null,
      attempt: this.attempt?.view ?? null,
      branding: this.shownBranding(stored)?.stamp ?? null,
    }
  }

  /**
   * Read the cached login-page branding to show: signed in, the signed-in tenant's; signed out,
   * the last-signed-in tenant's.
   * @returns the branding, or null when there is none to show.
   */
  @Remote
  async getBranding(): Promise<HubBrandingView | null> {
    const shown = this.shownBranding(await this.read())
    if (shown === undefined) return null
    const { tenantId, title, logo } = shown.branding
    return { tenantId, title, logo: logo === null ? null : logoDataUrl(logo) }
  }

  /**
   * Start a browser sign-in, or join the one already running. The state stream carries the
   * authorization page to open.
   * @returns the state with the attempt.
   */
  @Remote
  async signIn(): Promise<HubAccountView> {
    const active = this.attempt
    if (active !== undefined && (active.view.phase === 'waiting-browser' || active.view.phase === 'exchanging')) return this.getState()
    const attempt: Attempt = { view: { id: randomUUID(), phase: 'waiting-browser' }, controller: new AbortController() }
    this.attempt = attempt
    void this.ctx.authorization.begin({
      key: KEY, signal: attempt.controller.signal,
      // The flow never prompts; the seam still requires an interaction that could answer.
      /* v8 ignore next */
      interaction: { notify: () => undefined, prompt: () => Promise.reject(new HubAuthError('protocol')) },
    }).then((outcome) => {
      this.settle(attempt, outcome.status === 'authorized' ? { phase: 'succeeded' } : { phase: 'cancelled' })
    }, (error: unknown) => {
      const code = error instanceof HubAuthError ? error.code : 'protocol'
      console.info('[hub-account] sign-in failed', { errorCode: code })
      this.settle(attempt, { phase: 'failed', error: code })
    })
    return this.getState()
  }

  /**
   * Cancel the named sign-in attempt.
   * @param attemptId - attempt to cancel.
   * @returns the state after cancellation.
   * @throws RemoteError when the attempt is not the current one.
   */
  @Remote
  async cancelSignIn(attemptId: string): Promise<HubAccountView> {
    const attempt = this.attempt
    if (attempt?.view.id !== attemptId) throw new RemoteError('hub-account/attempt-not-found', 'no such sign-in attempt', { attemptId })
    attempt.controller.abort()
    return this.getState()
  }

  /**
   * Sign out: forget the local grant and revoke it at the user center in the background.
   * Model credentials are untouched.
   * @returns the signed-out state.
   */
  @Remote
  async signOut(): Promise<HubAccountView> {
    const stored = await this.read()
    this.reason = null
    await this.ctx.credentials.deleteRecord(KEY)
    if (stored !== undefined) void this.post('/oauth/revoke', { token: stored.refreshToken, client_id: this.config.clientId }).catch(() => {
      // Local sign-out already took effect; the refresh token also expires on its own.
    })
    return this.getState()
  }

  /**
   * Switch tenant: sign out, then sign in again so the user center offers the tenant choice.
   * @returns the state with the new attempt.
   */
  @Remote
  async switchTenant(): Promise<HubAccountView> {
    await this.signOut()
    return this.signIn()
  }

  /**
   * Stream the sign-in state.
   * @param signal - stream lifetime.
   * @returns the current state, then every change.
   */
  @Remote({ mode: 'stream' })
  async *watch(signal: AbortSignal): AsyncIterable<HubAccountView> {
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
   * The current access token for user-center client APIs, refreshed first when it is due. Host only.
   * @returns the token, or undefined while signed out.
   */
  async accessToken(): Promise<string | undefined> {
    const stored = await this.read()
    if (stored === undefined) return undefined
    if (stored.expiresAt - this.config.refreshMarginMs > Date.now()) return stored.accessToken
    await this.refresh()
    return (await this.read())?.accessToken
  }

  /**
   * Call a user-center client API (`/api/client/*`) as the signed-in employee. Host only: the token
   * never leaves this process. A rejected token is refreshed once and the call retried.
   * @param path - absolute path on the user center, with its query.
   * @param init - fetch options; its signal cancels the call.
   * @returns the user center's response, whatever its status.
   * @throws RemoteError `hub-account/signed-out` when no sign-in is stored.
   */
  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const send = async (): Promise<Response> => {
      const token = await this.accessToken()
      if (token === undefined) throw new RemoteError('hub-account/signed-out', 'sign in to the Skill Hub first', {})
      return fetch(new URL(path, this.origin), {
        ...init, redirect: 'error', headers: { ...init.headers as Record<string, string> | undefined, authorization: `Bearer ${token}` },
        signal: AbortSignal.any([this.lifetime.signal, ...init.signal ? [init.signal] : []]),
      })
    }
    const res = await send()
    if (res.status !== 401) return res
    await this.refresh()
    return send()
  }

  private changed(): void { for (const listener of this.listeners) listener() }

  private shownBranding(stored: Grant | undefined): { branding: CachedBranding; stamp: HubBrandingStamp } | undefined {
    const branding = this.branding
    if (branding === undefined || (stored !== undefined && stored.profile.tenantId !== branding.tenantId)) return undefined
    return { branding, stamp: { tenantId: branding.tenantId, title: branding.title, logoSha256: branding.logo?.sha256 ?? null } }
  }

  /**
   * Fetch the signed-in tenant's branding and replace the cache; a tenant that set nothing clears
   * it, and a logo that fails its checks is left out. A failed fetch keeps the cache when it is
   * this tenant's and clears another tenant's, which must not stand in for it after sign-out.
   * @param tenant - the signed-in tenant.
   */
  private async refreshBranding(tenant: string | null): Promise<void> {
    const run = ++this.brandingFetch
    let next: CachedBranding | undefined
    try {
      next = await this.fetchBranding()
    } catch (error) {
      if (this.lifetime.signal.aborted) return
      console.info('[hub-account] branding refresh failed', { error: String(error) })
      if (this.branding === undefined || this.branding.tenantId === tenant) return
      next = undefined
    }
    if (run !== this.brandingFetch) return
    try {
      if (next === undefined) await clearBrandingCache(this.brandingDir)
      else await writeBrandingCache(this.brandingDir, this.origin, next)
    } catch (error) {
      // The branding still shows for this run; the next start reads what the disk holds.
      console.info('[hub-account] branding cache not written', { error: String(error) })
    }
    this.branding = next
    this.changed()
  }

  /** The signed-in tenant's branding, or undefined when it set nothing; throws when the user center does not answer it. */
  private async fetchBranding(): Promise<CachedBranding | undefined> {
    const res = await this.request('/api/client/branding', { signal: AbortSignal.timeout(this.config.requestTimeoutMs) })
    if (!res.ok) {
      await res.body?.cancel()
      throw new Error(`branding answered ${String(res.status)}`)
    }
    const fetched = clientBranding.parse(await res.json())
    let logo: CachedBranding['logo'] = null
    if (fetched.logo !== null) {
      logo = this.branding?.logo?.sha256 === fetched.logo.sha256 ? this.branding.logo : await this.downloadLogo(fetched.logo)
    }
    return fetched.title === null && logo === null ? undefined : { tenantId: fetched.tenantId, title: fetched.title, logo }
  }

  /**
   * The logo the branding names, or null when it does not match its declared type, size and hash.
   * @throws when the user center does not answer the download.
   */
  private async downloadLogo(declared: { contentType: string; sha256: string }): Promise<CachedBranding['logo']> {
    // A fixed path on the user center: the access token never follows a URL from the response.
    const res = await this.request('/api/client/branding/logo', { signal: AbortSignal.timeout(this.config.requestTimeoutMs) })
    if (!res.ok) {
      await res.body?.cancel()
      throw new Error(`branding logo answered ${String(res.status)}`)
    }
    const contentType = (res.headers.get('content-type') ?? '').replace(/;.*$/su, '').trim()
    if (contentType !== declared.contentType) {
      await res.body?.cancel()
      console.info('[hub-account] branding logo refused', { contentType })
      return null
    }
    const logo = checkedLogo(contentType, declared.sha256, Buffer.from(await res.arrayBuffer()))
    if (logo === undefined) console.info('[hub-account] branding logo refused: size or sha256 mismatch')
    return logo ?? null
  }

  private settle(attempt: Attempt, view: Partial<HubSignInAttemptView>): void {
    const { authorizeUrl: _url, ...rest } = attempt.view
    attempt.view = { ...rest, ...view }
    attempt.callback?.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', connection: 'close' })
      .end(page(attempt.view.phase === 'succeeded' ? '登录成功，可以关闭此页面回到 DSH' : '登录未完成，请回到 DSH 重试'))
    attempt.callback = undefined
    this.changed()
  }

  private async read(): Promise<Grant | undefined> {
    const stored = parseGrant(await this.ctx.credentials.readRecord(KEY))
    // A grant from another user center or client cannot be refreshed here.
    return stored?.issuer === this.origin && stored.clientId === this.config.clientId ? stored : undefined
  }

  /** Re-read the record after any change: update the prompt gate, reschedule refresh, notify. */
  private async reload(): Promise<void> {
    const stored = await this.read()
    this.signedIn = stored !== undefined
    clearTimeout(this.refreshTimer)
    if (stored === undefined) this.brandedTenant = undefined
    if (stored !== undefined && !this.lifetime.signal.aborted) {
      this.reason = null
      this.schedule(stored.expiresAt - this.config.refreshMarginMs - Date.now())
      // Once per sign-in (token refreshes rewrite the record too); a new sign-in fetches again.
      if (this.brandedTenant !== stored.profile.tenantId) {
        this.brandedTenant = stored.profile.tenantId
        void this.refreshBranding(stored.profile.tenantId)
      }
    }
    this.changed()
  }

  private schedule(delay: number): void {
    clearTimeout(this.refreshTimer)
    this.refreshTimer = setTimeout(() => { void this.refresh() }, Math.max(0, delay))
  }

  /** Refresh once at a time; a verdict signs out, a transient failure retries later. */
  private refresh(): Promise<void> {
    this.refreshing ??= (async () => {
      try {
        await this.ctx.credentials.modifyRecord(KEY, async (current) => {
          const stored = parseGrant(current)
          // Signed out between scheduling and this write: nothing to refresh.
          /* v8 ignore next */
          if (stored === undefined) return undefined
          const tokens = await this.token({ grant_type: 'refresh_token', refresh_token: stored.refreshToken, client_id: this.config.clientId })
          return { kind: 'grant', payload: { ...stored, ...tokens } }
        })
      } catch (error) {
        if (error instanceof RefreshRefused) {
          console.info('[hub-account] refresh refused; signing out')
          this.reason = 'expired'
          this.signedIn = false
          await this.ctx.credentials.deleteRecord(KEY)
          this.ctx.emit('hub-account/session-expired')
          this.changed()
        } else if (!this.lifetime.signal.aborted) {
          console.info('[hub-account] refresh failed; retrying')
          this.schedule(this.config.refreshRetryMs)
        }
      } finally {
        this.refreshing = undefined
      }
    })()
    return this.refreshing
  }

  /** The browser half: loopback callback, PKCE, code exchange, userinfo, commit. */
  private async run(session: AuthorizationSession): Promise<void> {
    const attempt = this.attempt
    if (attempt === undefined) throw new HubAuthError('protocol')
    const verifier = randomBytes(32).toString('base64url')
    const state = randomBytes(32).toString('base64url')
    const deadline = AbortSignal.timeout(this.config.attemptTimeoutMs)
    const signal = AbortSignal.any([session.signal, deadline])
    const code = Promise.withResolvers<string>()
    void code.promise.catch(() => undefined)
    const abort = (): void => { code.reject(new HubAuthError(deadline.aborted ? 'expired' : 'protocol')) }
    signal.addEventListener('abort', abort, { once: true })
    const server: Server = createServer((req, res) => {
      const url = new URL(String(req.url), 'http://127.0.0.1')
      const received = url.searchParams.get('state') ?? ''
      const validState = Buffer.byteLength(received) === Buffer.byteLength(state)
        && timingSafeEqual(Buffer.from(received), Buffer.from(state))
      if (req.method !== 'GET' || url.pathname !== CALLBACK_PATH || !validState) {
        res.writeHead(400, { 'cache-control': 'no-store' }).end(); return
      }
      if (attempt.callback !== undefined || attempt.view.phase !== 'waiting-browser') {
        res.writeHead(410, { 'cache-control': 'no-store' }).end(); return
      }
      attempt.callback = res
      const error = url.searchParams.get('error')
      const value = url.searchParams.get('code')
      if (error !== null || value === null) code.reject(new HubAuthError(error === 'access_denied' ? 'denied' : 'protocol'))
      else code.resolve(value)
    })
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject).listen(0, '127.0.0.1', resolve) })
      const port = (server.address() as { port: number }).port
      const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`
      const authorizeUrl = new URL('/oauth/authorize', this.origin)
      authorizeUrl.search = new URLSearchParams({
        response_type: 'code', client_id: this.config.clientId, redirect_uri: redirectUri, state, scope: this.config.scope,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
      }).toString()
      attempt.view = { ...attempt.view, authorizeUrl: authorizeUrl.href }
      session.notify({ message: 'Continue in your browser', url: authorizeUrl.href })
      this.changed()
      const received = await code.promise
      attempt.view = { id: attempt.view.id, phase: 'exchanging' }
      this.changed()
      const tokens = await this.token({ grant_type: 'authorization_code', code: received, redirect_uri: redirectUri, client_id: this.config.clientId, code_verifier: verifier }, signal)
        .catch((error: unknown) => { throw error instanceof RefreshRefused ? new HubAuthError('protocol') : error })
      const profile = await this.userinfo(tokens.accessToken, signal)
      const payload: Grant = { version: 1, issuer: this.origin, clientId: this.config.clientId, ...tokens, profile }
      try { await session.commit({ kind: 'grant', payload }) } catch { throw new HubAuthError('storage') }
    } catch (error) {
      // The attempt's own deadline reports as expired wherever it interrupted the flow.
      if (deadline.aborted) throw new HubAuthError('expired')
      throw error
    } finally {
      signal.removeEventListener('abort', abort)
      // Stop accepting; the held callback response is answered by settle() once the attempt ends.
      server.close()
      server.closeIdleConnections()
    }
  }

  private async token(body: Record<string, string>, signal?: AbortSignal): Promise<Pick<Grant, 'accessToken' | 'refreshToken' | 'expiresAt'>> {
    const res = await this.post('/oauth/token', body, signal)
    if (res.status === 400 || res.status === 401) throw new RefreshRefused()
    if (!res.ok) throw new HubAuthError('network')
    const parsed = tokenResponse.safeParse(await res.json())
    if (!parsed.success) throw new HubAuthError('protocol')
    const { access_token: accessToken, refresh_token: refreshToken, expires_in: expiresIn } = parsed.data
    return { accessToken, refreshToken, expiresAt: Date.now() + expiresIn * 1000 }
  }

  private async userinfo(accessToken: string, signal: AbortSignal): Promise<HubProfile> {
    const res = await this.fetch('/oauth/userinfo', { headers: { authorization: `Bearer ${accessToken}` } }, signal)
    if (!res.ok) throw new HubAuthError('protocol')
    const parsed = userinfo.safeParse(await res.json())
    if (!parsed.success) throw new HubAuthError('protocol')
    return parsed.data
  }

  private post(path: string, body: Record<string, string>, signal?: AbortSignal): Promise<Response> {
    return this.fetch(path, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString(),
    }, signal)
  }

  private async fetch(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    try {
      return await fetch(new URL(path, this.origin), {
        ...init, redirect: 'error',
        signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.config.requestTimeoutMs), ...signal ? [signal] : []]),
      })
    } catch (error) {
      if (signal?.aborted === true) throw error
      throw new HubAuthError('network')
    }
  }
}

export default HubAccount
