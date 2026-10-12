/**
 * The watch DSH keeps on an account's browser while a task uses it. Through a DevTools connection
 * of its own, attached to every tab before the tab runs, it pauses each page load: a page the
 * rules refuse never loads, and once the platform's risk control shows, nothing else loads for
 * the rest of the task. A tab whose page lands on the platform's sign-in page is reported, after
 * any redirects that only pass through it, and still loads, so the task sees it too. A tab the task
 * opens in front, which brings its window back on screen, has the window minimized again. The task's own connection cannot get around it.
 */

import { Cdp } from './cdp.ts'

/** Whether an address belongs to the platform's risk control: its verification or block page. */
export const RISK_PAGE = /_____tmd_____|\/punish\b/u

/** What the watch asks about the task's pages. */
export interface GuardRules {
  /**
   * Decide whether a new page may open, and count it when it may; called once per page, however
   * many redirects it takes.
   * @param url - the page's address.
   * @returns true to let it open.
   */
  readonly page: (url: string) => boolean
  /**
   * The platform's risk control showed.
   * @param url - the address of its page.
   */
  readonly risk: (url: string) => void
  /**
   * Whether an address is the platform's sign-in page.
   * @param url - a tab's address.
   * @returns true for the sign-in page.
   */
  readonly signInPage: (url: string) => boolean
  /**
   * A tab was sent to the platform's sign-in page: the account is signed out.
   * @param url - the address of the sign-in page.
   */
  readonly signedOut: (url: string) => void
}

/** Ignore a call the browser no longer answers, such as one for a tab that closed. */
const ignore = (): undefined => undefined

/** Minimize the window of a tab when it is on screen; a tab that closed meanwhile is left. */
function minimizeWindowOf(cdp: Cdp, targetId: string): Promise<void> {
  return cdp.send<{ windowId: number }>('Browser.getWindowForTarget', { targetId }).then(async ({ windowId }) => {
    const { bounds } = await cdp.send<{ bounds: { windowState: string } }>('Browser.getWindowBounds', { windowId })
    if (bounds.windowState === 'normal' || bounds.windowState === 'maximized') {
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } })
    }
  }).catch(ignore)
}

/**
 * Watch every tab of a browser until the returned function is called.
 * @param port - the browser's remote-debugging port.
 * @param timeoutMs - how long to wait for the connection.
 * @param rules - what may open, and what to do on risk control.
 * @returns a function that ends the watch, once the loads of every tab already open are intercepted; a tab
 *   opened later loads nothing until its loads are intercepted too.
 */
export async function guardBrowser(port: number, timeoutMs: number, rules: GuardRules): Promise<() => void> {
  const cdp = await Cdp.connect(port, timeoutMs)
  /** Each watched tab's session, to the tab's id, which is also its main frame's id. */
  const tabs = new Map<string, string>()
  /** Page loads already decided, by their network request, which redirects keep. */
  const decided = new Map<string, boolean>()
  let stopped = false
  /** Tabs whose watch is still being put in place. */
  const watching = new Set<Promise<void>>()
  cdp.on('Target.attachedToTarget', (params) => {
    const sessionId = params.sessionId as string
    const target = params.targetInfo as { targetId: string; type: string }
    const watched = (async () => {
      if (target.type === 'page') {
        tabs.set(sessionId, target.targetId)
        void minimizeWindowOf(cdp, target.targetId)
        // The network domain gives each paused load the network request id that its redirects keep. A
        // tab may load nothing before Chrome intercepts its loads: Fetch.enable answers once it does.
        await Promise.all([
          cdp.send('Network.enable', {}, sessionId).catch(ignore),
          cdp.send('Page.enable', {}, sessionId).catch(ignore),
          cdp.send('Fetch.enable', { patterns: [{ resourceType: 'Document', requestStage: 'Request' }] }, sessionId).catch(ignore),
        ])
      }
      // A tab waits for this before it loads anything, so the watch is in place first.
      await cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(ignore)
    })()
    watching.add(watched)
    void watched.finally(() => { watching.delete(watched) })
  })
  // A navigation commits once its redirects are done, so only the page a tab lands on counts.
  cdp.on('Page.frameNavigated', (params, sessionId) => {
    const frame = params.frame as { id: string; url: string }
    if (frame.id === tabs.get(sessionId as string) && rules.signInPage(frame.url)) rules.signedOut(frame.url)
  })
  cdp.on('Fetch.requestPaused', (params, sessionId) => {
    const { url } = params.request as { url: string }
    const loadId = params.networkId as string
    let allow: boolean
    if (stopped) {
      allow = false
    } else if (RISK_PAGE.test(url)) {
      stopped = true
      rules.risk(url)
      allow = false
    } else if (params.frameId !== tabs.get(sessionId as string) || !/^https?:/u.test(url)) {
      allow = true
    } else {
      allow = decided.get(loadId) ?? rules.page(url)
      decided.set(loadId, allow)
    }
    const requestId = params.requestId as string
    void cdp.send(allow ? 'Fetch.continueRequest' : 'Fetch.failRequest', allow ? { requestId } : { requestId, errorReason: 'BlockedByClient' }, sessionId).catch(ignore)
  })
  await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true })
  // Tabs open before the watch do not wait for it: answer only once their loads are intercepted too.
  await Promise.all(watching)
  return () => { cdp.close() }
}
