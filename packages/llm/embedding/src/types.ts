/**
 * Browser-safe wire shapes of the `embedding` Remote namespace: the local embedding model's
 * install state and the API embedding models, as Settings → Embedding models renders them.
 *
 * @module @deepseek-ai/dsh-embedding/types
 */

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The provider route has no configured OpenAI-compatible endpoint. */
    'embedding/provider-unavailable': { readonly provider: string }
    /** The endpoint refused or failed an embedding request, or answered something unreadable. */
    'embedding/request-failed': { readonly status: number | null }
    /** An API embedding model with this id is already added. */
    'embedding/duplicate-model': { readonly id: string }
    /** No embedding model has this id. */
    'embedding/model-not-found': { readonly id: string }
    /** The local embedding model is not installed, or this platform cannot run it. */
    'embedding/local-model-unavailable': Record<string, never>
    /** The embedding model is used, so it cannot be removed; `users` names its users (knowledge bases). */
    'embedding/model-in-use': { readonly id: string; readonly users: readonly string[] }
  }
}

/**
 * Where the local embedding model is.
 * - `unsupported`: this platform has no runtime build.
 * - `missing`: not downloaded (deleted, or downloads switched off).
 * - `downloading` / `paused`: a download is running / stopped; partial files are kept.
 * - `installed`: verified and ready.
 * - `failed`: the last download stopped on an error; it resumes when started again.
 * - `damaged`: an installed file has the wrong size; repairing downloads it again.
 */
export type LocalModelStatus = 'unsupported' | 'missing' | 'downloading' | 'paused' | 'installed' | 'failed' | 'damaged'

/** Why the last local download failed. */
export type LocalModelError = 'network' | 'verification' | 'storage'

/** The local embedding model. */
export interface LocalModelView {
  /** Embedding model id used by knowledge bases. */
  readonly id: string
  /** Display name. */
  readonly name: string
  readonly status: LocalModelStatus
  /** Bytes on disk out of {@link totalBytes}, across the model and its runtime. */
  readonly receivedBytes: number
  readonly totalBytes: number
  /** Vector size, known once the installed model has run. */
  readonly dimensions: number | null
  /** Reason of the last failure while `failed`. */
  readonly error: LocalModelError | null
}

/** An API embedding model served by a configured provider route. */
export interface ApiEmbeddingModelView {
  /** Embedding model id used by knowledge bases: `<provider>/<model>`. */
  readonly id: string
  /** Provider route key. */
  readonly provider: string
  /** Provider display name; the route key when the route is gone. */
  readonly providerName: string
  /** Model id on the provider. */
  readonly model: string
  /** Vector size measured when the model was added. */
  readonly dimensions: number
  /** Whether the provider route still has a configured OpenAI-compatible endpoint. */
  readonly available: boolean
}

/** A configured provider route that can serve API embedding models. */
export interface EmbeddingProviderView {
  readonly provider: string
  readonly displayName: string
}

/** Everything Settings → Embedding models shows. */
export interface EmbeddingState {
  readonly local: LocalModelView
  readonly apiModels: readonly ApiEmbeddingModelView[]
}
