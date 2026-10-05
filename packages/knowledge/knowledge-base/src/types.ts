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
    /** A knowledge base setting is out of range; `field` names it. */
    'knowledge/invalid-settings': { readonly field: string }
    /** The new embedding model failed its trial embedding, so the knowledge base keeps its model. */
    'knowledge/embedding-probe-failed': { readonly id: string; readonly message: string }
    /** The knowledge base is being rebuilt for a new embedding model and cannot be searched yet. */
    'knowledge/rebuilding': { readonly id: string }
    /** The path to add as a folder is missing or not a folder. */
    'knowledge/not-a-folder': { readonly path: string }
    /** The address to add is not an http or https URL. */
    'knowledge/invalid-url': { readonly url: string }
    /** A note needs a title of 1 to `maxNameLength` characters and a body of at most `max` characters. */
    'knowledge/invalid-note': { readonly field: 'title' | 'content'; readonly max: number }
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
 * - `folder-missing`: a folder's path is gone or no longer a folder; its files stay as they were.
 * - `unreachable`: a page could not be fetched; the last fetched content stays.
 */
export type KnowledgeItemError = 'unreadable' | 'empty' | 'embedding' | 'interrupted' | 'storage' | 'folder-missing' | 'unreachable'

/**
 * What a knowledge item is.
 * - `file`: a file added on its own, or found in a folder (`parentId` names the folder).
 * - `folder`: a folder whose supported files are its `file` items; it is not processed itself.
 * - `url`: a web page, fetched on this machine.
 * - `note`: a note written in DSH.
 */
export type KnowledgeItemKind = 'file' | 'folder' | 'url' | 'note'

/** A file of a folder left out: an unsupported type, or past the per-folder file limit. */
export interface KnowledgeSkippedFile {
  /** Path relative to the folder. */
  readonly path: string
  readonly reason: 'unsupported' | 'limit'
}

/** One source added to a knowledge base. */
export interface KnowledgeItemView {
  readonly id: string
  readonly kind: KnowledgeItemKind
  /** The folder item a folder's file belongs to; null otherwise. */
  readonly parentId: string | null
  /** File name, folder name, page title (the URL until first fetched), or note title. */
  readonly name: string
  /** Folder path, page URL, or a folder file's path relative to its folder; null for files and notes. */
  readonly source: string | null
  /** Bytes: of the file, the fetched page text, or the note; a folder's is the sum of its files. */
  readonly size: number
  /** Files of a folder left out, the first 500 of `skippedCount`; empty for other kinds. */
  readonly skipped: readonly KnowledgeSkippedFile[]
  /** How many files of a folder were left out. */
  readonly skippedCount: number
  readonly status: KnowledgeItemStatus
  readonly error: KnowledgeItemError | null
  /** Chunks indexed; a folder's is the sum of its files'. */
  readonly chunkCount: number
  /** ISO time it was added. */
  readonly addedAt: string
}

/**
 * How chunk ends are chosen.
 * - `structured`: smart chunking, at Markdown structure (headings, code fences, paragraphs), with the separator as one more break.
 * - `delimiter`: at the separator first, then at lines, sentences, and spaces.
 */
export type KnowledgeChunkStrategy = 'structured' | 'delimiter'

/** A knowledge base's chunking and retrieval settings. */
export interface KnowledgeBaseSettings {
  readonly chunkStrategy: KnowledgeChunkStrategy
  /** Separator as typed, with `\n`, `\t`, `\r`, and `\\` escapes; required by `delimiter`. */
  readonly chunkSeparator: string
  /** Most estimated tokens per chunk; at least 1. */
  readonly chunkSize: number
  /** Estimated tokens repeated from the previous chunk; less than `chunkSize`. */
  readonly chunkOverlap: number
  /** Most chunks a search returns, 1–50. */
  readonly documentCount: number
  /** Least relevance score a search keeps, 0–1. */
  readonly threshold: number
}

/** Settings to change; omitted ones stay. */
export type KnowledgeSettingsPatch = Partial<KnowledgeBaseSettings> & {
  /** A new embedding model; with items present, the knowledge base is rebuilt in place. */
  readonly embeddingModelId?: string
}

/** One chunk a search found. */
export interface KnowledgeSearchHit {
  readonly itemId: string
  readonly itemName: string
  /** Position of the chunk within its item. */
  readonly ordinal: number
  readonly text: string
  /** Blended relevance, 0–1. */
  readonly score: number
}

/** Outcome of a recall test. */
export interface KnowledgeRecallResult {
  /** Hits under the knowledge base's retrieval settings, best first. */
  readonly hits: readonly KnowledgeSearchHit[]
  /** Time the search took, in milliseconds. */
  readonly durationMs: number
}

/** One knowledge base of the signed-in tenant. */
export interface KnowledgeBaseView {
  readonly id: string
  readonly name: string
  /** Embedding model id (`local/<name>` or `<provider>/<model>`). */
  readonly embeddingModelId: string
  /** Embedding model display name. */
  readonly embeddingModelName: string
  /** Vector length of the embedding model, as measured when it was chosen; null when not measured. */
  readonly dimensions: number | null
  /**
   * `ready`; `rebuilding` while items are processed again for a new embedding model, when it cannot
   * be searched; or `unavailable` while its embedding model cannot run (the local model missing,
   * damaged, or downloading), when pending items wait for it.
   */
  readonly status: 'ready' | 'rebuilding' | 'unavailable'
  readonly settings: KnowledgeBaseSettings
  readonly items: readonly KnowledgeItemView[]
  /** ISO creation time. */
  readonly createdAt: string
}

/** The Knowledge page's state. */
export interface KnowledgeState {
  /**
   * Grows with every change, across Host restarts too: an action's answer can arrive after a newer
   * streamed state, and the state with the larger revision is the current one.
   */
  readonly revision: number
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

/** A note's text, for editing. */
export interface KnowledgeNote {
  readonly title: string
  /** Markdown body. */
  readonly content: string
}
