/** Knowledge page state and actions over the `knowledgeBases` and `embedding` Remotes. */

import type { RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { EmbeddingState } from '@deepseek-ai/dsh-embedding/types'
import type {
  KnowledgeAddResult, KnowledgeNote, KnowledgeRecallResult, KnowledgeSettingsPatch, KnowledgeState,
} from '@deepseek-ai/dsh-knowledge-base/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

/** A refused action: a known reason the page words itself, or the Host's message. */
export type KnowledgeFailure =
  | { readonly reason: 'duplicate-name' | 'invalid-name' | 'rebuilding' | 'not-a-folder' | 'invalid-url' }
  | { readonly reason: 'invalid-note'; readonly field: 'title' | 'content'; readonly max: number }
  | { readonly reason: 'probe-failed' | 'other'; readonly message: string }

/** The recall test of one knowledge base. */
export interface KnowledgeRecall {
  readonly baseId: string
  readonly query: string
  readonly running: boolean
  /** Hits of the last finished search; null while none finished. */
  readonly result: KnowledgeRecallResult | null
  readonly failure: KnowledgeFailure | null
}

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
  /** The last recall test; kept apart from `failure`, as it does not change anything. */
  readonly recall: KnowledgeRecall | null
}

/** Remote calls the source drives. */
export interface KnowledgeDependencies {
  readonly createBase: (name: string, embeddingModelId: string) => Promise<RemoteResult<KnowledgeState>>
  readonly renameBase: (id: string, name: string) => Promise<RemoteResult<KnowledgeState>>
  readonly deleteBase: (id: string) => Promise<RemoteResult<KnowledgeState>>
  readonly addFiles: (id: string, paths: string[]) => Promise<RemoteResult<KnowledgeAddResult>>
  readonly reprocessItem: (id: string, itemId: string) => Promise<RemoteResult<KnowledgeState>>
  readonly deleteItem: (id: string, itemId: string) => Promise<RemoteResult<KnowledgeState>>
  readonly updateSettings: (id: string, patch: KnowledgeSettingsPatch) => Promise<RemoteResult<KnowledgeState>>
  readonly reprocessAll: (id: string) => Promise<RemoteResult<KnowledgeState>>
  readonly recall: (id: string, query: string) => Promise<RemoteResult<KnowledgeRecallResult>>
  readonly addFolder: (id: string, path: string) => Promise<RemoteResult<KnowledgeState>>
  readonly addUrl: (id: string, url: string) => Promise<RemoteResult<KnowledgeState>>
  readonly createNote: (id: string, title: string, content: string) => Promise<RemoteResult<KnowledgeState>>
  readonly updateNote: (id: string, itemId: string, title: string, content: string) => Promise<RemoteResult<KnowledgeState>>
  readonly getNote: (id: string, itemId: string) => Promise<RemoteResult<KnowledgeNote>>
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
  /** @returns whether the settings were saved. */
  readonly onSaveSettings: (id: string, patch: KnowledgeSettingsPatch) => Promise<boolean>
  readonly onReprocessAll: (id: string) => Promise<void>
  readonly onRecall: (id: string, query: string) => Promise<void>
  readonly onAddFolder: (id: string, path: string) => Promise<void>
  /** @returns whether the page was added. */
  readonly onAddUrl: (id: string, url: string) => Promise<boolean>
  /** @returns whether the note was saved. */
  readonly onCreateNote: (id: string, title: string, content: string) => Promise<boolean>
  /** @returns whether the note was saved. */
  readonly onUpdateNote: (id: string, itemId: string, title: string, content: string) => Promise<boolean>
  /** @returns the note, or undefined when it could not be read (the failure says why). */
  readonly onLoadNote: (id: string, itemId: string) => Promise<KnowledgeNote | undefined>
  /** Clear the last failure and addition outcome. */
  readonly onDismiss: () => void
}

/** The face plus the Host streams' entry points. */
export interface KnowledgeSource extends KnowledgeInjected {
  readonly publish: (state: KnowledgeState) => void
  readonly publishEmbedding: (state: EmbeddingState) => void
}

function failureOf(error: RemoteFailure): KnowledgeFailure {
  switch (error.code) {
    case 'knowledge/duplicate-name': return { reason: 'duplicate-name' }
    case 'knowledge/invalid-name': return { reason: 'invalid-name' }
    case 'knowledge/rebuilding': return { reason: 'rebuilding' }
    case 'knowledge/not-a-folder': return { reason: 'not-a-folder' }
    case 'knowledge/invalid-url': return { reason: 'invalid-url' }
    case 'knowledge/invalid-note': return { reason: 'invalid-note', field: error.details.field, max: error.details.max }
    case 'knowledge/embedding-probe-failed': return { reason: 'probe-failed', message: error.details.message }
    default: return { reason: 'other', message: error.message }
  }
}

/**
 * Create the source.
 * @param deps - Remote calls.
 * @returns the observable snapshot, the actions, and the frame entry points.
 */
export function createKnowledgeSource(deps: KnowledgeDependencies): KnowledgeSource {
  const store = createSnapshotStore<KnowledgeSnapshot>({
    state: undefined, embedding: undefined, selectedId: null, busy: false, failure: null, added: null, recall: null,
  })
  const patch = (next: Partial<KnowledgeSnapshot>): void => { store.set({ ...store.getSnapshot(), ...next }) }
  const run = async <T>(action: () => Promise<RemoteResult<T>>): Promise<T | undefined> => {
    patch({ busy: true, failure: null, added: null })
    const result = await action()
    if (result.ok) { patch({ busy: false }); return result.value }
    patch({ busy: false, failure: failureOf(result.error) })
    return undefined
  }
  /** Keep a state unless a newer one already arrived: action answers and stream frames can cross. */
  const accept = (state: KnowledgeState, extra: Partial<KnowledgeSnapshot> = {}): void => {
    const current = store.getSnapshot().state
    patch(current === undefined || state.revision >= current.revision ? { state, ...extra } : extra)
  }
  const adopt = (state: KnowledgeState | undefined): boolean => {
    if (state !== undefined) accept(state)
    return state !== undefined
  }
  return {
    hooks: { knowledge: store },
    publish: (state) => { accept(state) },
    publishEmbedding: (embedding) => { patch({ embedding }) },
    onSelect: (id) => { patch({ selectedId: id, failure: null, added: null }) },
    onCreate: async (name, embeddingModelId) => {
      const state = await run(() => deps.createBase(name, embeddingModelId))
      if (state !== undefined) accept(state, { selectedId: state.bases.at(-1)?.id ?? null })
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
    onSaveSettings: async (id, settings) => adopt(await run(() => deps.updateSettings(id, settings))),
    onReprocessAll: async (id) => { adopt(await run(() => deps.reprocessAll(id))) },
    onAddFolder: async (id, path) => { adopt(await run(() => deps.addFolder(id, path))) },
    onAddUrl: async (id, url) => adopt(await run(() => deps.addUrl(id, url))),
    onCreateNote: async (id, title, content) => adopt(await run(() => deps.createNote(id, title, content))),
    onUpdateNote: async (id, itemId, title, content) => adopt(await run(() => deps.updateNote(id, itemId, title, content))),
    onLoadNote: (id, itemId) => run(() => deps.getNote(id, itemId)),
    onRecall: async (id, query) => {
      const previous = store.getSnapshot().recall
      patch({ recall: { baseId: id, query, running: true, result: previous?.baseId === id ? previous.result : null, failure: null } })
      const result = await deps.recall(id, query)
      patch({
        recall: result.ok
          ? { baseId: id, query, running: false, result: result.value, failure: null }
          : { baseId: id, query, running: false, result: null, failure: failureOf(result.error) },
      })
    },
    onDismiss: () => { patch({ failure: null, added: null }) },
  }
}
