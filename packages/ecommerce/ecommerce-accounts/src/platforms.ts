/**
 * What DSH knows about each e-commerce platform's sign-in: where to sign in, which page to open to
 * check it, and how to read the platform's own response on that page. The check reads the
 * platform's response; it never reads or keeps a cookie.
 */

import type { EcommercePlatform } from './types.ts'

/** What the platform's check response says. */
export type CheckAnswer =
  | { readonly signedIn: false }
  /** `name` is the account name the platform reports, when its response carries one. */
  | { readonly signedIn: true; readonly name?: string }

/** How DSH signs in to and checks one platform. */
export interface PlatformSpec {
  readonly id: EcommercePlatform
  /** Page the user signs in on. */
  readonly loginUrl: string
  /** Whether a page address is still part of signing in; a check whose page lands there is signed out. */
  readonly isLoginPage: (url: string) => boolean
  /** Business page whose loading calls {@link checkApi}; it may be the check API itself. */
  readonly pageUrl: string
  /** Address prefix of the platform's own response that tells whether the account is signed in; queries are ignored. */
  readonly checkApi: string
  /**
   * Read the check response.
   * @param body - the response text, JSON or JSONP.
   * @returns whether the account is signed in, and its name on the platform when reported.
   */
  readonly read: (body: string) => CheckAnswer
  /**
   * Another response of the business page that names the signed-in store, for platforms that do
   * not name the account: its address prefix, and how to read the store name from it.
   */
  readonly store?: { readonly api: string; readonly read: (body: string) => string | undefined }
}

/**
 * Parse JSON, or JSONP such as `mtopjsonp3({...})`.
 * @param body - the response text.
 * @returns the parsed value, or undefined when it is neither.
 */
export function parseJsonOrJsonp(body: string): unknown {
  const text = body.trim()
  try {
    return JSON.parse(text)
  } catch {
    // Not plain JSON; try the JSONP wrapper below.
  }
  const start = text.indexOf('(')
  const end = text.lastIndexOf(')')
  if (start <= 0 || end <= start) return undefined
  try {
    return JSON.parse(text.slice(start + 1, end))
  } catch {
    // Neither JSON nor JSONP.
    return undefined
  }
}

/** The object a JSON or JSONP body carries, or undefined when it carries none. */
function objectOf(body: string): Record<string, unknown> | undefined {
  const parsed = parseJsonOrJsonp(body)
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
}

/** Whether an mtop response succeeded: `ret[0]` starts with `SUCCESS::`. */
function mtopSucceeded(value: Record<string, unknown>): boolean {
  const ret: unknown = Array.isArray(value.ret) ? value.ret[0] : undefined
  return typeof ret === 'string' && ret.startsWith('SUCCESS::')
}

/**
 * Read an mtop `getusersimple` response: `ret[0]` starts with `SUCCESS::` and `data.nick` is set.
 * @param body - the response text.
 * @returns the nick, or undefined when the response says the user is not signed in.
 */
export function mtopUserNick(body: string): string | undefined {
  const value = objectOf(body)
  if (value === undefined || !mtopSucceeded(value)) return undefined
  const nick = (value.data as { nick?: unknown } | null | undefined)?.nick
  return typeof nick === 'string' && nick !== '' ? nick : undefined
}

/** Whether a sign-in host serves this address: Taobao's and Tmall's shared login pages, and the Qianniu seller sign-in. */
const TAOBAO_LOGIN = /^https?:\/\/(?:login|loginmyseller|havanalogin)\.(?:tmall|taobao)\.com\//u

/** Tmall: the home page asks `mtop.user.getusersimple`, which names the signed-in user. */
export const TMALL: PlatformSpec = {
  id: 'tmall',
  loginUrl: 'https://login.tmall.com/',
  isLoginPage: url => TAOBAO_LOGIN.test(url),
  pageUrl: 'https://www.tmall.com/',
  checkApi: 'https://h5api.m.tmall.com/h5/mtop.user.getusersimple/1.0/',
  read: (body) => {
    const nick = mtopUserNick(body)
    return nick === undefined ? { signedIn: false } : { signedIn: true, name: nick }
  },
}

/** Taobao sellers: the Qianniu workbench asks `mtop.taobao.jdy.resource.shop.info.get`; signed out, it sends the page to sign in. */
export const TAOBAO: PlatformSpec = {
  id: 'taobao',
  loginUrl: 'https://login.taobao.com/havanaone/login/login.htm?bizName=taobao&redirectURL=https%3A%2F%2Fqn.taobao.com%2Fhome.htm%2FQnworkbenchHome%2F',
  isLoginPage: url => TAOBAO_LOGIN.test(url),
  pageUrl: 'https://qn.taobao.com/home.htm/QnworkbenchHome/',
  checkApi: 'https://h5api.m.taobao.com/h5/mtop.taobao.jdy.resource.shop.info.get/1.0/',
  read: (body) => {
    const value = objectOf(body)
    return value !== undefined && mtopSucceeded(value) ? { signedIn: true } : { signedIn: false }
  },
}

/** A non-empty string, or undefined. */
const text = (value: unknown): string | undefined => typeof value === 'string' && value !== '' ? value : undefined

/**
 * Pinduoduo merchants: the backend home page asks `janus/api/checkLogin`, which says `result.login`,
 * and `querySimpleCredential`, which names the store; signed out, it sends the page to sign in.
 */
export const PINDUODUO: PlatformSpec = {
  id: 'pinduoduo',
  loginUrl: 'https://mms.pinduoduo.com/login/',
  isLoginPage: url => url.startsWith('https://mms.pinduoduo.com/login'),
  pageUrl: 'https://mms.pinduoduo.com/home/',
  checkApi: 'https://mms.pinduoduo.com/janus/api/checkLogin',
  read: (body) => {
    const result = objectOf(body)?.result as { login?: unknown } | null | undefined
    return result?.login === true ? { signedIn: true } : { signedIn: false }
  },
  store: {
    api: 'https://mms.pinduoduo.com/earth/api/mallInfo/querySimpleCredential',
    read: (body) => {
      const result = objectOf(body)?.result as { merchantMainSimpleVO?: { mallName?: unknown } | null } | null | undefined
      return text(result?.merchantMainSimpleVO?.mallName)
    },
  },
}

/**
 * Douyin shops (抖店): the shop home page asks for its menu, which is empty or refused while signed
 * out, and for the shop's qualification, which names the store.
 */
export const DOUDIAN: PlatformSpec = {
  id: 'doudian',
  loginUrl: 'https://fxg.jinritemai.com/login/common',
  isLoginPage: url => url.startsWith('https://fxg.jinritemai.com/login'),
  pageUrl: 'https://fxg.jinritemai.com/ffa/mshop/homepage/index',
  checkApi: 'https://fxg.jinritemai.com/byteshop/menu/list/v2',
  read: (body) => {
    const value = objectOf(body)
    const menu = (value?.data as { menu_list?: unknown } | null | undefined)?.menu_list
    return value?.code === 0 && Array.isArray(menu) && menu.length > 0 ? { signedIn: true } : { signedIn: false }
  },
  store: {
    api: 'https://fxg.jinritemai.com/center/qualification/shop/info',
    read: body => text((objectOf(body)?.data as { shop_name?: unknown } | null | undefined)?.shop_name),
  },
}

/** Every platform by id. */
export const PLATFORMS: Readonly<Record<EcommercePlatform, PlatformSpec>> = {
  tmall: TMALL, taobao: TAOBAO, pinduoduo: PINDUODUO, doudian: DOUDIAN,
}

/**
 * Whether a response address is the check API: same origin and a path that starts with the check
 * path, ignoring the query, whose signature and time change on every call.
 * @param url - the response address.
 * @param checkApi - the platform's check API.
 * @returns true when it matches.
 */
export function matchesCheckApi(url: string, checkApi: string): boolean {
  try {
    const actual = new URL(url)
    const wanted = new URL(checkApi)
    const path = (value: string): string => value.length > 1 ? value.replace(/\/+$/u, '') : value
    return actual.origin === wanted.origin && path(actual.pathname).startsWith(path(wanted.pathname))
  } catch {
    // An address that is not a URL, such as a data URL, is never the check API.
    return false
  }
}
