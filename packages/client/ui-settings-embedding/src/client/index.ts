/**
 * Settings → Embedding models in the Desktop renderer: the local embedding model's download
 * (progress, pause, resume, repair, delete) and the API embedding models served by configured
 * provider routes. State streams from the `embedding` Remote.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { EmbeddingState } from '@deepseek-ai/dsh-embedding/types'
import { createEmbeddingSource } from './embedding-source.ts'
import { EmbeddingSection } from './EmbeddingSection.tsx'
import { en, zh, type EmbeddingLocaleKey } from './locales.ts'

export type { EmbeddingDependencies, EmbeddingInjected, EmbeddingSnapshot } from './embedding-source.ts'
export type { EmbeddingLocaleKey } from './locales.ts'
export type { EmbeddingSectionProps } from './EmbeddingSection.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Embedding models section copy. */
    'settings-embedding': EmbeddingLocaleKey
  }
}

const NS = 'settings-embedding'

/** Services the section reads: the `embedding` Remote and the Settings slots. */
export const inject = ['slots', 'locale', 'remote', 'remote.embedding']

/**
 * Contribute the Embedding models section in the Desktop renderer, after Models.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  // Desktop only: knowledge bases, the section's only consumer, exist only there.
  if (!('dshDesktop' in globalThis)) return
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-embedding: dictionaries')
  const t = ctx.locale.bind(NS)
  const remote = ctx.remote.embedding
  const source = createEmbeddingSource({
    listProviders: () => remote.listProviders(),
    startDownload: () => remote.startDownload(),
    pauseDownload: () => remote.pauseDownload(),
    removeLocalModel: () => remote.removeLocalModel(),
    addApiModel: (provider, model) => remote.addApiModel(provider, model),
    removeApiModel: id => remote.removeApiModel(id),
    openModels: () => { ctx.emit('settings/open-section', 'models') },
  })
  const stream = ctx.remote.$stream<EmbeddingState>({
    name: 'embedding', open: signal => remote.watch(signal), ended: () => new Error('embedding stream ended'),
  })
  ctx.effect(() => () => stream.dispose(), 'ui-settings-embedding: state stream')
  void (async () => {
    for await (const frame of stream) {
      source.publish(frame.value)
      frame.accept()
    }
  })().catch(() => {
    // The stream reconnects on its own; a disposed plugin simply stops listening.
  })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'embedding', order: 11, label: () => t('nav'), locale: NS, inject: () => source,
  }, EmbeddingSection))
}
