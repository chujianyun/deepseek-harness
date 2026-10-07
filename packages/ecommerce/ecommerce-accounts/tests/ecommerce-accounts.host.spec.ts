import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import EcommerceAccountsService, { DOUDIAN, matchesCheckApi, mtopUserNick, parseJsonOrJsonp, PINDUODUO, TAOBAO, TMALL } from '../src/index.ts'
import { alive, closeChrome, ensureTab, findChrome, launchChrome, readRecord } from '../src/chrome.ts'
import { Cdp, pageTabs } from '../src/cdp.ts'
import type { EcommerceAccountsState } from '../src/types.ts'
import { hubStub } from '../../../connector/connectors/tests/support.ts'

const FAKE = fileURLToPath(new URL('./fake-chrome.mjs', import.meta.url))
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  for (const key of ['FAKE_CHROME_VERSION', 'FAKE_CHROME_SILENT', 'FAKE_CHROME_BASE64', 'FAKE_CHROME_STUBBORN', 'FAKE_CHROME_NO_BODY', 'FAKE_CHROME_NO_CLOSE', 'FAKE_CHROME_OFFLINE', 'FAKE_CHROME_NO_STORE', 'FAKE_CHROME_NO_STORE_BODY']) {
    Reflect.deleteProperty(process.env, key)
  }
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ecommerce-'))
  // A check still finishing after disposal may write the ledger once more while the directory goes.
  cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }))
  return dir
}

/** Stop every fake Chrome recorded under a home, whatever state it is in. */
async function killChromes(home: string): Promise<void> {
  const root = join(home, 'ecommerce')
  for (const tenant of await readdir(root).catch(() => [] as string[])) {
    for (const id of await readdir(join(root, tenant, 'browsers')).catch(() => [] as string[])) {
      const record = await readRecord(join(root, tenant, 'browsers', id))
      if (record === undefined) continue
      try {
        process.kill(record.pid, 'SIGKILL')
      } catch {
        // Already stopped.
      }
    }
  }
}

const TIMING = { signInPollMs: 30, signInCheckEveryMs: 300, signInTimeoutMs: 3000, checkTimeoutMs: 1500, chromeTimeoutMs: 5000 }

async function setup(options: { home?: string; tenant?: string | null; config?: Record<string, unknown> } = {}) {
  const home = options.home ?? await tempDir()
  if (options.home === undefined) cleanups.push(() => killChromes(home))
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  const hub = hubStub(options.tenant === undefined ? 't-a' : options.tenant)
  ctx.provide('hubAccount', hub.service as never)
  await ctx.plugin(EcommerceAccountsService, { dshHome: home, chromePath: FAKE, ...TIMING, ...options.config })
  const service = ctx.get('ecommerceAccounts')!
  const settle = async (predicate: (state: EcommerceAccountsState) => boolean, timeoutMs = 8000) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const state = await service.getState()
      if (predicate(state)) return state
      if (Date.now() > deadline) throw new Error(`state never settled: ${JSON.stringify(state.accounts)}`)
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }
  const browserDir = (id: string, tenant = 't-a') => join(home, 'ecommerce', tenant, 'browsers', id)
  const signIn = (id: string, nick: string) => writeFile(join(browserDir(id), 'user-data', 'fake-signed-in'), nick)
  return { ctx, home, hub, service, settle, browserDir, signIn }
}

const code = (promise: Promise<unknown>) => promise.then(() => 'ok', (error: unknown) => remoteErrorOf(error)?.code ?? String(error))
const merchant = { platform: 'tmall', kind: 'merchant', storeName: ' 名流旗舰店 ', account: ' mingliu:运营 ' } as const

describe('platform checks', () => {
  it('reads JSON and JSONP, and the mtop user nick', () => {
    expect(parseJsonOrJsonp('{"a":1}')).toEqual({ a: 1 })
    expect(parseJsonOrJsonp(' mtopjsonp2({"a":2}) ')).toEqual({ a: 2 })
    expect(parseJsonOrJsonp('nothing')).toBeUndefined()
    expect(parseJsonOrJsonp('cb(not json)')).toBeUndefined()
    expect(mtopUserNick('mtopjsonp1({"ret":["SUCCESS::ok"],"data":{"nick":"店小二"}})')).toBe('店小二')
    expect(mtopUserNick('{"ret":["SUCCESS::ok"],"data":{"nick":""}}')).toBeUndefined()
    expect(mtopUserNick('{"ret":["SUCCESS::ok"],"data":null}')).toBeUndefined()
    expect(mtopUserNick('{"ret":["FAIL_SYS_SESSION_EXPIRED::x"],"data":{"nick":"a"}}')).toBeUndefined()
    expect(mtopUserNick('{"ret":"SUCCESS"}')).toBeUndefined()
    expect(mtopUserNick('null')).toBeUndefined()
    expect(mtopUserNick('7')).toBeUndefined()
  })

  it('matches the check API by origin and path prefix, ignoring the query', () => {
    expect(matchesCheckApi(`${TMALL.checkApi}?t=1&sign=2`, TMALL.checkApi)).toBe(true)
    expect(matchesCheckApi('https://h5api.m.tmall.com/h5/mtop.user.getusersimple/1.0', TMALL.checkApi)).toBe(true)
    expect(matchesCheckApi('https://h5api.m.tmall.com/h5/mtop.other/1.0/', TMALL.checkApi)).toBe(false)
    expect(matchesCheckApi('https://evil.example/h5/mtop.user.getusersimple/1.0/', TMALL.checkApi)).toBe(false)
    expect(matchesCheckApi('data:text/plain,x', TMALL.checkApi)).toBe(false)
    expect(matchesCheckApi('not a url', TMALL.checkApi)).toBe(false)
    expect(matchesCheckApi('https://a.example/', 'https://a.example/')).toBe(true)
    expect(TMALL.isLoginPage('https://login.tmall.com/?x')).toBe(true)
    expect(TMALL.isLoginPage('https://login.taobao.com/havanaone/login/login.htm')).toBe(true)
    expect(TMALL.isLoginPage('https://www.tmall.com/')).toBe(false)
  })
})

describe('Chrome processes', () => {
  it('finds Chrome and its version, and reports none or no version when missing', async () => {
    expect(await findChrome(FAKE)).toEqual({ path: FAKE, version: '141.0.7390.65', major: 141 })
    expect(await findChrome(join(tmpdir(), 'no-such-chrome'))).toBeUndefined()
    process.env.FAKE_CHROME_VERSION = ''
    expect(await findChrome(FAKE)).toEqual({ path: FAKE, version: undefined, major: undefined })
    // The standard install may or may not exist on this machine.
    const installed = await findChrome(undefined)
    expect(installed === undefined || installed.path.length > 0).toBe(true)
  })

  it('talks CDP: answers calls, rejects refused ones, and ignores events nobody listens to', async () => {
    const dir = await tempDir()
    cleanups.push(() => closeChrome(dir, 2000))
    const { port } = await launchChrome({ chrome: FAKE, dir, url: 'about:blank', hidden: true, timeoutMs: 5000, env: process.env })
    const cdp = await Cdp.connect(port, 2000)
    await expect(cdp.send('No.such')).rejects.toThrow('unknown method No.such')
    const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })
    await cdp.send('Page.navigate', { url: 'https://www.tmall.com/' }, sessionId)
    // An empty Chrome gets a tab back.
    for (const tab of await pageTabs(cdp)) await cdp.send('Target.closeTarget', { targetId: tab.targetId })
    await ensureTab(port)
    // The closed tabs are listed one last time, then only the new one.
    expect(await pageTabs(cdp)).toHaveLength(3)
    expect(await pageTabs(cdp)).toHaveLength(1)
    await expect(cdp.send('Browser.close')).resolves.toEqual({})
    cdp.close()
  })

  it('starts a detached Chrome that restores its last session, revives an empty one, and closes it', async () => {
    const dir = await tempDir()
    cleanups.push(() => closeChrome(dir, 2000))
    await mkdir(join(dir, 'user-data', 'Default'), { recursive: true })
    await writeFile(join(dir, 'user-data', 'Default', 'Preferences'), JSON.stringify({ session: { other: 1 }, profile: { exit_type: 'Crashed' } }))
    expect(await readRecord(dir)).toBeUndefined()
    const started = await launchChrome({ chrome: FAKE, dir, url: 'about:blank', hidden: true, timeoutMs: 5000, env: process.env })
    expect(await readRecord(dir)).toEqual(started)
    expect(await alive(started.port)).toBe(true)
    const args = JSON.parse(await readFile(join(dir, 'user-data', 'fake-args.json'), 'utf8')) as string[]
    expect(args).toContain('--window-position=-32000,-32000')
    expect(args).toContain('--restore-last-session')
    expect(JSON.parse(await readFile(join(dir, 'user-data', 'Default', 'Preferences'), 'utf8'))).toEqual({
      session: { other: 1, restore_on_startup: 1 }, profile: { exit_type: 'Normal', exited_cleanly: true },
    })
    await ensureTab(started.port)
    await closeChrome(dir, 2000)
    expect(await alive(started.port)).toBe(false)
    expect(await readRecord(dir)).toBeUndefined()
    await closeChrome(dir, 2000)
  })

  it('signals a Chrome that ignores Browser.close, and gives up waiting for one that never starts', async () => {
    const dir = await tempDir()
    process.env.FAKE_CHROME_STUBBORN = '1'
    const started = await launchChrome({ chrome: FAKE, dir, url: 'about:blank', hidden: false, timeoutMs: 5000, env: process.env })
    await closeChrome(dir, 300)
    expect(await alive(started.port)).toBe(false)
    const silent = join(dir, 'silent.mjs')
    await writeFile(silent, 'setTimeout(() => {}, 2000)\n')
    await expect(launchChrome({ chrome: process.execPath, dir: join(dir, 'never'), url: silent, hidden: false, timeoutMs: 300, env: process.env }))
      .rejects.toThrow(/did not answer/)
  })

  it('closes a recorded Chrome that is already gone, and one whose DevTools connection fails', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'chrome.json'), JSON.stringify({ pid: 999_999_999, port: 9 }))
    await closeChrome(dir, 300)
    expect(await readRecord(dir)).toBeUndefined()
  })
})

describe('e-commerce accounts', () => {
  it('adds accounts per tenant, refusing what is unsupported, invalid, or already added', async () => {
    const env = await setup({ config: { maxNameLength: 12 } })
    const { accountId, state } = await env.service.addAccount(merchant)
    expect(state.accounts).toEqual([expect.objectContaining({ id: accountId, platform: 'tmall', kind: 'merchant', storeName: '名流旗舰店', account: 'mingliu:运营', status: 'signed-out' })])
    expect(state.chrome).toMatchObject({ status: 'ready', version: '141.0.7390.65', minVersion: 120, downloadUrl: 'https://www.google.com/chrome/' })
    expect(await code(env.service.addAccount({ ...merchant, account: 'mingliu:运营' }))).toBe('ecommerce-accounts/duplicate')
    expect(await code(env.service.addAccount({ ...merchant, kind: 'buyer' }))).toBe('ecommerce-accounts/unsupported')
    expect(await code(env.service.addAccount({ ...merchant, account: '  ' }))).toBe('ecommerce-accounts/invalid-field')
    expect(await code(env.service.addAccount({ ...merchant, account: '一二三四五六七八九十一二三' }))).toBe('ecommerce-accounts/invalid-field')
    const { storeName: _storeName, ...withoutStore } = merchant
    expect(await code(env.service.addAccount({ ...withoutStore, account: 'b' }))).toBe('ecommerce-accounts/invalid-field')
    const ledger = await readFile(join(env.home, 'ecommerce', 't-a', 'accounts.json'), 'utf8')
    expect(ledger).not.toMatch(/cookie|password/iu)
    env.hub.set('t-b')
    expect(await env.settle(s => s.tenantId === 't-b')).toMatchObject({ accounts: [] })
    env.hub.set(null)
    await env.settle(s => s.tenantId === null)
    expect(await code(env.service.addAccount(merchant))).toBe('hub-account/signed-out')
    expect(await code(env.service.deleteAccount('x'))).toBe('hub-account/signed-out')
    env.hub.set('t-a')
    expect((await env.settle(s => s.tenantId === 't-a' && s.accounts.length === 1)).accounts[0]!.id).toBe(accountId)
  })

  it('signs in through the sign-in page, then keeps Chrome running off screen', async () => {
    const env = await setup()
    const { accountId } = await env.service.addAccount(merchant)
    const state = await env.service.startSignIn(accountId)
    expect(state.accounts[0]!.status).toBe('signing-in')
    const args = JSON.parse(await readFile(join(env.browserDir(accountId), 'user-data', 'fake-args.json'), 'utf8')) as string[]
    expect(args).toContain('--window-position=80,80')
    expect(JSON.parse(await readFile(join(env.browserDir(accountId), 'user-data', 'fake-window.json'), 'utf8'))).toMatchObject({ left: 80, top: 80 })
    // The user scans the code: the sign-in tab moves on and the platform names the account.
    await env.signIn(accountId, '名流旗舰店:运营')
    const signedIn = await env.settle(s => s.accounts[0]!.status === 'signed-in')
    expect(signedIn.accounts[0]).toMatchObject({ signedInAs: '名流旗舰店:运营', checkedAt: expect.any(String) as string })
    expect(JSON.parse(await readFile(join(env.browserDir(accountId), 'user-data', 'fake-window.json'), 'utf8'))).toMatchObject({ windowState: 'minimized' })
    const ledger = JSON.parse(await readFile(join(env.home, 'ecommerce', 't-a', 'accounts.json'), 'utf8')) as { accounts: object[] }
    expect(ledger.accounts[0]).toMatchObject({ signedInAs: '名流旗舰店:运营', everSignedIn: true })
    expect(await readdir(join(env.browserDir(accountId), 'user-data'))).not.toContain('cookies.json')
  })

  it('checks at once when the user says the sign-in is done, and keeps waiting while it is not', async () => {
    const env = await setup({ config: { signInCheckEveryMs: 60_000 } })
    const { accountId } = await env.service.addAccount(merchant)
    await env.service.startSignIn(accountId)
    expect((await env.service.confirmSignIn(accountId)).accounts[0]!.status).toBe('signing-in')
    await env.signIn(accountId, 'nick')
    expect((await env.service.confirmSignIn(accountId)).accounts[0]!.status).toBe('signed-in')
    expect((await env.service.confirmSignIn(accountId)).accounts[0]!.status).toBe('signed-in')
  })

  it('gives up a sign-in nobody completes, and starts a second sign-in on the running Chrome', async () => {
    const env = await setup({ config: { signInTimeoutMs: 400 } })
    const { accountId } = await env.service.addAccount(merchant)
    await env.service.startSignIn(accountId)
    await env.settle(s => s.accounts[0]!.status === 'signed-out')
    const record = await readRecord(env.browserDir(accountId))
    await env.service.startSignIn(accountId)
    expect(await readRecord(env.browserDir(accountId))).toEqual(record)
    await env.service.startSignIn(accountId)
    await env.settle(s => s.accounts[0]!.status === 'signed-out')
  })

  it('reattaches to the running Chrome after a restart, and restarts a Chrome that is gone, minimized', async () => {
    const first = await setup()
    const { accountId } = await first.service.addAccount(merchant)
    await first.service.startSignIn(accountId)
    await first.signIn(accountId, 'nick')
    await first.settle(s => s.accounts[0]!.status === 'signed-in')
    const record = await readRecord(first.browserDir(accountId))
    await first.ctx.fiber.dispose()
    expect(await alive(record!.port)).toBe(true)
    // DSH starts again: the same Chrome is still signed in.
    const second = await setup({ home: first.home })
    await second.settle(s => s.accounts[0]?.status === 'signed-in')
    expect(await readRecord(first.browserDir(accountId))).toEqual(record)
    // The computer restarted: Chrome is gone and starts again minimized, restoring its session.
    process.kill(record!.pid, 'SIGKILL')
    await new Promise(resolve => setTimeout(resolve, 300))
    expect((await second.service.refresh()).accounts[0]!.status).toBe('signed-in')
    const again = await readRecord(first.browserDir(accountId))
    expect(again!.pid).not.toBe(record!.pid)
    const args = JSON.parse(await readFile(join(first.browserDir(accountId), 'user-data', 'fake-args.json'), 'utf8')) as string[]
    expect(args).toContain('--window-position=-32000,-32000')
    // The blank tabs it gathered on each start are closed; the restored sign-in tab stays.
    const tabs = await (await fetch(`http://127.0.0.1:${String(again!.port)}/json`)).json() as { url: string }[]
    expect(tabs.map(tab => tab.url)).toEqual(['https://www.tmall.com/'])
    // A restart that lost the session shows the account signed out.
    await rm(join(first.browserDir(accountId), 'user-data', 'fake-signed-in'))
    expect((await second.service.refresh()).accounts[0]!.status).toBe('signed-out')
    // A Chrome started again in the background is minimized even when the session is lost.
    process.kill(again!.pid, 'SIGKILL')
    await new Promise(resolve => setTimeout(resolve, 300))
    await rm(join(first.browserDir(accountId), 'user-data', 'fake-window.json'), { force: true })
    expect((await second.service.refresh()).accounts[0]!.status).toBe('signed-out')
    expect(JSON.parse(await readFile(join(first.browserDir(accountId), 'user-data', 'fake-window.json'), 'utf8'))).toMatchObject({ windowState: 'minimized' })
  })

  it('shows a check that got no answer as failed, reads base64 bodies, and leaves a never-signed-in account without Chrome', async () => {
    const env = await setup()
    const { accountId } = await env.service.addAccount(merchant)
    expect((await env.service.refresh()).accounts[0]!.status).toBe('signed-out')
    expect(await readRecord(env.browserDir(accountId))).toBeUndefined()
    process.env.FAKE_CHROME_BASE64 = '1'
    await env.service.startSignIn(accountId)
    await env.signIn(accountId, 'b64')
    expect((await env.settle(s => s.accounts[0]!.status === 'signed-in')).accounts[0]!.signedInAs).toBe('b64')
    await closeChrome(env.browserDir(accountId), 2000)
    process.env.FAKE_CHROME_SILENT = '1'
    expect((await env.service.refresh()).accounts[0]!.status).toBe('check-failed')
  })

  it('refuses to sign in without Chrome or with an old one, and with an unknown account', async () => {
    const missing = await setup({ config: { chromePath: join(tmpdir(), 'no-such-chrome') } })
    const { accountId } = await missing.service.addAccount(merchant)
    expect((await missing.service.getState()).chrome.status).toBe('missing')
    expect(await code(missing.service.startSignIn(accountId))).toBe('ecommerce-accounts/chrome-missing')
    expect(await code(missing.service.startSignIn('nope'))).toBe('ecommerce-accounts/not-found')
    process.env.FAKE_CHROME_VERSION = '100.0.1'
    const old = await setup()
    const added = await old.service.addAccount(merchant)
    expect((await old.service.getState()).chrome).toMatchObject({ status: 'outdated', version: '100.0.1' })
    const refused = await old.service.startSignIn(added.accountId).catch((error: unknown) => error)
    expect(remoteErrorOf(refused)).toMatchObject({ code: 'ecommerce-accounts/chrome-outdated', details: { version: '100.0.1', minVersion: 120 } })
  })

  it('reports a Chrome that cannot open the sign-in page', async () => {
    const env = await setup({ config: { chromeTimeoutMs: 300 } })
    const { accountId } = await env.service.addAccount(merchant)
    await mkdir(env.browserDir(accountId), { recursive: true })
    // The browser directory is a file, so Chrome cannot keep its data there.
    await rm(env.browserDir(accountId), { recursive: true })
    await writeFile(env.browserDir(accountId), '')
    expect(await code(env.service.startSignIn(accountId))).toBe('ecommerce-accounts/browser-failed')
    expect((await env.service.getState()).accounts[0]!.status).toBe('signed-out')
  })

  it('deletes an account with its browser data, closing its Chrome', async () => {
    const env = await setup()
    const { accountId } = await env.service.addAccount(merchant)
    await env.service.startSignIn(accountId)
    const record = await readRecord(env.browserDir(accountId))
    const state = await env.service.deleteAccount(accountId)
    expect(state.accounts).toEqual([])
    expect(await alive(record!.port)).toBe(false)
    expect(await readdir(join(env.home, 'ecommerce', 't-a', 'browsers'))).toEqual([])
    expect(await code(env.service.deleteAccount(accountId))).toBe('ecommerce-accounts/not-found')
  })

  it('streams the state on every change until the reader stops, and ignores a malformed ledger', async () => {
    const home = await tempDir()
    await mkdir(join(home, 'ecommerce', 't-a'), { recursive: true })
    await writeFile(join(home, 'ecommerce', 't-a', 'accounts.json'), JSON.stringify({ version: 2 }))
    const env = await setup({ home })
    cleanups.push(() => killChromes(home))
    expect((await env.service.getState()).accounts).toEqual([])
    const stop = new AbortController()
    const iterator = env.service.watch(stop.signal)[Symbol.asyncIterator]()
    expect((await iterator.next()).value).toMatchObject({ tenantId: 't-a' })
    const next = iterator.next()
    await env.service.addAccount(merchant)
    expect((await next).value).toMatchObject({ accounts: [expect.objectContaining({ account: 'mingliu:运营' })] })
    const done = iterator.next()
    stop.abort()
    expect((await done).done).toBe(true)
  })
})

describe('e-commerce account edge cases', () => {
  it('starts signed out, ignores a sign-in to the same tenant, and stops a sign-in when the tenant switches or DSH stops', async () => {
    const env = await setup({ tenant: null })
    expect((await env.service.getState()).tenantId).toBeNull()
    env.hub.set('t-a')
    await env.settle(s => s.tenantId === 't-a')
    const revision = (await env.service.getState()).revision
    env.hub.set('t-a')
    await new Promise(resolve => setTimeout(resolve, 50))
    expect((await env.service.getState()).revision).toBe(revision)
    const { accountId } = await env.service.addAccount(merchant)
    await env.service.startSignIn(accountId)
    env.hub.set('t-b')
    await env.settle(s => s.tenantId === 't-b')
    env.hub.set('t-a')
    await env.settle(s => s.tenantId === 't-a' && s.accounts[0]?.status === 'signed-out')
    await env.service.startSignIn(accountId)
    await env.ctx.fiber.dispose()
  })

  it('keeps a sign-in waiting when its Chrome is gone, and lists several accounts apart', async () => {
    const env = await setup({ config: { signInCheckEveryMs: 100 } })
    const { accountId } = await env.service.addAccount(merchant)
    const other = await env.service.addAccount({ ...merchant, account: 'second' })
    await env.service.startSignIn(accountId)
    const record = await readRecord(env.browserDir(accountId))
    process.kill(record!.pid, 'SIGKILL')
    await new Promise(resolve => setTimeout(resolve, 400))
    expect((await env.service.getState()).accounts.map(item => item.status)).toEqual(['signing-in', 'signed-out'])
    await env.service.deleteAccount(accountId)
    expect((await env.service.getState()).accounts.map(item => item.id)).toEqual([other.accountId])
  })

  it('fails a check whose body is lost, or whose Chrome cannot be started again, and survives a tab that will not close', async () => {
    const env = await setup()
    const { accountId } = await env.service.addAccount(merchant)
    await env.service.startSignIn(accountId)
    await env.signIn(accountId, 'nick')
    await env.settle(s => s.accounts[0]!.status === 'signed-in')
    process.env.FAKE_CHROME_NO_CLOSE = '1'
    expect((await env.service.refresh()).accounts[0]!.status).toBe('signed-in')
    process.env.FAKE_CHROME_NO_BODY = '1'
    await closeChrome(env.browserDir(accountId), 2000)
    expect((await env.service.refresh()).accounts[0]!.status).toBe('check-failed')
    await closeChrome(env.browserDir(accountId), 2000)
    // Chrome can no longer start: the check fails instead of throwing.
    const silent = join(env.home, 'silent-chrome.sh')
    await writeFile(silent, '#!/bin/sh\nsleep 2\n', { mode: 0o755 })
    const broken = await setup({ home: env.home, config: { chromePath: silent, chromeTimeoutMs: 200 } })
    await broken.settle(s => s.accounts[0]?.status === 'check-failed')
    expect((await broken.service.getState()).chrome).toEqual({ status: 'ready', minVersion: 120, downloadUrl: 'https://www.google.com/chrome/' })
  }, 15_000)

  it('drops a check whose account left with the tenant meanwhile', async () => {
    const env = await setup()
    const { accountId } = await env.service.addAccount(merchant)
    await env.service.startSignIn(accountId)
    await env.signIn(accountId, 'nick')
    await env.settle(s => s.accounts[0]!.status === 'signed-in')
    // A Chrome started again without answering keeps the check running.
    await closeChrome(env.browserDir(accountId), 2000)
    process.env.FAKE_CHROME_SILENT = '1'
    const checking = env.service.refresh()
    await env.settle(s => s.accounts[0]!.status === 'checking')
    env.hub.set('t-b')
    await env.settle(s => s.tenantId === 't-b')
    expect((await checking).accounts).toEqual([])
  }, 15_000)

  it('reads each platform\'s check response and sign-in pages', () => {
    expect(TMALL.read('mtopjsonp1({"ret":["SUCCESS::ok"],"data":{"nick":"店小二"}})')).toEqual({ signedIn: true, name: '店小二' })
    expect(TMALL.read('{"ret":["FAIL_SYS_SESSION_EXPIRED::x"]}')).toEqual({ signedIn: false })
    expect(TAOBAO.read('mtopjsonp2({"ret":["SUCCESS::ok"],"data":{}})')).toEqual({ signedIn: true })
    expect(TAOBAO.read('mtopjsonp2({"ret":["FAIL_SYS_SESSION_EXPIRED::x"]})')).toEqual({ signedIn: false })
    expect(TAOBAO.read('oops')).toEqual({ signedIn: false })
    expect(PINDUODUO.read('{"result":{"login":true}}')).toEqual({ signedIn: true })
    expect(PINDUODUO.read('{"result":{"login":false}}')).toEqual({ signedIn: false })
    expect(PINDUODUO.read('{"result":null}')).toEqual({ signedIn: false })
    expect(DOUDIAN.read('{"code":0,"data":{"menu_list":[{"name":"首页"}]}}')).toEqual({ signedIn: true })
    expect(DOUDIAN.read('{"code":0,"data":{"menu_list":[]}}')).toEqual({ signedIn: false })
    expect(DOUDIAN.read('{"code":10008,"data":null}')).toEqual({ signedIn: false })
    expect(DOUDIAN.read('[]')).toEqual({ signedIn: false })
    expect(PINDUODUO.store!.read('{"result":{"merchantMainSimpleVO":{"mallName":"名流保健"}}}')).toBe('名流保健')
    expect(PINDUODUO.store!.read('{"result":{"merchantMainSimpleVO":null}}')).toBeUndefined()
    expect(PINDUODUO.store!.read('{"result":null}')).toBeUndefined()
    expect(DOUDIAN.store!.read('{"data":{"shop_name":"名流欣屹"}}')).toBe('名流欣屹')
    expect(DOUDIAN.store!.read('{"data":{"shop_name":""}}')).toBeUndefined()
    expect(DOUDIAN.store!.read('{"data":null}')).toBeUndefined()
    expect(TAOBAO.isLoginPage('https://login.taobao.com/havanaone/login/login.htm')).toBe(true)
    // Signed out, the Qianniu workbench goes to its seller sign-in.
    expect(TAOBAO.isLoginPage('https://loginmyseller.taobao.com/?from=taobaoindex&redirect_url=x')).toBe(true)
    expect(TAOBAO.isLoginPage('https://qn.taobao.com/home.htm')).toBe(false)
    expect(PINDUODUO.isLoginPage('https://mms.pinduoduo.com/login/?redirectUrl=x')).toBe(true)
    expect(PINDUODUO.isLoginPage('https://mms.pinduoduo.com/home/')).toBe(false)
    expect(DOUDIAN.isLoginPage('https://fxg.jinritemai.com/login/common')).toBe(true)
    expect(DOUDIAN.isLoginPage('https://fxg.jinritemai.com/ffa/mshop/homepage/index')).toBe(false)
  })

  it('signs in Taobao, Pinduoduo, and Douyin shop accounts, and shows a lost sign-in as expired', async () => {
    const env = await setup()
    for (const platform of ['taobao', 'pinduoduo', 'doudian'] as const) {
      const { accountId } = await env.service.addAccount({ ...merchant, platform })
      expect((await env.service.getState()).accounts.at(-1)).toMatchObject({ platform, status: 'signed-out', expired: false })
      await env.service.startSignIn(accountId)
      await env.signIn(accountId, '小美')
    }
    const signedIn = await env.settle(s => s.accounts.every(account => account.status === 'signed-in'))
    // These platforms name no account; Pinduoduo and Douyin shop pages name the store.
    expect(signedIn.accounts.map(account => [account.signedInAs, account.signedInStore])).toEqual([[undefined, undefined], [undefined, '小美店'], [undefined, '小美店']])
    for (const account of signedIn.accounts) await rm(join(env.browserDir(account.id), 'user-data', 'fake-signed-in'))
    // Signed out, the Taobao and Douyin shop pages go to sign in, and Pinduoduo says so.
    const lost = await env.service.refresh()
    expect(lost.accounts.map(account => [account.status, account.expired])).toEqual([['signed-out', true], ['signed-out', true], ['signed-out', true]])
  })

  it('shows a check that times out, cannot reach the page, or finds the browser held by another Chrome as a problem', async () => {
    const env = await setup()
    const { accountId } = await env.service.addAccount(merchant)
    const dir = env.browserDir(accountId)
    await env.service.startSignIn(accountId)
    await env.signIn(accountId, 'nick')
    await env.settle(s => s.accounts[0]!.status === 'signed-in')
    const failed = async (problem: string) => {
      await closeChrome(dir, 2000)
      expect((await env.service.refresh()).accounts[0]).toMatchObject({ status: 'check-failed', problem, signedInAs: 'nick', expired: false })
    }
    process.env.FAKE_CHROME_OFFLINE = '1'
    await failed('network')
    Reflect.deleteProperty(process.env, 'FAKE_CHROME_OFFLINE')
    process.env.FAKE_CHROME_SILENT = '1'
    await failed('timeout')
    Reflect.deleteProperty(process.env, 'FAKE_CHROME_SILENT')
    // A Chrome DSH did not start holds the data: DSH starts none and refuses to sign in.
    const lock = join(dir, 'user-data', 'SingletonLock')
    await symlink(`other-host-${String(process.pid)}`, lock)
    await failed('busy')
    expect(await readRecord(dir)).toBeUndefined()
    expect(await code(env.service.startSignIn(accountId))).toBe('ecommerce-accounts/browser-busy')
    // A lock left by a Chrome that is gone, or one DSH cannot read, holds nothing.
    for (const target of ['other-host-999999999', 'garbage']) {
      await rm(lock)
      await symlink(target, lock)
      expect((await env.service.refresh()).accounts[0]).toMatchObject({ status: 'signed-in' })
      expect((await env.service.getState()).accounts[0]!.problem).toBeUndefined()
      await closeChrome(dir, 2000)
    }
  }, 20_000)

  it('stays signed in without a store name when the page does not name the store in time, or loses its body', async () => {
    const env = await setup()
    const { accountId } = await env.service.addAccount({ ...merchant, platform: 'doudian' })
    await env.service.startSignIn(accountId)
    await env.signIn(accountId, '小美')
    expect((await env.settle(s => s.accounts[0]!.status === 'signed-in')).accounts[0]!.signedInStore).toBe('小美店')
    for (const flag of ['FAKE_CHROME_NO_STORE', 'FAKE_CHROME_NO_STORE_BODY']) {
      process.env[flag] = '1'
      await closeChrome(env.browserDir(accountId), 2000)
      expect((await env.service.refresh()).accounts[0]).toMatchObject({ status: 'signed-in' })
      expect((await env.service.getState()).accounts[0]!.signedInStore).toBeUndefined()
      Reflect.deleteProperty(process.env, flag)
    }
  }, 15_000)

  it('renames an account, refusing a name another account has or an invalid one', async () => {
    const env = await setup()
    const { accountId } = await env.service.addAccount(merchant)
    await env.service.addAccount({ ...merchant, account: 'other' })
    expect((await env.service.renameAccount(accountId, { account: ' 名流:小美 ' })).accounts[0]).toMatchObject({ account: '名流:小美', storeName: '名流旗舰店' })
    expect((await env.service.renameAccount(accountId, { account: '名流:小美' })).accounts[0]!.account).toBe('名流:小美')
    expect((await env.service.renameAccount(accountId, { storeName: ' 名流成人用品旗舰店 ' })).accounts[0]).toMatchObject({ account: '名流:小美', storeName: '名流成人用品旗舰店' })
    expect(await code(env.service.renameAccount(accountId, { account: 'other' }))).toBe('ecommerce-accounts/duplicate')
    expect(await code(env.service.renameAccount(accountId, { account: ' ' }))).toBe('ecommerce-accounts/invalid-field')
    expect(await code(env.service.renameAccount(accountId, { storeName: '' }))).toBe('ecommerce-accounts/invalid-field')
    expect(await code(env.service.renameAccount('nope', { account: 'x' }))).toBe('ecommerce-accounts/not-found')
    const ledger = JSON.parse(await readFile(join(env.home, 'ecommerce', 't-a', 'accounts.json'), 'utf8')) as { accounts: { account: string; storeName: string }[] }
    expect(ledger.accounts.map(account => [account.account, account.storeName])).toEqual([['名流:小美', '名流成人用品旗舰店'], ['other', '名流旗舰店']])
  })

  it('checks every account in the background', async () => {
    const env = await setup({ config: { checkIntervalMs: 300 } })
    const { accountId } = await env.service.addAccount(merchant)
    await env.service.startSignIn(accountId)
    await env.signIn(accountId, 'nick')
    const first = (await env.settle(s => s.accounts[0]!.status === 'signed-in')).accounts[0]!.checkedAt
    await env.settle(s => s.accounts[0]!.checkedAt !== first && s.accounts[0]!.status === 'signed-in')
  })
})
