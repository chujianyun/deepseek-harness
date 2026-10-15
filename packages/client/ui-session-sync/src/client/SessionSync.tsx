/**
 * Conversations from other computers in the client: a mark on their sidebar rows, a line in the
 * row's hover card naming the computer, and a composer that says the conversation is view-only.
 */
import type { HostObservable, PropsHooks, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { NS } from './locales.ts'
import css from './SessionSync.module.css'

/** Pulled conversations by their top-level Session, with the computer each comes from. */
export type PulledDevices = Readonly<Record<SessionId, string>>

/** Row share: the pulled conversations. */
export interface PulledRowInjected {
  hooks: {
    /** The conversations pulled from the employee's other computers. */
    pulled: HostObservable<PulledDevices>
  }
}

/** Props of the row mark. */
export type PulledBadgeProps = PropsRuntime<'sidebar.session.row.badge'> & PropsLocale<typeof NS> & PropsHooks<PulledRowInjected['hooks']>

/** Props of the hover line. */
export type PulledHoverProps = PropsRuntime<'sidebar.session.row.hover'> & PropsLocale<typeof NS> & PropsHooks<PulledRowInjected['hooks']>

/** The composer's match: the computer the open conversation comes from. */
export interface PulledComposerMatch {
  readonly device: string
}

/** Props of the view-only composer. */
export type PulledComposerProps = PropsRuntime<'conversation.composer'> & { matched: PulledComposerMatch } & PropsLocale<typeof NS>

/** A small monitor, drawn in the current text color. */
function ComputerGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.75" y="2.75" width="12.5" height="8.5" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M5.5 13.75h5M8 11.25v2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

/**
 * Mark a row whose conversation comes from another computer.
 * @param props - the row's Session, the pulled conversations, and copy.
 * @returns the mark, or nothing for this computer's own conversation.
 */
export function PulledBadge({ sessionId, usePulled, t }: PulledBadgeProps) {
  const device = usePulled(pulled => pulled[sessionId])
  if (device === undefined) return null
  const label = t('badge', { device })
  return <span className={css.badge} title={label} aria-label={label} role="img" data-session-sync-badge=""><ComputerGlyph /></span>
}

/**
 * Name the computer in the row's hover card.
 * @param props - the row's Session, the pulled conversations, and copy.
 * @returns the line, or nothing for this computer's own conversation.
 */
export function PulledHover({ sessionId, usePulled, t }: PulledHoverProps) {
  const device = usePulled(pulled => pulled[sessionId])
  if (device === undefined) return null
  return <div className={css.hover}><ComputerGlyph /><span>{t('hover', { device })}</span></div>
}

/**
 * Take the composer's place in a conversation from another computer.
 * @param props - the computer and copy.
 * @returns the view-only notice.
 */
export function PulledComposer({ matched, t }: Pick<PulledComposerProps, 'matched' | 't'>) {
  return (
    <div className={css.frame} role="status" data-session-sync-readonly="">
      <strong>{t('readonly.title', { device: matched.device })}</strong>
      <span>{t('readonly.body')}</span>
    </div>
  )
}
