/**
 * The Douyin shop merchant backend (fxg.jinritemai.com) from inside its own pages. Reads are plain
 * same-origin calls; anything else goes through the page's `XMLHttpRequest`, which the page's security
 * SDK signs. The new-item page keeps its form in a store the page's React tree holds; DSH finds that
 * store and saves through the page's own save, so the page builds the request and its signature.
 */

import { EXIT, SkillError } from './errors.ts'
import { signedOut, type Page } from './page.ts'

/** The merchant backend's address. */
export const DOUDIAN_ORIGIN = 'https://fxg.jinritemai.com'

/** The new-item page; it holds the publish session a category prediction names. */
export const DOUDIAN_CREATE_URL = `${DOUDIAN_ORIGIN}/ffa/g/create`

/** The 草稿箱 page. */
export const DOUDIAN_DRAFTS_URL = `${DOUDIAN_ORIGIN}/ffa/g/draft`

/**
 * The new-item page with a category chosen, whose store holds that category's form.
 * @param catId - the leaf category.
 * @returns the address.
 */
export const createUrl = (catId: string): string => `${DOUDIAN_ORIGIN}/ffa/g/create?category_leaf_id=${encodeURIComponent(catId)}`

/**
 * Whether an address is the Douyin shop sign-in page.
 * @param href - the page's address.
 * @returns true for the sign-in page.
 */
export function isDoudianSignIn(href: string): boolean {
  return new URL(href).pathname.startsWith('/login')
}

/**
 * Finds the new-item page's form store in its React tree, as `window.__dshGoodsStore`: the object with
 * `formatSchemaData`. Answers whether it is there.
 */
export const FIND_STORE = `(() => {
  if (window.__dshGoodsStore) return true
  const visit = (fiber, depth) => {
    for (let n = fiber; n && depth < 4000; n = n.sibling) {
      for (const source of [n.memoizedProps, n.stateNode, n.memoizedState]) {
        if (source && typeof source === 'object') for (const key of Object.keys(source)) {
          const value = source[key]
          if (value && typeof value === 'object' && typeof value.formatSchemaData === 'function') { window.__dshGoodsStore = value; return true }
        }
      }
      if (n.child && visit(n.child, depth + 1)) return true
    }
    return false
  }
  for (const el of document.querySelectorAll('*')) {
    const key = Object.keys(el).find(name => name.startsWith('__reactContainer$'))
    if (key && visit(el[key], 0)) return true
  }
  return false
})()`

/**
 * Makes the page refuse to send an item submit that is not a draft save: `addWithSchema` and
 * `editWithSchema` go out only with `check_status=1`, whatever the page's code asks for.
 */
export const GUARD = `(() => {
  if (window.__dshDraftGuard) return true
  const open = XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    const address = String(url)
    if (/\\/(addWithSchema|editWithSchema)/.test(address) && !/[?&]check_status=1(&|$)/.test(address)) throw new Error('DSH 只允许保存草稿，已拦截：' + address.split('?')[0])
    return open.call(this, method, url, ...rest)
  }
  window.__dshDraftGuard = true
  return true
})()`

/**
 * Open a seller page and wait until a condition holds there.
 * @param page - the tab.
 * @param url - the seller page.
 * @param ready - an expression true once the page is ready.
 * @throws SkillError signed-out on the sign-in page, failed when the page never gets ready.
 */
export async function openDoudian(page: Page, url: string, ready = "document.readyState === 'complete'"): Promise<void> {
  await page.goto(url)
  const seen = { signIn: false }
  const done = await page.waitFor(async () => {
    seen.signIn = isDoudianSignIn(await page.evaluate<string>('location.href'))
    return seen.signIn || await page.evaluate<boolean>(ready)
  }, 45_000)
  if (seen.signIn) signedOut('抖店商家后台')
  if (!done) throw new SkillError(`抖店商家后台页面打不开或已改版（${url}）。`, EXIT.failed)
}

/** Douyin shop refused a call: nothing it was asked to do happened. */
export class DoudianRefusal extends SkillError {}

/** An answer of the merchant backend. */
interface Answer<T> {
  readonly code?: number
  readonly msg?: string
  readonly data?: T
}

/**
 * Call the backend from an open seller page: through the page's signed `XMLHttpRequest`.
 * @param page - a seller page.
 * @param method - `GET` or `POST`.
 * @param path - the path, with its query.
 * @param body - the JSON body of a POST.
 * @returns the answer's data.
 * @throws DoudianRefusal with the backend's message when it refuses; SkillError signed-out when it says
 *   to sign in, failed when it gave no readable answer.
 */
export async function doudianCall<T>(page: Page, method: 'GET' | 'POST', path: string, body?: object): Promise<T> {
  const answer = await page.evaluate<Answer<T> | { unanswered: string } | null>(`new Promise((resolve) => {
  const x = new XMLHttpRequest()
  x.open(${JSON.stringify(method)}, ${JSON.stringify(path)} + (${JSON.stringify(path)}.includes('?') ? '&' : '?') + 'appid=1&_bid=ffa_goods')
  x.withCredentials = true
  ${body === undefined ? '' : "x.setRequestHeader('content-type', 'application/json')"}
  x.onload = () => { try { resolve(JSON.parse(x.responseText)) } catch (e) { resolve({ unanswered: 'HTTP ' + x.status }) } }
  x.onerror = () => resolve({ unanswered: 'network error' })
  x.send(${body === undefined ? 'null' : JSON.stringify(JSON.stringify(body))})
})`)
  const name = path.split('?')[0] as string
  if (answer === null || 'unanswered' in answer) {
    throw new SkillError(`抖店接口 ${name} 没有给出可读的答复（${answer?.unanswered ?? '无应答'}）。`, EXIT.failed)
  }
  if (answer.code !== 0) {
    const message = answer.msg ?? '无应答'
    if (/登录|login/iu.test(message)) signedOut('抖店商家后台')
    throw new DoudianRefusal(`抖店接口 ${name} 拒绝了请求（${message}）。`, EXIT.failed)
  }
  return answer.data as T
}
