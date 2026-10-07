/**
 * Knowledge page, browser half: the **Knowledge** entry of the Desktop sidebar and the page it
 * opens in the main column, where the signed-in tenant's knowledge bases are created, renamed,
 * deleted, and filled with files. State streams from the `knowledgeBases` Remote; the embedding
 * models offered for a new knowledge base stream from the `embedding` Remote.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { EmbeddingState } from '@deepseek-ai/dsh-embedding/types'
import type { KnowledgeState } from '@deepseek-ai/dsh-knowledge-base/types'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { citationsDefinition } from './citations.ts'
import { createKnowledgeSource } from './knowledge-source.ts'
import { KnowledgeCitationsCard, type KnowledgeCitationsInjected } from './KnowledgeCitations.tsx'
import { KnowledgePicker, type KnowledgePickerInjected } from './KnowledgePicker.tsx'
import { KnowledgePage } from './KnowledgePage.tsx'
import { KnowledgePanelIcon } from './KnowledgePanelIcon.tsx'
import { en, zh, type KnowledgeLocaleKey } from './locales.ts'

export type { KnowledgeDependencies, KnowledgeFailure, KnowledgeInjected, KnowledgeRecall, KnowledgeSnapshot } from './knowledge-source.ts'
export type { KnowledgeLocaleKey } from './locales.ts'
export type { KnowledgePageProps } from './KnowledgePage.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Knowledge page copy. */
    'knowledge': KnowledgeLocaleKey
  }
}

const NS = 'knowledge'
const PANEL_ID = 'knowledge' as MainPanelId
const PICKER_ID = '@deepseek-ai/dsh-client-ui-knowledge/picker'
const CITATIONS_ID = '@deepseek-ai/dsh-client-ui-knowledge/citations'

/** Services the page reads: the `knowledgeBases` and `embedding` Remotes and the layout slots. */
export const inject = ['slots', 'locale', 'remote', 'remote.knowledgeBases', 'remote.embedding', 'remote.knowledgeSelection', 'sessions', 'uiConversation']

/**
 * Contribute the Knowledge sidebar entry, below Skills, and the page it opens, in the Desktop renderer.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  // Desktop only: knowledge bases live on this machine, beside the Hub sign-in that scopes them.
  if (!('dshDesktop' in globalThis)) return
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-knowledge: dictionaries')
  const t = ctx.locale.bind(NS)
  const remote = ctx.remote.knowledgeBases
  const source = createKnowledgeSource({
    createBase: (name, model) => remote.createBase(name, model),
    renameBase: (id, name) => remote.renameBase(id, name),
    deleteBase: id => remote.deleteBase(id),
    addFiles: (id, paths) => remote.addFiles(id, paths),
    reprocessItem: (id, itemId) => remote.reprocessItem(id, itemId),
    deleteItem: (id, itemId) => remote.deleteItem(id, itemId),
    updateSettings: (id, patch) => remote.updateSettings(id, patch),
    reprocessAll: id => remote.reprocessAll(id),
    recall: (id, query) => remote.recall(id, query),
    addFolder: (id, path) => remote.addFolder(id, path),
    addUrl: (id, url) => remote.addUrl(id, url),
    createNote: (id, title, content) => remote.createNote(id, title, content),
    updateNote: (id, itemId, title, content) => remote.updateNote(id, itemId, title, content),
    getNote: (id, itemId) => remote.getNote(id, itemId),
  })
  const knowledge = ctx.remote.$stream<KnowledgeState>({
    name: 'knowledgeBases', open: signal => remote.watch(signal), ended: () => new Error('knowledge stream ended'),
  })
  const embedding = ctx.remote.$stream<EmbeddingState>({
    name: 'embedding', open: signal => ctx.remote.embedding.watch(signal), ended: () => new Error('embedding stream ended'),
  })
  ctx.effect(() => () => { void knowledge.dispose(); void embedding.dispose() }, 'ui-knowledge: state streams')
  void (async () => {
    for await (const frame of knowledge) { source.publish(frame.value); frame.accept() }
  })().catch(() => {
    // The stream reconnects on its own; a disposed plugin simply stops listening.
  })
  void (async () => {
    for await (const frame of embedding) { source.publishEmbedding(frame.value); frame.accept() }
  })().catch(() => {
    // As above.
  })
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS, inject: () => source }, KnowledgePage))
  ctx.effect(() => ctx.uiConversation.events.register(citationsDefinition), 'ui-knowledge: citations')
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left', id: PICKER_ID, locale: NS,
    inject: (sessionId: SessionId): KnowledgePickerInjected => ({
      hooks: { knowledge: source.hooks.knowledge },
      select: async (baseIds) => {
        const result = await ctx.remote.knowledgeSelection.select(sessionId, baseIds)
        return result.ok ? result.value.applies : { failure: result.error.message }
      },
    }),
  }, KnowledgePicker))
  ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail', id: CITATIONS_ID, locale: NS,
    inject: (sessionId: SessionId): KnowledgeCitationsInjected => {
      const binding = ctx.sessions.binding(sessionId)
      if (binding === undefined) throw new Error(`ui-knowledge: unknown session "${sessionId}"`)
      const chat = ctx.uiConversation.binding(binding).target('chat')
      return {
        keyedHooks: {
          citations: (turn) => {
            const snapshot = chat.getSnapshot()
            if (snapshot === undefined) throw new Error('ui-knowledge: Chat target is unavailable')
            return snapshot.nodes.turnDataSource(Number(turn), 'knowledge-citations')
          },
        },
        openItem: async (citation) => {
          const result = await remote.openItem(citation.knowledgeBaseId, citation.itemId)
          return result.ok
        },
        // The Desktop shell sends a new window's http(s) address to the default browser.
        openUrl: (url) => { globalThis.open(url, '_blank', 'noopener') },
      }
    },
  }, KnowledgeCitationsCard))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: PANEL_ID, order: 6, label: () => t('panel'), locale: NS,
  }, KnowledgePanelIcon))
}
