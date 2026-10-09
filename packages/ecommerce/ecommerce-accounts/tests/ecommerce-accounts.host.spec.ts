import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { Bridge } from '../src/bridge.ts'
import { writeJsonAtomic } from '../src/files.ts'
import { applyUpdate, DamagedMemory, EMPTY_MEMORY, readMemory } from '../src/memory.ts'
import { SKILL_CONTENT } from '../src/skill.ts'
import EcommerceAccountsService, {
  DOUDIAN, matchesCheckApi, mtopUserNick, parseJsonOrJsonp, PINDUODUO, PUBLIC_PAGE, RISK_PAGE, specOf, TAOBAO, TAOBAO_BUYER, TMALL,
} from '../src/index.ts'
import { alive, closeChrome, ensureTab, findChrome, launchChrome, readRecord } from '../src/chrome.ts'
import { Cdp, pageTabs } from '../src/cdp.ts'
import type { AddEcommerceAccountInput, EcommerceAccountsState } from '../src/types.ts'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { hubStub } from '../../../connector/connectors/tests/support.ts'

const FAKE = fileURLToPath(new URL('./fake-chrome.mjs', import.meta.url))
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  for (const key of ['FAKE_CHROME_VERSION', 'FAKE_CHROME_SILENT', 'FAKE_CHROME_BASE64', 'FAKE_CHROME_STUBBORN', 'FAKE_CHROME_NO_BODY', 'FAKE_CHROME_NO_CLOSE', 'FAKE_CHROME_LINGER_MS', 'FAKE_CHROME_OFFLINE', 'FAKE_CHROME_NO_STORE', 'FAKE_CHROME_NO_STORE_BODY']) {
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
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(ShellEnv, { dshHome: home })
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
    expect(await code(env.service.addAccount({ ...merchant, platform: 'pinduoduo', kind: 'buyer' }))).toBe('ecommerce-accounts/unsupported')
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

  it('waits for a Chrome that keeps running after its DevTools port closes before deleting its data', async () => {
    process.env.FAKE_CHROME_LINGER_MS = '1500'
    const env = await setup()
    const { accountId } = await env.service.addAccount(merchant)
    await env.service.startSignIn(accountId)
    const record = await readRecord(env.browserDir(accountId))
    expect((await env.service.deleteAccount(accountId)).accounts).toEqual([])
    expect(() => process.kill(record!.pid, 0)).toThrow()
    expect(await readdir(join(env.home, 'ecommerce', 't-a', 'browsers'))).toEqual([])
  })

  it('keeps the account and says its browser data could not be removed when the deletion fails', async () => {
    const env = await setup()
    const { accountId } = await env.service.addAccount(merchant)
    await env.service.startSignIn(accountId)
    const browsers = join(env.home, 'ecommerce', 't-a', 'browsers')
    await chmod(browsers, 0o500)
    try {
      expect(await code(env.service.deleteAccount(accountId))).toBe('ecommerce-accounts/delete-failed')
    } finally {
      await chmod(browsers, 0o700)
    }
    expect((await env.service.getState()).accounts.map(account => account.id)).toEqual([accountId])
  })

  it('leaves a deleted account deleted when a check or sign-in waited behind the deletion', async () => {
    const env = await setup()
    const signedIn = async () => {
      const { accountId } = await env.service.addAccount(merchant)
      await env.service.startSignIn(accountId)
      await env.signIn(accountId, '名流旗舰店:运营')
      await env.settle(s => s.accounts.some(item => item.id === accountId && item.status === 'signed-in'))
      return accountId
    }
    const browsers = () => readdir(join(env.home, 'ecommerce', 't-a', 'browsers'))
    // The check that "I have signed in" asks for is queued at once, behind the deletion queued first.
    const checked = await signedIn()
    const record = await readRecord(env.browserDir(checked))
    const deleted = env.service.deleteAccount(checked)
    const confirmed = env.service.confirmSignIn(checked)
    expect((await deleted).accounts).toEqual([])
    expect((await confirmed).accounts).toEqual([])
    expect(await alive(record!.port)).toBe(false)
    expect(await browsers()).toEqual([])
    // A sign-in queued behind the deletion opens nothing and says the account is gone.
    const signing = await signedIn()
    const removing = env.service.deleteAccount(signing)
    const reopened = code(env.service.startSignIn(signing))
    await removing
    expect(await reopened).toBe('ecommerce-accounts/not-found')
    expect(await browsers()).toEqual([])
    expect((await env.service.getState()).accounts).toEqual([])
  })

  it('tells a task the account was deleted when its take-over waited behind the deletion', async () => {
    // A Chrome that ignores Browser.close keeps the deletion closing it long enough for the take-over to queue behind.
    process.env.FAKE_CHROME_STUBBORN = '1'
    const env = await setup({ config: { chromeTimeoutMs: 3000 } })
    const { accountId } = await env.service.addAccount(merchant)
    await env.service.startSignIn(accountId)
    await env.signIn(accountId, '名流旗舰店:运营')
    await env.settle(s => s.accounts[0]!.status === 'signed-in')
    const deleted = env.service.deleteAccount(accountId)
    const taken = await runCommand(env, varsOf(env, bashCall('c-gone')), 'browser', accountId)
    await deleted
    expect(taken.code).toBe(1)
    expect(taken.stderr).toContain('was deleted in DSH Settings. Tell the user and stop')
    expect((await env.service.getState()).accounts).toEqual([])
    expect(await readdir(join(env.home, 'ecommerce', 't-a', 'browsers'))).toEqual([])
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

/** A bash call of the model. */
const bashCall = (id: string): ToolExecution => ({
  signal: new AbortController().signal, token: Symbol('ecommerce-test') as ToolExecution['token'],
  callId: ToolCallId(id), rootCallId: ToolCallId(id), name: 'bash', arguments: { command: 'dsh-ecommerce' },
})

/** What the `dsh-ecommerce` command printed and how it exited. */
interface Run { readonly code: number; readonly stdout: string; readonly stderr: string }

/**
 * Run `dsh-ecommerce` as one bash call would.
 * @param env - the test service.
 * @param vars - the call's variables, fixed when it starts.
 * @param args - the command's arguments.
 * @returns what it printed and its exit code.
 */
function runCommand(env: Awaited<ReturnType<typeof setup>>, vars: Readonly<Record<string, string>>, ...args: string[]): Promise<Run> {
  const pathVar = [join(env.home, 'ecommerce', 'bin'), process.env.PATH ?? ''].join(':')
  return new Promise((resolve) => {
    execFile('dsh-ecommerce', args, { env: { PATH: pathVar, ...vars } }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : Number(error.code), stdout, stderr })
    })
  })
}

/** The variables a bash call starts with. */
const varsOf = (env: Awaited<ReturnType<typeof setup>>, exec: ToolExecution) => env.ctx.shellEnv.collect(exec)

const endCall = (env: Awaited<ReturnType<typeof setup>>, exec: ToolExecution) => {
  env.ctx.emit('tools/result', exec, { isError: false, value: { exitCode: 0 } } as object as ToolExecutionResult)
}

describe('e-commerce accounts for the model', () => {
  it('gives the model the Skill and the command only while signed in to the user center', async () => {
    const env = await setup()
    const skill = await env.ctx.skills.get('ecommerce-accounts')
    expect(skill?.content).toBe(SKILL_CONTENT)
    expect(skill?.description).toContain('dsh-ecommerce')
    const exec = bashCall('c-1')
    expect(env.ctx.shellEnv.collectPath(exec)).toEqual([join(env.home, 'ecommerce', 'bin')])
    expect(env.ctx.shellEnv.collect(exec).DSH_ECOMMERCE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{48}$/u)
    // The same call keeps its address.
    expect(env.ctx.shellEnv.collect(exec).DSH_ECOMMERCE_URL).toBe(env.ctx.shellEnv.collect(exec).DSH_ECOMMERCE_URL)
    const started = env.ctx.shellEnv.collect(exec)
    env.hub.set(null)
    await env.settle(s => s.tenantId === null)
    expect(await env.ctx.skills.get('ecommerce-accounts')).toBeUndefined()
    expect(env.ctx.shellEnv.collectPath(exec)).toEqual([])
    expect(env.ctx.shellEnv.collect(bashCall('c-2'))).not.toHaveProperty('DSH_ECOMMERCE_URL')
    // A call that began before the sign-out reaches no accounts.
    expect(await runCommand(env, started, 'accounts')).toMatchObject({ code: 1, stderr: 'DSH: DSH is signed out of the user center, so there are no e-commerce accounts.\n' })
    expect(await runCommand(env, started, 'browser', 'x')).toMatchObject({ code: 1, stderr: 'DSH: DSH is signed out of the user center, so there are no e-commerce accounts.\n' })
    env.hub.set('t-a')
    await env.settle(s => s.tenantId === 't-a')
    expect(await env.ctx.skills.get('ecommerce-accounts')).toBeDefined()
  })

  it('lists the accounts without anything secret, and explains how to call the command', async () => {
    const env = await setup()
    const { accountId } = await env.service.addAccount(merchant)
    await env.service.addAccount({ ...merchant, platform: 'pinduoduo', account: 'pdd' })
    await env.service.startSignIn(accountId)
    await env.signIn(accountId, 'nick')
    await env.settle(s => s.accounts[0]!.status === 'signed-in')
    process.env.FAKE_CHROME_OFFLINE = '1'
    await closeChrome(env.browserDir(accountId), 2000)
    expect((await env.service.refresh()).accounts[0]!.problem).toBe('network')
    const exec = bashCall('c-1')
    const listed = await runCommand(env, varsOf(env, exec), 'accounts')
    expect(listed.code).toBe(0)
    expect(JSON.parse(listed.stdout)).toEqual([
      { id: accountId, platform: 'tmall', store: '名流旗舰店', account: 'mingliu:运营', kind: 'merchant', status: 'check-failed', problem: 'network' },
      { id: expect.any(String) as string, platform: 'pinduoduo', store: '名流旗舰店', account: 'pdd', kind: 'merchant', status: 'signed-out' },
    ])
    expect(listed.stdout).not.toMatch(/cookie|user-data|ecommerce\//iu)
    const usage = 'usage: dsh-ecommerce accounts | dsh-ecommerce browser <account-id> | dsh-ecommerce buyer [tmall|taobao] | dsh-ecommerce risk <account-id>'
      + ' | dsh-ecommerce memory | dsh-ecommerce remember <json-file>\n'
    expect(await runCommand(env, varsOf(env, exec))).toMatchObject({ code: 2, stderr: usage })
    expect(await runCommand(env, varsOf(env, exec), 'browser')).toMatchObject({ code: 2, stderr: usage })
    expect(await runCommand(env, varsOf(env, exec), 'risk')).toMatchObject({ code: 2, stderr: usage })
    expect((await runCommand(env, {}, 'accounts')).code).toBe(2)
    const url = env.ctx.shellEnv.collect(exec).DSH_ECOMMERCE_URL!
    expect(await (await fetch(`${url}/other`)).text()).toBe('DSH: unknown command "other".')
    expect(await (await fetch(`${url}/browser`)).text()).toBe('DSH: there is no e-commerce account "". Run dsh-ecommerce accounts to list them.')
    expect(await (await fetch(`${url}/risk`)).text()).toBe('DSH: risk control can only be reported for a buyer account this shell call took over, not "".')
    // Once the call ends, its address reaches nothing.
    const vars = env.ctx.shellEnv.collect(exec)
    endCall(env, exec)
    endCall(env, exec)
    expect(await runCommand(env, vars, 'accounts')).toMatchObject({ code: 1, stderr: 'DSH: this shell call can no longer reach the e-commerce accounts.\n' })
  })

  it('hands one call the signed-in browser, refuses a second task until the first call ends, and keeps sign-in and delete away meanwhile', async () => {
    const env = await setup()
    const { accountId } = await env.service.addAccount(merchant)
    await env.service.startSignIn(accountId)
    await env.signIn(accountId, 'nick')
    await env.settle(s => s.accounts[0]!.status === 'signed-in')
    const first = bashCall('c-1')
    const taken = await runCommand(env, varsOf(env, first), 'browser', accountId)
    expect(taken.code).toBe(0)
    const { cdpUrl, ...rest } = JSON.parse(taken.stdout) as { cdpUrl: string }
    expect(rest).toEqual({ id: accountId, platform: 'tmall', kind: 'merchant', store: '名流旗舰店', account: 'mingliu:运营' })
    // The address is the account's own signed-in Chrome.
    expect((await readRecord(env.browserDir(accountId)))!.port).toBe(Number(new URL(cdpUrl).port))
    expect((await (await fetch(`${cdpUrl}/json/version`)).json() as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl).toMatch(/^ws:/u)
    expect((await env.service.getState()).accounts[0]!.inUse).toBe(true)
    // The same call may ask again; another task may not.
    expect((await runCommand(env, varsOf(env, first), 'browser', accountId)).code).toBe(0)
    const second = bashCall('c-2')
    expect(await runCommand(env, varsOf(env, second), 'browser', accountId)).toMatchObject({
      code: 1, stderr: 'DSH: the Tmall account "名流旗舰店" is in use by another task. Tell the user and stop; do not switch to another account.\n',
    })
    expect(await code(env.service.startSignIn(accountId))).toBe('ecommerce-accounts/in-use')
    expect(await code(env.service.deleteAccount(accountId))).toBe('ecommerce-accounts/in-use')
    // Settings checks leave the account to the task that uses it.
    const checkedAt = (await env.service.getState()).accounts[0]!.checkedAt
    expect((await env.service.refresh()).accounts[0]!.checkedAt).toBe(checkedAt)
    // Another call ending leaves the reservation.
    endCall(env, bashCall('c-3'))
    expect((await env.service.getState()).accounts[0]!.inUse).toBe(true)
    endCall(env, first)
    expect((await env.service.getState()).accounts[0]!.inUse).toBe(false)
    expect((await runCommand(env, varsOf(env, second), 'browser', accountId)).code).toBe(0)
  })

  it('stops a task whose account is signed out, cannot be checked, is being signed in, or does not exist', async () => {
    const env = await setup()
    const { accountId } = await env.service.addAccount(merchant)
    const exec = bashCall('c-1')
    expect(await runCommand(env, varsOf(env, exec), 'browser', accountId)).toMatchObject({
      code: 1, stderr: 'DSH: the Tmall account "名流旗舰店" is signed out. Stop, and ask the user to sign in again in DSH Settings → E-commerce accounts (设置 → 电商账号).\n',
    })
    expect((await env.service.getState()).accounts[0]!.inUse).toBe(false)
    await env.service.startSignIn(accountId)
    expect(await runCommand(env, varsOf(env, exec), 'browser', accountId)).toMatchObject({
      code: 1, stderr: 'DSH: the Tmall account "名流旗舰店" is being signed in in DSH Settings. Tell the user and stop.\n',
    })
    await env.signIn(accountId, 'nick')
    await env.settle(s => s.accounts[0]!.status === 'signed-in')
    expect((await runCommand(env, varsOf(env, exec), 'browser', accountId)).code).toBe(0)
    process.env.FAKE_CHROME_SILENT = '1'
    await closeChrome(env.browserDir(accountId), 2000)
    // The call that holds the browser keeps it when a later check of its own fails.
    expect(await runCommand(env, varsOf(env, exec), 'browser', accountId)).toMatchObject({
      code: 1,
      stderr: 'DSH: the Tmall account "名流旗舰店" could not be checked: the platform did not answer in time. Stop, and tell the user; they can check it in DSH Settings → E-commerce accounts (设置 → 电商账号).\n',
    })
    expect((await env.service.getState()).accounts[0]!.inUse).toBe(true)
    expect(await runCommand(env, varsOf(env, exec), 'browser', 'nope')).toMatchObject({
      code: 1, stderr: 'DSH: there is no e-commerce account "nope". Run dsh-ecommerce accounts to list them.\n',
    })
  }, 15_000)

  it('answers a call whose tenant switched while its account was checked as signed out of the user center', async () => {
    const env = await setup()
    const { accountId } = await env.service.addAccount(merchant)
    await env.service.startSignIn(accountId)
    await env.signIn(accountId, 'nick')
    await env.settle(s => s.accounts[0]!.status === 'signed-in')
    process.env.FAKE_CHROME_SILENT = '1'
    await closeChrome(env.browserDir(accountId), 2000)
    const asked = runCommand(env, varsOf(env, bashCall('c-1')), 'browser', accountId)
    await env.settle(s => s.accounts[0]!.status === 'checking')
    env.hub.set('t-b')
    expect(await asked).toMatchObject({ code: 1, stderr: 'DSH: DSH is signed out of the user center, so there are no e-commerce accounts.\n' })
  }, 15_000)

  it('answers a command that fails instead of leaving the script waiting', async () => {
    const broken = () => Promise.reject(new Error('broken'))
    const bridge = new Bridge({ accounts: broken, browser: broken, buyer: broken, risk: broken, memory: broken, remember: broken })
    const stop = await bridge.start()
    try {
      const url = bridge.urlFor({ callId: 'c-1', tenantId: 't-a' })
      const response = await fetch(`${url}/accounts`)
      expect([response.status, await response.text()]).toEqual([500, 'DSH: the e-commerce accounts could not answer: Error: broken'])
      bridge.revoke('c-1')
      bridge.revoke('c-1')
    } finally {
      await stop()
    }
  })
})

/**
 * Open pages through a taken-over browser, as a Skill script would.
 * @param cdpUrl - the address `dsh-ecommerce browser` or `buyer` printed.
 * @param urls - the pages, each in a tab of its own.
 * @returns each page's navigation error, or `ok`.
 */
async function openPages(cdpUrl: string, ...urls: string[]): Promise<string[]> {
  const cdp = await Cdp.connect(Number(new URL(cdpUrl).port), 2000)
  try {
    const results: string[] = []
    for (const url of urls) {
      const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' })
      const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })
      results.push((await cdp.send<{ errorText?: string }>('Page.navigate', { url }, sessionId)).errorText ?? 'ok')
    }
    return results
  } finally {
    cdp.close()
  }
}

const buyer = { platform: 'tmall', kind: 'buyer', account: '买家号一' } as const

/** Add a buyer account and sign it in. */
async function signedInBuyer(env: Awaited<ReturnType<typeof setup>>, input: AddEcommerceAccountInput) {
  const { accountId } = await env.service.addAccount(input)
  await env.service.startSignIn(accountId)
  await env.signIn(accountId, input.account)
  await env.settle(s => s.accounts.find(account => account.id === accountId)!.status === 'signed-in')
  return accountId
}

describe('buyer accounts and risk protection', () => {
  it('adds Taobao and Tmall buyer accounts with only an account name, and signs a Taobao buyer in through the Taobao home page', async () => {
    const env = await setup()
    const { accountId } = await env.service.addAccount({ ...buyer, storeName: 'ignored' })
    expect((await env.service.getState()).accounts[0]).toMatchObject({ kind: 'buyer', account: '买家号一', pagesToday: 0 })
    expect((await env.service.getState()).accounts[0]!.storeName).toBeUndefined()
    expect((await env.service.renameAccount(accountId, { storeName: 'still none' })).accounts[0]!.storeName).toBeUndefined()
    const taobao = await signedInBuyer(env, { platform: 'taobao', kind: 'buyer', account: '淘宝买家' })
    expect((await env.service.getState()).accounts.find(account => account.id === taobao)).toMatchObject({ status: 'signed-in', signedInAs: '淘宝买家' })
    expect(specOf('taobao', 'buyer')).toBe(TAOBAO_BUYER)
    expect(specOf('taobao', 'merchant')).toBe(TAOBAO)
    expect(TAOBAO_BUYER.read('mtopjsonp3({"ret":["SUCCESS::ok"],"data":{"nick":"淘宝买家"}})')).toEqual({ signedIn: true, name: '淘宝买家' })
    expect(PUBLIC_PAGE.test('https://item.taobao.com/item.htm?id=1')).toBe(true)
    expect(PUBLIC_PAGE.test('https://s.taobao.com/search?q=x')).toBe(true)
    expect(PUBLIC_PAGE.test('https://myseller.taobao.com/home.htm')).toBe(false)
    expect(RISK_PAGE.test('https://h5api.m.taobao.com/_____tmd_____/punish?x5secdata=1')).toBe(true)
  })

  it('keeps a merchant account off public product and search pages', async () => {
    const env = await setup()
    const { accountId } = await env.service.addAccount(merchant)
    await env.service.startSignIn(accountId)
    await env.signIn(accountId, 'nick')
    await env.settle(s => s.accounts[0]!.status === 'signed-in')
    const taken = await runCommand(env, varsOf(env, bashCall('c-1')), 'browser', accountId)
    const { cdpUrl } = JSON.parse(taken.stdout) as { cdpUrl: string }
    expect(await openPages(cdpUrl, 'https://myseller.taobao.com/home.htm', 'https://detail.tmall.com/item.htm?id=1', 'https://s.taobao.com/search?q=x'))
      .toEqual(['ok', 'net::ERR_BLOCKED_BY_CLIENT', 'net::ERR_BLOCKED_BY_CLIENT'])
    // Risk control stops the task's pages; a merchant account does not rest.
    expect(await openPages(cdpUrl, 'https://myseller.taobao.com/home.htm?risk=1', 'https://myseller.taobao.com/home.htm'))
      .toEqual(['ok', 'net::ERR_BLOCKED_BY_CLIENT'])
    expect((await env.service.getState()).accounts[0]!.cooldownUntil).toBeUndefined()
  })

  it('counts a buyer account\'s pages, stops at the daily limit, refuses it for the rest of the day, and lets it again the next day', async () => {
    const env = await setup()
    const accountId = await signedInBuyer(env, buyer)
    expect(await code(env.service.setBuyerDailyPages(0))).toBe('ecommerce-accounts/invalid-field')
    expect(await code(env.service.setBuyerDailyPages(2.5))).toBe('ecommerce-accounts/invalid-field')
    expect((await env.service.setBuyerDailyPages(2)).buyerDailyPages).toBe(2)
    const exec = bashCall('c-1')
    const taken = await runCommand(env, varsOf(env, exec), 'buyer', 'tmall')
    const picked = JSON.parse(taken.stdout) as { id: string; cdpUrl: string; pagesLeft: number }
    expect(picked).toMatchObject({ id: accountId, kind: 'buyer', pagesLeft: 2 })
    // A Taobao item page that redirects to Tmall is one page; the third page is over the limit.
    expect(await openPages(picked.cdpUrl, 'https://item.taobao.com/item.htm?id=1', 'https://www.tmall.com/', 'https://detail.tmall.com/item.htm?id=2'))
      .toEqual(['ok', 'ok', 'net::ERR_BLOCKED_BY_CLIENT'])
    expect((await env.service.getState()).accounts[0]!.pagesToday).toBe(2)
    endCall(env, exec)
    expect(await runCommand(env, varsOf(env, bashCall('c-2')), 'browser', accountId)).toMatchObject({
      code: 1, stderr: 'DSH: the Tmall buyer account "买家号一" has opened its 2 pages for today. It can be used again tomorrow.\n',
    })
    const accounts = JSON.parse((await runCommand(env, varsOf(env, bashCall('c-3')), 'accounts')).stdout) as object[]
    expect(accounts[0]).toMatchObject({ kind: 'buyer', pagesToday: 2, pageLimit: 2 })
    expect(accounts[0]).not.toHaveProperty('store')
    // The limit and the count are kept for the tenant.
    const ledger = JSON.parse(await readFile(join(env.home, 'ecommerce', 't-a', 'accounts.json'), 'utf8')) as { buyerDailyPages: number; accounts: { usage: object }[] }
    expect(ledger.buyerDailyPages).toBe(2)
    expect(ledger.accounts[0]!.usage).toMatchObject({ pages: 2 })
    const reloaded = await setup({ home: env.home })
    expect((await reloaded.settle(s => s.accounts.length === 1)).buyerDailyPages).toBe(2)
    // The next calendar day starts from none.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 86_400_000 })
    try {
      expect((await env.service.getState()).accounts[0]!.pagesToday).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rests a buyer account for 72 hours once the risk control shows, stops its task at once, and picks another buyer account meanwhile', async () => {
    const env = await setup()
    const first = await signedInBuyer(env, buyer)
    const second = await signedInBuyer(env, { ...buyer, account: '买家号二' })
    const exec = bashCall('c-1')
    const taken = JSON.parse((await runCommand(env, varsOf(env, exec), 'buyer')).stdout) as { id: string; cdpUrl: string }
    expect(taken.id).toBe(first)
    const before = Date.now()
    expect(await openPages(taken.cdpUrl, 'https://detail.tmall.com/item.htm?id=1&risk=1', 'https://www.tmall.com/'))
      .toEqual(['ok', 'net::ERR_BLOCKED_BY_CLIENT'])
    const resting = (await env.service.getState()).accounts[0]!.cooldownUntil!
    expect(Date.parse(resting) - before).toBeGreaterThanOrEqual(72 * 3_600_000 - 1000)
    expect((JSON.parse((await runCommand(env, varsOf(env, bashCall('c-9')), 'accounts')).stdout) as object[])[0]).toMatchObject({ cooldownUntil: resting })
    endCall(env, exec)
    // The resting account is refused, and picking chooses the other one.
    expect((await runCommand(env, varsOf(env, bashCall('c-2')), 'browser', first)).stderr)
      .toBe(`DSH: the Tmall buyer account "买家号一" is resting after the platform's risk control until ${resting}. Do not use it before then.\n`)
    const next = JSON.parse((await runCommand(env, varsOf(env, bashCall('c-3')), 'buyer', 'tmall')).stdout) as { id: string }
    expect(next.id).toBe(second)
    // With every buyer account unusable, nothing is picked and each reason is given.
    const busy = await runCommand(env, varsOf(env, bashCall('c-4')), 'buyer', 'tmall')
    expect(busy.code).toBe(1)
    expect(busy.stderr).toContain('DSH: no buyer account can be used now. Stop, and tell the user why:\n- the Tmall buyer account "买家号二" is in use by another task.')
    expect(busy.stderr).toContain('- the Tmall buyer account "买家号一" is resting after the platform\'s risk control')
  })

  it('rests a buyer account its call took over when a script reports risk control met through the platform\'s APIs', async () => {
    const env = await setup()
    const first = await signedInBuyer(env, buyer)
    const second = await signedInBuyer(env, { ...buyer, account: '买家号二' })
    const exec = bashCall('c-1')
    const taken = JSON.parse((await runCommand(env, varsOf(env, exec), 'buyer')).stdout) as { id: string }
    expect(taken.id).toBe(first)
    // Only the account this call took over can be reported; another call's or none at all is refused.
    const refusal = (id: string) => `DSH: risk control can only be reported for a buyer account this shell call took over, not "${id}".\n`
    expect(await runCommand(env, varsOf(env, exec), 'risk', second)).toMatchObject({ code: 1, stderr: refusal(second) })
    expect(await runCommand(env, varsOf(env, bashCall('c-2')), 'risk', first)).toMatchObject({ code: 1, stderr: refusal(first) })
    expect(await runCommand(env, varsOf(env, exec), 'risk', 'nope')).toMatchObject({ code: 1, stderr: refusal('nope') })
    const before = Date.now()
    const reported = await runCommand(env, varsOf(env, exec), 'risk', first)
    expect(reported.code).toBe(0)
    const resting = (await env.service.getState()).accounts[0]!.cooldownUntil!
    expect(Date.parse(resting) - before).toBeGreaterThanOrEqual(72 * 3_600_000 - 1000)
    expect(JSON.parse(reported.stdout)).toEqual({ id: first, account: '买家号一', cooldownUntil: resting })
    endCall(env, exec)
    // The rested account is passed over; the other one is picked.
    expect((JSON.parse((await runCommand(env, varsOf(env, bashCall('c-3')), 'buyer')).stdout) as { id: string }).id).toBe(second)
    // A merchant account taken over by the call is not a buyer account, and a call outlives no tenant switch.
    const shop = await env.service.addAccount(merchant)
    const merchantCall = bashCall('c-4')
    await env.service.startSignIn(shop.accountId)
    expect(await runCommand(env, varsOf(env, merchantCall), 'risk', shop.accountId)).toMatchObject({ code: 1, stderr: refusal(shop.accountId) })
    const started = varsOf(env, bashCall('c-5'))
    env.hub.set(null)
    await env.settle(s => s.tenantId === null)
    expect((await runCommand(env, started, 'risk', first)).stderr).toBe('DSH: DSH is signed out of the user center, so there are no e-commerce accounts.\n')
  })

  it('picks the buyer account that opened the fewest pages, and says when there is none or the platform has none', async () => {
    const env = await setup()
    const first = await signedInBuyer(env, buyer)
    const second = await signedInBuyer(env, { ...buyer, account: '买家号二' })
    const exec = bashCall('c-1')
    const { cdpUrl } = JSON.parse((await runCommand(env, varsOf(env, exec), 'browser', first)).stdout) as { cdpUrl: string }
    await openPages(cdpUrl, 'https://www.tmall.com/')
    endCall(env, exec)
    expect((JSON.parse((await runCommand(env, varsOf(env, bashCall('c-2')), 'buyer', 'tmall')).stdout) as { id: string }).id).toBe(second)
    expect(await runCommand(env, varsOf(env, bashCall('c-3')), 'buyer', 'taobao')).toMatchObject({
      code: 1, stderr: 'DSH: there is no buyer account for this. Stop, and ask the user to add one in DSH Settings → E-commerce accounts (设置 → 电商账号).\n',
    })
    expect(await runCommand(env, varsOf(env, bashCall('c-4')), 'buyer', 'pinduoduo')).toMatchObject({
      code: 1, stderr: 'DSH: buyer accounts are on tmall and taobao, not "pinduoduo".\n',
    })
    const started = varsOf(env, bashCall('c-5'))
    expect(await (await fetch(`${started.DSH_ECOMMERCE_URL!}/buyer`)).text()).toContain('"kind": "buyer"')
    env.hub.set(null)
    await env.settle(s => s.tenantId === null)
    expect((await runCommand(env, started, 'buyer')).stderr).toBe('DSH: DSH is signed out of the user center, so there are no e-commerce accounts.\n')
  })

  it('checks only merchant accounts in the background, since each check of a buyer account opens a page', async () => {
    const env = await setup({ config: { checkIntervalMs: 300 } })
    await signedInBuyer(env, buyer)
    const { accountId } = await env.service.addAccount(merchant)
    await env.service.startSignIn(accountId)
    await env.signIn(accountId, 'nick')
    const before = (await env.settle(s => s.accounts.every(account => account.status === 'signed-in'))).accounts
    const after = (await env.settle(s => s.accounts[1]!.checkedAt !== before[1]!.checkedAt && s.accounts[1]!.status === 'signed-in')).accounts
    expect(after[0]!.checkedAt).toBe(before[0]!.checkedAt)
  })
})

describe('publishing memory', () => {
  const write = async (dir: string, name: string, json: unknown): Promise<string> => {
    const path = join(dir, name)
    await writeFile(path, typeof json === 'string' ? json : JSON.stringify(json))
    return path
  }

  it('remembers store information, categories, headers, and declarations for the company, and forgets on null', async () => {
    const env = await setup()
    const dir = await tempDir()
    const run = (...args: string[]) => runCommand(env, varsOf(env, bashCall(`c-${String(Math.random())}`)), ...args)
    expect(JSON.parse((await run('memory')).stdout)).toEqual({ stores: {}, categories: {}, columns: {}, declarations: {} })
    const first = await run('remember', await write(dir, 'a.json', {
      store: { name: '名流旗舰店', values: { 品牌: '名流', 产地: '大陆', 颜色: ['透明'] } },
      category: { line: '水多多', platform: 'tmall', catId: '50024154', categoryPath: '计生用品 > 避孕套' },
      columns: { 到手价: 'price', 上架名称: 'name' },
      declarations: { store: '名流旗舰店', catId: '50024154', confirmed: [{ key: 'personalUseConfirm', text: '确认个人可自行使用。' }] },
    }))
    expect(first.code).toBe(0)
    const memory = JSON.parse((await run('memory')).stdout) as {
      stores: Record<string, { values: unknown; updatedAt: string }>
      categories: Record<string, unknown>
      columns: Record<string, unknown>
      declarations: Record<string, Record<string, Record<string, { text: string; confirmedAt: string }>>>
    }
    expect(JSON.parse(first.stdout)).toEqual(memory)
    expect(memory.stores['名流旗舰店']).toEqual({ values: { 品牌: '名流', 产地: '大陆', 颜色: ['透明'] }, updatedAt: expect.any(String) as string })
    expect(memory.categories['水多多']).toEqual({ tmall: { catId: '50024154', categoryPath: '计生用品 > 避孕套', updatedAt: expect.any(String) as string } })
    expect(memory.columns['到手价']).toEqual({ field: 'price', updatedAt: expect.any(String) as string })
    expect(memory.declarations['名流旗舰店']!['50024154']!.personalUseConfirm!.text).toBe('确认个人可自行使用。')
    // A change keeps the rest; null forgets one value, a whole store, or a header.
    await run('remember', await write(dir, 'b.json', { store: { name: '名流旗舰店', values: { 产地: '香港进口', 颜色: null } }, columns: { 上架名称: null } }))
    const changed = JSON.parse((await run('memory')).stdout) as typeof memory
    expect(changed.stores['名流旗舰店']!.values).toEqual({ 品牌: '名流', 产地: '香港进口' })
    expect(Object.keys(changed.columns)).toEqual(['到手价'])
    await run('remember', await write(dir, 'c.json', { store: { name: '名流旗舰店', values: { 品牌: null, 产地: null } } }))
    expect((JSON.parse((await run('memory')).stdout) as typeof memory).stores).toEqual({})
    const saved = JSON.parse(await readFile(join(env.home, 'ecommerce', 't-a', 'publish-memory.json'), 'utf8')) as typeof memory
    expect(saved.categories['水多多']).toBeDefined()
    // The same product line keeps its category on each platform; remembering one platform again replaces only that one.
    for (const [platform, catId] of [['pinduoduo', '18770'], ['doudian', '1000000638'], ['tmall', '50024155']]) {
      await run('remember', await write(dir, 'd.json', { category: { line: '水多多', platform, catId } }))
    }
    const lines = (JSON.parse((await run('memory')).stdout) as typeof memory).categories['水多多'] as Record<string, { catId: string; categoryPath: string }>
    expect(Object.fromEntries(Object.entries(lines).map(([platform, entry]) => [platform, entry.catId]))).toEqual({ tmall: '50024155', pinduoduo: '18770', doudian: '1000000638' })
    expect(lines['tmall']!.categoryPath).toBe('')
  })

  it('reads a category remembered before categories were kept per platform as that platform\'s, and keeps it', async () => {
    const env = await setup()
    const dir = await tempDir()
    const run = (...args: string[]) => runCommand(env, varsOf(env, bashCall(`c-${String(Math.random())}`)), ...args)
    const path = join(env.home, 'ecommerce', 't-a', 'publish-memory.json')
    await mkdir(join(path, '..'), { recursive: true })
    // An older remember took any platform name; a later platform name in a line is kept too.
    await writeFile(path, JSON.stringify({ categories: {
      水多多: { platform: 'pinduoduo', catId: '18770', categoryPath: '成人用品 > 计生用品 > 避孕套', updatedAt: '2026-10-09T01:35:15.002Z' },
      旧线: { platform: '淘宝', catId: '1', categoryPath: 'x', updatedAt: 't' },
      新线: { jd: { catId: '2', categoryPath: 'y', updatedAt: 't' } },
    } }))
    const old = { pinduoduo: { catId: '18770', categoryPath: '成人用品 > 计生用品 > 避孕套', updatedAt: '2026-10-09T01:35:15.002Z' } }
    expect(JSON.parse((await run('memory')).stdout)).toMatchObject({ categories: {
      水多多: old, 旧线: { 淘宝: { catId: '1', categoryPath: 'x', updatedAt: 't' } }, 新线: { jd: { catId: '2', categoryPath: 'y', updatedAt: 't' } },
    } })
    await run('remember', await write(dir, 'a.json', { category: { line: '水多多', platform: 'doudian', catId: '1000000638' } }))
    const saved = JSON.parse(await readFile(path, 'utf8')) as { categories: Record<string, Record<string, unknown>> }
    expect(saved.categories['水多多']).toEqual({ ...old, doudian: { catId: '1000000638', categoryPath: '', updatedAt: expect.any(String) as string } })
  })

  it('forgets a remembered category and declarations, and leaves a damaged file as it is', async () => {
    const env = await setup()
    const dir = await tempDir()
    const run = async (json: unknown) => runCommand(env, varsOf(env, bashCall(`c-${String(Math.random())}`)), 'remember', await write(dir, 'x.json', json))
    const confirmed = (keys: string[]) => keys.map(key => ({ key, text: key }))
    await run({
      category: { line: '水多多', platform: 'tmall', catId: '50024154' },
      declarations: { store: '名流', catId: '1', confirmed: confirmed(['a', 'b']) },
    })
    await run({ category: { line: '水多多', platform: 'doudian', catId: '1000000638' } })
    await run({ category: { line: '颗粒', platform: 'tmall', catId: '1' } })
    // One platform of a line is forgotten, the rest kept; forgetting its last platform forgets the line.
    const onePlatform = JSON.parse((await run({ forget: { categories: [{ line: '水多多', platform: 'tmall' }, { line: '无', platform: 'tmall' }] } })).stdout) as { categories: object }
    expect(onePlatform.categories).toEqual({ 水多多: { doudian: expect.any(Object) as object }, 颗粒: { tmall: expect.any(Object) as object } })
    const lastPlatform = JSON.parse((await run({ forget: { categories: [{ line: '颗粒', platform: 'tmall' }] } })).stdout) as { categories: object }
    expect(lastPlatform.categories).toEqual({ 水多多: { doudian: expect.any(Object) as object } })
    // One remember that forgets a line and sets a platform of it keeps the new platform only.
    const replaced = JSON.parse((await run({ category: { line: '水多多', platform: 'pinduoduo', catId: '18770' }, forget: { categories: ['水多多'] } })).stdout) as { categories: object }
    expect(replaced.categories).toEqual({ 水多多: { pinduoduo: expect.objectContaining({ catId: '18770' }) as object } })
    await run({ declarations: { store: '名流', catId: '2', confirmed: confirmed(['c']) } })
    const forget = { categories: ['水多多', '无'], declarations: [{ store: '名流', catId: '1', keys: ['a'] }, { store: '别家', catId: '1' }] }
    type Forgot = { categories: object; declarations: Record<string, Record<string, object>> }
    const forgot = JSON.parse((await run({ forget })).stdout) as Forgot
    expect(forgot.categories).toEqual({})
    expect(Object.keys(forgot.declarations['名流']!['1']!)).toEqual(['b'])
    const rest = JSON.parse((await run({ forget: { declarations: [{ store: '名流', catId: '1', keys: ['b'] }, { store: '名流', catId: '2' }] } })).stdout) as { declarations: object }
    expect(rest.declarations).toEqual({})
    const path = join(env.home, 'ecommerce', 't-a', 'publish-memory.json')
    await writeFile(path, '{"stores": [')
    const message = 'DSH: the publishing memory file is damaged'
    expect((await runCommand(env, varsOf(env, bashCall('c-9')), 'memory')).stderr).toContain(message)
    expect((await run({ columns: { 价: 'price' } })).stderr).toContain(message)
    expect(await readFile(path, 'utf8')).toBe('{"stores": [')
  })

  it('refuses a remember that waited behind a switch of company', async () => {
    const env = await setup()
    const dir = await tempDir()
    const started = varsOf(env, bashCall('c-1'))
    const file = await write(dir, 'a.json', { columns: { 价: 'price' } })
    env.hub.set('t-b')
    expect(await runCommand(env, started, 'remember', file)).toMatchObject({ code: 1, stderr: 'DSH: DSH is signed out of the user center, so there are no e-commerce accounts.\n' })
    env.hub.set('t-a')
    await env.settle(s => s.tenantId === 't-a')
    expect(JSON.parse((await runCommand(env, varsOf(env, bashCall('c-2')), 'memory')).stdout)).toMatchObject({ columns: {} })
  })

  it('keeps each company\'s memory to itself', async () => {
    const env = await setup()
    const dir = await tempDir()
    const remember = await write(dir, 'a.json', { store: { name: '名流旗舰店', values: { 品牌: '名流' } } })
    expect((await runCommand(env, varsOf(env, bashCall('c-1')), 'remember', remember)).code).toBe(0)
    const started = varsOf(env, bashCall('c-2'))
    env.hub.set('t-b')
    await env.settle(s => s.tenantId === 't-b')
    expect(await runCommand(env, started, 'memory')).toMatchObject({ code: 1, stderr: 'DSH: DSH is signed out of the user center, so there are no e-commerce accounts.\n' })
    expect(await runCommand(env, started, 'remember', remember)).toMatchObject({ code: 1 })
    expect(JSON.parse((await runCommand(env, varsOf(env, bashCall('c-3')), 'memory')).stdout)).toMatchObject({ stores: {} })
    env.hub.set('t-a')
    await env.settle(s => s.tenantId === 't-a')
    expect(JSON.parse((await runCommand(env, varsOf(env, bashCall('c-4')), 'memory')).stdout)).toMatchObject({ stores: { 名流旗舰店: { values: { 品牌: '名流' } } } })
  })

  it('refuses a file that is not as described, and remembers nothing from it', async () => {
    const env = await setup()
    const dir = await tempDir()
    const run = async (json: unknown) => runCommand(env, varsOf(env, bashCall(`c-${String(Math.random())}`)), 'remember', await write(dir, 'x.json', json))
    expect((await run('not json')).stderr).toMatch(/^DSH: what to remember is not JSON: /u)
    expect((await run({})).stderr).toBe('DSH: nothing was remembered, the file is not as described: (top level): nothing to remember\n')
    expect((await run({ columns: { 价: 'money' } })).stderr).toContain('columns.价')
    expect((await run({ category: { line: '水多多', platform: 'tmall', catId: 'abc' } })).stderr).toContain('category.catId')
    expect((await run({ category: { line: '水多多', platform: 'jd', catId: '1' } })).stderr).toContain('category.platform')
    expect((await run({ forget: { categories: [{ line: '水多多', platform: 'jd' }] } })).stderr).toContain('forget.categories')
    expect((await run({ store: { name: '名流', values: { 品牌: '' } } })).stderr).toContain('store.values.品牌')
    expect((await run({ declarations: { store: '名流', catId: '1', confirmed: [] } })).stderr).toContain('declarations.confirmed')
    expect((await run({ shops: {} })).code).toBe(1)
    expect(JSON.parse((await run('{"store":{"name":"名流","values":{"__proto__":"x"}}}')).stdout)).toMatchObject({ stores: {} })
    expect((await run({ store: { name: 'prototype', values: { a: 'x' } } })).stderr).toContain('this name cannot be used')
    expect((await run({ columns: { constructor: 'price' } })).stderr).toContain('columns.constructor')
    expect(await runCommand(env, varsOf(env, bashCall('c-1')), 'remember')).toMatchObject({ code: 2 })
    expect(await runCommand(env, varsOf(env, bashCall('c-1')), 'remember', join(dir, 'none.json'))).toMatchObject({ code: 2 })
    const big = await write(dir, 'big.json', JSON.stringify({ store: { name: 'x', values: { a: 'y'.repeat(300 * 1024) } } }))
    expect(await runCommand(env, varsOf(env, bashCall('c-2')), 'remember', big)).toMatchObject({ code: 1, stderr: 'DSH: what to remember is too large.\n' })
    expect(JSON.parse((await runCommand(env, varsOf(env, bashCall('c-3')), 'memory')).stdout)).toEqual({ stores: {}, categories: {}, columns: {}, declarations: {} })
  })

  it('reads a missing memory as empty, refuses a damaged one, and fills in parts an older file lacks', async () => {
    const dir = await tempDir()
    expect(await readMemory(join(dir, 'none.json'))).toEqual(EMPTY_MEMORY)
    await writeFile(join(dir, 'bad.json'), '{')
    await expect(readMemory(join(dir, 'bad.json'))).rejects.toBeInstanceOf(DamagedMemory)
    await writeFile(join(dir, 'shape.json'), '{"stores":null}')
    await expect(readMemory(join(dir, 'shape.json'))).rejects.toThrow('stores')
    await expect(readMemory(dir)).rejects.toBeInstanceOf(DamagedMemory)
    await writeFile(join(dir, 'old.json'), '{"stores":{"a":{"values":{"b":"c"},"updatedAt":"t"}}}')
    expect(await readMemory(join(dir, 'old.json'))).toEqual({ ...EMPTY_MEMORY, stores: { a: { values: { b: 'c' }, updatedAt: 't' } } })
    const memory = applyUpdate(EMPTY_MEMORY, { declarations: { store: 's', catId: '1', confirmed: [{ key: 'k', text: 't' }] } }, 'now')
    expect(applyUpdate(memory, { declarations: { store: 's', catId: '1', confirmed: [{ key: 'j', text: 'u' }] } }, 'later').declarations)
      .toEqual({ s: { 1: { k: { text: 't', confirmedAt: 'now' }, j: { text: 'u', confirmedAt: 'later' } } } })
    await writeJsonAtomic(join(dir, 'deep', 'm.json'), memory)
    expect(await readMemory(join(dir, 'deep', 'm.json'))).toEqual(memory)
  })
})
