/**
 * The sidebar's Assistant grouping: Sessions sectioned by the assistant they are bound to, each
 * section led by the assistant's avatar. Sessions bound to none fall under General mode; ones bound
 * to an assistant this tenant does not list (deleted, another company's, or signed out) fall under
 * Other, which names nothing about that assistant.
 */

import { IconUserOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AssistantsState } from '@deepseek-ai/dsh-assistants/types'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionGroupHeading, SessionGrouping } from '@deepseek-ai/dsh-client-ui-workspace/client'
import { AssistantAvatar, NEUTRAL_AVATAR } from './AssistantAvatar.tsx'
import { assistantOf, type AssistantsSnapshot } from './assistants-source.ts'

/** Dictionary keys the grouping reads. */
export type AssistantGroupingKey = 'groupByAssistant' | 'noAssistant' | 'groupOther'

/**
 * Build the Assistant grouping.
 * @param t - translator owning {@link AssistantGroupingKey}.
 * @param assistants - the assistants snapshot; a change of its Host state regroups the sidebar.
 * @param localeChanges - subscription to language switches, which relabel General mode and Other.
 * @returns the grouping, listed first under Group by; its sections follow their most recent Session.
 *   It reads as not ready until the signed-in tenant's assistants are known.
 */
export function assistantGrouping(
  t: (key: AssistantGroupingKey) => string,
  assistants: HostObservable<AssistantsSnapshot>,
  localeChanges: (onChange: () => void) => () => void,
): SessionGrouping {
  // One heading per assistant for as long as the Host state stays the same object.
  let headingsOf: AssistantsState | undefined
  let headings = new Map<string, SessionGroupHeading>()
  const assistantHeading = (id: string): SessionGroupHeading | undefined => {
    const state = assistants.getSnapshot().state
    if (state === undefined) return undefined
    if (state !== headingsOf) {
      headingsOf = state
      headings = new Map(state.assistants.map(assistant => [assistant.id, {
        key: `assistant:${assistant.id}`, label: assistant.name,
        icon: <AssistantAvatar avatar={assistant.avatar} name={assistant.name} size={16} />,
      }]))
    }
    return headings.get(id)
  }
  return {
    id: 'assistant',
    label: () => t('groupByAssistant'),
    order: 50,
    icon: <IconUserOutlineRegular />,
    groupOf: (session) => {
      const bound = assistantOf(session)
      if (bound === null) {
        const label = t('noAssistant')
        return { key: 'general', label, icon: <AssistantAvatar avatar={NEUTRAL_AVATAR} name={label} size={16} /> }
      }
      return assistantHeading(bound)
        ?? { key: 'other', label: t('groupOther'), icon: <AssistantAvatar avatar={NEUTRAL_AVATAR} name="?" size={16} /> }
    },
    subscribe: (onChange) => {
      let seen = assistants.getSnapshot().state
      const stopAssistants = assistants.subscribe(() => {
        const state = assistants.getSnapshot().state
        if (state === seen) return
        seen = state
        onChange()
      })
      const stopLocale = localeChanges(onChange)
      return () => {
        stopAssistants()
        stopLocale()
      }
    },
    ready: () => {
      const state = assistants.getSnapshot().state
      return state !== undefined && state.tenantId !== null
    },
  }
}
