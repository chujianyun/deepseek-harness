/** Types and helpers the Knowledge page's parts share. */

import type { EmbeddingState } from '@deepseek-ai/dsh-embedding/types'
import type { InjectFace, PropsLocale, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { KnowledgeFailure, KnowledgeInjected } from './knowledge-source.ts'

/** Props the page reads from its `main` registration: the translator and the knowledge face. */
export type KnowledgePageProps = PropsLocale<'knowledge'> & InjectFace<KnowledgeInjected>

/** The `knowledge` translator. */
export type T = TranslateNS<'knowledge'>

/**
 * Embedding models a knowledge base can use, with the label a select shows.
 * @param t - the `knowledge` translator.
 * @param embedding - the embedding models' state.
 * @returns the local model unless unsupported, then the API models.
 */
export function modelOptions(t: T, embedding: EmbeddingState | undefined): { id: string; label: string }[] {
  if (embedding === undefined) return []
  const { local } = embedding
  const options = local.status === 'unsupported' ? []
    : [{ id: local.id, label: t(local.status === 'installed' ? 'modelLocal' : 'modelLocalPending', { name: local.name }) }]
  return [...options, ...embedding.apiModels.map(model => ({ id: model.id, label: `${model.model} · ${model.providerName}` }))]
}

/**
 * Words for a refused action.
 * @param t - the `knowledge` translator.
 * @param failure - the refusal.
 * @returns the sentence the page shows.
 */
export function failureText(t: T, failure: KnowledgeFailure): string {
  switch (failure.reason) {
    case 'other': return t('actionFailed', { message: failure.message })
    case 'probe-failed': return t('failure.probe-failed', { message: failure.message })
    default: return t(`failure.${failure.reason}`)
  }
}
