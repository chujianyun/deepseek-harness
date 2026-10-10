/** Assistants state and actions over the `assistants` Remote: the page's cards, the detail page, and the new-session picker. */

import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  AssistantCapabilityOptions, AssistantDetail, AssistantsState, CreateAssistantInput, CreateAssistantResult, UpdateAssistantInput,
} from '@deepseek-ai/dsh-assistants/types'
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
  /** A pick waiting for a blank session to bind: an assistant id, null for none, or undefined when nothing is waiting. */
  readonly staged: string | null | undefined
  /** A bind is in flight. */
  readonly busy: boolean
  /** The Host's message for the last refused pick. */
  readonly failure: string | null
  /**
   * Bound assistant ids outside the signed-in tenant that the Host was asked about, and those it
   * found under another tenant; a row whose id was not asked about yet shows no mark.
   */
  readonly elsewhere: { readonly asked: readonly string[]; readonly otherTenant: readonly string[] }
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

/** The models, presets, and subset choices the creation wizard and the detail page offer. */
export interface WizardOptions {
  readonly models: readonly WizardModel[]
  readonly presets: readonly WizardPreset[]
  /** Skills, connectors, and knowledge bases available now; undefined when they could not be read. */
  readonly capabilities?: AssistantCapabilityOptions
}

/** Remote calls and workspace navigation the source drives. */
export interface AssistantsDependencies {
  readonly select: (sessionId: SessionSummary['id'], assistantId: string | null) => Promise<RemoteResult<string | null>>
  /** Open the new-session screen, which brings a blank session into the main view. */
  readonly startSession: () => void
  /** The blank session the main view shows now, if any. */
  readonly blankSession: () => BlankSession | undefined
  readonly create: (input: CreateAssistantInput) => Promise<RemoteResult<CreateAssistantResult>>
  /** Read the models and presets the wizard offers; a source that fails contributes none. */
  readonly loadOptions: () => Promise<WizardOptions>
  /** Crop and compress an uploaded image into an avatar data URL. */
  readonly squareAvatar: (file: Blob) => Promise<string>
  readonly read: (assistantId: string) => Promise<RemoteResult<AssistantDetail>>
  readonly update: (assistantId: string, input: UpdateAssistantInput) => Promise<RemoteResult<AssistantsState>>
  readonly duplicate: (assistantId: string) => Promise<RemoteResult<CreateAssistantResult>>
  readonly remove: (assistantId: string) => Promise<RemoteResult<AssistantsState>>
  /** How many started sessions in the session list are bound to the assistant. */
  readonly sessionCount: (assistantId: string) => number
  /** The session list, whose rows carry each session's assistant. */
  readonly sessionList: HostObservable<SessionListState>
  /** Show a session's conversation. */
  readonly openSession: (sessionId: SessionSummary['id']) => void
  /** Pick the ids another tenant on this machine keeps. */
  readonly otherTenant: (assistantIds: readonly string[]) => Promise<RemoteResult<string[]>>
}

/** Business face injected into the page and the picker. */
export interface AssistantsInjected {
  readonly hooks: { readonly assistants: HostObservable<AssistantsSnapshot>; readonly sessions: HostObservable<SessionListState> }
  /** Bind an assistant, or none (null), to the session about to start. */
  readonly onPick: (assistantId: string | null) => Promise<void>
  /** Open a new session with this assistant. */
  readonly onChat: (assistantId: string) => Promise<void>
  /** Clear the last failure. */
  readonly onDismiss: () => void
  /** Create an assistant; resolves to the Host's refusal message, or undefined once created. */
  readonly onCreate: (input: CreateAssistantInput) => Promise<string | undefined>
  readonly onLoadOptions: () => Promise<WizardOptions>
  readonly squareAvatar: (file: Blob) => Promise<string>
  /** Read an assistant and its core files; resolves to the Host's refusal message when it cannot. */
  readonly onRead: (assistantId: string) => Promise<AssistantDetail | string>
  /** Save changes; resolves to the Host's refusal message, or undefined once saved. */
  readonly onUpdate: (assistantId: string, input: UpdateAssistantInput) => Promise<string | undefined>
  /** Copy the assistant; resolves to the copy's id, or the Host's refusal message. */
  readonly onDuplicate: (assistantId: string) => Promise<{ readonly assistantId: string } | string>
  /** Delete the assistant; resolves to the Host's refusal message, or undefined once deleted. */
  readonly onDelete: (assistantId: string) => Promise<string | undefined>
  /** How many started sessions are bound to the assistant, for the delete confirmation. */
  readonly sessionCount: (assistantId: string) => number
  /** Show a session's conversation. */
  readonly onOpenSession: (sessionId: SessionSummary['id']) => void
}

/** Picks for other plugins, provided as the `assistantPicker` service. */
export interface AssistantPicker {
  /**
   * Pick, for the session about to start, the first assistant of the signed-in tenant created from a template, as the
   * new-session picker does; a picked or bound assistant already created from it is kept.
   * @param templateId - template id, for example `ecommerce` (电商管家).
   * @returns false when the tenant has no assistant from the template, or before the first state frame.
   */
  readonly pickTemplate: (templateId: string) => Promise<boolean>
}

/** The face plus the entry points of the Host stream and of session-list changes. */
export interface AssistantsSource extends AssistantsInjected, AssistantPicker {
  readonly publish: (state: AssistantsState) => void
  /** Re-read the main view's blank session and bind a staged pick to it. */
  readonly sessionsChanged: () => Promise<void>
}

/** One started session of an assistant, as the detail page lists it. */
export interface AssistantSession {
  readonly id: SessionSummary['id']
  readonly title: string
  readonly updatedAt: number
}

/**
 * The assistant a session is bound to, as its list row carries it.
 * @param summary - the session's list row, if listed.
 * @returns the assistant id, or null for a session bound to none.
 */
export function assistantOf(summary: SessionSummary | undefined): string | null {
  const bound = summary?.projectionValues?.assistant
  return typeof bound === 'string' ? bound : null
}

/**
 * The started main sessions bound to an assistant, most recently updated first.
 * @param list - the session list.
 * @param assistantId - the assistant.
 * @returns the sessions.
 */
export function assistantSessions(list: SessionListState, assistantId: string): AssistantSession[] {
  return list.ids.map(id => list.byId[id]).filter((summary): summary is SessionSummary => summary !== undefined)
    .filter(summary => !summary.blank && summary.origin !== 'subagent' && assistantOf(summary) === assistantId)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(summary => ({ id: summary.id, title: summary.displayTitle, updatedAt: summary.updatedAt }))
}

/**
 * The assistant a picker shows: the staged pick, else the blank session's own.
 * @param snapshot - the current snapshot.
 * @returns the assistant id, or null for no assistant.
 */
export function shownAssistant(snapshot: AssistantsSnapshot): string | null {
  return snapshot.staged === undefined ? snapshot.bound : snapshot.staged
}

/**
 * Create the source. A pick is staged, then bound when the main view shows a blank session —
 * immediately when one is already shown, or once the new-session screen brings one.
 * @param deps - Remote calls and navigation.
 * @returns the source.
 */
export function createAssistantsSource(deps: AssistantsDependencies): AssistantsSource {
  const nowhere = { asked: [], otherTenant: [] }
  const store = createSnapshotStore<AssistantsSnapshot>({
    state: undefined, bound: null, staged: undefined, busy: false, failure: null, elsewhere: nowhere,
  })
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
  // Ask the Host about bound ids the signed-in tenant does not have; answers hold until the tenant changes.
  let askedFor: string | null = null
  const pending = new Set<string>()
  const lookUp = async (): Promise<void> => {
    const { state, elsewhere } = store.getSnapshot()
    const tenantId = state?.tenantId ?? null
    if (tenantId !== askedFor) {
      askedFor = tenantId
      if (elsewhere !== nowhere) set({ elsewhere: nowhere })
    }
    if (state === undefined || tenantId === null) return
    const known = new Set([...state.assistants.map(item => item.id), ...store.getSnapshot().elsewhere.asked, ...pending])
    const list = deps.sessionList.getSnapshot()
    const ids = [...new Set(list.ids.map(id => assistantOf(list.byId[id])))].filter((id): id is string => id !== null && !known.has(id))
    if (ids.length === 0) return
    for (const id of ids) pending.add(id)
    let result: RemoteResult<string[]> | undefined
    try {
      result = await deps.otherTenant(ids)
    } catch {
      // A dropped connection answers nothing; the rows show no mark until the next change asks again.
      result = undefined
    }
    for (const id of ids) pending.delete(id)
    // An answer for a tenant no longer signed in is dropped and the new tenant is asked; a failed call asks again on the next change.
    if (askedFor !== tenantId) { void lookUp(); return }
    if (result?.ok !== true) return
    const current = store.getSnapshot().elsewhere
    set({ elsewhere: { asked: [...current.asked, ...ids], otherTenant: [...current.otherTenant, ...result.value] } })
  }
  // A call's state and the stream's frames may arrive in either order; keep the newer one.
  const adopt = (state: AssistantsState): void => {
    const current = store.getSnapshot().state
    if (current === undefined || state.revision > current.revision) set({ state })
  }
  const settle = async (call: Promise<RemoteResult<AssistantsState>>): Promise<string | undefined> => {
    const result = await call
    if (!result.ok) return result.error.message
    adopt(result.value)
    return undefined
  }
  return {
    hooks: { assistants: store, sessions: deps.sessionList },
    publish: (state) => { set({ state }); void lookUp() },
    sessionsChanged: async () => { void lookUp(); await apply() },
    onPick: async (assistantId) => {
      set({ staged: assistantId })
      await apply()
    },
    pickTemplate: async (templateId) => {
      const snapshot = store.getSnapshot()
      const assistants = snapshot.state?.assistants ?? []
      const shown = shownAssistant(snapshot)
      if (assistants.some(item => item.id === shown && item.templateId === templateId)) return true
      const match = assistants.find(item => item.templateId === templateId)
      if (match === undefined) return false
      set({ staged: match.id })
      await apply()
      return true
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
      adopt(result.value.state)
      return undefined
    },
    onLoadOptions: () => deps.loadOptions(),
    squareAvatar: file => deps.squareAvatar(file),
    onRead: async (assistantId) => {
      const result = await deps.read(assistantId)
      return result.ok ? result.value : result.error.message
    },
    onUpdate: (assistantId, input) => settle(deps.update(assistantId, input)),
    onDuplicate: async (assistantId) => {
      const result = await deps.duplicate(assistantId)
      if (!result.ok) return result.error.message
      adopt(result.value.state)
      return { assistantId: result.value.assistantId }
    },
    onDelete: assistantId => settle(deps.remove(assistantId)),
    sessionCount: assistantId => deps.sessionCount(assistantId),
    onOpenSession: (sessionId) => { deps.openSession(sessionId) },
  }
}
