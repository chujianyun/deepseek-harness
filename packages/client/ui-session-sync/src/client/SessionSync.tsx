/**
 * Conversations from other computers in the client: a mark on their sidebar rows, a line in the
 * row's hover card naming the computer, and a composer that says the conversation is view-only.
 */
import { useEffect, useRef, useState } from 'react'
import type { RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, PropsHooks, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionSyncContinueInfo, SessionSyncContinuation } from '@deepseek-ai/dsh-session-sync/client'
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

/** The composer's match: the open pulled conversation and the computer it comes from. */
export interface PulledComposerMatch {
  readonly sessionId: SessionId
  readonly device: string
}

/** Composer share: asking to continue the conversation here. */
export interface PulledComposerInjected {
  /** Open the continue dialog for a pulled conversation. */
  requestContinue: (sessionId: SessionId) => void
}

/** Props of the view-only composer. */
export type PulledComposerProps = PropsRuntime<'conversation.composer'> & { matched: PulledComposerMatch } & PropsLocale<typeof NS>
  & PulledComposerInjected

/** Continuations by their top-level Session. */
export type ContinuationsById = Readonly<Record<SessionId, SessionSyncContinuation>>

/** Share of the continuation label and hover line. */
export interface ContinuationInjected {
  hooks: {
    /** The conversations of this computer that carry on pulled ones. */
    continuations: HostObservable<ContinuationsById>
  }
  /** Open a Session in the main view. */
  open: (sessionId: SessionId) => void
}

/** Props of the continuation label in the conversation header. */
export type ContinuationLabelProps = PropsRuntime<'conversation.session.header.actions'> & PropsLocale<typeof NS>
  & Omit<ContinuationInjected, 'hooks'> & PropsHooks<ContinuationInjected['hooks']>

/** Props of the continuation line in a row's hover card. */
export type ContinuationHoverProps = PropsRuntime<'sidebar.session.row.hover'> & PropsLocale<typeof NS>
  & PropsHooks<ContinuationInjected['hooks']>

/** Share of the continue dialog. */
export interface ContinueDialogInjected {
  hooks: {
    /** The pulled conversation to continue, until the dialog closes. */
    continueRequest: HostObservable<SessionId | null>
  }
  /** Close the dialog. */
  settleContinue: () => void
  /** Read where the conversation worked. */
  continueInfo: (sessionId: SessionId) => Promise<RemoteResult<SessionSyncContinueInfo>>
  /** Let the user choose a folder of this computer; null when they cancel. */
  pickFolder: () => Promise<string | null>
  /** Continue the conversation in a folder. */
  continueConversation: (sessionId: SessionId, cwd: string) => Promise<RemoteResult<{ readonly sessionId: SessionId }>>
  /** Open a Session in the main view. */
  open: (sessionId: SessionId) => void
}

/** Props of the continue dialog. */
export type ContinueDialogProps = PropsRuntime<'shell.overlay'> & PropsLocale<typeof NS>
  & Omit<ContinueDialogInjected, 'hooks'> & PropsHooks<ContinueDialogInjected['hooks']>

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
export function PulledComposer({ matched, requestContinue, t }: Pick<PulledComposerProps, 'matched' | 'requestContinue' | 't'>) {
  return (
    <div className={css.frame} role="status" data-session-sync-readonly="">
      <strong>{t('readonly.title', { device: matched.device })}</strong>
      <span>{t('readonly.body')}</span>
      <Button variant="primary" size="sm" onClick={() => { requestContinue(matched.sessionId) }}>{t('continue')}</Button>
    </div>
  )
}

/**
 * Say in the conversation header which pulled conversation this one carries on, linking back to it
 * while it is still here.
 * @param props - the open Session, the continuations, the list, navigation, and copy.
 * @returns the label, or nothing for any other conversation.
 */
export function ContinuationLabel({ sessionId, useContinuations, useSessions, open, t }: ContinuationLabelProps) {
  const entry = useContinuations(continuations => continuations[sessionId])
  const sourceHere = useSessions(state => entry !== undefined && state.byId[entry.sourceId] !== undefined)
  if (entry === undefined) return null
  const label = entry.title === null ? t('continued.untitled', { device: entry.device }) : t('continued', { title: entry.title })
  if (!sourceHere) return <span className={css.continued} data-session-sync-continued="">{label}</span>
  return (
    <button type="button" className={`${css.continued} ${css.link}`} title={t('continued.open')} data-session-sync-continued=""
      onClick={() => { open(entry.sourceId) }}>
      {label}
    </button>
  )
}

/**
 * Say in a row's hover card which pulled conversation it carries on.
 * @param props - the row's Session, the continuations, and copy.
 * @returns the line, or nothing for any other conversation.
 */
export function ContinuationHover({ sessionId, useContinuations, t }: ContinuationHoverProps) {
  const entry = useContinuations(continuations => continuations[sessionId])
  if (entry === undefined) return null
  return <div className={css.hover}>{entry.title === null ? t('continued.untitled', { device: entry.device }) : t('continued', { title: entry.title })}</div>
}

/** The words for a refusal, by its code. */
function failureText(error: RemoteFailure, t: ContinueDialogProps['t']): string {
  return error.code === 'session/fork-folder-unavailable' ? t('error.folder') : t('error.failed', { reason: error.message })
}

/** One request's dialog: the folder, in-flight state, and errors die with it. */
function ContinueForm({ sessionId, face, t, title }: {
  sessionId: SessionId
  face: Pick<ContinueDialogProps, 'settleContinue' | 'continueInfo' | 'pickFolder' | 'continueConversation' | 'open'>
  t: ContinueDialogProps['t']
  title: string
}) {
  const { settleContinue, continueInfo, pickFolder, continueConversation, open } = face
  const [busy, setBusy] = useState<'loading' | 'continuing' | 'idle'>('loading')
  const [folder, setFolder] = useState<string | null>(null)
  const [away, setAway] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The copy follows the language without making the folder read run again.
  const copy = useRef(t)
  copy.current = t
  // The dialog is keyed by the Session, so the read on mount is the read of this request; an
  // answer that arrives after the dialog closed changes nothing.
  useEffect(() => {
    let current = true
    void continueInfo(sessionId).then((result) => {
      if (!current) return
      if (result.ok) {
        setFolder(result.value.folderHere ? result.value.folder : null)
        setAway(result.value.folder !== null && !result.value.folderHere)
      } else setError(failureText(result.error, copy.current))
      setBusy('idle')
    })
    return () => { current = false }
  }, [continueInfo, sessionId])
  const submit = (cwd: string): void => {
    setBusy('continuing')
    setError(null)
    void continueConversation(sessionId, cwd).then((result) => {
      if (result.ok) {
        settleContinue()
        open(result.value.sessionId)
        return
      }
      setError(failureText(result.error, t))
      setBusy('idle')
    })
  }
  const working = busy !== 'idle'
  return (
    <Modal
      open
      onClose={() => { if (busy !== 'continuing') settleContinue() }}
      closeLabel={t('close')}
      title={t('dialog.title')}
      description={t('dialog.desc', { title })}
      footer={(
        <>
          <Button variant="outline" disabled={busy === 'continuing'} onClick={settleContinue}>{t('cancel')}</Button>
          <Button variant="primary" disabled={working || folder === null} onClick={folder === null ? undefined : () => { submit(folder) }}>
            {t('continue')}
          </Button>
        </>
      )}
    >
      <div className={css.folderRow}>
        <span className={css.folderLabel}>{t('folder')}</span>
        <span className={css.folderPath} data-session-sync-folder="">{folder ?? t('folder.none')}</span>
        <Button variant="outline" size="sm" disabled={working} onClick={() => {
          pickFolder().then((picked) => {
            if (picked === null) return
            setFolder(picked)
            setError(null)
          }, (failure: unknown) => {
            setError(t('error.failed', { reason: failure instanceof Error ? failure.message : String(failure) }))
          })
        }}>
          {t('folder.pick')}
        </Button>
      </div>
      {away && <div className={css.warning} role="note">{t('folder.away')}</div>}
      {!working && folder === null && <div className={css.warning} role="note">{t('folder.choose')}</div>}
      {working && <div className={css.status} role="status">{t(busy)}</div>}
      {error !== null && <div className={css.error} role="alert">{error}</div>}
    </Modal>
  )
}

/**
 * The `shell.overlay` entry: nothing while no continue is requested, otherwise one dialog per
 * request that offers the original folder (or asks for one here), then continues the conversation
 * and opens the new one.
 * @param props - the request hook, the Remote calls, the picker, navigation, and copy.
 * @returns the open dialog, or null.
 */
export function ContinueDialog({
  useContinueRequest, useSessions, settleContinue, continueInfo, pickFolder, continueConversation, open, t,
}: ContinueDialogProps) {
  const sessionId = useContinueRequest(pending => pending)
  const title = useSessions(state => (sessionId === null ? '' : state.byId[sessionId]?.title ?? ''))
  if (sessionId === null) return null
  const face = { settleContinue, continueInfo, pickFolder, continueConversation, open }
  return <ContinueForm key={sessionId} sessionId={sessionId} face={face} t={t} title={title === '' ? t('dialog.untitled') : title} />
}
