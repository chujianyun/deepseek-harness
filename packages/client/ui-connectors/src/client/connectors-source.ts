/** Connectors page state and actions over the `connectors` Remote. */

import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { ConnectorsState } from '@deepseek-ai/dsh-connectors/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

/** State the page renders. */
export interface ConnectorsSnapshot {
  /** Latest Host state; undefined until the first frame arrives. */
  readonly state: ConnectorsState | undefined
  /** Connectors with an action in flight. */
  readonly busy: readonly string[]
  /** The Host's message for the last refused action. */
  readonly failure: string | null
}

/** Remote calls and the browser opener the source drives. */
export interface ConnectorsDependencies {
  readonly install: (id: string) => Promise<RemoteResult<ConnectorsState>>
  readonly uninstall: (id: string) => Promise<RemoteResult<ConnectorsState>>
  readonly connect: (id: string) => Promise<RemoteResult<ConnectorsState>>
  readonly cancelConnect: (id: string) => Promise<RemoteResult<ConnectorsState>>
  readonly disconnect: (id: string) => Promise<RemoteResult<ConnectorsState>>
  readonly check: () => Promise<RemoteResult<ConnectorsState>>
  readonly setEnabled: (id: string, enabled: boolean) => Promise<RemoteResult<ConnectorsState>>
  /** Open an address in the system browser. */
  readonly openUrl: (url: string) => void
}

/** Business face injected into the page. */
export interface ConnectorsInjected {
  readonly hooks: { readonly connectors: HostObservable<ConnectorsSnapshot> }
  readonly onInstall: (id: string) => Promise<void>
  readonly onUninstall: (id: string) => Promise<void>
  readonly onConnect: (id: string) => Promise<void>
  readonly onCancelConnect: (id: string) => Promise<void>
  readonly onDisconnect: (id: string) => Promise<void>
  /** Switch a connector on or off for the current company. */
  readonly onSetEnabled: (id: string, enabled: boolean) => Promise<void>
  /** Check every connection again, as opening the page does. */
  readonly onCheck: () => Promise<void>
  /** Open a sign-in address in the system browser. */
  readonly onOpenUrl: (url: string) => void
  /** Clear the last failure. */
  readonly onDismiss: () => void
}

/** The face plus the Host stream's entry point. */
export interface ConnectorsSource extends ConnectorsInjected {
  readonly publish: (state: ConnectorsState) => void
}

/**
 * Create the source. Card state comes only from the stream, which is ordered; an action's
 * answer can arrive after a newer frame, so it reports only a refusal. A sign-in this page
 * started opens each step's address in the browser once, when the Host first reports it.
 * @param deps - Remote calls and the browser opener.
 * @returns the observable snapshot, the actions, and the frame entry point.
 */
export function createConnectorsSource(deps: ConnectorsDependencies): ConnectorsSource {
  const store = createSnapshotStore<ConnectorsSnapshot>({ state: undefined, busy: [], failure: null })
  const patch = (next: Partial<ConnectorsSnapshot>): void => { store.set({ ...store.getSnapshot(), ...next }) }
  /** Connectors whose sign-in this page started: the addresses already opened, and whether a frame showed it under way. */
  const signingIn = new Map<string, { readonly opened: Set<string>; seen: boolean }>()
  const run = async (id: string, action: () => Promise<RemoteResult<ConnectorsState>>): Promise<void> => {
    patch({ busy: [...store.getSnapshot().busy, id], failure: null })
    const result = await action()
    patch({ busy: store.getSnapshot().busy.filter(entry => entry !== id), failure: result.ok ? null : result.error.message })
  }
  return {
    hooks: { connectors: store },
    publish: (state) => {
      for (const connector of state.connectors) {
        const sign = signingIn.get(connector.id)
        if (sign === undefined) continue
        // A frame sent before the Host started the sign-in does not end it.
        if (connector.status !== 'connecting') {
          if (sign.seen) signingIn.delete(connector.id)
          continue
        }
        sign.seen = true
        const url = connector.login?.url
        if (url != null && !sign.opened.has(url)) { sign.opened.add(url); deps.openUrl(url) }
      }
      patch({ state })
    },
    onInstall: id => run(id, () => deps.install(id)),
    onUninstall: id => run(id, () => deps.uninstall(id)),
    onConnect: async (id) => {
      signingIn.set(id, { opened: new Set(), seen: false })
      await run(id, () => deps.connect(id))
    },
    onCancelConnect: id => run(id, () => deps.cancelConnect(id)),
    onDisconnect: id => run(id, () => deps.disconnect(id)),
    onSetEnabled: (id, enabled) => run(id, () => deps.setEnabled(id, enabled)),
    onCheck: async () => {
      const result = await deps.check()
      if (!result.ok) patch({ failure: result.error.message })
    },
    onOpenUrl: (url) => { deps.openUrl(url) },
    onDismiss: () => { patch({ failure: null }) },
  }
}
