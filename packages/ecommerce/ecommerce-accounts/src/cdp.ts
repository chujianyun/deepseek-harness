/**
 * The few Chrome DevTools Protocol calls an e-commerce account needs, over the browser-level
 * WebSocket of a Chrome that DSH started with a remote-debugging port: open a background tab and
 * read the platform's own sign-in response there, show the sign-in tab, and minimize every window.
 * Page sessions use flat mode, so one socket carries every tab.
 */

import WebSocket from 'ws'
import { matchesCheckApi, type PlatformSpec } from './platforms.ts'

/** The answer to one call. */
interface Reply { readonly id: number; readonly result?: unknown; readonly error?: { readonly message: string } }

/** An event; `sessionId` names the tab session, absent for browser-level events. */
interface Event { readonly method: string; readonly params: Record<string, unknown>; readonly sessionId?: string }

/** A CDP event listener; `sessionId` names the tab session, absent for browser-level events. */
type Listener = (params: Record<string, unknown>, sessionId: string | undefined) => void

/** One browser-level CDP connection. */
export class Cdp {
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private readonly listeners = new Map<string, Set<Listener>>()

  private constructor(private readonly socket: WebSocket) {
    socket.on('message', (data: Buffer) => { this.receive(data.toString('utf8')) })
    socket.on('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('the Chrome DevTools connection closed'))
      this.pending.clear()
    })
  }

  /**
   * Connect to the browser of a local Chrome.
   * @param port - its remote-debugging port.
   * @param timeoutMs - how long to wait for the connection.
   * @returns the connection.
   */
  static async connect(port: number, timeoutMs: number): Promise<Cdp> {
    const response = await fetch(`http://127.0.0.1:${String(port)}/json/version`, { signal: AbortSignal.timeout(timeoutMs) })
    const { webSocketDebuggerUrl } = await response.json() as { webSocketDebuggerUrl: string }
    const socket = new WebSocket(webSocketDebuggerUrl, { handshakeTimeout: timeoutMs, perMessageDeflate: false })
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => { resolve() })
      socket.once('error', reject)
    })
    return new Cdp(socket)
  }

  /**
   * Call a CDP method.
   * @param method - the method, such as `Target.createTarget`.
   * @param params - its parameters.
   * @param sessionId - the tab session, or none for the browser.
   * @returns the result.
   */
  send<T = Record<string, unknown>>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => { resolve(value as T) }, reject })
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }))
    })
  }

  /**
   * Listen to a CDP event.
   * @param method - the event, such as `Network.responseReceived`.
   * @param listener - called with its parameters and session.
   * @returns the disposer.
   */
  on(method: string, listener: Listener): () => void {
    let set = this.listeners.get(method)
    if (set === undefined) this.listeners.set(method, set = new Set())
    set.add(listener)
    return () => { set.delete(listener) }
  }

  /** Close the connection; Chrome keeps running. */
  close(): void {
    this.socket.close()
  }

  private receive(text: string): void {
    const message = JSON.parse(text) as Reply | Event
    if ('id' in message) {
      // Every reply answers a call this connection sent.
      const waiter = this.pending.get(message.id) as { resolve: (value: unknown) => void; reject: (error: Error) => void }
      this.pending.delete(message.id)
      if (message.error === undefined) waiter.resolve(message.result)
      else waiter.reject(new Error(message.error.message))
      return
    }
    for (const listener of this.listeners.get(message.method) ?? []) listener(message.params, message.sessionId)
  }
}

/** The outcome of asking the platform whether the account is signed in. */
export type ProbeResult =
  | { readonly kind: 'signed-in'; readonly nick: string }
  | { readonly kind: 'signed-out' }
  /** The page never sent the check response in time. */
  | { readonly kind: 'no-response' }

/**
 * Open the platform's business page in a background tab and read its own sign-in response.
 * The listener is attached before navigating, so the response is never missed; the tab closes
 * afterwards whatever happens.
 * @param cdp - the browser connection.
 * @param spec - the platform.
 * @param timeoutMs - how long to wait for the response.
 * @returns what the response says.
 */
export async function probe(cdp: Cdp, spec: PlatformSpec, timeoutMs: number): Promise<ProbeResult> {
  const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank', background: true })
  const disposers: (() => void)[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })
    const body = new Promise<string | undefined>((resolve) => {
      let requestId: unknown
      disposers.push(cdp.on('Network.responseReceived', (params, from) => {
        const url = (params.response as { url: string }).url
        if (from === sessionId && requestId === undefined && matchesCheckApi(url, spec.checkApi)) requestId = params.requestId
      }))
      disposers.push(cdp.on('Network.loadingFinished', (params, from) => {
        if (from !== sessionId || params.requestId !== requestId) return
        cdp.send<{ body: string; base64Encoded: boolean }>('Network.getResponseBody', { requestId }, sessionId)
          .then(({ body: text, base64Encoded }) => { resolve(base64Encoded ? Buffer.from(text, 'base64').toString('utf8') : text) })
          // A body Chrome no longer holds counts as no answer.
          .catch(() => { resolve(undefined) })
      }))
      timer = setTimeout(() => { resolve(undefined) }, timeoutMs)
    })
    await cdp.send('Network.enable', {}, sessionId)
    await cdp.send('Page.navigate', { url: spec.pageUrl }, sessionId)
    const text = await body
    if (text === undefined) return { kind: 'no-response' }
    const nick = spec.signedInAs(text)
    return nick === undefined ? { kind: 'signed-out' } : { kind: 'signed-in', nick }
  } finally {
    clearTimeout(timer)
    for (const dispose of disposers) dispose()
    await cdp.send('Target.closeTarget', { targetId }).catch(() => undefined)
  }
}

/**
 * The page tabs of the browser.
 * @param cdp - the browser connection.
 * @returns each tab's id and address.
 */
export async function pageTabs(cdp: Cdp): Promise<{ readonly targetId: string; readonly url: string }[]> {
  const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>('Target.getTargets')
  return targetInfos.filter(info => info.type === 'page').map(({ targetId, url }) => ({ targetId, url }))
}

/**
 * Open the sign-in page in a new tab and bring its window on screen, in front.
 * @param cdp - the browser connection.
 * @param url - the sign-in page.
 * @returns the tab id.
 */
export async function showSignIn(cdp: Cdp, url: string): Promise<string> {
  const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url })
  const { windowId } = await cdp.send<{ windowId: number }>('Browser.getWindowForTarget', { targetId })
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: 80, top: 80, width: 1280, height: 880 } })
  await cdp.send('Target.activateTarget', { targetId })
  return targetId
}

/**
 * Minimize every window of the browser, so it keeps running unseen. Minimizing rather than moving
 * off screen: macOS keeps part of any window on screen.
 * @param cdp - the browser connection.
 */
export async function hideWindows(cdp: Cdp): Promise<void> {
  const windows = new Set<number>()
  for (const tab of await pageTabs(cdp)) {
    // Chrome still lists a tab that is closing, though it has no window any more.
    const found = await cdp.send<{ windowId: number }>('Browser.getWindowForTarget', { targetId: tab.targetId }).catch(() => undefined)
    if (found !== undefined) windows.add(found.windowId)
  }
  for (const windowId of windows) {
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } })
  }
}

/**
 * Close the blank tabs a started Chrome gathers: the page it was started on, beside the tabs it
 * restored from its last session. One blank tab stays when every tab is blank, so the browser
 * keeps a tab to drive.
 * @param cdp - the browser connection.
 */
export async function closeBlankTabs(cdp: Cdp): Promise<void> {
  const tabs = await pageTabs(cdp)
  const blank = tabs.filter(tab => tab.url === 'about:blank')
  for (const tab of blank.length === tabs.length ? blank.slice(1) : blank) {
    // A tab that closed meanwhile is already gone.
    await cdp.send('Target.closeTarget', { targetId: tab.targetId }).catch(() => undefined)
  }
}
