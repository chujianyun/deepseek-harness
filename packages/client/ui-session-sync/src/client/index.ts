/**
 * Conversations from other computers, browser half: marks their sidebar rows, names the computer in
 * the row's hover card, and replaces the composer of an open one with a view-only notice, over the
 * `sessionSync` Remote. Bringing the window back to the front asks the Host to pull now, and a
 * change in the pulled conversations reloads the Session list.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { ComposerChainProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionSyncView } from '@deepseek-ai/dsh-session-sync/client'
import { en, NS, zh, type SessionSyncLocaleKey } from './locales.ts'
import {
  PulledBadge, PulledComposer, PulledHover, type PulledComposerMatch, type PulledDevices, type PulledRowInjected,
} from './SessionSync.tsx'

export type { SessionSyncLocaleKey } from './locales.ts'
export type {
  PulledBadgeProps, PulledComposerMatch, PulledComposerProps, PulledDevices, PulledHoverProps, PulledRowInjected,
} from './SessionSync.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy for conversations from other computers. */
    'sessionSync': SessionSyncLocaleKey
  }
}

/** Services the feature reads: the slots, the copy, the Session list, and the sync Remote. */
export const inject = ['slots', 'locale', 'sessions', 'remote', 'remote.sessionSync']

/** The pulled conversations of a state, by top-level Session. */
function devicesOf(view: SessionSyncView): PulledDevices {
  return Object.fromEntries(view.pulled.map(item => [item.sessionId, item.device]))
}

/**
 * Register the row mark, the hover line, and the composer for exactly the plugin lifetime.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  // Desktop only: a browser tab of the same roster has no Hub sign-in of its own.
  if (!('dshDesktop' in globalThis)) return
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-session-sync: dictionaries')
  const remote = ctx.remote
  const pulled = createSnapshotStore<PulledDevices>({})
  const stream = remote.$stream<SessionSyncView>({
    name: 'sessionSync.watch', open: signal => remote.sessionSync.watch(signal), ended: () => new Error('session sync stream ended'),
  })
  ctx.effect(() => () => stream.dispose(), 'ui-session-sync: pulled stream')
  let changes: number | undefined
  let revisions: Readonly<Record<string, number>> = {}
  void (async () => {
    for await (const frame of stream) {
      const view = frame.value
      pulled.set(devicesOf(view))
      frame.accept()
      const seen = changes
      const previous = revisions
      changes = view.changes
      revisions = Object.fromEntries(view.pulled.map(item => [item.sessionId, item.revision]))
      // The sync writes and removes logs behind the list's back; reload it so rows appear, change,
      // and leave, and read the projections of new or newer pulled rows from their logs, since the
      // Host's cache may not hold them yet.
      if (seen === undefined || seen === view.changes) continue
      const renewed = view.pulled.filter(item => previous[item.sessionId] !== item.revision).map(item => item.sessionId)
      void ctx.sessions.refresh().then(() => Promise.all(renewed.map(id => ctx.sessions.refreshProjections(id))))
    }
  })().catch(() => {
    // The stream reconnects on its own; a disposed plugin simply stops listening.
  })
  ctx.effect(() => {
    const pullNow = () => { if (document.visibilityState === 'visible') void remote.sessionSync.refresh() }
    window.addEventListener('focus', pullNow)
    document.addEventListener('visibilitychange', pullNow)
    return () => {
      window.removeEventListener('focus', pullNow)
      document.removeEventListener('visibilitychange', pullNow)
    }
  }, 'ui-session-sync: pull on focus')
  const rowFace: PulledRowInjected = { hooks: { pulled } }
  ctx.slots.inject('sidebar.session.row.badge', () => ctx.slots.register({
    name: 'sidebar.session.row.badge', id: 'session-sync-badge', order: 20, locale: NS, inject: () => rowFace,
  }, PulledBadge))
  ctx.slots.inject('sidebar.session.row.hover', () => ctx.slots.register({
    name: 'sidebar.session.row.hover', id: 'session-sync-hover', order: 6, locale: NS, inject: () => rowFace,
  }, PulledHover))
  const selectPulled = (owner: ComposerChainProps): PulledComposerMatch | null => {
    const device = owner.sessionId === undefined ? undefined : pulled.getSnapshot()[owner.sessionId]
    return device === undefined ? null : { device }
  }
  ctx.slots.inject('conversation.composer', () => ctx.slots.register({
    name: 'conversation.composer', priority: -5, locale: NS, select: selectPulled,
  }, PulledComposer))
}
