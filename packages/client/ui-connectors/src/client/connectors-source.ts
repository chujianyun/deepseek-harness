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

/** Remote calls the source drives. */
export interface ConnectorsDependencies {
  readonly install: (id: string) => Promise<RemoteResult<ConnectorsState>>
  readonly uninstall: (id: string) => Promise<RemoteResult<ConnectorsState>>
}

/** Business face injected into the page. */
export interface ConnectorsInjected {
  readonly hooks: { readonly connectors: HostObservable<ConnectorsSnapshot> }
  readonly onInstall: (id: string) => Promise<void>
  readonly onUninstall: (id: string) => Promise<void>
  /** Clear the last failure. */
  readonly onDismiss: () => void
}

/** The face plus the Host stream's entry point. */
export interface ConnectorsSource extends ConnectorsInjected {
  readonly publish: (state: ConnectorsState) => void
}

/**
 * Create the source. Card state comes only from the stream, which is ordered; an action's
 * answer can arrive after a newer frame, so it reports only a refusal.
 * @param deps - Remote calls.
 * @returns the observable snapshot, the actions, and the frame entry point.
 */
export function createConnectorsSource(deps: ConnectorsDependencies): ConnectorsSource {
  const store = createSnapshotStore<ConnectorsSnapshot>({ state: undefined, busy: [], failure: null })
  const patch = (next: Partial<ConnectorsSnapshot>): void => { store.set({ ...store.getSnapshot(), ...next }) }
  const run = async (id: string, action: () => Promise<RemoteResult<ConnectorsState>>): Promise<void> => {
    patch({ busy: [...store.getSnapshot().busy, id], failure: null })
    const result = await action()
    patch({ busy: store.getSnapshot().busy.filter(entry => entry !== id), failure: result.ok ? null : result.error.message })
  }
  return {
    hooks: { connectors: store },
    publish: (state) => { patch({ state }) },
    onInstall: id => run(id, () => deps.install(id)),
    onUninstall: id => run(id, () => deps.uninstall(id)),
    onDismiss: () => { patch({ failure: null }) },
  }
}
