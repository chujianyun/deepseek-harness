/**
 * Problem report, browser half: a Report a problem button in the Session header, the dialog it
 * opens, and the notice after a report is stored, over the `feedbackReport` Remote. Everything
 * shows only while the `hubAccount` Remote reports a sign-in, and only in the Desktop window.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HubAccountView } from '@deepseek-ai/dsh-hub-account/types'
import { en, zh, type FeedbackReportLocaleKey } from './locales.ts'
import {
  ReportButton, ReportDialog, ReportNotice,
  type ReportButtonInjected, type ReportDialogInjected, type ReportNoticeInjected, type ReportTarget,
} from './ReportDialog.tsx'

export type { FeedbackReportLocaleKey } from './locales.ts'
export type {
  ReportButtonInjected, ReportButtonProps, ReportDialogInjected, ReportDialogProps, ReportNoticeInjected, ReportNoticeProps, ReportTarget,
} from './ReportDialog.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Problem report copy. */
    'feedbackReport': FeedbackReportLocaleKey
  }
}

const NS = 'feedbackReport'

/** Services the surface reads: the slots, the copy, and the sign-in and report Remotes. */
export const inject = ['slots', 'locale', 'remote', 'remote.hubAccount', 'remote.feedbackReport']

/**
 * Register the button, the dialog, and the notice for exactly the plugin lifetime.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  // Desktop only: a browser tab of the same roster has no Hub sign-in of its own.
  if (!('dshDesktop' in globalThis)) return
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-feedback-report: dictionaries')
  const remote = ctx.remote
  const signedIn = createSnapshotStore(false)
  const reportRequest = createSnapshotStore<ReportTarget | null>(null)
  const stream = remote.$stream<HubAccountView>({
    name: 'feedbackReport.hubAccount', open: signal => remote.hubAccount.watch(signal), ended: () => new Error('hub account stream ended'),
  })
  ctx.effect(() => () => stream.dispose(), 'ui-feedback-report: sign-in stream')
  void (async () => {
    for await (const frame of stream) {
      signedIn.set(frame.value.status === 'signed-in')
      frame.accept()
    }
  })().catch(() => {
    // The stream reconnects on its own; a disposed plugin simply stops listening.
  })
  const submitted = createSnapshotStore(0)
  const buttonFace: ReportButtonInjected = { hooks: { signedIn }, requestReport: (target) => { reportRequest.set(target) } }
  const dialogFace: ReportDialogInjected = {
    hooks: { reportRequest },
    settleReport: () => { reportRequest.set(null) },
    submit: request => remote.feedbackReport.submit(request),
    notifySubmitted: () => { submitted.set(submitted.getSnapshot() + 1) },
    uiLanguage: () => ctx.locale.getSnapshot().active,
  }
  const noticeFace: ReportNoticeInjected = { hooks: { submitted }, dismissNotice: () => { submitted.set(0) } }
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    // Left of the schedule catalog (-5).
    name: 'conversation.session.header.utilities', id: 'feedback-report', order: -8, locale: NS, inject: () => buttonFace,
  }, ReportButton))
  ctx.slots.inject('shell.overlay', function* () {
    yield ctx.slots.register({ name: 'shell.overlay', id: 'feedback-report', locale: NS, inject: () => dialogFace }, ReportDialog)
    yield ctx.slots.register({ name: 'shell.overlay', id: 'feedback-report.notice', locale: NS, inject: () => noticeFace }, ReportNotice)
  })
}
