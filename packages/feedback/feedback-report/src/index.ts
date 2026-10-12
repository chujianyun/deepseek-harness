/**
 * Problem reports for Desktop: the user's category, description, and images, the environment this
 * Host sees, and optionally a Session's conversation snapshot, posted to the user center of the
 * current Hub sign-in for its super administrators. Thumbs-down feedback with a category or note
 * is reported the same way.
 *
 * @module @deepseek-ai/dsh-feedback-report
 */

import { arch, platform, release } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/types'
import type {} from '@deepseek-ai/dsh-assistants'
import { brandString } from '@deepseek-ai/dsh-brand'
import { userCenterRefusal } from '@deepseek-ai/dsh-hub-account'
import type { MessageFeedbackItem } from '@deepseek-ai/dsh-message-feedback'
import type {} from '@deepseek-ai/dsh-session-title'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-session-query'
import { buildShareSnapshot } from '@deepseek-ai/dsh-session-share'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import Schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import type { FeedbackReportId, FeedbackReportImage, FeedbackReportReceipt, FeedbackReportRequest } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Problem reports to the user center, and their Remote namespace. */
    feedbackReport: FeedbackReport
  }
}

/** Deployment configuration. */
export interface Config {
  /** Version of the Desktop client, shown to administrators. */
  appVersion?: string
  /** Deadline of each report request, in milliseconds. */
  requestTimeoutMs?: number
}

/** Validated deployment configuration. */
export const Config: Schema<Config> = Schema.object({
  appVersion: Schema.string().description('Version of the Desktop client, shown to administrators.'),
  requestTimeoutMs: Schema.number().min(1).max(600_000).default(120_000).description('Deadline of each report request, in milliseconds.'),
})

/** Limits the user center enforces, checked here first so the user gets the reason without an upload. */
const MAX_IMAGES = 3
const IMAGE_MAX_BYTES = 5 * 1024 * 1024
const DESCRIPTION_MAX_LENGTH = 2000
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

const receiptSchema = z.object({ id: z.string().min(1), createdAt: z.iso.datetime({ offset: true }) })

/** The user center's refusal, as this service's error. */
async function refusal(res: Response): Promise<RemoteError> {
  const { reason, status } = await userCenterRefusal(res)
  return new RemoteError('feedback-report/refused', reason, { status })
}

/** A thumbs-down with a category or note. */
function explainedDislike(item: MessageFeedbackItem): boolean {
  return item.rating === 'negative' && (item.category !== undefined || item.note !== undefined)
}

/** Longest excerpt of the rated reply a thumbs-down report carries. */
const RATED_REPLY_MAX = 200

/** The text of the assistant message with `messageId`, clipped, or undefined when the log lacks it. */
function replyText(events: readonly SessionEvent[], messageId: string): string | undefined {
  const message = lastOf(events, event => event.type === 'assistant/message' && event.data.message.id === messageId ? event.data.message : undefined)
  if (message === undefined) return undefined
  const text = message.content.flatMap(block => block.type === 'text' ? [block.text.trim()] : []).join(' ').replaceAll(/\s+/gu, ' ')
  const points = Array.from(text)
  return points.length <= RATED_REPLY_MAX ? text : `${points.slice(0, RATED_REPLY_MAX - 1).join('')}…`
}

/** The Session's title and conversation snapshot, or null when it has no conversation. */
function snapshotOf(sessionId: SessionId, events: readonly SessionEvent[]) {
  const messages = buildShareSnapshot(events)
  if (messages.length === 0) return null
  const title = lastOf(events, event => event.type === 'session/title' ? event.data.title : undefined)
  return { sessionId, title: title ?? '', messages }
}

/** The last value `read` finds in the log, or undefined. */
function lastOf<T>(events: readonly SessionEvent[], read: (event: SessionEvent) => T | undefined): T | undefined {
  let found: T | undefined
  for (const event of events) found = read(event) ?? found
  return found
}

/** Host owner of problem reports and of the `feedbackReport` Remote namespace. */
export class FeedbackReport extends TypertRemoteService {
  static inject = ['hubAccount', 'sessionQuery']
  static Config = Config

  private readonly config: Pick<Config, 'appVersion'> & { requestTimeoutMs: number }

  /** @param ctx - Host with the Hub sign-in and Session reads. @param config - client version and request deadline. */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'feedbackReport', { namespace: 'feedbackReport' })
    this.config = Config(config) as Pick<Config, 'appVersion'> & { requestTimeoutMs: number }
    // Thumbs-down feedback the user explained is a report too, once: editing an explained
    // thumbs-down does not report it again, and plain ratings are not reported.
    ctx.on('feedback/message-recorded', (sessionId, item, previous) => {
      if (!explainedDislike(item) || (previous !== undefined && explainedDislike(previous))) return
      void this.reportMessage(sessionId, item).catch((error: unknown) => {
        // The rating is recorded in the Session either way; only its copy for the administrators is lost.
        console.info('[feedback-report] thumbs-down feedback not reported', { sessionId, error: String(error) })
      })
    })
  }

  /**
   * Report a problem to the super administrators of the user center.
   * @param request - category, description, images, and the Session it is about.
   * @returns the stored report.
   * @throws RemoteError `feedback-report/signed-out`, `feedback-report/invalid` (`reason` names the
   *   broken limit), `feedback-report/refused` (the user center's reason), or `feedback-report/unreachable`.
   */
  @Remote
  async submit(request: FeedbackReportRequest): Promise<FeedbackReportReceipt> {
    const description = request.description.trim()
    if (description === '' || description.length > DESCRIPTION_MAX_LENGTH) {
      throw new RemoteError('feedback-report/invalid', `the description must be 1 to ${String(DESCRIPTION_MAX_LENGTH)} characters`, { reason: 'description' })
    }
    const images = request.images.map(image => this.decode(image))
    if (images.length > MAX_IMAGES) throw new RemoteError('feedback-report/invalid', `at most ${String(MAX_IMAGES)} images`, { reason: 'images' })
    return this.send({
      source: 'report', category: request.category, description, sessionId: request.sessionId ?? null,
      attachSession: request.attachSession, uiLanguage: request.uiLanguage,
    }, images)
  }

  /**
   * Report thumbs-down feedback the user explained, with the Session it belongs to and an excerpt
   * of the rated reply. The rating dialog tells the user the conversation is included.
   */
  private async reportMessage(sessionId: SessionId, item: MessageFeedbackItem) {
    return this.send({
      source: 'message', category: item.category ?? 'other',
      description: item.note === undefined ? '（未填写说明）' : item.note.slice(0, DESCRIPTION_MAX_LENGTH),
      sessionId, attachSession: true, ratedMessageId: item.messageId,
    }, [])
  }

  private decode(image: FeedbackReportImage): { name: string; contentType: string; bytes: Buffer } {
    if (!IMAGE_TYPES.has(image.contentType)) {
      throw new RemoteError('feedback-report/invalid', 'only PNG, JPEG, WebP, and GIF images', { reason: 'image-type' })
    }
    const bytes = Buffer.from(image.data, 'base64')
    if (bytes.length === 0 || bytes.length > IMAGE_MAX_BYTES) {
      throw new RemoteError('feedback-report/invalid', 'each image must be at most 5 MB', { reason: 'image-size' })
    }
    return { name: image.name, contentType: image.contentType, bytes }
  }

  private async send(
    report: {
      source: 'report' | 'message'
      category: string
      description: string
      sessionId: SessionId | null
      attachSession: boolean
      uiLanguage?: string | undefined
      ratedMessageId?: string
    },
    images: readonly { name: string; contentType: string; bytes: Buffer }[],
  ): Promise<FeedbackReportReceipt> {
    const state = await this.ctx.hubAccount.getState()
    if (state.status !== 'signed-in') throw new RemoteError('feedback-report/signed-out', 'sign in to the user center before reporting', {})
    const events = report.sessionId === null ? [] : await this.readEvents(report.sessionId)
    const rated = report.ratedMessageId === undefined ? undefined : replyText(events, report.ratedMessageId)
    const environment: Record<string, string> = {
      ...this.config.appVersion === undefined ? {} : { appVersion: this.config.appVersion },
      os: `${platform()} ${release()}`,
      arch: arch(),
      ...report.uiLanguage === undefined ? {} : { locale: report.uiLanguage },
      ...await this.sessionEnvironment(events),
      ...rated === undefined ? {} : { ratedReply: rated },
      ...state.profile?.tenantName ? { tenant: state.profile.tenantName } : {},
    }
    const session = report.sessionId === null || !report.attachSession ? null : snapshotOf(report.sessionId, events)
    const payload = { source: report.source, category: report.category, description: report.description, environment, session }
    const res = await this.post(payload, images)
    if (res.status === 413 && session !== null) {
      // The conversation is over the user center's limit: the report still goes, without it.
      await res.body?.cancel()
      return this.receipt(await this.post({ ...payload, environment: { ...environment, sessionOmitted: 'too-large' }, session: null }, images))
    }
    return this.receipt(res)
  }

  /** The Session's log, or an empty one when it cannot be read: the report goes either way. */
  private async readEvents(sessionId: SessionId): Promise<readonly SessionEvent[]> {
    try {
      return (await this.ctx.sessionQuery.readSession(sessionId)).events
    } catch (error: unknown) {
      console.info('[feedback-report] Session not readable; reporting without it', { sessionId, error: String(error) })
      return []
    }
  }

  /** One report request; a transport failure reads as `feedback-report/unreachable`. */
  private async post(payload: object, images: readonly { name: string; contentType: string; bytes: Buffer }[]): Promise<Response> {
    const form = new FormData()
    form.set('payload', JSON.stringify(payload))
    for (const image of images) form.append('images', new Blob([new Uint8Array(image.bytes)], { type: image.contentType }), image.name)
    try {
      return await this.ctx.hubAccount.request('/api/client/feedback', { method: 'POST', body: form, signal: AbortSignal.timeout(this.config.requestTimeoutMs) })
    } catch (error: unknown) {
      if (error instanceof RemoteError && error.code === 'hub-account/signed-out') {
        throw new RemoteError('feedback-report/signed-out', 'sign in to the user center before reporting', {}, { cause: error })
      }
      throw new RemoteError('feedback-report/unreachable', 'the user center cannot be reached', {}, { cause: error })
    }
  }

  private async receipt(res: Response): Promise<FeedbackReportReceipt> {
    if (!res.ok) throw await refusal(res)
    const parsed = receiptSchema.safeParse(await res.json().catch(() => undefined))
    if (!parsed.success) throw new RemoteError('feedback-report/refused', 'the user center answered an unreadable receipt', { status: res.status })
    return { id: brandString<FeedbackReportId>(parsed.data.id), createdAt: parsed.data.createdAt }
  }

  /** The model and assistant the Session last recorded. */
  private async sessionEnvironment(events: readonly SessionEvent[]): Promise<Record<string, string>> {
    // An explicit selection, or the model a request was sent to when the Session kept the default; the latest wins.
    const model = lastOf(events, (event): { provider: string; model: string; reasoningEffort?: string } | undefined => {
      if (event.type === 'model/selection') return event.data
      return event.type === 'request/context' ? { provider: event.data.provider, model: event.data.model } : undefined
    })
    const assistantId = lastOf(events, event => event.type === 'assistant/selected' ? event.data.assistantId : undefined)
    const assistants = this.ctx.get('assistants')
    const assistant = assistantId === undefined || assistantId === '' || assistants === undefined
      ? undefined
      : (await assistants.getState()).assistants.find(item => item.id === assistantId)?.name
    return {
      ...model === undefined ? {} : { model: `${model.provider}/${model.model}${model.reasoningEffort === undefined ? '' : ` (${model.reasoningEffort})`}` },
      ...assistant === undefined ? {} : { assistant },
    }
  }
}

export default FeedbackReport
