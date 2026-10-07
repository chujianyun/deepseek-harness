/** Assistants state and actions over the `assistants` Remote: the page's cards and the new-session picker. */

import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { AssistantsState, CreateAssistantInput, CreateAssistantResult } from '@deepseek-ai/dsh-assistants/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

/** The blank session the main view shows, which a pick binds. */
export interface BlankSession {
  readonly id: SessionSummary['id']
  /** Assistant the session is already bound to; null when none. */
  readonly assistantId: string | null
}

/** State the page and the picker render. */
export interface AssistantsSnapshot {
  /** Latest Host state; undefined until the first frame arrives. */
  readonly state: AssistantsState | undefined
  /** Assistant the main view's blank session is bound to; null when none or no blank session is shown. */
  readonly bound: string | null
  /** A pick waiting for a blank session to bind. */
  readonly staged: string | undefined
  /** A bind is in flight. */
  readonly busy: boolean
  /** The Host's message for the last refused pick. */
  readonly failure: string | null
}

/** One model the creation wizard offers. */
export interface WizardModel {
  readonly provider: string
  readonly providerName: string
  readonly id: string
  readonly name: string
  /** Reasoning efforts the model offers, in order; empty when it has none. */
  readonly efforts: readonly { readonly id: string; readonly name: string }[]
  readonly defaultEffort?: string
}

/** One Agent preset the creation wizard offers as the capability base. */
export interface WizardPreset {
  readonly id: string
  readonly name: string
  readonly description?: string
}

/** The models and presets the creation wizard offers. */
export interface WizardOptions {
  readonly models: readonly WizardModel[]
  readonly presets: readonly WizardPreset[]
}

/** Remote calls and workspace navigation the source drives. */
export interface AssistantsDependencies {
  readonly select: (sessionId: SessionSummary['id'], assistantId: string) => Promise<RemoteResult<string>>
  /** Open the new-session screen, which brings a blank session into the main view. */
  readonly startSession: () => void
  /** The blank session the main view shows now, if any. */
  readonly blankSession: () => BlankSession | undefined
  readonly create: (input: CreateAssistantInput) => Promise<RemoteResult<CreateAssistantResult>>
  /** Read the models and presets the wizard offers; a source that fails contributes none. */
  readonly loadOptions: () => Promise<WizardOptions>
  /** Crop and compress an uploaded image into an avatar data URL. */
  readonly squareAvatar: (file: Blob) => Promise<string>
}

/** Business face injected into the page and the picker. */
export interface AssistantsInjected {
  readonly hooks: { readonly assistants: HostObservable<AssistantsSnapshot> }
  /** Bind an assistant to the session about to start. */
  readonly onPick: (assistantId: string) => Promise<void>
  /** Open a new session with this assistant. */
  readonly onChat: (assistantId: string) => Promise<void>
  /** Clear the last failure. */
  readonly onDismiss: () => void
  /** Create an assistant; resolves to the Host's refusal message, or undefined once created. */
  readonly onCreate: (input: CreateAssistantInput) => Promise<string | undefined>
  readonly onLoadOptions: () => Promise<WizardOptions>
  readonly squareAvatar: (file: Blob) => Promise<string>
}

/** The face plus the entry points of the Host stream and of session-list changes. */
export interface AssistantsSource extends AssistantsInjected {
  readonly publish: (state: AssistantsState) => void
  /** Re-read the main view's blank session and bind a staged pick to it. */
  readonly sessionsChanged: () => Promise<void>
}

/**
 * The assistant a picker shows: the staged pick, else the blank session's own, else the tenant default.
 * @param snapshot - the current snapshot.
 * @returns the assistant id, or null when there is none to show.
 */
export function shownAssistant(snapshot: AssistantsSnapshot): string | null {
  return snapshot.staged ?? snapshot.bound ?? snapshot.state?.defaultId ?? null
}

/**
 * Create the source. A pick is staged, then bound when the main view shows a blank session —
 * immediately when one is already shown, or once the new-session screen brings one.
 * @param deps - Remote calls and navigation.
 * @returns the source.
 */
export function createAssistantsSource(deps: AssistantsDependencies): AssistantsSource {
  const store = createSnapshotStore<AssistantsSnapshot>({ state: undefined, bound: null, staged: undefined, busy: false, failure: null })
  const set = (patch: Partial<AssistantsSnapshot>): void => { store.set({ ...store.getSnapshot(), ...patch }) }
  const apply = async (): Promise<void> => {
    const blank = deps.blankSession()
    const bound = blank?.assistantId ?? null
    // Every session-list change lands here; publish only an actual change of the binding.
    if (store.getSnapshot().bound !== bound) set({ bound })
    const { staged, busy } = store.getSnapshot()
    if (staged === undefined || busy || blank === undefined) return
    if (blank.assistantId === staged) { set({ staged: undefined }); return }
    set({ busy: true, failure: null })
    let shown = blank.assistantId
    try {
      const result = await deps.select(blank.id, staged)
      if (result.ok) shown = result.value
      else set({ failure: result.error.message })
    } catch (error) {
      set({ failure: error instanceof Error ? error.message : String(error) })
    } finally {
      // The session list reports the new binding a moment later; show it now.
      set({ staged: undefined, busy: false, bound: shown })
    }
  }
  return {
    hooks: { assistants: store },
    publish: (state) => { set({ state }) },
    sessionsChanged: apply,
    onPick: async (assistantId) => {
      set({ staged: assistantId })
      await apply()
    },
    onChat: async (assistantId) => {
      set({ staged: assistantId })
      deps.startSession()
      await apply()
    },
    onDismiss: () => { set({ failure: null }) },
    onCreate: async (input) => {
      const result = await deps.create(input)
      if (!result.ok) return result.error.message
      // The stream brings the same state; keep whichever is newer so the card shows at once.
      const current = store.getSnapshot().state
      if (current === undefined || result.value.state.revision > current.revision) set({ state: result.value.state })
      return undefined
    },
    onLoadOptions: () => deps.loadOptions(),
    squareAvatar: file => deps.squareAvatar(file),
  }
}
