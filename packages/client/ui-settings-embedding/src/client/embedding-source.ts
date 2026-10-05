/** Embedding models state and actions over the `embedding` Remote. */

import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { EmbeddingProviderView, EmbeddingState } from '@deepseek-ai/dsh-embedding/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

/** State the section renders. */
export interface EmbeddingSnapshot {
  /** Latest Host state; undefined until the first frame arrives. */
  readonly state: EmbeddingState | undefined
  /** Provider routes an API embedding model can use, as of the last refresh. */
  readonly providers: readonly EmbeddingProviderView[]
  /** An action is in flight; its controls stay disabled. */
  readonly busy: boolean
  /** The last refused action until the next one starts. */
  readonly failure: EmbeddingFailure | null
}

/** A refused action: the Host's message, and the users that keep a model from being removed. */
export interface EmbeddingFailure {
  readonly message: string
  /** Knowledge bases using the model, when that is why it could not be removed. */
  readonly users: readonly string[] | null
}

/** Remote calls and Settings navigation the source drives. */
export interface EmbeddingDependencies {
  readonly listProviders: () => Promise<RemoteResult<EmbeddingProviderView[]>>
  readonly startDownload: () => Promise<RemoteResult<EmbeddingState>>
  readonly pauseDownload: () => Promise<RemoteResult<EmbeddingState>>
  readonly removeLocalModel: () => Promise<RemoteResult<EmbeddingState>>
  readonly addApiModel: (provider: string, model: string) => Promise<RemoteResult<EmbeddingState>>
  readonly removeApiModel: (id: string) => Promise<RemoteResult<EmbeddingState>>
  /** Open Settings on the Models section. */
  readonly openModels: () => void
}

/** Business face injected into the section. */
export interface EmbeddingInjected {
  readonly hooks: { readonly embedding: HostObservable<EmbeddingSnapshot> }
  readonly onRefreshProviders: () => Promise<void>
  readonly onStart: () => Promise<void>
  readonly onPause: () => Promise<void>
  readonly onRemoveLocal: () => Promise<void>
  /** @returns whether the model was added. */
  readonly onAdd: (provider: string, model: string) => Promise<boolean>
  readonly onRemoveApi: (id: string) => Promise<void>
  readonly onOpenModels: () => void
}

/** The face plus the Host stream's entry point. */
export interface EmbeddingSource extends EmbeddingInjected {
  /** Adopt one Host state frame. */
  readonly publish: (state: EmbeddingState) => void
}

/**
 * Create the source.
 * @param deps - Remote calls and navigation.
 * @returns the observable snapshot, the actions, and the frame entry point.
 */
export function createEmbeddingSource(deps: EmbeddingDependencies): EmbeddingSource {
  const store = createSnapshotStore<EmbeddingSnapshot>({ state: undefined, providers: [], busy: false, failure: null })
  const patch = (next: Partial<EmbeddingSnapshot>): void => { store.set({ ...store.getSnapshot(), ...next }) }
  const run = async (action: () => Promise<RemoteResult<EmbeddingState>>): Promise<boolean> => {
    patch({ busy: true, failure: null })
    const result = await action()
    if (result.ok) patch({ busy: false, state: result.value })
    else {
      const { error } = result
      patch({ busy: false, failure: { message: error.message, users: error.code === 'embedding/model-in-use' ? error.details.users : null } })
    }
    return result.ok
  }
  return {
    hooks: { embedding: store },
    publish: (state) => { patch({ state }) },
    onRefreshProviders: async () => {
      const result = await deps.listProviders()
      if (result.ok) patch({ providers: result.value })
    },
    onStart: async () => { await run(deps.startDownload) },
    onPause: async () => { await run(deps.pauseDownload) },
    onRemoveLocal: async () => { await run(deps.removeLocalModel) },
    onAdd: (provider, model) => run(() => deps.addApiModel(provider, model)),
    onRemoveApi: async (id) => { await run(() => deps.removeApiModel(id)) },
    onOpenModels: deps.openModels,
  }
}
