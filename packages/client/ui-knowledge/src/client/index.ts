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
import { createKnowledgeSource } from './knowledge-source.ts'
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

/** Services the page reads: the `knowledgeBases` and `embedding` Remotes and the layout slots. */
export const inject = ['slots', 'locale', 'remote', 'remote.knowledgeBases', 'remote.embedding']

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
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: PANEL_ID, order: 6, label: () => t('panel'), locale: NS,
  }, KnowledgePanelIcon))
}
