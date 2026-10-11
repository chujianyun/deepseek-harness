/**
 * The problem report: the header's Report a problem button, and the `shell.overlay` dialog that
 * collects the type, description, and screenshots and sends them over the `feedbackReport` Remote.
 */
import clsx from 'clsx'
import { useEffect, useRef, useState, type ClipboardEvent } from 'react'
import {
  Button, Checkbox, IconCloseOutlineRegular, IconPlusOutlineRegular, IconQuestionOutlineRegular, IconWarningTriangleOutlineRegular,
  Modal, Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { HostObservable, InjectFace, PropsHooks, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { FeedbackReportCategory, FeedbackReportImage, FeedbackReportReceipt, FeedbackReportRequest } from '@deepseek-ai/dsh-feedback-report/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { FeedbackReportLocaleKey } from './locales.ts'
import css from './ReportDialog.module.css'

/** The categories in the order the dialog offers them. */
export const REPORT_CATEGORIES: readonly FeedbackReportCategory[] = ['error', 'lag', 'unavailable', 'wrong-result', 'other']
/** Limits the Host and the user center enforce, checked before sending. */
const MAX_IMAGES = 3
const IMAGE_MAX_BYTES = 5 * 1024 * 1024
const DESCRIPTION_MAX_LENGTH = 2000
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** A report the button or the menu asked for: the Session it is about, if any. */
export interface ReportTarget {
  readonly sessionId: SessionId | null
}

/** Header button share: whether a sign-in exists, and the request the button raises. */
export interface ReportButtonInjected {
  hooks: {
    /** A user-center sign-in exists; the button hides without one. */
    signedIn: HostObservable<boolean>
  }
  /** Ask for the report dialog. */
  requestReport: (target: ReportTarget) => void
}

/** Dialog share: the pending request, its settlement, the submission, and the notice after it. */
export interface ReportDialogInjected {
  hooks: {
    /** The report asked for, until the dialog closes. */
    reportRequest: HostObservable<ReportTarget | null>
  }
  /** Close the dialog. */
  settleReport: () => void
  /** Send the report. */
  submit: (request: FeedbackReportRequest) => Promise<RemoteResult<FeedbackReportReceipt>>
  /** Thank the user once the report is stored. */
  notifySubmitted: () => void
  /** The UI language, sent with the report. */
  uiLanguage: () => string
}

/** Notice share: the count of reports stored so far, and its dismissal. */
export interface ReportNoticeInjected {
  hooks: {
    /** Grows with every stored report; 0 shows nothing. */
    submitted: HostObservable<number>
  }
  /** Take the notice down. */
  dismissNotice: () => void
}

/** Props of the notice entry. */
export type ReportNoticeProps = PropsRuntime<'shell.overlay'> & PropsLocale<'feedbackReport'> & InjectFace<ReportNoticeInjected>

/**
 * The `shell.overlay` notice that thanks the user after a report is stored.
 * @param props - the submission count hook, its dismissal, and the locale seat.
 * @returns the notice, or null.
 */
export function ReportNotice({ useSubmitted, dismissNotice, t }: ReportNoticeProps) {
  const submitted = useSubmitted(count => count)
  if (submitted === 0) return null
  return <Toast key={submitted} text={t('submitted')} tone="success" onDone={dismissNotice} />
}

/** Props of the header button. */
export type ReportButtonProps =
  PropsRuntime<'conversation.session.header.utilities'>
  & PropsLocale<'feedbackReport'>
  & Omit<ReportButtonInjected, 'hooks'>
  & PropsHooks<ReportButtonInjected['hooks']>

/** Props of the dialog entry. */
export type ReportDialogProps = PropsRuntime<'shell.overlay'> & PropsLocale<'feedbackReport'> & InjectFace<ReportDialogInjected>

type Translate = ReportDialogProps['t']

/**
 * Header utility: ask for the report dialog about the open Session. Renders nothing without a sign-in.
 * @param props - the Session, the sign-in hook, and the request.
 * @returns the button, or null.
 */
export function ReportButton({ sessionId, useSignedIn, requestReport, t }: ReportButtonProps) {
  const signedIn = useSignedIn(value => value)
  if (!signedIn) return null
  return (
    <button type="button" className={css.trigger} onClick={() => { requestReport({ sessionId }) }}>
      <IconQuestionOutlineRegular size={16} />
      <span>{t('button')}</span>
    </button>
  )
}

/**
 * The `shell.overlay` entry: nothing while no report is asked for, otherwise one dialog per request.
 * @param props - the request hook, its settlement, the submission, and the locale seat.
 * @returns the open dialog, or null.
 */
export function ReportDialog({ useReportRequest, t, ...face }: ReportDialogProps) {
  const request = useReportRequest(pending => pending)
  if (request === null) return null
  return <ReportForm key={String(request.sessionId)} target={request} face={face} t={t} />
}

/** One screenshot the user added. */
interface Shot extends FeedbackReportImage {
  readonly preview: string
}

/** Read an image file the user picked or pasted, or say why it cannot be sent. */
function readImage(file: File): Promise<Shot | FeedbackReportLocaleKey> {
  if (!IMAGE_TYPES.has(file.type)) return Promise.resolve('images.badType')
  if (file.size > IMAGE_MAX_BYTES) return Promise.resolve('images.tooLarge')
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => {
      // readAsDataURL always answers with a string.
      const preview = reader.result as string
      resolve({ name: file.name, contentType: file.type, data: preview.slice(preview.indexOf(',') + 1), preview })
    }
    reader.onerror = () => { resolve('images.badType') }
    reader.readAsDataURL(file)
  })
}

/** The words for a refusal, by its code. */
function failureText(error: RemoteFailure, t: Translate): string {
  switch (error.code) {
    case 'feedback-report/signed-out': return t('error.signedOut')
    case 'feedback-report/unreachable': return t('error.unreachable')
    case 'feedback-report/refused': return t('error.refused', { reason: error.message })
    default: return t('error.failed', { reason: error.message })
  }
}

/** One request's form: the draft, the screenshots, and the submission die with it. */
function ReportForm({ target, face, t }: { target: ReportTarget; face: Omit<ReportDialogProps, 'useReportRequest' | 't'>; t: Translate }) {
  const { settleReport, submit, notifySubmitted, uiLanguage } = face
  const [category, setCategory] = useState<FeedbackReportCategory | null>(null)
  const [description, setDescription] = useState('')
  const [shots, setShots] = useState<readonly Shot[]>([])
  // The conversation goes to the platform's administrators only when the user ticks the box.
  const [attach, setAttach] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const picker = useRef<HTMLInputElement>(null)
  // Slots taken by screenshots shown or still being read, so adds that overlap cannot overfill.
  const taken = useRef(0)
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])

  const add = async (files: readonly File[]): Promise<void> => {
    if (files.length === 0) return
    setError(null)
    const chosen = files.slice(0, MAX_IMAGES - taken.current)
    if (chosen.length < files.length) setError(t('images.tooMany'))
    taken.current += chosen.length
    const read = await Promise.all(chosen.map(readImage))
    const problem = read.find((item): item is FeedbackReportLocaleKey => typeof item === 'string')
    if (problem !== undefined) setError(t(problem))
    const accepted = read.filter((item): item is Shot => typeof item !== 'string')
    taken.current -= chosen.length - accepted.length
    setShots(current => [...current, ...accepted])
  }
  const onPaste = (event: ClipboardEvent<HTMLDivElement>): void => {
    const files = Array.from(event.clipboardData.files).filter(file => file.type.startsWith('image/'))
    if (files.length === 0) return
    event.preventDefault()
    void add(files)
  }
  const ready = category !== null && description.trim() !== '' && !sending
  // Submit is disabled until the report is ready, so a click always sends a complete one.
  const send = (): void => {
    setSending(true)
    setError(null)
    void submit({
      category: category as FeedbackReportCategory, description, sessionId: target.sessionId,
      attachSession: attach && target.sessionId !== null,
      images: shots.map(({ name, contentType, data }) => ({ name, contentType, data })), uiLanguage: uiLanguage(),
    }).then((result) => {
      if (!mounted.current) return
      setSending(false)
      if (!result.ok) {
        setError(failureText(result.error, t))
        return
      }
      settleReport()
      notifySubmitted()
    })
  }
  const close = (): void => { if (!sending) settleReport() }

  return (
    <Modal open headless onClose={close} title={t('title')} className={clsx(css.dialog)}>
      <div onPaste={onPaste}>
        <div className={css.header}>
          <span className={css.badge}><IconWarningTriangleOutlineRegular size={20} /></span>
          <div>
            <h2 className={css.title}>{t('title')}</h2>
            <p className={css.subtitle}>{t('subtitle')}</p>
          </div>
          <button type="button" className={css.close} aria-label={t('close')} disabled={sending} onClick={close}>
            <IconCloseOutlineRegular size={16} />
          </button>
        </div>
        <div className={css.body}>
          <fieldset className={css.field}>
            <legend className={css.label}>{t('category')}</legend>
            <div className={css.chips} role="radiogroup" aria-label={t('category')}>
              {REPORT_CATEGORIES.map(value => (
                <button
                  key={value} type="button" role="radio" aria-checked={category === value} className={css.chip} disabled={sending}
                  onClick={() => { setCategory(value) }}
                >
                  {t(`category.${value}`)}
                </button>
              ))}
            </div>
          </fieldset>
          <label className={css.field}>
            <span className={css.label}>{t('description')}</span>
            <textarea
              className={css.textarea} value={description} maxLength={DESCRIPTION_MAX_LENGTH} disabled={sending}
              aria-label={t('description')} placeholder={t('description.placeholder')} data-modal-autofocus
              onChange={(event) => { setDescription(event.target.value) }}
            />
            <span className={css.counter}>{description.length}/{DESCRIPTION_MAX_LENGTH}</span>
          </label>
          <div className={css.field}>
            <span className={css.label}>{t('images')}</span>
            <div className={css.images}>
              {shots.map((shot, index) => (
                <div key={index} className={css.thumb}>
                  <img src={shot.preview} alt={shot.name} />
                  <button
                    type="button" className={css.remove} aria-label={t('images.remove', { name: shot.name })} disabled={sending}
                    onClick={() => {
                      taken.current -= 1
                      setShots(current => current.filter((_, at) => at !== index))
                    }}
                  >
                    <IconCloseOutlineRegular size={12} />
                  </button>
                </div>
              ))}
              {shots.length < MAX_IMAGES && (
                <button type="button" className={css.add} disabled={sending} onClick={() => { picker.current?.click() }}>
                  <IconPlusOutlineRegular size={16} />
                  <span>{t('images.add')}</span>
                </button>
              )}
            </div>
            <span className={css.hint}>{t('images.hint')}</span>
            <input
              ref={picker} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden aria-label={t('images.add')}
              onChange={(event) => {
                // A file input always carries a FileList once it changed.
                void add(Array.from(event.target.files as FileList))
                event.target.value = ''
              }}
            />
          </div>
          {target.sessionId !== null && <Checkbox checked={attach} disabled={sending} onChange={setAttach} label={t('attach')} />}
          {sending && <div className={css.status} role="status">{t('submitting')}</div>}
          {error !== null && <div className={css.error} role="alert">{error}</div>}
        </div>
        <div className={css.footer}>
          <span className={css.environment}>{t('environment')}</span>
          <Button variant="outline" disabled={sending} onClick={close}>{t('cancel')}</Button>
          <Button variant="primary" disabled={!ready} onClick={send}>{t('submit')}</Button>
        </div>
      </div>
    </Modal>
  )
}
