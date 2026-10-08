/**
 * One background tab of a taken-over Chrome, opened by the skill and closed when it is done: navigate,
 * evaluate script in the page, and see the requests the page sends. The browser keeps running.
 */

import { Cdp } from '@deepseek-ai/dsh-ecommerce-accounts/src/cdp.ts'
import { EXIT, SkillError } from './errors.ts'

/** A request the page sent. */
export interface SentRequest {
  readonly url: string
  readonly method: string
  /** The request body, when it has one. */
  readonly body?: string
}

/** What a skill does with its tab. */
export interface Page {
  /**
   * Load a URL and wait for the page's load event; a change of only the fragment does not wait.
   * @param url - the address.
   */
  goto(url: string): Promise<void>
  /**
   * Run an expression in the page, awaiting a promise it returns.
   * @param expression - JavaScript source.
   * @returns the value, copied out of the page as JSON.
   */
  evaluate<T>(expression: string): Promise<T>
  /**
   * Watch the requests the page sends from now on.
   * @param listener - called once per request.
   */
  onRequest(listener: (request: SentRequest) => void): void
  /**
   * Wait for a condition, checking it every half second.
   * @param condition - true when the wait is over.
   * @param timeoutMs - the longest wait.
   * @returns whether the condition came true in time.
   */
  waitFor(condition: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean>
  /** Close the tab and the connection; Chrome keeps running. */
  close(): Promise<void>
}

/** What `Runtime.evaluate` answers. */
interface EvaluateAnswer<T> {
  readonly result: { readonly value?: T }
  readonly exceptionDetails?: { readonly exception?: { readonly description?: string }; readonly text: string }
}

/**
 * Open a background tab in the Chrome at a DevTools address.
 * @param cdpUrl - `http://127.0.0.1:<port>`, as `dsh-ecommerce browser` prints it.
 * @param timeoutMs - how long to wait for the connection.
 * @param loadTimeoutMs - how long one navigation may take.
 * @returns the tab.
 */
export async function openPage(cdpUrl: string, timeoutMs = 20_000, loadTimeoutMs = 60_000): Promise<Page> {
  const cdp = await Cdp.connect(Number(new URL(cdpUrl).port), timeoutMs)
  let targetId: string | undefined
  let sessionId: string
  try {
    ({ targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank', background: true }))
    ;({ sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true }))
    await cdp.send('Page.enable', {}, sessionId)
    await cdp.send('Network.enable', {}, sessionId)
  } catch (error) {
    if (targetId !== undefined) await cdp.send('Target.closeTarget', { targetId }).catch(() => undefined)
    cdp.close()
    throw error
  }
  const send = <T>(method: string, params: object = {}): Promise<T> => cdp.send<T>(method, params, sessionId)
  const page: Page = {
    async goto(url) {
      let settle!: (loaded: boolean) => void
      const load = new Promise<boolean>((resolve) => { settle = resolve })
      const stop = cdp.on('Page.loadEventFired', (_params, from) => { if (from === sessionId) settle(true) })
      const timer = setTimeout(() => { settle(false) }, loadTimeoutMs)
      try {
        const { errorText, loaderId } = await send<{ errorText?: string; loaderId?: string }>('Page.navigate', { url })
        if (errorText !== undefined) throw new SkillError(`打不开 ${url}：${errorText}`)
        if (loaderId !== undefined && !await load) throw new SkillError(`${url} 在 ${String(loadTimeoutMs / 1000)} 秒内没有加载完。`)
      } finally {
        clearTimeout(timer)
        stop()
      }
    },
    async evaluate<T>(expression: string) {
      const { result, exceptionDetails } = await send<EvaluateAnswer<T>>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (exceptionDetails !== undefined) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text)
      return result.value as T
    },
    onRequest(listener) {
      cdp.on('Network.requestWillBeSent', (params, from) => {
        if (from !== sessionId) return
        const { url, method, postData } = params.request as { url: string; method: string; postData?: string }
        listener({ url, method, ...postData === undefined ? {} : { body: postData } })
      })
    },
    async waitFor(condition, waitMs) {
      const deadline = Date.now() + waitMs
      for (;;) {
        if (await condition()) return true
        if (Date.now() >= deadline) return false
        await sleep(500)
      }
    },
    async close() {
      try {
        await cdp.send('Target.closeTarget', { targetId })
      } finally {
        cdp.close()
      }
    },
  }
  return page
}

/**
 * Wait.
 * @param ms - milliseconds.
 * @returns when the time has passed.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/**
 * The expression that fetches a URL from inside the page, with the page's cookies, and returns its JSON.
 * @param url - the address.
 * @param body - a JSON body to POST; a GET without it.
 * @returns JavaScript source for {@link Page.evaluate}.
 */
export function fetchJson(url: string, body?: object): string {
  const init = body === undefined
    ? '{ credentials: \'include\' }'
    : `{ method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: ${JSON.stringify(JSON.stringify(body))} }`
  return `(async () => { const r = await fetch(${JSON.stringify(url)}, ${init}); return await r.json() })()`
}

/**
 * Fail as signed out, so the user is sent to sign in again.
 * @param platform - the platform's name for the message.
 * @returns never.
 * @throws SkillError with the signed-out exit status.
 */
export function signedOut(platform: string): never {
  throw new SkillError(`${platform}需要重新登录。请在 DSH 设置 → 电商账号里重新登录这个账号后再试。`, EXIT.signedOut)
}
