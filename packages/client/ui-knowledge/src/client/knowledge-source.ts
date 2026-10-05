/** Knowledge page state and actions over the `knowledgeBases` and `embedding` Remotes. */

import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { EmbeddingState } from '@deepseek-ai/dsh-embedding/types'
import type { KnowledgeAddResult, KnowledgeState } from '@deepseek-ai/dsh-knowledge-base/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

/** A refused action: a known reason the page words itself, or the Host's message. */
export type KnowledgeFailure = { readonly reason: 'duplicate-name' | 'invalid-name' } | { readonly reason: 'other'; readonly message: string }

/** State the page renders. */
export interface KnowledgeSnapshot {
  /** Latest Host state; undefined until the first frame arrives. */
  readonly state: KnowledgeState | undefined
  /** Embedding models the create dialog offers, as of the last frame. */
  readonly embedding: EmbeddingState | undefined
  /** Selected knowledge base; the first one when unset or gone. */
  readonly selectedId: string | null
  readonly busy: boolean
  readonly failure: KnowledgeFailure | null
  /** Outcome of the last file addition, until the next action. */
  readonly added: KnowledgeAddResult | null
}

/** Remote calls the source drives. */
export interface KnowledgeDependencies {
  readonly createBase: (name: string, embeddingModelId: string) => Promise<RemoteResult<KnowledgeState>>
  readonly renameBase: (id: string, name: string) => Promise<RemoteResult<KnowledgeState>>
  readonly deleteBase: (id: string) => Promise<RemoteResult<KnowledgeState>>
  readonly addFiles: (id: string, paths: string[]) => Promise<RemoteResult<KnowledgeAddResult>>
  readonly reprocessItem: (id: string, itemId: string) => Promise<RemoteResult<KnowledgeState>>
  readonly deleteItem: (id: string, itemId: string) => Promise<RemoteResult<KnowledgeState>>
}

/** Business face injected into the page. */
export interface KnowledgeInjected {
  readonly hooks: { readonly knowledge: HostObservable<KnowledgeSnapshot> }
  readonly onSelect: (id: string) => void
  /** @returns whether it was created; the new knowledge base is selected. */
  readonly onCreate: (name: string, embeddingModelId: string) => Promise<boolean>
  /** @returns whether it was renamed. */
  readonly onRename: (id: string, name: string) => Promise<boolean>
  readonly onDelete: (id: string) => Promise<void>
  readonly onAddFiles: (id: string, paths: string[]) => Promise<void>
  readonly onReprocess: (id: string, itemId: string) => Promise<void>
  readonly onDeleteItem: (id: string, itemId: string) => Promise<void>
  /** Clear the last failure and addition outcome. */
  readonly onDismiss: () => void
}

/** The face plus the Host streams' entry points. */
export interface KnowledgeSource extends KnowledgeInjected {
  readonly publish: (state: KnowledgeState) => void
  readonly publishEmbedding: (state: EmbeddingState) => void
}

/**
 * Create the source.
 * @param deps - Remote calls.
 * @returns the observable snapshot, the actions, and the frame entry points.
 */
export function createKnowledgeSource(deps: KnowledgeDependencies): KnowledgeSource {
  const store = createSnapshotStore<KnowledgeSnapshot>({
    state: undefined, embedding: undefined, selectedId: null, busy: false, failure: null, added: null,
  })
  const patch = (next: Partial<KnowledgeSnapshot>): void => { store.set({ ...store.getSnapshot(), ...next }) }
  const run = async <T>(action: () => Promise<RemoteResult<T>>): Promise<T | undefined> => {
    patch({ busy: true, failure: null, added: null })
    const result = await action()
    if (result.ok) { patch({ busy: false }); return result.value }
    const { error } = result
    const failure: KnowledgeFailure = error.code === 'knowledge/duplicate-name' ? { reason: 'duplicate-name' }
      : error.code === 'knowledge/invalid-name' ? { reason: 'invalid-name' } : { reason: 'other', message: error.message }
    patch({ busy: false, failure })
    return undefined
  }
  const adopt = (state: KnowledgeState | undefined): boolean => {
    if (state !== undefined) patch({ state })
    return state !== undefined
  }
  return {
    hooks: { knowledge: store },
    publish: (state) => { patch({ state }) },
    publishEmbedding: (embedding) => { patch({ embedding }) },
    onSelect: (id) => { patch({ selectedId: id, failure: null, added: null }) },
    onCreate: async (name, embeddingModelId) => {
      const state = await run(() => deps.createBase(name, embeddingModelId))
      if (state !== undefined) patch({ state, selectedId: state.bases.at(-1)?.id ?? null })
      return state !== undefined
    },
    onRename: async (id, name) => adopt(await run(() => deps.renameBase(id, name))),
    onDelete: async (id) => { adopt(await run(() => deps.deleteBase(id))) },
    onAddFiles: async (id, paths) => {
      const added = await run(() => deps.addFiles(id, paths))
      if (added !== undefined) patch({ added })
    },
    onReprocess: async (id, itemId) => { adopt(await run(() => deps.reprocessItem(id, itemId))) },
    onDeleteItem: async (id, itemId) => { adopt(await run(() => deps.deleteItem(id, itemId))) },
    onDismiss: () => { patch({ failure: null, added: null }) },
  }
}
