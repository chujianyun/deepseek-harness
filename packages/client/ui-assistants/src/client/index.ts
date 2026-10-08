/**
 * Assistants, browser half: the **Assistants** entry of the Desktop sidebar with the page it opens
 * in the main column, and the assistant picker that leads the new-session screen's workspace row.
 * State streams from the `assistants` Remote; a pick binds the blank session the main view shows,
 * and a card's Chat button opens the new-session screen with that assistant picked. A card opens
 * the assistant's detail page, where its fields and core files are edited.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { AssistantsState } from '@deepseek-ai/dsh-assistants/types'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { assistantOf, assistantSessions, createAssistantsSource, type BlankSession, type WizardOptions } from './assistants-source.ts'
import { squareAvatar } from './avatar-image.ts'
import { AssistantSeat } from './AssistantSeat.tsx'
import { SessionAssistantBadge, SessionAssistantHover } from './SessionAssistant.tsx'
import { AssistantsPage } from './AssistantsPage.tsx'
import { AssistantsPanelIcon } from './AssistantsPanelIcon.tsx'
import { en, zh, type AssistantsLocaleKey } from './locales.ts'

export type { AssistantsDependencies, AssistantsInjected, AssistantsSnapshot, BlankSession } from './assistants-source.ts'
export type { AssistantsLocaleKey } from './locales.ts'
export type { AssistantsPageProps } from './AssistantsPage.tsx'
export type { AssistantSeatProps } from './AssistantSeat.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Assistants page and picker copy. */
    'assistants': AssistantsLocaleKey
  }
}

const NS = 'assistants'
const PANEL_ID = 'assistants' as MainPanelId

/** Services the page reads: the `assistants` Remote, the model catalog and preset roster for the wizard, and the layout slots. */
export const inject = ['slots', 'locale', 'remote', 'remote.assistants', 'remote.session', 'remote.agentPresets']

/**
 * Read the wizard's models, presets, and subset choices; a Remote that refuses or is absent contributes none.
 * @param ctx - the browser plugin context.
 * @returns the models of every routable provider, the presets that can compose a session, and the
 *   Skills, connectors, and knowledge bases available now.
 */
async function wizardOptions(ctx: ClientContext): Promise<WizardOptions> {
  // A deployment without one of these Remotes, or one that refuses, offers nothing from it.
  const settle = <T>(call: () => Promise<T>): Promise<T | undefined> => Promise.resolve().then(call).catch(() => undefined)
  const [catalog, roster, capabilities] = await Promise.all([
    settle(() => ctx.remote.session.modelCatalog()),
    settle(() => ctx.remote.agentPresets.list()),
    settle(() => ctx.remote.assistants.capabilityOptions()),
  ])
  const models = catalog?.ok === true
    ? catalog.value.groups.flatMap(group => group.models.map(model => ({
      provider: group.id, providerName: group.name, id: model.id, name: model.name,
      efforts: (model.reasoning?.efforts ?? []).map(effort => ({ id: effort.id, name: effort.name })),
      ...(model.reasoning?.defaultEffort === undefined ? {} : { defaultEffort: model.reasoning.defaultEffort }),
    })))
    : []
  const presets = roster?.ok === true
    ? roster.value.presets.filter(preset => preset.broken === undefined).map(preset => ({
      id: preset.id, name: preset.name ?? preset.id, ...(preset.description === undefined ? {} : { description: preset.description }),
    }))
    : []
  return { models, presets, ...(capabilities?.ok === true ? { capabilities: capabilities.value } : {}) }
}

/**
 * Contribute the Assistants sidebar entry, below Connectors, its page, and the new-session picker, in the Desktop renderer.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  // Desktop only: assistants belong to the tenant of the user-center sign-in.
  if (!('dshDesktop' in globalThis)) return
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-assistants: dictionaries')
  const t = ctx.locale.bind(NS)
  const remote = ctx.remote.assistants
  ctx.inject(['sessions', 'uiWorkspace'], (scope: ClientContext) => {
    const blankSession = (): BlankSession | undefined => {
      const summary = Object.values(scope.sessions.list.getSnapshot().byId)
        .find(session => session.blank && (session.retainedBy.mainView ?? 0) > 0)
      if (summary === undefined) return undefined
      return { id: summary.id, assistantId: assistantOf(summary) }
    }
    const source = createAssistantsSource({
      select: (sessionId, assistantId) => remote.select(sessionId, assistantId),
      startSession: () => { scope.uiWorkspace.startSession() },
      blankSession,
      create: input => remote.createAssistant(input),
      loadOptions: () => wizardOptions(scope),
      squareAvatar,
      read: assistantId => remote.getAssistant(assistantId),
      update: (assistantId, input) => remote.updateAssistant(assistantId, input),
      setDefault: assistantId => remote.setDefault(assistantId),
      duplicate: assistantId => remote.duplicateAssistant(assistantId),
      remove: assistantId => remote.deleteAssistant(assistantId),
      otherTenant: assistantIds => remote.otherTenantAssistants(assistantIds),
      sessionCount: assistantId => assistantSessions(scope.sessions.list.getSnapshot(), assistantId).length,
      sessionList: scope.sessions.list,
      openSession: (sessionId) => { scope.uiWorkspace.openSession(sessionId) },
    })
    const assistants = scope.remote.$stream<AssistantsState>({
      name: 'assistants', open: signal => remote.watch(signal), ended: () => new Error('assistants stream ended'),
    })
    scope.effect(() => () => { void assistants.dispose() }, 'ui-assistants: state stream')
    void (async () => {
      for await (const frame of assistants) { source.publish(frame.value); frame.accept() }
    })().catch(() => {
      // The stream reconnects on its own; a disposed plugin simply stops listening.
    })
    scope.effect(() => scope.sessions.list.subscribe(() => { void source.sessionsChanged() }), 'ui-assistants: session list')
    scope.slots.inject('main', () => scope.slots.register({ name: 'main', key: PANEL_ID, locale: NS, inject: () => source }, AssistantsPage))
    scope.slots.inject('sidebar.panellist', () => scope.slots.register({
      name: 'sidebar.panellist', id: PANEL_ID, order: 8, label: () => t('panel'), locale: NS,
    }, AssistantsPanelIcon))
    scope.slots.inject('conversation.hero.assistant', () => scope.slots.register({
      name: 'conversation.hero.assistant', locale: NS, inject: () => source,
    }, AssistantSeat))
    scope.slots.inject('sidebar.session.row.badge', () => scope.slots.register({
      name: 'sidebar.session.row.badge', id: 'assistant-badge', order: 10, locale: NS, inject: () => source,
    }, SessionAssistantBadge))
    scope.slots.inject('sidebar.session.row.hover', () => scope.slots.register({
      name: 'sidebar.session.row.hover', id: 'assistant-hover', order: 5, locale: NS, inject: () => source,
    }, SessionAssistantHover))
  })
}
