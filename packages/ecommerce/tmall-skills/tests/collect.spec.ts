import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MerchantBrowser } from '../src/account.ts'
import { readTable, readTableIn, realCollectDeps, runCollect, type Collection, type CollectDeps } from '../src/collect.ts'
import { EXIT, SkillError } from '../src/errors.ts'
import { openPage, type Page } from '../src/page.ts'
import { fakeCdp, type Call } from './fake-cdp.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** A browser whose tabs are `T<n>` with sessions `S<n>`; `evaluate` answers each `Runtime.evaluate`. */
async function browser(evaluate: (call: Call) => object | Error = () => ({ result: { value: 'ok' } })) {
  let tabs = 0
  const fake = await fakeCdp((call) => {
    switch (call.method) {
      case 'Target.createTarget': return { targetId: `T${String(++tabs)}` }
      case 'Target.attachToTarget': return { sessionId: `S${String(tabs)}` }
      case 'Runtime.evaluate': return evaluate(call)
      default: return {}
    }
  })
  cleanups.push(fake.close)
  const opened = () => fake.calls.filter(call => call.method === 'Target.createTarget').length
  const closed = () => fake.calls.filter(call => call.method === 'Target.closeTarget').map(call => call.params.targetId)
  return { ...fake, opened, closed }
}

/** Collect deps over a fake browser: the account `a1` on `tmall`, with output captured. */
function depsFor(url: string, overrides: Partial<CollectDeps> = {}) {
  const out: string[] = [], err: string[] = []
  const account: MerchantBrowser = { id: 'a1', store: '名流旗舰店', account: '名流:运营', cdpUrl: url }
  const deps: CollectDeps = {
    takeOver: vi.fn(() => Promise.resolve(account)),
    reportSignedOut: vi.fn(() => Promise.resolve()),
    openPage: cdpUrl => openPage(cdpUrl, 2000),
    stdout: (text) => { out.push(text) },
    stderr: (text) => { err.push(text) },
    ...overrides,
  }
  return { deps, out, err }
}

const collection = (read: Collection<unknown>['read'], fields: Partial<Collection<unknown>> = {}): Collection<unknown> => ({
  platform: 'tmall', usage: '用法：--account <id>', timeoutMs: 2000, attempts: 2, read, ...fields,
})

describe('runCollect', () => {
  it('takes over the account, reads in one background tab, prints JSON, and closes the tab', async () => {
    const fake = await browser()
    const { deps, out, err } = depsFor(fake.url)
    const read = vi.fn(async (page: Page, _account: MerchantBrowser, values: Readonly<Record<string, unknown>>) => ({
      href: await page.evaluate<string>('location.href'), date: values.date,
    }))
    const code = await runCollect(['--account', 'a1', '--date', '2026-10-12'], deps, collection(read, { platform: 'yuntai', options: { date: { type: 'string' } } }))
    expect([code, err]).toEqual([0, []])
    expect(deps.takeOver).toHaveBeenCalledWith('a1', 'yuntai')
    expect(JSON.parse(out.join(''))).toEqual({ platform: 'yuntai', accountId: 'a1', store: '名流旗舰店', account: '名流:运营', data: { href: 'ok', date: '2026-10-12' } })
    expect(fake.calls[0]?.params).toEqual({ url: 'about:blank', background: true })
    expect([fake.opened(), fake.closed()]).toEqual([1, ['T1']])
  })

  it('retries a failure in a new tab, and fails naming every attempt once they run out', async () => {
    const fake = await browser()
    const { deps, out, err } = depsFor(fake.url)
    let tries = 0
    const flaky = collection(() => ++tries === 1 ? Promise.reject(new Error('接口没返回')) : Promise.resolve({ tries }))
    expect(await runCollect(['--account', 'a1'], deps, flaky)).toBe(0)
    expect((JSON.parse(out.join('')) as { data: unknown }).data).toEqual({ tries: 2 })
    expect([fake.opened(), fake.closed()]).toEqual([2, ['T1', 'T2']])

    const always = collection(() => Promise.reject(new Error('接口没返回')))
    expect(await runCollect(['--account', 'a1'], deps, always)).toBe(EXIT.failed)
    expect(err.join('')).toBe('天猫采集试了 2 次都没成功：\n第 1 次：接口没返回\n第 2 次：接口没返回\n')
    expect(fake.closed()).toHaveLength(4)
  })

  it('stops a reading that runs out of time without retrying, closing its tab while the reading goes on to fail unnoticed', async () => {
    const fake = await browser()
    const { deps, err } = depsFor(fake.url)
    const late = new Promise<void>((resolve) => { setTimeout(resolve, 1300) })
    const slow = collection(() => late.then(() => { throw new Error('读到一半标签页没了') }), { timeoutMs: 1000, attempts: 3 })
    expect(await runCollect(['--account', 'a1'], deps, slow)).toBe(EXIT.failed)
    expect(err.join('')).toBe('天猫采集超过 1 秒没有结果。\n')
    expect([fake.opened(), fake.closed()]).toEqual([1, ['T1']])
    await late
  })

  it('keeps an attempt\'s outcome when its tab cannot be closed, and names a failure that is not an Error', async () => {
    const fake = await browser()
    const stuckClose = (page: Page): Page => ({ ...page, close: () => page.close().then(() => Promise.reject(new Error('Chrome 已退出'))) })
    const { deps, out, err } = depsFor(fake.url, { openPage: async cdpUrl => stuckClose(await openPage(cdpUrl, 2000)) })
    expect(await runCollect(['--account', 'a1'], deps, collection(() => Promise.resolve({ ok: true })))).toBe(0)
    expect((JSON.parse(out.join('')) as { data: unknown }).data).toEqual({ ok: true })
    const risk = collection(() => Promise.reject(new SkillError('遇到滑块验证，已停止。', EXIT.stopped)))
    expect(await runCollect(['--account', 'a1'], deps, risk)).toBe(EXIT.stopped)
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- a non-Error rejection is the scenario under test.
    const odd = collection(() => Promise.reject('接口返回了 502'), { attempts: 1 })
    expect(await runCollect(['--account', 'a1'], deps, odd)).toBe(EXIT.failed)
    expect(err.join('')).toBe('遇到滑块验证，已停止。\n天猫采集试了 1 次都没成功：\n第 1 次：接口返回了 502\n')
  })

  it('stops at once on a SkillError, telling DSH when the account is signed out', async () => {
    const fake = await browser()
    const { deps, err } = depsFor(fake.url)
    const signedOut = collection(() => Promise.reject(new SkillError('天猫需要重新登录。', EXIT.signedOut)))
    expect(await runCollect(['--account', 'a1'], deps, signedOut)).toBe(EXIT.signedOut)
    expect(deps.reportSignedOut).toHaveBeenCalledWith('a1')
    const risk = collection(() => Promise.reject(new SkillError('遇到滑块验证，已停止。', EXIT.stopped)))
    expect(await runCollect(['--account', 'a1'], deps, risk)).toBe(EXIT.stopped)
    expect(deps.reportSignedOut).toHaveBeenCalledTimes(1)
    expect(err.join('')).toBe('天猫需要重新登录。\n遇到滑块验证，已停止。\n')
    expect([fake.opened(), fake.closed()]).toEqual([2, ['T1', 'T2']])
  })

  it('refuses a command line without an account or with an unknown option, and stops when DSH refuses the account', async () => {
    const fake = await browser()
    const { deps, err } = depsFor(fake.url)
    const read = vi.fn(() => Promise.resolve({}))
    expect(await runCollect([], deps, collection(read))).toBe(EXIT.usage)
    expect(await runCollect(['--account', 'a1', '--days', '3'], deps, collection(read))).toBe(EXIT.usage)
    expect(err.join('')).toContain('缺少 --account。\n用法：--account <id>')
    const refused = depsFor(fake.url, { takeOver: () => Promise.reject(new SkillError('账号 a1 不是天猫商家账号', EXIT.usage)) })
    expect(await runCollect(['--account', 'a1'], refused.deps, collection(read))).toBe(EXIT.usage)
    expect(read).not.toHaveBeenCalled()
    expect(fake.opened()).toBe(0)
  })

  it('uses dsh-ecommerce and a real tab outside tests', async () => {
    realCollectDeps.stdout('')
    realCollectDeps.stderr('')
    await expect(realCollectDeps.openPage('http://127.0.0.1:9')).rejects.toThrow()
    const path = process.env.PATH
    process.env.PATH = '/nowhere'
    try {
      await expect(realCollectDeps.takeOver('a1', 'yuntai')).rejects.toThrow('找不到 dsh-ecommerce 命令')
      await expect(realCollectDeps.reportSignedOut('a1')).resolves.toBeUndefined()
    } finally {
      process.env.PATH = path
    }
  })
})

describe('readTable', () => {
  const doc = (html: string) => new JSDOM(html).window.document

  it('reads the header row and body rows, collapsing whitespace and leaving out rows without cells', () => {
    const table = doc(`<table id="t"><thead><tr><th> 日期 </th><th>花费\n（元）</th></tr></thead>
      <tbody><tr><td>2026-10-12</td><td> 1,234.50 </td></tr><tr></tr><tr><td>2026-10-13</td><td></td></tr></tbody></table>`)
    expect(readTableIn(table, '#t')).toEqual({ headers: ['日期', '花费 （元）'], rows: [['2026-10-12', '1,234.50'], ['2026-10-13', '']], footer: [] })
  })

  it('takes the last header row of a grouped header, keeps totals as the footer, and leaves out nested tables\' rows', () => {
    const table = doc(`<table id="t"><thead><tr><th colspan="2">推广</th></tr><tr><th>场景</th><th>花费</th></tr></thead>
      <tbody><tr><td>全站</td><td>10<table><tr><td>内层</td></tr></table></td></tr></tbody><tfoot><tr><td>合计</td><td>10</td></tr></tfoot></table>`)
    expect(readTableIn(table, '#t')).toEqual({ headers: ['场景', '花费'], rows: [['全站', '10内层']], footer: [['合计', '10']] })
  })

  it('takes the first row as the header without a thead, and gives null for a missing or empty table', () => {
    expect(readTableIn(doc('<table><tr><td>a</td><td>b</td></tr><tr><td>1</td><td>2</td></tr></table>'), 'table')).toEqual({ headers: ['a', 'b'], rows: [['1', '2']], footer: [] })
    expect(readTableIn(doc('<table></table>'), 'table')).toEqual({ headers: [], rows: [], footer: [] })
    expect(readTableIn(doc('<p></p>'), 'table')).toBeNull()
    expect(readTableIn(doc('<p></p>'), 'p')).toBeNull()
  })

  it('runs the same reader inside the page', async () => {
    const html = '<table class="r"><tr><th>x</th></tr><tr><td>1</td></tr></table>'
    // The page evaluates the expression against its own document.
    const fake = await browser(call => ({ result: { value: new JSDOM(html, { runScripts: 'outside-only' }).window.eval(call.params.expression as string) as object } }))
    const page = await openPage(fake.url, 2000)
    expect(await readTable(page, '.r')).toEqual({ headers: ['x'], rows: [['1']], footer: [] })
    expect(await readTable(page, '.none')).toBeUndefined()
    await page.close()
  })
})
