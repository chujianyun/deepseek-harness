/**
 * Pinduoduo's merchant backend (mms.pinduoduo.com) from inside its own pages. Every backend call there
 * must carry the page's risk-control payload (`anti-content`), which the page's own anti-content module
 * makes; a call without it is refused (54001). So each call runs in a signed-in seller page, takes that
 * module through the page's webpack runtime, and sends the payload it makes, as the page's request
 * library does.
 */

import { EXIT, SkillError } from './errors.ts'
import { signedOut, type Page } from './page.ts'

/** The merchant backend's address. */
export const PDD_ORIGIN = 'https://mms.pinduoduo.com'

/**
 * The goods list, whose 草稿箱 tab lists the drafts. It loads the seller app and its anti-content module
 * and, unlike the new-item category page, starts no edit session on opening.
 */
export const PDD_GOODS_URL = `${PDD_ORIGIN}/goods/goods_list`

/**
 * Whether an address is Pinduoduo's sign-in page.
 * @param href - the page's address.
 * @returns true for the sign-in page.
 */
export function isPddSignIn(href: string): boolean {
  const url = new URL(href)
  return url.pathname.startsWith('/login') || url.hostname.startsWith('login.')
}

/**
 * Installs `window.__dshPdd(method, path, body)` in the page: it takes the page's anti-content module
 * (webpack module `fbeZ`, or else a loaded module whose instances make a `messagePack`), and answers the
 * parsed JSON of the call. Answers `false` while the page has not loaded that module yet.
 */
export const INSTALL = `(() => {
  if (window.__dshPdd) return true
  const chunk = window.webpackJsonp
  if (!Array.isArray(chunk)) return false
  let req
  chunk.push([['dshPdd' + Date.now()], { dshPdd: (m, e, r) => { req = r } }, [['dshPdd']]])
  if (!req) return false
  const loaded = (id) => {
    if (!req.m || !req.m[id]) return undefined
    try {
      const m = req(id)
      const C = typeof m === 'function' ? m : m && m.default
      return typeof C === 'function' && typeof new C({ serverTime: Date.now() }).messagePack === 'function' ? C : undefined
    } catch (e) { return undefined }
  }
  const Anti = loaded('fbeZ') || Object.keys(req.m || {}).filter(key => String(req.m[key]).includes('messagePack')).map(loaded).find(Boolean)
  if (!Anti) return false
  window.__dshPdd = async (method, path, body) => {
    const anti = await new Anti({ serverTime: Date.now() }).messagePack()
    const headers = { 'anti-content': anti }
    if (body !== undefined) headers['content-type'] = 'application/json'
    const r = await fetch(${JSON.stringify(PDD_ORIGIN)} + path, { method, credentials: 'include', headers, body: body === undefined ? undefined : JSON.stringify(body) })
    try { return await r.json() } catch (e) { return { error_msg: 'HTTP ' + r.status } }
  }
  return true
})()`

/**
 * Open a seller page and get it ready for backend calls.
 * @param page - the tab.
 * @param url - the seller page.
 * @throws SkillError signed-out on the sign-in page, failed when the page never loads its seller app.
 */
export async function openPdd(page: Page, url = PDD_GOODS_URL): Promise<void> {
  await page.goto(url)
  const seen = { signIn: false }
  const ready = await page.waitFor(async () => {
    seen.signIn = isPddSignIn(await page.evaluate<string>('location.href'))
    return seen.signIn || await page.evaluate<boolean>(INSTALL)
  }, 30_000)
  if (seen.signIn) signedOut('拼多多商家后台')
  if (!ready) throw new SkillError(`拼多多商家后台页面打不开或已改版（${url}）。`, EXIT.failed)
}

/** Pinduoduo answered and refused the call: nothing it was asked to do happened. */
export class PddRefusal extends SkillError {}

/** A backend answer: the two spellings Pinduoduo's services use. */
interface Answer<T> {
  readonly success?: boolean
  readonly error_code?: number
  readonly errorCode?: number
  readonly error_msg?: string | null
  readonly errorMsg?: string | null
  readonly result?: T
}

/**
 * Call the backend from an open seller page.
 * @param page - a seller page {@link openPdd} opened.
 * @param method - `GET` or `POST`.
 * @param path - the path, with its query.
 * @param body - the JSON body of a POST.
 * @returns the answer's `result`.
 * @throws PddRefusal with the backend's message when it refuses.
 */
export async function pddCall<T>(page: Page, method: 'GET' | 'POST', path: string, body?: object): Promise<T> {
  const answer = await page.evaluate<Answer<T> | null>(`window.__dshPdd(${JSON.stringify(method)}, ${JSON.stringify(path)}, ${body === undefined ? 'undefined' : JSON.stringify(body)})`)
  const code = answer?.error_code ?? answer?.errorCode
  if (answer?.success !== true || (code !== undefined && code !== 1_000_000)) {
    const message = answer?.error_msg ?? answer?.errorMsg ?? '无应答'
    throw new PddRefusal(`拼多多接口 ${path.split('?')[0] as string} 拒绝了请求（${message}）。`, EXIT.failed)
  }
  return answer.result as T
}
