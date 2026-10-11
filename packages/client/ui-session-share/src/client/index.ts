/**
 * Share session action, browser half: adds **Share session** to a Session row's menu and the dialog
 * it opens, over the `sessionShare` Remote. The row shows only while the `hubAccount` Remote
 * reports a sign-in.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HubAccountView } from '@deepseek-ai/dsh-hub-account/types'
import { en, zh, type SessionShareLocaleKey } from './locales.ts'
import {
  SessionShareDialog, ShareSessionMenuItem, type SessionShareDialogInjected, type ShareSessionInjected,
} from './ShareSession.tsx'
import type { SessionShareRequest } from '@deepseek-ai/dsh-session-share/client'

export type { SessionShareLocaleKey } from './locales.ts'
export type {
  SessionShareDialogInjected, SessionShareDialogProps, ShareSessionInjected, ShareSessionMenuItemProps,
} from './ShareSession.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Share session copy. */
    'sessionShare': SessionShareLocaleKey
  }
}

const NS = 'sessionShare'

/** Services the action reads: the slots, the copy, and the sign-in and share Remotes. */
export const inject = ['slots', 'locale', 'remote', 'remote.hubAccount', 'remote.sessionShare']

/**
 * Register the menu row and the dialog for exactly the plugin lifetime.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  // Desktop only: a browser tab of the same roster has no Hub sign-in of its own.
  if (!('dshDesktop' in globalThis)) return
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-session-share: dictionaries')
  const remote = ctx.remote
  const signedIn = createSnapshotStore(false)
  const stream = remote.$stream<HubAccountView>({
    name: 'sessionShare.hubAccount', open: signal => remote.hubAccount.watch(signal), ended: () => new Error('hub account stream ended'),
  })
  ctx.effect(() => () => stream.dispose(), 'ui-session-share: sign-in stream')
  void (async () => {
    for await (const frame of stream) {
      signedIn.set(frame.value.status === 'signed-in')
      frame.accept()
    }
  })().catch(() => {
    // The stream reconnects on its own; a disposed plugin simply stops listening.
  })
  const shareRequest = createSnapshotStore<SessionShareRequest | null>(null)
  const rowFace: ShareSessionInjected = {
    hooks: { signedIn },
    requestSessionShare: (target) => { shareRequest.set(target) },
  }
  const dialogFace: SessionShareDialogInjected = {
    hooks: { shareRequest },
    settleSessionShare: () => { shareRequest.set(null) },
    loadStatus: sessionId => remote.sessionShare.status({ sessionId }),
    share: target => remote.sessionShare.share(target),
    revoke: sessionId => remote.sessionShare.revoke({ sessionId }),
    copyLink: writeClipboard,
  }
  ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
    name: 'sidebar.workspaces.session.menu.item', id: 'share', order: 350, locale: NS, inject: () => rowFace,
  }, ShareSessionMenuItem))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'session-share', locale: NS, inject: () => dialogFace,
  }, SessionShareDialog))
}
