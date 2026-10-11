/**
 * The sidebar's Assistant grouping: Sessions sectioned by the assistant they are bound to, each
 * section led by the assistant's avatar. Sessions bound to none fall under General mode; ones bound
 * to an assistant this tenant does not list (deleted, another company's, or signed out) fall under
 * Other, which names nothing about that assistant.
 */

import { IconUserOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionGrouping } from '@deepseek-ai/dsh-client-ui-workspace/client'
import { AssistantAvatar } from './AssistantAvatar.tsx'
import { assistantOf, type AssistantsSnapshot } from './assistants-source.ts'

/** Dictionary keys the grouping reads. */
export type AssistantGroupingKey = 'groupByAssistant' | 'noAssistant' | 'groupOther'

/** A preset key outside the palette, which the avatar draws as a neutral disc. */
const NEUTRAL = { kind: 'preset', key: 'neutral' } as const

/**
 * Build the Assistant grouping.
 * @param t - translator owning {@link AssistantGroupingKey}.
 * @param assistants - the assistants snapshot; each change regroups the sidebar.
 * @returns the grouping, listed first under Group by; its sections follow their most recent Session.
 */
export function assistantGrouping(
  t: (key: AssistantGroupingKey) => string,
  assistants: HostObservable<AssistantsSnapshot>,
): SessionGrouping {
  return {
    id: 'assistant',
    label: () => t('groupByAssistant'),
    order: 50,
    icon: <IconUserOutlineRegular />,
    groupOf: (session) => {
      const bound = assistantOf(session)
      if (bound === null) {
        const label = t('noAssistant')
        return { key: 'general', label, icon: <AssistantAvatar avatar={NEUTRAL} name={label} size={16} /> }
      }
      const assistant = assistants.getSnapshot().state?.assistants.find(item => item.id === bound)
      if (assistant === undefined) {
        return { key: 'other', label: t('groupOther'), icon: <AssistantAvatar avatar={NEUTRAL} name="?" size={16} /> }
      }
      return {
        key: `assistant:${assistant.id}`, label: assistant.name,
        icon: <AssistantAvatar avatar={assistant.avatar} name={assistant.name} size={16} />,
      }
    },
    subscribe: onChange => assistants.subscribe(onChange),
  }
}
