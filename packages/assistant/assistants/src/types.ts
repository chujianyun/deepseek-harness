/** Types of the `assistants` Host service, its Remote namespace, and the session events it records. */

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The signed-in tenant has no assistant with this id. */
    'assistants/not-found': { readonly assistantId: string }
    /** The session already started a turn, so its assistant can no longer change. */
    'assistants/locked': { readonly sessionId: string; readonly assistantId: string }
  }
}

/** A preset avatar: one of the built-in avatar keys the client draws. */
export interface AssistantPresetAvatar {
  readonly kind: 'preset'
  /** Built-in avatar key, such as `sun`. */
  readonly key: string
}

/** How an assistant's avatar is drawn. */
export type AssistantAvatar = AssistantPresetAvatar

/** One assistant as the Assistants page and the new-session picker show it. */
export interface AssistantView {
  /** Assistant id, unique within the tenant. */
  readonly id: string
  readonly name: string
  readonly description: string
  readonly avatar: AssistantAvatar
  /** Agent preset the assistant's sessions run; absent means the deployment default. */
  readonly preset?: string
  /** Template the assistant was created from, when any. */
  readonly templateId?: string
  /** ISO time of creation. */
  readonly createdAt: string
}

/** The signed-in tenant's assistants. */
export interface AssistantsState {
  /** Grows with every change, so a reader keeps the newer of two states that arrive out of order. */
  readonly revision: number
  /** Tenant of the current Hub sign-in; null while signed out. */
  readonly tenantId: string | null
  /** Assistant a new session binds unless the user picks another; null when the tenant has none. */
  readonly defaultId: string | null
  /** Assistants in creation order. */
  readonly assistants: readonly AssistantView[]
}

/** The `assistant` Session projection state. */
export interface AssistantProjectionState {
  /** Assistant the session is bound to; null when it is bound to none. */
  readonly assistantId: string | null
  /** Core-file instructions last recorded for the model; null before the first record. */
  readonly instructions: string | null
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * The session was bound to an assistant while it was still blank. Later turns carry that
     * assistant's core files; a session is bound at most once per blank window.
     */
    'assistant/selected': { assistantId: string }
    /**
     * The bound assistant's core files as rendered for the model, recorded before a turn whenever
     * they differ from the previous record. An empty text means the assistant no longer exists.
     */
    'assistant/instructions': { text: string }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    assistant: AssistantProjectionState
  }
  interface SessionProjectionMap {
    /** Assistant the session is bound to, or null. */
    assistant: string | null
  }
}
