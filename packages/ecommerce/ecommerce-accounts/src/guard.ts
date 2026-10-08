/**
 * The watch DSH keeps on an account's browser while a task uses it. Through a DevTools connection
 * of its own, attached to every tab before the tab runs, it pauses each page load: a page the
 * rules refuse never loads, and once the platform's risk control shows, nothing else loads for
 * the rest of the task. The task's own connection cannot get around it.
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
}

/** Ignore a call the browser no longer answers, such as one for a tab that closed. */
const ignore = (): undefined => undefined

/**
 * Watch every tab of a browser until the returned function is called.
 * @param port - the browser's remote-debugging port.
 * @param timeoutMs - how long to wait for the connection.
 * @param rules - what may open, and what to do on risk control.
 * @returns a function that ends the watch.
 */
export async function guardBrowser(port: number, timeoutMs: number, rules: GuardRules): Promise<() => void> {
  const cdp = await Cdp.connect(port, timeoutMs)
  /** Each watched tab's session, to the tab's id, which is also its main frame's id. */
  const tabs = new Map<string, string>()
  /** Page loads already decided, by their network request, which redirects keep. */
  const decided = new Map<string, boolean>()
  let stopped = false
  cdp.on('Target.attachedToTarget', (params) => {
    const sessionId = params.sessionId as string
    const target = params.targetInfo as { targetId: string; type: string }
    if (target.type === 'page') {
      tabs.set(sessionId, target.targetId)
      // The network domain gives each paused load the network request id that its redirects keep.
      void cdp.send('Network.enable', {}, sessionId).catch(ignore)
      void cdp.send('Fetch.enable', { patterns: [{ resourceType: 'Document', requestStage: 'Request' }] }, sessionId).catch(ignore)
    }
    // A tab waits for this before it loads anything, so the watch is in place first.
    void cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(ignore)
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
  return () => { cdp.close() }
}
