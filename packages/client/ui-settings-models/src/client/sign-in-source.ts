/**
 * Account sign-in state and actions over the `authorization` Remote: the
 * Host's flow views keyed by credential record, which action is in flight for
 * which key, and the last refusal per key. Where the window may open pages by
 * itself, a sign-in started from it opens the first page its attempt reports;
 * an attempt joined from elsewhere does not.
 */

import type {
  AuthorizationAttemptId, AuthorizationFlowView, AuthorizationPromptId, RemoteResult,
} from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'

/** What the Models page renders about account sign-in. */
export interface SignInSnapshot {
  /** The Host's view of every flow, by credential record key; empty until the first frame. */
  readonly flows: Readonly<Record<string, AuthorizationFlowView>>
  /** Keys with an action in flight; their controls stay disabled. */
  readonly busy: Readonly<Record<string, true>>
  /** Message of the last refused action per key, until that key's next action. */
  readonly failures: Readonly<Record<string, string>>
}

/** Remote calls and the browser opener the source drives. */
export interface SignInDependencies {
  readonly begin: (key: string, method: string) => Promise<RemoteResult<AuthorizationFlowView>>
  readonly answer: (attemptId: AuthorizationAttemptId, promptId: AuthorizationPromptId, value: string) => Promise<RemoteResult<void>>
  readonly cancel: (attemptId: AuthorizationAttemptId) => Promise<RemoteResult<void>>
  readonly signOut: (key: string) => Promise<RemoteResult<AuthorizationFlowView>>
  /** Open a page outside the app: the system browser on Desktop, a new tab on the Web. */
  readonly open: (url: string) => void
  /** Whether a page may open without a click, which a browser blocks as a popup. */
  readonly opensPages: boolean
}

/** The actions a provider card invokes, each addressed by the flow's credential record key. */
export interface SignInActions {
  readonly begin: (key: string, method: string) => Promise<void>
  readonly answer: (key: string, promptId: AuthorizationPromptId, value: string) => Promise<void>
  readonly cancel: (key: string) => Promise<void>
  readonly signOut: (key: string) => Promise<void>
  /** Open a page the running attempt reported. */
  readonly open: (url: string) => void
}

/** The observable snapshot, the actions, and the stream's entry point. */
export interface SignInSource {
  readonly store: SnapshotStore<SignInSnapshot>
  readonly actions: SignInActions
  /** Adopt one Host frame: every flow's current view. */
  readonly publish: (views: readonly AuthorizationFlowView[]) => void
}

/**
 * Create the sign-in source.
 * @param deps - Remote calls and the browser opener.
 * @returns the snapshot store, the card actions, and the frame entry point.
 */
export function createSignInSource(deps: SignInDependencies): SignInSource {
  const store = createSnapshotStore<SignInSnapshot>({ flows: {}, busy: {}, failures: {} })
  const patch = (next: Partial<SignInSnapshot>): void => { store.set({ ...store.getSnapshot(), ...next }) }
  /** Attempts started here whose first page has not been opened yet. */
  const toOpen = new Set<AuthorizationAttemptId>()

  const openIfDue = (view: AuthorizationFlowView): void => {
    const attempt = view.attempt
    if (!deps.opensPages || attempt === null || !toOpen.has(attempt.id)) return
    if (attempt.phase !== 'running') { toOpen.delete(attempt.id); return }
    const url = attempt.notices.find(notice => notice.url !== undefined)?.url
    if (url === undefined) return
    toOpen.delete(attempt.id)
    deps.open(url)
  }
  const adopt = (view: AuthorizationFlowView): void => {
    patch({ flows: { ...store.getSnapshot().flows, [view.key]: view } })
    openIfDue(view)
  }
  const run = async <T>(key: string, action: () => Promise<RemoteResult<T>>): Promise<RemoteResult<T>> => {
    const { [key]: _cleared, ...failures } = store.getSnapshot().failures
    patch({ busy: { ...store.getSnapshot().busy, [key]: true }, failures })
    const result = await action()
    const { [key]: _done, ...busy } = store.getSnapshot().busy
    patch(result.ok ? { busy } : { busy, failures: { ...store.getSnapshot().failures, [key]: result.error.message } })
    return result
  }
  /** Run an action against the key's current attempt; a key with none has nothing to act on. */
  const onAttempt = async (
    key: string,
    action: (attemptId: AuthorizationAttemptId) => Promise<RemoteResult<unknown>>,
  ): Promise<void> => {
    const attempt = store.getSnapshot().flows[key]?.attempt
    if (attempt === null || attempt === undefined) return
    await run(key, () => action(attempt.id))
  }

  return {
    store,
    publish: (views) => {
      patch({ flows: Object.fromEntries(views.map(view => [view.key, view])) })
      for (const view of views) openIfDue(view)
    },
    actions: {
      begin: async (key, method) => {
        // Read before the call: a stream frame can announce the new attempt
        // before the call itself answers.
        const before = store.getSnapshot().flows[key]?.attempt?.id
        const result = await run(key, () => deps.begin(key, method))
        if (!result.ok) return
        const started = result.value.attempt
        // Only an attempt this window started opens a page here; a joined one already ran elsewhere.
        if (started !== null && started.id !== before) toOpen.add(started.id)
        // The answer describes the attempt as it began. A stream frame that already reported
        // this attempt is at least as new, and replacing it would hide the questions it carries.
        const current = store.getSnapshot().flows[key]
        if (current !== undefined && started !== null && current.attempt?.id === started.id) openIfDue(current)
        else adopt(result.value)
      },
      answer: (key, promptId, value) => onAttempt(key, attemptId => deps.answer(attemptId, promptId, value)),
      cancel: key => onAttempt(key, attemptId => deps.cancel(attemptId)),
      signOut: async (key) => {
        const result = await run(key, () => deps.signOut(key))
        if (result.ok) adopt(result.value)
      },
      open: (url) => { deps.open(url) },
    },
  }
}
