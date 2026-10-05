/**
 * Pure types of the knowledge selection: the session event that records it, the projection
 * keys that serve it, and the Remote's wire shapes. Free of host-side value imports, so `./types`
 * serves Host consumers and `./client` re-exports it for Client code.
 *
 * @module @deepseek-ai/dsh-knowledge-selection/types
 */

/** One selected knowledge base, with its name when it was selected. */
export interface KnowledgeSelectionBase {
  readonly id: string
  readonly name: string
}

/** The knowledge bases one session may search; empty when none is selected. */
export interface KnowledgeSelectionProjection {
  bases: KnowledgeSelectionBase[]
}

/** Outcome of selecting knowledge bases for a session. */
export interface KnowledgeSelectionResult {
  /** The selection as it will apply. */
  readonly bases: readonly KnowledgeSelectionBase[]
  /** `now` between turns; `next-step` while a turn runs, from its next step. */
  readonly applies: 'now' | 'next-step'
}

/** Why a selected knowledge base was not searched. */
export type KnowledgeSearchSkipReason = 'missing' | 'rebuilding' | 'unavailable' | 'failed'

/** One cited passage, as the answer's sources show it; a type alias, so it is plain JSON. */
export type KnowledgeCitation = {
  readonly knowledgeBaseId: string
  readonly knowledgeBase: string
  readonly itemId: string
  readonly item: string
  readonly kind: 'file' | 'url' | 'note'
  /** A page's address, or a folder file's path within its folder. */
  readonly source?: string
  /** 1-based chunk number within the item. */
  readonly chunk: number
  readonly score: number
  /** The start of the passage. */
  readonly snippet: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * The knowledge bases this session searches from this point on: log-only, whole-value
     * replace. The last one wins; a log with none selects nothing.
     */
    'knowledge/selection': { bases: KnowledgeSelectionBase[] }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Host fold of the logged knowledge selection. */
    knowledgeSelection: KnowledgeSelectionProjection
  }
  interface SessionProjectionMap {
    /** The knowledge bases the session searches, from its last `knowledge/selection` event. */
    knowledgeSelection: KnowledgeSelectionProjection
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** A knowledge base to select is not one of the signed-in tenant's. */
    'knowledge-selection/unknown-base': { readonly id: string }
  }
}
