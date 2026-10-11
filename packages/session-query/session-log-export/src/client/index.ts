/** Browser plugin owning Session export download state and its shared modal. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-commands/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-message-feedback/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SessionLogDownloadController } from './controller.ts'
import { SessionLogDownloadHeaderAction, type SessionLogDownloadHeaderInjected } from './HeaderAction.tsx'
import { en, NS, zh, type SessionLogDownloadKey } from './locales.ts'

/**
 * A plugin that takes over the Header menu's Feedback row: while one is provided as
 * `sessionFeedbackEntry`, the row opens it instead of the message-feedback dialog.
 */
export interface SessionFeedbackEntry {
  /**
   * Open the plugin's feedback surface for the Session.
   * @param sessionId - the Session the header menu belongs to.
   */
  open(sessionId: SessionId): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The Feedback row's replacement surface, when a plugin provides one. */
    sessionFeedbackEntry: SessionFeedbackEntry
    sessionLogDownload: SessionLogDownloadController
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'session-log-download': SessionLogDownloadKey
  }
}

export type { SessionLogDownloadEntry, SessionLogDownloadState } from './controller.ts'

export const inject = ['slots', 'locale']

/**
 * Provide the download controller and mount its modal into the Session Header.
 * @param ctx - browser context carrying slots and locale services.
 */
export function apply(ctx: ClientContext): void {
  const controller = new SessionLogDownloadController()
  ctx.provide('sessionLogDownload', controller)
  ctx.effect(() => async () => { await controller.dispose() }, 'session-log-download: browser download lifecycle')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-log-download: browser dictionaries')
  const feedbackAvailable = createSnapshotStore(false)
  // The row shows while either surface is mounted.
  let feedbackSurfaces = 0
  for (const service of ['feedbackUi', 'sessionFeedbackEntry'] as const) {
    ctx.inject([service], (scope: ClientContext) => {
      scope.effect(() => {
        feedbackAvailable.set(++feedbackSurfaces > 0)
        return () => { feedbackAvailable.set(--feedbackSurfaces > 0) }
      }, `session-log-download: ${service} availability`)
    })
  }
  ctx.on('command/executed', (sessionId, commandName, result) => {
    if (commandName === 'export' && result.kind === 'success') void controller.download(sessionId)
  })
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'session-log-download',
    locale: NS,
    inject: (): SessionLogDownloadHeaderInjected => ({
      hooks: { sessionLogDownload: controller.store, feedbackAvailable },
      request: (sessionId: SessionId) => controller.download(sessionId),
      dismiss: (sessionId: SessionId) => { controller.dismiss(sessionId) },
      // The feedback plugins can unload between the menu render and this click.
      openFeedback: (sessionId: SessionId) => {
        const entry = ctx.get('sessionFeedbackEntry')
        if (entry !== undefined) entry.open(sessionId)
        else ctx.get('feedbackUi')?.openSession(sessionId)
      },
    }),
  }, SessionLogDownloadHeaderAction))
}

export type { SessionLogDownloadDialogInjected, SessionLogDownloadDialogProps } from './Dialog.tsx'
