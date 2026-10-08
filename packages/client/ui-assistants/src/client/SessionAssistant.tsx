/**
 * The assistant a session belongs to, in the sidebar's session rows: an avatar before the title,
 * named on hover, and a line in the row's hover card. A session whose assistant belongs to another
 * company on this machine shows the other-company mark, which names nothing about that assistant;
 * one whose assistant is gone shows the deleted-assistant mark.
 */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { AssistantAvatar } from './AssistantAvatar.tsx'
import { assistantOf, type AssistantsInjected } from './assistants-source.ts'
import css from './SessionAssistant.module.css'

/** What a row shows: the assistant, the other-company or deleted mark, or nothing. */
type RowAssistant =
  | { readonly kind: 'assistant'; readonly name: string; readonly avatar: Parameters<typeof AssistantAvatar>[0]['avatar'] }
  | { readonly kind: 'other-tenant' }
  | { readonly kind: 'deleted' }

/**
 * Resolve the assistant of a listed session.
 * @param props - the session id and the assistants and session list hooks.
 * @returns the row's assistant, or undefined when the session has none or the state is unknown.
 */
function useRowAssistant({ sessionId, useAssistants, useSessions }: Pick<SessionAssistantProps, 'sessionId' | 'useAssistants' | 'useSessions'>): RowAssistant | undefined {
  const bound = useSessions(list => assistantOf(list.byId[sessionId]))
  const state = useAssistants(snapshot => snapshot.state)
  const elsewhere = useAssistants(snapshot => snapshot.elsewhere)
  // Signed out, or before the first state, there is nothing to compare the binding with.
  if (bound === null || state === undefined || state.tenantId === null) return undefined
  const assistant = state.assistants.find(item => item.id === bound)
  if (assistant !== undefined) return { kind: 'assistant', name: assistant.name, avatar: assistant.avatar }
  // Until the Host answers whether another tenant keeps it, the row shows no mark rather than a wrong one.
  if (!elsewhere.asked.includes(bound)) return undefined
  return elsewhere.otherTenant.includes(bound) ? { kind: 'other-tenant' } : { kind: 'deleted' }
}

/** A preset key outside the palette, which the avatar draws as a neutral disc. */
const NEUTRAL = { kind: 'preset', key: 'neutral' } as const

/** The glyph of each mark, the same in every locale. */
const MARK_GLYPH = { 'other-tenant': '⇄', 'deleted': '?' } as const

/** The row's label: the assistant's name, or the text of its mark. */
function labelOf(shown: RowAssistant, t: SessionAssistantProps['t']): string {
  switch (shown.kind) {
    case 'assistant': return t('rowAssistant', { name: shown.name })
    case 'other-tenant': return t('otherTenantAssistant')
    case 'deleted': return t('deletedAssistant')
  }
}

/** Props of the session row seats. */
export type SessionAssistantProps =
  PropsRuntime<'sidebar.session.row.badge'> & PropsLocale<'assistants'> & InjectFace<AssistantsInjected>

/**
 * Render the avatar of the session's assistant before the row's title.
 * @param props - the row's session id, the hooks, and copy.
 * @returns the avatar, the other-company or deleted mark, or nothing for a session without an assistant.
 */
export function SessionAssistantBadge(props: SessionAssistantProps) {
  const shown = useRowAssistant(props)
  if (shown === undefined) return null
  const label = labelOf(shown, props.t)
  // The marks draw a neutral disc with a fixed glyph: "?" for a deleted assistant, "⇄" for another company's.
  const avatar = shown.kind === 'assistant' ? shown.avatar : NEUTRAL
  return (
    <span className={css.badge} title={label} aria-label={label} role="img" data-assistant-badge={shown.kind}>
      <AssistantAvatar avatar={avatar} name={shown.kind === 'assistant' ? shown.name : MARK_GLYPH[shown.kind]} size={16} />
    </span>
  )
}

/**
 * Render the hover card line that names the session's assistant.
 * @param props - the row's session id, the hooks, and copy.
 * @returns the line, or nothing for a session without an assistant.
 */
export function SessionAssistantHover(props: SessionAssistantProps) {
  const shown = useRowAssistant(props)
  if (shown === undefined) return null
  return (
    <div className={css.hover}>
      {shown.kind === 'assistant' && <AssistantAvatar avatar={shown.avatar} name={shown.name} size={14} />}
      <span>{labelOf(shown, props.t)}</span>
    </div>
  )
}
