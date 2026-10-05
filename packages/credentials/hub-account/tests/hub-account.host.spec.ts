/** Hub sign-in against a mock user center over a real credential store and authorization seam. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { remoteErrorOf, remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import HubAccount, { type Config, type HubAccountView } from '../src/index.ts'
import { browse, startMockUserCenter, type MockUserCenter } from './mock-user-center.ts'

const KEY = credentialKey('hub-account', 'default')
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function boot(options: Partial<Config> = {}, mock?: MockUserCenter) {
  const center = mock ?? await startMockUserCenter()
  if (mock === undefined) cleanups.push(() => center.close())
  const home = await mkdtemp(join(tmpdir(), 'dsh-hub-account-'))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  const ctx = new Context()
  const credentials = ctx.plugin(LocalCredentialProvider, { path: join(home, 'credentials.yaml'), watch: false })
  await credentials
  const authorization = ctx.plugin(AuthorizationService)
  await authorization
  const fiber = ctx.plugin(HubAccount, {
    origin: center.origin, clientId: center.clientId, allowLoopbackHttp: true, dshHome: home, ...options,
  })
  await fiber
  cleanups.push(async () => { await fiber.dispose(); await authorization.dispose(); await credentials.dispose() })
  const hub = ctx.get('hubAccount')!
  const states = new AbortController()
  cleanups.push(async () => { states.abort() })
  const stream = hub.watch(states.signal)[Symbol.asyncIterator]()
  /** Wait for the first state that satisfies the predicate. */
  const until = async (predicate: (view: HubAccountView) => boolean): Promise<HubAccountView> => {
    for (;;) {
      const next = await stream.next()
      if (next.done === true) throw new Error('state stream ended')
      if (predicate(next.value)) return next.value
    }
  }
  /** Start sign-in and play the browser through it. */
  const signIn = async () => {
    await hub.signIn()
    const waiting = await until(view => view.attempt?.authorizeUrl !== undefined)
    const page = await browse(waiting.attempt!.authorizeUrl!)
    const settled = await until(view => view.attempt?.phase !== 'waiting-browser' && view.attempt?.phase !== 'exchanging')
    return { waiting, page, settled }
  }
  return { ctx, hub, center, home, fiber, until, signIn }
}

describe('hubAccount', () => {
  it('publishes the namespace and its methods', async () => {
    const { hub } = await boot()
    expect(hub.typertRemote.namespace).toBe('hubAccount')
    expect(remoteMethods(hub).map(method => method.method)).toEqual(['getState', 'getBranding', 'signIn', 'cancelSignIn', 'signOut', 'switchTenant', 'watch'])
  })

  it('starts signed out and refuses new prompts', async () => {
    const { ctx, hub } = await boot()
    expect(await hub.getState()).toEqual({ status: 'signed-out', profile: null, reason: null, attempt: null, branding: null })
    expect(remoteErrorOf(ctx.bail('api-session/prompt-admission', 'session-1' as never))).toMatchObject({ code: 'hub-account/signed-out' })
  })

  it('signs in with PKCE S256 over a loopback callback and stores the grant on the Host only', async () => {
    const { ctx, hub, center, home, signIn } = await boot()
    const { waiting, page, settled } = await signIn()
    const query = new URL(waiting.attempt!.authorizeUrl!).searchParams
    expect(Object.fromEntries(query)).toMatchObject({
      response_type: 'code', client_id: 'dsh-desktop', scope: 'profile skills:read skills:write', code_challenge_method: 'S256',
    })
    expect(query.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    expect(query.get('code_challenge')).toMatch(/^[\w-]{43}$/)
    const exchange = center.tokenRequests[0]!
    expect(Object.fromEntries(exchange)).toMatchObject({ grant_type: 'authorization_code', client_id: 'dsh-desktop', redirect_uri: query.get('redirect_uri') })
    expect(exchange.get('code_verifier')).toMatch(/^[\w-]{43}$/)
    expect(page.text).toContain('登录成功')
    expect(settled).toEqual({
      status: 'signed-in', reason: null, attempt: { id: settled.attempt!.id, phase: 'succeeded' }, branding: null,
      profile: { nickname: '李雷', phone: '138****0001', tenantId: 't-a', tenantName: '甲公司', isTenantAdmin: false },
    })
    expect(JSON.stringify(settled)).not.toMatch(/at-|rt-/)
    expect(await readFile(join(home, 'credentials.yaml'), 'utf8')).toContain('hub-account')
    expect(await hub.accessToken()).toMatch(/^at-/)
    expect(ctx.bail('api-session/prompt-admission', 'session-1' as never)).toBeUndefined()
    // The callback port closes with the attempt.
    await expect(fetch(query.get('redirect_uri')!)).rejects.toThrow()
  })

  it('reports a denied consent as a failed attempt and stays signed out', async () => {
    const { center, signIn } = await boot()
    center.denyWith = 'access_denied'
    const { page, settled } = await signIn()
    expect(page.text).toContain('登录未完成')
    expect(settled).toMatchObject({ status: 'signed-out', attempt: { phase: 'failed', error: 'denied' } })
  })

  it('rejects a callback with the wrong state and keeps waiting', async () => {
    const { hub, until } = await boot()
    await hub.signIn()
    const waiting = await until(view => view.attempt?.authorizeUrl !== undefined)
    const callback = new URL(new URL(waiting.attempt!.authorizeUrl!).searchParams.get('redirect_uri')!)
    callback.search = 'code=forged&state=wrong'
    expect((await fetch(callback)).status).toBe(400)
    expect((await hub.getState()).attempt).toMatchObject({ phase: 'waiting-browser' })
  })

  it('ends an attempt the browser never completes as expired', async () => {
    const { hub, until } = await boot({ attemptTimeoutMs: 200 })
    await hub.signIn()
    expect(await until(view => view.attempt?.phase === 'failed')).toMatchObject({ status: 'signed-out', attempt: { error: 'expired' } })
  })

  it('cancels a waiting attempt and closes its callback', async () => {
    const { hub, until } = await boot()
    await hub.signIn()
    const waiting = await until(view => view.attempt?.authorizeUrl !== undefined)
    await hub.cancelSignIn(waiting.attempt!.id)
    expect(await until(view => view.attempt?.phase === 'cancelled')).toMatchObject({ status: 'signed-out' })
    await expect(fetch(new URL(waiting.attempt!.authorizeUrl!).searchParams.get('redirect_uri')!)).rejects.toThrow()
    expect(remoteErrorOf(await hub.cancelSignIn('missing').catch((error: unknown) => error))).toMatchObject({ code: 'hub-account/attempt-not-found' })
  })

  it('joins the running attempt instead of starting a second one', async () => {
    const { hub, until } = await boot()
    const first = await hub.signIn()
    await until(view => view.attempt?.authorizeUrl !== undefined)
    expect((await hub.signIn()).attempt?.id).toBe(first.attempt?.id)
  })

  it('refreshes the access token before it expires, rotating the refresh token', async () => {
    const { hub, center, signIn, until } = await boot({ refreshMarginMs: 1_900 })
    center.expiresIn = 2
    await signIn()
    const before = await hub.accessToken()
    await expect.poll(() => center.tokenRequests.filter(request => request.get('grant_type') === 'refresh_token').length, { timeout: 3_000 }).toBeGreaterThan(0)
    await until(view => view.status === 'signed-in')
    await expect.poll(async () => (await hub.getState()).status).toBe('signed-in')
    expect(await hub.accessToken()).not.toBe(before)
  })

  it('returns to the gate when the user center refuses the refresh, and admits prompts again after signing in', async () => {
    const { ctx, center, signIn, until } = await boot({ refreshMarginMs: 1_900 })
    const expired: unknown[] = []
    ctx.on('hub-account/session-expired', () => { expired.push(true) })
    center.expiresIn = 2
    await signIn()
    center.refreshStatus = 400
    expect(await until(view => view.status === 'signed-out')).toMatchObject({ reason: 'expired', profile: null })
    await expect.poll(() => expired.length).toBe(1)
    expect(await ctx.credentials.readRecord(KEY)).toBeUndefined()
    expect(remoteErrorOf(ctx.bail('api-session/prompt-admission', 'session-1' as never))).toMatchObject({ code: 'hub-account/signed-out' })
    center.refreshStatus = undefined
    center.expiresIn = 7200
    expect((await signIn()).settled).toMatchObject({ status: 'signed-in', reason: null })
    expect(ctx.bail('api-session/prompt-admission', 'session-1' as never)).toBeUndefined()
  })

  it('keeps the sign-in through a refresh outage and retries', async () => {
    const { hub, center, signIn } = await boot({ refreshMarginMs: 1_900, refreshRetryMs: 50 })
    center.expiresIn = 2
    await signIn()
    center.refreshStatus = 500
    await expect.poll(() => center.tokenRequests.filter(request => request.get('grant_type') === 'refresh_token').length, { timeout: 3_000 }).toBeGreaterThan(1)
    expect((await hub.getState()).status).toBe('signed-in')
  })

  it('switches tenant by revoking and signing in again', async () => {
    const { hub, center, signIn, until } = await boot()
    await signIn()
    const firstRefresh = center.tokenRequests.length
    center.tenant = { tenantId: 't-b', tenantName: '乙公司' }
    await hub.switchTenant()
    const waiting = await until(view => view.attempt?.authorizeUrl !== undefined && view.attempt.phase === 'waiting-browser')
    expect(waiting.status).toBe('signed-out')
    await browse(waiting.attempt!.authorizeUrl!)
    expect(await until(view => view.status === 'signed-in')).toMatchObject({ profile: { tenantId: 't-b', tenantName: '乙公司' } })
    expect(center.revoked).toHaveLength(1)
    expect(center.tokenRequests.length).toBe(firstRefresh + 1)
  })

  it('signs out without touching model credentials', async () => {
    const { ctx, hub, center, signIn } = await boot()
    const apiKey = credentialRef('TEST_HUB_ACCOUNT_API_KEY')
    await ctx.credentials.set(apiKey, 'model-key')
    await signIn()
    expect(await hub.signOut()).toMatchObject({ status: 'signed-out', reason: null })
    expect(await ctx.credentials.readRecord(KEY)).toBeUndefined()
    expect(await hub.accessToken()).toBeUndefined()
    expect((await ctx.credentials.resolve(apiKey))?.value).toBe('model-key')
    await expect.poll(() => center.revoked.length).toBe(1)
  })

  it('signs out locally even when the user center cannot take the revocation', async () => {
    const { hub, center, signIn } = await boot()
    await signIn()
    await center.close()
    expect(await hub.signOut()).toMatchObject({ status: 'signed-out' })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(center.revoked).toEqual([])
  })

  it('calls client APIs as the signed-in employee and refreshes once when the token is rejected', async () => {
    const { hub, center, signIn } = await boot()
    expect(remoteErrorOf(await hub.request('/api/client/skills').catch((error: unknown) => error))).toMatchObject({ code: 'hub-account/signed-out' })
    await signIn()
    center.skills = [{ id: 's1', name: 'pdf-tools', description: 'PDF', category: null, version: '1.0.0' }]
    const ok = await hub.request('/api/client/skills?page=1')
    expect(ok.status).toBe(200)
    expect((await ok.json() as { total: number }).total).toBe(1)
    center.clientStatus = 401
    const refreshes = () => center.tokenRequests.filter(request => request.get('grant_type') === 'refresh_token').length
    expect((await hub.request('/api/client/skills')).status).toBe(401)
    expect(refreshes()).toBe(1)
  })

  it('stays signed in across a restart and ignores a grant from another user center', async () => {
    const center = await startMockUserCenter()
    cleanups.push(() => center.close())
    const first = await boot({}, center)
    await first.signIn()
    await first.fiber.dispose()
    const other = await startMockUserCenter()
    cleanups.push(() => other.close())
    // Same credential file, different user center: the stored grant is not ours.
    const home = first.home
    const ctx = new Context()
    const credentials = ctx.plugin(LocalCredentialProvider, { path: join(home, 'credentials.yaml'), watch: false })
    await credentials
    await ctx.plugin(AuthorizationService)
    const fiber = ctx.plugin(HubAccount, { origin: other.origin, clientId: other.clientId, allowLoopbackHttp: true, dshHome: home })
    await fiber
    cleanups.push(async () => { await credentials.dispose() })
    expect((await ctx.get('hubAccount')!.getState()).status).toBe('signed-out')
    await fiber.dispose()
    const again = ctx.plugin(HubAccount, { origin: center.origin, clientId: center.clientId, allowLoopbackHttp: true, dshHome: home })
    await again
    cleanups.push(async () => { await again.dispose() })
    expect((await ctx.get('hubAccount')!.getState()).profile).toMatchObject({ tenantName: '甲公司' })
  })

  it('unregisters its flow and stops refreshing when disposed', async () => {
    const { ctx, fiber } = await boot()
    expect(ctx.authorization.describe(KEY)).toMatchObject({ label: 'Skill Hub' })
    await fiber.dispose()
    expect(ctx.authorization.describe(KEY)).toBeUndefined()
    expect(ctx.bail('api-session/prompt-admission', 'session-1' as never)).toBeUndefined()
  })

  describe('sign-in failures', () => {
    it.each([
      ['an unexpected OAuth error', (c: MockUserCenter) => { c.denyWith = 'server_error' }, 'protocol'],
      ['a refused code exchange', (c: MockUserCenter) => { c.exchangeStatus = 400 }, 'protocol'],
      ['a failing code exchange', (c: MockUserCenter) => { c.exchangeStatus = 503 }, 'network'],
      ['a malformed token response', (c: MockUserCenter) => { c.tokenBody = '{"access_token":1}' }, 'protocol'],
      ['a token response that is not JSON', (c: MockUserCenter) => { c.tokenBody = 'not json' }, 'protocol'],
      ['a failing userinfo', (c: MockUserCenter) => { c.userinfoReply = { status: 500, body: '{}' } }, 'protocol'],
      ['a malformed userinfo', (c: MockUserCenter) => { c.userinfoReply = { status: 200, body: '{"nickname":1}' } }, 'protocol'],
    ] as const)('reports %s as a failed attempt', async (_label, arrange, error) => {
      const { center, signIn } = await boot()
      arrange(center)
      const { settled } = await signIn()
      expect(settled).toMatchObject({ status: 'signed-out', attempt: { phase: 'failed', error } })
    })

    it('reports a store that refuses the grant as a storage failure', async () => {
      const { ctx, signIn } = await boot()
      const modify = ctx.credentials.modifyRecord.bind(ctx.credentials)
      vi.spyOn(ctx.credentials, 'modifyRecord').mockImplementation((key, mutate) => key === KEY
        ? Promise.reject(new Error('disk full'))
        : modify(key, mutate))
      expect((await signIn()).settled).toMatchObject({ status: 'signed-out', attempt: { phase: 'failed', error: 'storage' } })
    })

    it('refuses an attempt begun outside signIn()', async () => {
      const { ctx } = await boot()
      await expect(ctx.authorization.begin({ key: KEY, interaction: { notify: () => undefined, prompt: () => Promise.reject(new Error('no')) } }))
        .rejects.toThrow('hub sign-in failed: protocol')
    })
  })

  it('answers a second callback while the first is being exchanged with 410, and a callback without state with 400', async () => {
    const { hub, center, until } = await boot()
    const gate = Promise.withResolvers<undefined>()
    center.tokenGate = gate.promise
    await hub.signIn()
    const waiting = await until(view => view.attempt?.authorizeUrl !== undefined)
    const callback = new URL(new URL(waiting.attempt!.authorizeUrl!).searchParams.get('redirect_uri')!)
    expect((await fetch(callback)).status).toBe(400)
    const first = browse(waiting.attempt!.authorizeUrl!)
    await until(view => view.attempt?.phase === 'exchanging')
    const state = new URL(waiting.attempt!.authorizeUrl!).searchParams.get('state')!
    callback.search = new URLSearchParams({ code: 'again', state }).toString()
    expect((await fetch(callback)).status).toBe(410)
    gate.resolve(undefined)
    expect((await first).text).toContain('登录成功')
  })

  it('withdraws an attempt cancelled during the code exchange', async () => {
    const { hub, center, until } = await boot()
    const gate = Promise.withResolvers<undefined>()
    center.tokenGate = gate.promise
    await hub.signIn()
    const waiting = await until(view => view.attempt?.authorizeUrl !== undefined)
    const page = browse(waiting.attempt!.authorizeUrl!)
    await until(view => view.attempt?.phase === 'exchanging')
    await hub.cancelSignIn(waiting.attempt!.id)
    expect(await until(view => view.attempt?.phase === 'cancelled')).toMatchObject({ status: 'signed-out' })
    expect((await page).text).toContain('登录未完成')
    gate.resolve(undefined)
  })

  it('refreshes first when a caller asks for a token that is due', async () => {
    const { hub, center, signIn } = await boot({ refreshMarginMs: 7_200_000 })
    center.tokenGate = undefined
    await signIn()
    const issued = center.tokenRequests.length
    expect(await hub.accessToken()).toMatch(/^at-/)
    expect(center.tokenRequests.length).toBeGreaterThan(issued)
  })

  it('stops refreshing when disposed during a refresh', async () => {
    const { hub, center, fiber, signIn } = await boot({ refreshMarginMs: 1_900, refreshRetryMs: 10 })
    center.expiresIn = 2
    await signIn()
    const gate = Promise.withResolvers<undefined>()
    center.tokenGate = gate.promise
    await expect.poll(() => center.tokenRequests.filter(request => request.get('grant_type') === 'refresh_token').length, { timeout: 3_000 }).toBe(1)
    await fiber.dispose()
    gate.resolve(undefined)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(center.tokenRequests.filter(request => request.get('grant_type') === 'refresh_token')).toHaveLength(1)
    expect(hub).toBeDefined()
  })

  it('ends a watch when its subscriber leaves and ignores other credential records', async () => {
    const { ctx, hub } = await boot()
    const controller = new AbortController()
    const stream = hub.watch(controller.signal)[Symbol.asyncIterator]()
    expect((await stream.next()).value).toMatchObject({ status: 'signed-out' })
    await ctx.credentials.modifyRecord(credentialKey('other', 'default'), () => Promise.resolve({ kind: 'api-key', key: 'x' }))
    const pending = stream.next()
    controller.abort()
    expect(await pending).toMatchObject({ done: true })
  })

  it('treats a record of another kind as signed out, and signs out with nothing to revoke', async () => {
    const { ctx, hub, center } = await boot()
    await ctx.credentials.modifyRecord(KEY, () => Promise.resolve({ kind: 'api-key', key: 'x' }))
    expect((await hub.getState()).status).toBe('signed-out')
    await ctx.credentials.modifyRecord(KEY, () => Promise.resolve({ kind: 'grant', payload: { version: 1 } }))
    expect((await hub.getState()).status).toBe('signed-out')
    await ctx.credentials.deleteRecord(KEY)
    expect(await hub.signOut()).toMatchObject({ status: 'signed-out' })
    expect(center.revoked).toEqual([])
  })

  it('refuses an HTTP origin off loopback', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalCredentialProvider, { path: join(tmpdir(), 'dsh-hub-unused.yaml'), watch: false })
    await ctx.plugin(AuthorizationService)
    const fiber = ctx.plugin(HubAccount, { origin: 'http://hub.example.com', clientId: 'x', allowLoopbackHttp: true })
    await expect(fiber).rejects.toThrow(/HTTPS/)
  })
})

describe('hubAccount branding', () => {
  const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')
  const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>')
  const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex')
  const cacheDir = (home: string) => join(home, 'cache', 'hub-branding')
  const logoDownloads = (center: MockUserCenter) => center.clientRequests.filter(path => path === '/api/client/branding/logo').length
  /** Wait for a branding refresh that changes nothing visible to end. */
  const refreshFailed = (spy: { mock: { calls: unknown[][] } }) => vi.waitFor(() => {
    expect(spy.mock.calls.some(call => String(call[0]).includes('branding refresh failed'))).toBe(true)
  })

  it('caches the signed-in tenant\'s logo and title and serves them as an image data URL', async () => {
    const center = await startMockUserCenter()
    cleanups.push(() => center.close())
    center.brandings['t-a'] = { title: '欢迎使用 甲公司 AI 助手', logo: { contentType: 'image/png', data: PNG } }
    const { hub, home, signIn, until } = await boot({}, center)
    expect(await hub.getBranding()).toBeNull()
    await signIn()
    const view = await until(state => state.branding !== null)
    expect(view.branding).toEqual({ tenantId: 't-a', title: '欢迎使用 甲公司 AI 助手', logoSha256: sha(PNG) })
    expect(await hub.getBranding()).toEqual({ tenantId: 't-a', title: '欢迎使用 甲公司 AI 助手', logo: `data:image/png;base64,${PNG.toString('base64')}` })
    expect(await readFile(join(cacheDir(home), `logo-${sha(PNG)}`))).toEqual(PNG)
    // Signed out, the last tenant's branding stays for the welcome window.
    await hub.signOut()
    expect((await hub.getState()).branding).toMatchObject({ tenantId: 't-a' })
  })

  it('shows the cache after a restart without reaching the user center, and fetches once per sign-in', async () => {
    const center = await startMockUserCenter()
    cleanups.push(() => center.close())
    center.brandings['t-a'] = { title: '甲公司', logo: { contentType: 'image/svg+xml', data: SVG } }
    center.expiresIn = 2
    const first = await boot({ refreshMarginMs: 1_900 }, center)
    await first.signIn()
    await first.until(state => state.branding !== null)
    // A token refresh rewrites the grant without fetching the branding again.
    await vi.waitFor(() => { expect(center.tokenRequests.filter(form => form.get('grant_type') === 'refresh_token').length).toBeGreaterThan(0) })
    expect(center.clientRequests.filter(path => path === '/api/client/branding')).toHaveLength(1)
    await first.hub.signOut()
    await first.fiber.dispose()
    await center.close()
    const ctx = new Context()
    const credentials = ctx.plugin(LocalCredentialProvider, { path: join(first.home, 'credentials.yaml'), watch: false })
    await credentials
    await ctx.plugin(AuthorizationService)
    const again = ctx.plugin(HubAccount, { origin: center.origin, clientId: center.clientId, allowLoopbackHttp: true, dshHome: first.home })
    await again
    cleanups.push(async () => { await again.dispose(); await credentials.dispose() })
    const cached = await ctx.get('hubAccount')!.getBranding()
    expect(cached?.title).toBe('甲公司')
    expect(cached?.logo).toMatch(/^data:image\/svg\+xml;base64,/u)
  })

  it('follows a tenant switch, reuses an unchanged logo, and clears when the tenant restores defaults', async () => {
    const center = await startMockUserCenter()
    cleanups.push(() => center.close())
    center.brandings['t-a'] = { title: '甲公司', logo: { contentType: 'image/png', data: PNG } }
    center.brandings['t-b'] = { title: null, logo: { contentType: 'image/png', data: PNG } }
    const { hub, home, signIn, until } = await boot({}, center)
    await signIn()
    await until(state => state.branding?.tenantId === 't-a')
    center.tenant = { tenantId: 't-b', tenantName: '乙公司' }
    await hub.switchTenant()
    const waiting = await until(state => state.attempt?.authorizeUrl !== undefined)
    await browse(waiting.attempt!.authorizeUrl!)
    expect((await until(state => state.branding?.tenantId === 't-b')).branding).toEqual({ tenantId: 't-b', title: null, logoSha256: sha(PNG) })
    expect(logoDownloads(center)).toBe(1)
    delete center.brandings['t-b']
    await hub.signOut()
    await signIn()
    await until(state => state.status === 'signed-in' && state.branding === null)
    await vi.waitFor(async () => { expect(await readdir(cacheDir(home))).toEqual([]) })
    expect(await hub.getBranding()).toBeNull()
  }, 20_000)

  it('keeps the tenant\'s cache when the user center cannot answer, and clears another tenant\'s', async () => {
    const center = await startMockUserCenter()
    cleanups.push(() => center.close())
    center.brandings['t-a'] = { title: '甲公司', logo: { contentType: 'image/png', data: PNG } }
    const { hub, home, signIn, until } = await boot({}, center)
    await signIn()
    await until(state => state.branding !== null)
    await hub.signOut()
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    // The logo changed, but its download fails: the cached logo stays.
    center.brandings['t-a'] = { title: '甲公司', logo: { contentType: 'image/svg+xml', data: SVG } }
    center.logoReply = { status: 503, contentType: 'application/json', body: Buffer.from('{}') }
    await signIn()
    await refreshFailed(info)
    expect((await hub.getState()).branding).toMatchObject({ logoSha256: sha(PNG) })
    await hub.signOut()
    info.mockClear()
    center.clientStatus = 503
    await signIn()
    await refreshFailed(info)
    expect((await hub.getState()).branding).toMatchObject({ tenantId: 't-a', title: '甲公司', logoSha256: sha(PNG) })
    await hub.signOut()
    info.mockClear()
    center.tenant = { tenantId: 't-b', tenantName: '乙公司' }
    await signIn()
    await refreshFailed(info)
    await vi.waitFor(async () => { expect(await readdir(cacheDir(home))).toEqual([]) })
    await hub.signOut()
    // Signed out after 乙公司, the welcome window must not show 甲公司.
    expect(await hub.getBranding()).toBeNull()
    info.mockRestore()
  }, 20_000)

  it('leaves out a logo that does not match its declared type, size or hash', async () => {
    const center = await startMockUserCenter()
    cleanups.push(() => center.close())
    center.brandings['t-a'] = { title: '甲公司', logo: { contentType: 'image/png', data: PNG } }
    const { hub, signIn, until } = await boot({}, center)
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const attempt = async (reply: MockUserCenter['logoReply']) => {
      center.logoReply = reply
      await signIn()
      const view = await until(state => state.status === 'signed-in' && state.branding !== null)
      await hub.signOut()
      return view.branding
    }
    expect(await attempt({ status: 200, contentType: 'text/html', body: PNG })).toEqual({ tenantId: 't-a', title: '甲公司', logoSha256: null })
    expect(await attempt({ status: 200, contentType: 'image/png', body: SVG })).toMatchObject({ logoSha256: null })
    expect(await attempt({ status: 200, body: PNG })).toMatchObject({ logoSha256: null })
    expect(await attempt({ status: 200, contentType: 'image/png', body: Buffer.alloc(512 * 1024 + 1) })).toMatchObject({ logoSha256: null })
    // A logo the server declares in a format DSH does not show.
    center.brandings['t-a'] = { title: '甲公司', logo: { contentType: 'image/gif', data: PNG } }
    expect(await attempt(undefined)).toMatchObject({ logoSha256: null })
    // Nothing usable left at all clears the cache.
    center.brandings['t-a'] = { title: null, logo: { contentType: 'image/png', data: PNG } }
    center.logoReply = { status: 200, contentType: 'text/html', body: PNG }
    await signIn()
    await until(state => state.status === 'signed-in' && state.branding === null)
    expect(await hub.getBranding()).toBeNull()
    expect(info.mock.calls.some(call => String(call[0]).includes('branding logo refused'))).toBe(true)
    info.mockRestore()
  }, 20_000)

  it('lets the latest sign-in\'s branding win over an earlier fetch that answers late', async () => {
    const center = await startMockUserCenter()
    cleanups.push(() => center.close())
    center.brandings['t-a'] = { title: '甲公司', logo: null }
    center.brandings['t-b'] = { title: '乙公司', logo: null }
    const { hub, signIn, until } = await boot({}, center)
    const late = Promise.withResolvers<undefined>()
    center.brandingGate = late.promise
    await signIn()
    await hub.signOut()
    center.tenant = { tenantId: 't-b', tenantName: '乙公司' }
    await signIn()
    await until(state => state.branding?.title === '乙公司')
    late.resolve(undefined)
    await vi.waitFor(() => { expect(center.clientRequests.filter(path => path === '/api/client/branding')).toHaveLength(2) })
    await hub.signOut()
    expect(await hub.getBranding()).toMatchObject({ tenantId: 't-b', title: '乙公司' })
  })

  it('shows the fetched branding when the cache cannot be written', async () => {
    const center = await startMockUserCenter()
    cleanups.push(() => center.close())
    center.brandings['t-a'] = { title: '甲公司', logo: null }
    const home = await mkdtemp(join(tmpdir(), 'dsh-hub-branding-home-'))
    cleanups.push(() => rm(home, { recursive: true, force: true }))
    await mkdir(join(home, 'cache'))
    await writeFile(cacheDir(home), 'not a directory')
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const { signIn, until } = await boot({ dshHome: home }, center)
    await signIn()
    expect((await until(state => state.branding !== null)).branding).toMatchObject({ title: '甲公司' })
    expect(info.mock.calls.some(call => String(call[0]).includes('branding cache not written'))).toBe(true)
    info.mockRestore()
  }, 20_000)

  it('refuses a malformed branding answer and keeps the cache', async () => {
    const center = await startMockUserCenter()
    cleanups.push(() => center.close())
    const { hub, signIn } = await boot({}, center)
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    center.brandings['t-a'] = { title: 42 as never, logo: null }
    await signIn()
    await refreshFailed(info)
    expect(await hub.getBranding()).toBeNull()
    info.mockRestore()
  })

  it('ignores a cache that is unreadable, from another user center, or whose logo was altered', async () => {
    const { readBrandingCache, writeBrandingCache } = await import('../src/branding.ts')
    const dir = await mkdtemp(join(tmpdir(), 'dsh-hub-branding-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    expect(await readBrandingCache(dir, 'https://hub.example.com')).toBeUndefined()
    await writeFile(join(dir, 'branding.json'), '{')
    expect(await readBrandingCache(dir, 'https://hub.example.com')).toBeUndefined()
    await writeBrandingCache(dir, 'https://hub.example.com', { tenantId: 't-a', title: null, logo: { contentType: 'image/png', sha256: sha(PNG), data: PNG } })
    expect(await readBrandingCache(dir, 'https://other.example.com')).toBeUndefined()
    expect((await readBrandingCache(dir, 'https://hub.example.com'))?.logo?.data).toEqual(PNG)
    await writeFile(join(dir, `logo-${sha(PNG)}`), SVG)
    expect(await readBrandingCache(dir, 'https://hub.example.com')).toBeUndefined()
    await writeBrandingCache(dir, 'https://hub.example.com', { tenantId: 't-a', title: '甲公司', logo: { contentType: 'image/png', sha256: sha(PNG), data: SVG } })
    expect(await readBrandingCache(dir, 'https://hub.example.com')).toEqual({ tenantId: 't-a', title: '甲公司', logo: null })
    await writeBrandingCache(dir, 'https://hub.example.com', { tenantId: 't-a', title: '甲公司', logo: null })
    expect(await readBrandingCache(dir, 'https://hub.example.com')).toEqual({ tenantId: 't-a', title: '甲公司', logo: null })
    await writeBrandingCache(dir, 'https://hub.example.com', { tenantId: 't-a', title: null, logo: { contentType: 'image/png', sha256: sha(PNG), data: PNG } })
    await rm(join(dir, `logo-${sha(PNG)}`))
    expect(await readBrandingCache(dir, 'https://hub.example.com')).toBeUndefined()
  })
})
