import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import type { Deps } from '../src/cli.ts'
import type { Page, SentRequest } from '../src/page.ts'

/** The scene query body Alimama's report page sends, with its session fields. */
export const TEMPLATE = {
  bizCode: 'universalBP', source: 'baseReport', byPage: true, totalTag: true, rptType: 'account', pageSize: 20, unifyType: 'zhai',
  effectEqual: 15, startTime: '2026-10-06', endTime: '2026-10-06', splitType: 'day', queryFieldIn: ['adPv', 'click', 'charge'],
  queryDomains: ['scene'], csrfId: 'csrf-1', loginPointId: 'point-1',
}

/** Alimama's 2026-10-06 answer for the two scenes the store ran (real figures). */
export const SCENES_1006 = [
  {
    sceneId: 436, scene1Name: '货品全站推广', charge: 10151.400000000018, adPv: 93003, click: 6214, alipayInshopAmt: 25904.68, alipayInshopNum: 638,
    alipayInshopUv: 596, cartInshopNum: 427, inshopPotentialUvRate: 0.82742, orgNaturalPv: 90350, naturalPayAmt: 607.3515492573894,
  },
  {
    sceneId: 371, scene1Name: '关键词推广', charge: 650, adPv: 3626, click: 198, alipayInshopAmt: 615.87, alipayInshopNum: 23, alipayInshopUv: 22,
    cartInshopNum: 22, inshopPotentialUvRate: 0.7764, orgNaturalPv: 2931, naturalPayAmt: 40.22827424695214,
  },
]

/** How a fake page answers an expression; `undefined` falls through to the next route. */
export type Route = (expression: string, page: FakePage) => unknown

/** A scripted tab: navigation is recorded, expressions are answered by routes. */
export class FakePage implements Page {
  readonly visited: string[] = []
  readonly evaluated: string[] = []
  href = 'about:blank'
  closed = false
  private readonly listeners: ((request: SentRequest) => void)[] = []
  private readonly responses: { match: (url: string) => boolean; listener: (body: string) => void }[] = []

  /**
   * @param routes - answer expressions, first match wins.
   * @param onGoto - runs after each navigation, such as to send the page's own requests.
   */
  constructor(private readonly routes: Route[], private readonly onGoto: (url: string, page: FakePage) => void = () => {}) {}

  goto(url: string): Promise<void> {
    this.visited.push(url)
    this.href = url
    this.onGoto(url, this)
    return Promise.resolve()
  }

  evaluate<T>(expression: string): Promise<T> {
    this.evaluated.push(expression)
    if (expression === 'location.href') return Promise.resolve(this.href as T)
    for (const route of this.routes) {
      const answer = route(expression, this)
      if (answer instanceof Error) return Promise.reject(answer)
      if (answer !== undefined) return Promise.resolve(answer as T)
    }
    return Promise.reject(new Error(`no route for ${expression.slice(0, 120)}`))
  }

  onRequest(listener: (request: SentRequest) => void): void {
    this.listeners.push(listener)
  }

  onResponse(match: (url: string) => boolean, listener: (body: string) => void): void {
    this.responses.push({ match, listener })
  }

  /** Receive a response as the page. */
  respond(url: string, body: string): void {
    for (const { match, listener } of this.responses) if (match(url)) listener(body)
  }

  /** Send a request as the page. */
  send(request: SentRequest): void {
    for (const listener of this.listeners) listener(request)
  }

  async waitFor(condition: () => boolean | Promise<boolean>): Promise<boolean> {
    return condition()
  }

  close(): Promise<void> {
    this.closed = true
    return Promise.resolve()
  }
}

/** Route an expression that fetches a URL containing `part` to an answer. */
export function on(part: string, answer: unknown): Route {
  return expression => expression.includes(part) ? typeof answer === 'function' ? (answer as (e: string) => unknown)(expression) : answer : undefined
}

/** Send Alimama's scene query whenever the report page loads. */
export function sendsTemplate(url: string, page: FakePage): void {
  if (url.includes('#!/report/account')) {
    page.send({ url: 'https://one.alimama.com/report/query.json?csrfId=csrf-1', method: 'POST', body: JSON.stringify(TEMPLATE) })
  }
}

/** The JSON body a `fetchJson` expression posts. */
export function postedBody(expression: string): Record<string, unknown> {
  const literal = /body: ("(?:[^"\\]|\\.)*")/u.exec(expression)?.[1] as string
  return JSON.parse(JSON.parse(literal) as string) as Record<string, unknown>
}

/** An .xlsx file with one sheet of inline-string cells. */
export function xlsxOf(rows: readonly (readonly string[])[], extra: Record<string, string> = {}): Uint8Array<ArrayBuffer> {
  const xml = rows.map((row, r) => `<row r="${String(r + 1)}">${row.map((cell, c) =>
    `<c r="${String.fromCharCode(65 + c)}${String(r + 1)}" t="inlineStr"><is><t>${cell}</t></is></c>`).join('')}</row>`).join('')
  return new Uint8Array(zipSync({
    'xl/worksheets/sheet1.xml': strToU8(`<worksheet><sheetData>${xml}</sheetData></worksheet>`),
    ...Object.fromEntries(Object.entries(extra).map(([path, text]) => [path, strToU8(text)])),
  }))
}

/** Deps around a fake page, recording output. */
export function fakeDeps(page: FakePage, overrides: Partial<Deps> = {}): Deps & { out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return {
    takeOver: id => Promise.resolve({ id, store: '名流旗舰店（主账号）', account: '名流成人用品旗舰店:小美', cdpUrl: 'http://127.0.0.1:9' }),
    openPage: () => Promise.resolve(page),
    fetchFile: () => Promise.reject(new Error('no file')),
    now: () => new Date('2026-10-08T03:00:00Z'),
    stdout: (text) => { out.push(text) },
    stderr: (text) => { err.push(text) },
    out,
    err,
    ...overrides,
  }
}

/**
 * A temporary directory, removed by the returned cleanup.
 * @returns its path and the cleanup.
 */
export async function tempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tmall-skills-test-'))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}
