/**
 * What DSH knows about each e-commerce platform's sign-in: where to sign in, which page to open to
 * check it, and how to read the platform's own response on that page. The check reads the
 * platform's response; it never reads or keeps a cookie.
 */

import type { EcommercePlatform } from './types.ts'

/** How DSH signs in to and checks one platform. */
export interface PlatformSpec {
  readonly id: EcommercePlatform
  /** Page the user signs in on. */
  readonly loginUrl: string
  /** Whether a page address is still part of signing in. */
  readonly isLoginPage: (url: string) => boolean
  /** Business page whose loading calls {@link checkApi}. */
  readonly pageUrl: string
  /** Address prefix of the platform's own response that tells whether the account is signed in; queries are ignored. */
  readonly checkApi: string
  /**
   * Read the check response.
   * @param body - the response text, JSON or JSONP.
   * @returns the signed-in account's name on the platform, or undefined when not signed in.
   */
  readonly signedInAs: (body: string) => string | undefined
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

/**
 * Read an mtop `getusersimple` response: `ret[0]` starts with `SUCCESS::` and `data.nick` is set.
 * @param body - the response text.
 * @returns the nick, or undefined when the response says the user is not signed in.
 */
export function mtopUserNick(body: string): string | undefined {
  const parsed = parseJsonOrJsonp(body)
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const value = parsed as { ret?: unknown; data?: { nick?: unknown } | null }
  const ret: unknown = Array.isArray(value.ret) ? value.ret[0] : undefined
  if (typeof ret !== 'string' || !ret.startsWith('SUCCESS::')) return undefined
  const nick = value.data?.nick
  return typeof nick === 'string' && nick !== '' ? nick : undefined
}

/** Tmall: the home page asks `mtop.user.getusersimple`, which names the signed-in user. */
export const TMALL: PlatformSpec = {
  id: 'tmall',
  loginUrl: 'https://login.tmall.com/',
  isLoginPage: url => /^https?:\/\/login\.(?:tmall|taobao)\.com\//u.test(url),
  pageUrl: 'https://www.tmall.com/',
  checkApi: 'https://h5api.m.tmall.com/h5/mtop.user.getusersimple/1.0/',
  signedInAs: mtopUserNick,
}

/** Every platform by id. */
export const PLATFORMS: Readonly<Record<EcommercePlatform, PlatformSpec>> = { tmall: TMALL }

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
