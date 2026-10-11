/**
 * Pure types of problem reports: the `feedbackReport` Remote's request and result and its error
 * details. Free of host-side value imports, so `./types` serves Host consumers and `./client`
 * re-exports it for Client code.
 *
 * @module @deepseek-ai/dsh-feedback-report/types
 */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** Reporting needs a user-center sign-in, and there is none. */
    'feedback-report/signed-out': Record<never, never>
    /** The report breaks a limit this service checks before sending; `reason` names it. */
    'feedback-report/invalid': { readonly reason: 'description' | 'images' | 'image-type' | 'image-size' }
    /** The user center refused the report; `status` is its HTTP status and the message its own text. */
    'feedback-report/refused': { readonly status: number }
    /** The user center could not be reached. */
    'feedback-report/unreachable': Record<never, never>
  }
}

/** Kinds of problem the problem-report form offers. */
export type FeedbackReportCategory = 'error' | 'lag' | 'unavailable' | 'wrong-result' | 'other'

/** Id of a report on the user center. */
export type FeedbackReportId = Branded<'FeedbackReportId'>

/** One image of a report, as the browser read it. */
export interface FeedbackReportImage {
  /** File name shown to administrators. */
  readonly name: string
  /** `image/png`, `image/jpeg`, `image/webp`, or `image/gif`. */
  readonly contentType: string
  /** The image bytes, base64. */
  readonly data: string
}

/** A problem report. */
export interface FeedbackReportRequest {
  readonly category: FeedbackReportCategory
  /** What happened, as the user wrote it; required after trimming. */
  readonly description: string
  /** The Session the report is about; environment details are read from it when given. */
  readonly sessionId?: SessionId | null
  /** Send the Session's conversation snapshot with the report. */
  readonly attachSession: boolean
  /** At most three images. */
  readonly images: readonly FeedbackReportImage[]
  /** The UI language the user sees, as a BCP 47 tag. */
  readonly uiLanguage?: string
}

/** The stored report. */
export interface FeedbackReportReceipt {
  readonly id: FeedbackReportId
  /** ISO 8601 time the user center stored it. */
  readonly createdAt: string
}
