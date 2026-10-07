/**
 * Assistants, browser half: the **Assistants** entry of the Desktop sidebar with the page it opens
 * in the main column, and the assistant picker that leads the new-session screen's workspace row.
 * State streams from the `assistants` Remote; a pick binds the blank session the main view shows,
 * and a card's Chat button opens the new-session screen with that assistant picked.
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
import { createAssistantsSource, type BlankSession } from './assistants-source.ts'
import { AssistantSeat } from './AssistantSeat.tsx'
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

/** Services the page reads: the `assistants` Remote and the layout slots. */
export const inject = ['slots', 'locale', 'remote', 'remote.assistants']

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
      const bound = summary.projectionValues?.assistant
      return { id: summary.id, assistantId: typeof bound === 'string' ? bound : null }
    }
    const source = createAssistantsSource({
      select: (sessionId, assistantId) => remote.select(sessionId, assistantId),
      startSession: () => { scope.uiWorkspace.startSession() },
      blankSession,
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
  })
}
