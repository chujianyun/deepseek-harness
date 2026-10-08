import { afterEach, describe, expect, it } from 'vitest'
import { fetchJson, openPage, signedOut } from '../src/page.ts'
import { EXIT, SkillError } from '../src/errors.ts'
import { fakeCdp, type Call, type Emit } from './fake-cdp.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** A browser with one tab session `S1`; `navigate` and `evaluate` answer per call. */
/** How the fake browser answers navigation and evaluation. */
interface Answers {
  readonly navigate?: (call: Call, emit: Emit) => object
  readonly evaluate?: (call: Call) => object | Error
  readonly body?: (call: Call) => object | Error
}

async function browser(answers: Answers = {}): Promise<{ url: string; calls: Call[] }> {
  const fake = await fakeCdp((call, emit) => {
    switch (call.method) {
      case 'Target.createTarget': return { targetId: 'T1' }
      case 'Target.attachToTarget': return { sessionId: 'S1' }
      case 'Page.navigate': return answers.navigate?.(call, emit) ?? { frameId: 'F1' }
      case 'Runtime.evaluate': return answers.evaluate?.(call) ?? { result: {} }
      case 'Network.getResponseBody': return answers.body?.(call) ?? new Error('no body')
      default: return {}
    }
  })
  cleanups.push(fake.close)
  return fake
}

describe('openPage', () => {
  it('opens a background tab, waits for its load, and closes only the tab', async () => {
    const fake = await browser({
      navigate: (_call, emit) => {
        setTimeout(() => {
          emit('Page.loadEventFired', {}, 'S2')
          emit('Page.loadEventFired', {}, 'S1')
        }, 20)
        return { frameId: 'F1', loaderId: 'L1' }
      },
    })
    const page = await openPage(fake.url)
    await page.goto('https://one.alimama.com/index.html')
    await page.goto('https://one.alimama.com/index.html#!/other')
    await page.close()
    expect(fake.calls.map(call => [call.method, call.sessionId])).toEqual([
      ['Target.createTarget', undefined], ['Target.attachToTarget', undefined], ['Page.enable', 'S1'], ['Network.enable', 'S1'],
      ['Page.navigate', 'S1'], ['Page.navigate', 'S1'], ['Target.closeTarget', undefined],
    ])
    expect(fake.calls[0]?.params).toEqual({ url: 'about:blank', background: true })
  })

  it('fails a navigation Chrome refuses or that does not load in time', async () => {
    const refused = await openPage((await browser({ navigate: () => ({ errorText: 'net::ERR_BLOCKED_BY_CLIENT' }) })).url)
    await expect(refused.goto('https://x.test/')).rejects.toThrow('net::ERR_BLOCKED_BY_CLIENT')
    const slow = await openPage((await browser({ navigate: () => ({ loaderId: 'L1' }) })).url, 1000, 30)
    await expect(slow.goto('https://x.test/')).rejects.toThrow('没有加载完')
  })

  it('evaluates in the page and reports a thrown error', async () => {
    const fake = await browser({
      evaluate: ({ params }) => {
        if (params.expression === 'boom') return { result: {}, exceptionDetails: { text: 'Uncaught', exception: { description: 'Error: boom' } } }
        if (params.expression === 'bare') return { result: {}, exceptionDetails: { text: 'Uncaught' } }
        return { result: { value: { ok: true } } }
      },
    })
    const page = await openPage(fake.url)
    expect(await page.evaluate('1')).toEqual({ ok: true })
    expect(fake.calls.at(-1)?.params).toEqual({ expression: '1', awaitPromise: true, returnByValue: true })
    await expect(page.evaluate('boom')).rejects.toThrow('Error: boom')
    await expect(page.evaluate('bare')).rejects.toThrow('Uncaught')
  })

  it('reports the tab own requests, with their bodies', async () => {
    const fake = await browser({
      navigate: (_call, emit) => {
        emit('Network.requestWillBeSent', { request: { url: 'https://other.test/', method: 'GET' } }, 'S2')
        emit('Network.requestWillBeSent', { request: { url: 'https://a.test/q', method: 'POST', postData: '{"a":1}' } }, 'S1')
        emit('Network.requestWillBeSent', { request: { url: 'https://a.test/g', method: 'GET' } }, 'S1')
        return {}
      },
    })
    const page = await openPage(fake.url)
    const seen: unknown[] = []
    page.onRequest((request) => { seen.push(request) })
    await page.goto('https://a.test/')
    expect(await page.waitFor(() => seen.length === 2, 2000)).toBe(true)
    expect(seen).toEqual([{ url: 'https://a.test/q', method: 'POST', body: '{"a":1}' }, { url: 'https://a.test/g', method: 'GET' }])
  })

  it('reads the bodies of matching responses of its own tab', async () => {
    const fake = await browser({
      navigate: (_call, emit) => {
        emit('Network.responseReceived', { requestId: 'r1', response: { url: 'https://h5api/mtop.taobao.detail.getdesc/?a' } }, 'S1')
        emit('Network.responseReceived', { requestId: 'r2', response: { url: 'https://h5api/mtop.taobao.detail.getdesc/?b' } }, 'S1')
        emit('Network.responseReceived', { requestId: 'r3', response: { url: 'https://h5api/mtop.taobao.detail.getdesc/?c' } }, 'S2')
        emit('Network.responseReceived', { requestId: 'r4', response: { url: 'https://other/x.js' } }, 'S1')
        emit('Network.responseReceived', { requestId: 'r6', response: { url: 'https://h5api/mtop.taobao.detail.getdesc/?d' } }, 'S1')
        for (const requestId of ['r1', 'r2', 'r3', 'r4', 'r5', 'r6']) emit('Network.loadingFinished', { requestId }, 'S1')
        emit('Network.loadingFinished', { requestId: 'r3' }, 'S2')
        return {}
      },
      body: ({ params }) => params.requestId === 'r1' ? { body: Buffer.from('{"a":1}').toString('base64'), base64Encoded: true }
        : params.requestId === 'r2' ? new Error('No resource with given identifier found') : { body: 'plain', base64Encoded: false },
    })
    const page = await openPage(fake.url)
    const bodies: string[] = []
    page.onResponse(url => url.includes('getdesc'), (body) => { bodies.push(body) })
    await page.goto('https://item.taobao.com/item.htm?id=1')
    expect(await page.waitFor(() => fake.calls.filter(call => call.method === 'Network.getResponseBody').length === 3, 2000)).toBe(true)
    await page.waitFor(() => bodies.length === 2, 2000)
    expect(bodies).toEqual(['{"a":1}', 'plain'])
    expect(fake.calls.filter(call => call.method === 'Network.getResponseBody').map(call => call.params.requestId)).toEqual(['r1', 'r2', 'r6'])
  })

  it('waits for a condition until its time is up', async () => {
    const page = await openPage((await browser()).url)
    let checks = 0
    expect(await page.waitFor(() => ++checks === 2, 2000)).toBe(true)
    expect(await page.waitFor(() => false, 0)).toBe(false)
  })

  it('closes the tab and the connection when setting the tab up fails', async () => {
    const fake = await fakeCdp(({ method }) => {
      if (method === 'Network.enable' || method === 'Target.closeTarget') return new Error(`${method} failed`)
      return { targetId: 'T1', sessionId: 'S1' }
    })
    cleanups.push(fake.close)
    await expect(openPage(fake.url)).rejects.toThrow('Network.enable failed')
    expect(fake.calls.at(-1)).toEqual({ method: 'Target.closeTarget', params: { targetId: 'T1' } })
    const early = await fakeCdp(() => new Error('Target.createTarget failed'))
    cleanups.push(early.close)
    await expect(openPage(early.url)).rejects.toThrow('Target.createTarget failed')
    expect(early.calls.map(call => call.method)).toEqual(['Target.createTarget'])
  })

  it('closes the connection even when closing the tab fails', async () => {
    const fake = await fakeCdp(({ method }) => method === 'Target.closeTarget' ? new Error('No target') : { targetId: 'T1', sessionId: 'S1' })
    cleanups.push(fake.close)
    const page = await openPage(fake.url)
    await expect(page.close()).rejects.toThrow('No target')
  })
})

describe('page helpers', () => {
  it('builds in-page fetches with the page cookies', () => {
    expect(fetchJson('https://a.test/x')).toBe('(async () => { const r = await fetch("https://a.test/x", { credentials: \'include\' }); return await r.json() })()')
    expect(fetchJson('https://a.test/x', { a: '"' })).toContain('body: "{\\"a\\":\\"\\\\\\"\\"}"')
  })

  it('stops as signed out', () => {
    try {
      signedOut('万相台')
    } catch (error) {
      expect(error).toBeInstanceOf(SkillError)
      expect((error as SkillError).exitCode).toBe(EXIT.signedOut)
      expect((error as SkillError).message).toContain('万相台需要重新登录')
    }
  })
})
