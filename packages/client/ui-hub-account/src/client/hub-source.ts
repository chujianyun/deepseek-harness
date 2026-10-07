/** Hub sign-in state and actions over the `hubAccount` Remote. */

import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { HubAccountView } from '@deepseek-ai/dsh-hub-account/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

/** State the account section renders. */
export interface HubSnapshot {
  /** Latest Host state; undefined until the first frame arrives. */
  readonly view: HubAccountView | undefined
  /** An action is in flight; its controls stay disabled. */
  readonly busy: boolean
  /** Message of the last refused action until the next one starts. */
  readonly failure: string | null
}

/** Remote calls and the browser opener the source drives. */
export interface HubDependencies {
  readonly signIn: () => Promise<RemoteResult<HubAccountView>>
  readonly cancelSignIn: (attemptId: string) => Promise<RemoteResult<HubAccountView>>
  readonly signOut: () => Promise<RemoteResult<HubAccountView>>
  readonly switchTenant: () => Promise<RemoteResult<HubAccountView>>
  /** Open a page in the system browser. */
  readonly open: (url: string) => void
}

/** Business face injected into the account section. */
export interface HubAccountInjected {
  readonly hooks: { readonly hub: HostObservable<HubSnapshot> }
  readonly onSignIn: () => Promise<void>
  readonly onCancel: () => Promise<void>
  readonly onSignOut: () => Promise<void>
  readonly onSwitchTenant: () => Promise<void>
  /** Open the current attempt's sign-in page again. */
  readonly onReopen: () => void
}

/** The face plus the Host stream's entry point. */
export interface HubSource extends HubAccountInjected {
  /** Adopt one Host state frame. */
  readonly publish: (view: HubAccountView) => void
}

/**
 * Create the sign-in source. A sign-in started from this window opens its page in the system
 * browser as soon as the Host publishes it; an attempt joined from elsewhere does not.
 * @param deps - Remote calls and the browser opener.
 * @returns the observable snapshot, the actions, and the frame entry point.
 */
export function createHubSource(deps: HubDependencies): HubSource {
  const store = createSnapshotStore<HubSnapshot>({ view: undefined, busy: false, failure: null })
  const patch = (next: Partial<HubSnapshot>): void => { store.set({ ...store.getSnapshot(), ...next }) }
  /** Attempt whose page this window still has to open: `pending` (never an attempt id) until the Host names the attempt. */
  let toOpen: string | undefined
  const openIfDue = (view: HubAccountView): void => {
    const attempt = view.attempt
    if (toOpen === undefined || attempt?.authorizeUrl === undefined || attempt.phase !== 'waiting-browser') return
    if (toOpen !== 'pending' && toOpen !== attempt.id) return
    toOpen = undefined
    deps.open(attempt.authorizeUrl)
  }
  const run = async (action: () => Promise<RemoteResult<HubAccountView>>, opens: boolean): Promise<void> => {
    patch({ busy: true, failure: null })
    if (opens) toOpen = 'pending'
    const result = await action()
    if (result.ok) {
      if (opens && toOpen === 'pending' && result.value.attempt !== null) toOpen = result.value.attempt.id
      patch({ busy: false, view: result.value })
      openIfDue(result.value)
    } else {
      if (opens) toOpen = undefined
      patch({ busy: false, failure: result.error.message })
    }
  }
  return {
    hooks: { hub: store },
    publish: (view) => { patch({ view }); openIfDue(view) },
    onSignIn: () => run(deps.signIn, true),
    onSwitchTenant: () => run(deps.switchTenant, true),
    onSignOut: () => run(deps.signOut, false),
    onCancel: async () => {
      const attempt = store.getSnapshot().view?.attempt
      if (attempt === null || attempt === undefined) return
      toOpen = undefined
      await run(() => deps.cancelSignIn(attempt.id), false)
    },
    onReopen: () => {
      const url = store.getSnapshot().view?.attempt?.authorizeUrl
      if (url !== undefined) deps.open(url)
    },
  }
}
