/** Types of the `assistants` Host service, its Remote namespace, and the session events it records. */

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The signed-in tenant has no assistant with this id. */
    'assistants/not-found': { readonly assistantId: string }
    /** The session already started a turn, so its assistant can no longer change. */
    'assistants/locked': { readonly sessionId: string; readonly assistantId: string }
    /** The name is empty or longer than allowed. */
    'assistants/invalid-name': { readonly name: string }
    /** The description is longer than allowed. */
    'assistants/invalid-description': { readonly length: number }
    /** The avatar is not a preset key or a PNG, JPEG, or WebP image within the size limit. */
    'assistants/invalid-avatar': { readonly reason: string }
    /** No built-in template has this id. */
    'assistants/template-not-found': { readonly templateId: string }
    /** The deployment composes no Agent preset with this id. */
    'assistants/preset-unavailable': { readonly preset: string }
    /** A core file is longer than allowed. */
    'assistants/invalid-file': { readonly file: string; readonly length: number }
  }
}

/** A preset avatar: one of the built-in avatar keys the client draws. */
export interface AssistantPresetAvatar {
  readonly kind: 'preset'
  /** Built-in avatar key, such as `sun`. */
  readonly key: string
}

/** An uploaded avatar: a square image the client already cropped and compressed. */
export interface AssistantImageAvatar {
  readonly kind: 'image'
  /** `data:image/png|jpeg|webp;base64,…` URL of the image. */
  readonly dataUrl: string
}

/** How an assistant's avatar is drawn. */
export type AssistantAvatar = AssistantPresetAvatar | AssistantImageAvatar

/** The model an assistant's sessions use instead of the global default. */
export interface AssistantModel {
  readonly provider: string
  readonly model: string
  /** Reasoning effort id the model offers; absent means the model's default. */
  readonly reasoningEffort?: string
}

/** What the user tells an assistant about themselves; written into its `USER.md`. */
export interface AssistantUserInfo {
  /** How the assistant addresses the user. */
  readonly name: string
  readonly language: string
  /** A short note, such as city or job. */
  readonly notes: string
  readonly background: string
}

/** One built-in template the creation wizard offers. */
export interface AssistantTemplateView {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly avatar: AssistantAvatar
}

/** Everything the creation wizard collects. */
export interface CreateAssistantInput {
  /** Template to start from; null starts blank. */
  readonly templateId: string | null
  readonly name: string
  readonly description: string
  readonly avatar: AssistantAvatar
  /** Model the assistant's sessions use; absent follows the global default. */
  readonly model?: AssistantModel
  /** Agent preset the assistant's sessions run; absent follows the deployment default. */
  readonly preset?: string
  readonly user: AssistantUserInfo
}

/** The result of creating an assistant. */
export interface CreateAssistantResult {
  readonly assistantId: string
  readonly state: AssistantsState
}

/** Name of one core file. */
export type CoreFileName = 'IDENTITY.md' | 'SOUL.md' | 'USER.md' | 'AGENTS.md'

/** Changes the detail page saves; an absent field keeps its value. */
export interface UpdateAssistantInput {
  readonly name?: string
  readonly description?: string
  readonly avatar?: AssistantAvatar
  /** Model the assistant's sessions use; null follows the global default again. */
  readonly model?: AssistantModel | null
  /** Agent preset the assistant's sessions run; null follows the deployment default again. */
  readonly preset?: string | null
  /** Core file texts to replace. */
  readonly files?: Readonly<Partial<Record<CoreFileName, string>>>
}

/** One assistant as the Assistants page and the new-session picker show it. */
export interface AssistantView {
  /** Assistant id, unique within the tenant. */
  readonly id: string
  readonly name: string
  readonly description: string
  readonly avatar: AssistantAvatar
  /** Agent preset the assistant's sessions run; absent means the deployment default. */
  readonly preset?: string
  /** Model the assistant's sessions use; absent means the global default. */
  readonly model?: AssistantModel
  /** Template the assistant was created from, when any. */
  readonly templateId?: string
  /** ISO time of creation. */
  readonly createdAt: string
}

/** One assistant with the text of its core files, as the detail page edits them. */
export interface AssistantDetail {
  readonly assistant: AssistantView
  /** Text of each core file; empty when the file is missing on disk. */
  readonly files: Readonly<Record<CoreFileName, string>>
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
  /** Built-in templates the creation wizard offers. */
  readonly templates: readonly AssistantTemplateView[]
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
