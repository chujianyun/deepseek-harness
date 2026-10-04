/** Hub sign-in against a mock user center over a real credential store and authorization seam. */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
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
  const fiber = ctx.plugin(HubAccount, { origin: center.origin, clientId: center.clientId, allowLoopbackHttp: true, ...options })
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
    expect(remoteMethods(hub).map(method => method.method)).toEqual(['getState', 'signIn', 'cancelSignIn', 'signOut', 'switchTenant', 'watch'])
  })

  it('starts signed out and refuses new prompts', async () => {
    const { ctx, hub } = await boot()
    expect(await hub.getState()).toEqual({ status: 'signed-out', profile: null, reason: null, attempt: null })
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
      status: 'signed-in', reason: null, attempt: { id: settled.attempt!.id, phase: 'succeeded' },
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
    const fiber = ctx.plugin(HubAccount, { origin: other.origin, clientId: other.clientId, allowLoopbackHttp: true })
    await fiber
    cleanups.push(async () => { await credentials.dispose() })
    expect((await ctx.get('hubAccount')!.getState()).status).toBe('signed-out')
    await fiber.dispose()
    const again = ctx.plugin(HubAccount, { origin: center.origin, clientId: center.clientId, allowLoopbackHttp: true })
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
