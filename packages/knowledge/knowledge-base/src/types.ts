/**
 * Browser-safe wire shapes of the `knowledgeBases` Remote namespace: the signed-in tenant's
 * knowledge bases and their items, as the Knowledge page renders them.
 *
 * @module @deepseek-ai/dsh-knowledge-base/types
 */

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** No knowledge base, or no item in it, has this id for the signed-in tenant. */
    'knowledge/not-found': { readonly id: string }
    /** Another knowledge base of the tenant already has this name. */
    'knowledge/duplicate-name': { readonly name: string }
    /** The name is empty or longer than allowed. */
    'knowledge/invalid-name': { readonly name: string }
    /** The chosen embedding model is not one Settings → Embedding models offers. */
    'knowledge/embedding-model-unavailable': { readonly id: string }
  }
}

/**
 * Where an item is.
 * - `pending`: waiting to be processed.
 * - `processing`: being read, chunked, and embedded.
 * - `completed`: searchable.
 * - `failed`: stopped; `error` says why, and reprocessing retries it.
 */
export type KnowledgeItemStatus = 'pending' | 'processing' | 'completed' | 'failed'

/**
 * Why an item failed.
 * - `unreadable`: the file could not be read or parsed.
 * - `empty`: no text was found (for example a scanned PDF).
 * - `embedding`: the embedding model refused or failed.
 * - `interrupted`: DSH stopped while an API embedding model was processing it; retry by hand.
 * - `storage`: the chunks could not be written to the base's index.
 */
export type KnowledgeItemError = 'unreadable' | 'empty' | 'embedding' | 'interrupted' | 'storage'

/** One source added to a knowledge base. */
export interface KnowledgeItemView {
  readonly id: string
  /** The source's kind; files only, for now. */
  readonly kind: 'file'
  /** File name. */
  readonly name: string
  /** Bytes. */
  readonly size: number
  readonly status: KnowledgeItemStatus
  readonly error: KnowledgeItemError | null
  /** Chunks indexed when completed. */
  readonly chunkCount: number
  /** ISO time it was added. */
  readonly addedAt: string
}

/** One knowledge base of the signed-in tenant. */
export interface KnowledgeBaseView {
  readonly id: string
  readonly name: string
  /** Embedding model id (`local/<name>` or `<provider>/<model>`). */
  readonly embeddingModelId: string
  /** Embedding model display name. */
  readonly embeddingModelName: string
  /**
   * `ready`, or `unavailable` while its embedding model cannot run (the local model missing,
   * damaged, or downloading); pending items wait for it.
   */
  readonly status: 'ready' | 'unavailable'
  readonly items: readonly KnowledgeItemView[]
  /** ISO creation time. */
  readonly createdAt: string
}

/** The Knowledge page's state. */
export interface KnowledgeState {
  /** Signed-in tenant; null while signed out, when there are no knowledge bases to show. */
  readonly tenantId: string | null
  /** The tenant's knowledge bases, oldest first. */
  readonly bases: readonly KnowledgeBaseView[]
}

/** Why a file was not added. */
export type KnowledgeRejectReason = 'unsupported' | 'too-large' | 'unreadable'

/** Outcome of adding files. */
export interface KnowledgeAddResult {
  /** Files accepted and queued. */
  readonly added: number
  /** Files refused, with why. */
  readonly rejected: readonly { readonly name: string; readonly reason: KnowledgeRejectReason }[]
}
