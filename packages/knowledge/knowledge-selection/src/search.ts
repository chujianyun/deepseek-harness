/**
 * The `knowledge_search` tool's model-facing contract: its fixed description, its canonical result
 * value, the text the model reads, and the citations a client shows below the answer.
 */

import type { KnowledgeCitation, KnowledgeSearchSkipReason } from './types.ts'

/** The tool's name. */
export const KNOWLEDGE_SEARCH = 'knowledge_search'

/** The tool's description; the model sees exactly this text. */
export const KNOWLEDGE_SEARCH_DESCRIPTION
  = 'Search the knowledge bases the user selected for this conversation — company documents, folders, web pages, and notes. '
  + 'Use it before answering questions those sources may cover, and name the sources you rely on. '
  + 'Returns the best-matching passages with their knowledge base, source item, and relevance.'

/** The query parameter's description. */
export const QUERY_DESCRIPTION = 'What to look for: a question or keywords, in the language of the sources when known.'

/** Longest passage start kept for a citation. */
const SNIPPET_CHARS = 160

/** One passage found. */
export interface KnowledgeSearchHitValue {
  knowledgeBaseId: string
  knowledgeBase: string
  itemId: string
  item: string
  kind: 'file' | 'url' | 'note'
  source?: string
  chunk: number
  score: number
  text: string
}

/** A selected knowledge base that was not searched. */
export interface KnowledgeSearchSkipValue {
  knowledgeBaseId: string
  knowledgeBase: string
  reason: KnowledgeSearchSkipReason
  message?: string
}

/** The tool's canonical result. */
export interface KnowledgeSearchValue {
  hits: KnowledgeSearchHitValue[]
  skipped: KnowledgeSearchSkipValue[]
}

const SKIP_TEXT: Record<KnowledgeSearchSkipReason, string> = {
  missing: 'it no longer exists for the signed-in company',
  rebuilding: 'it is being rebuilt for a new embedding model and can be searched once that finishes',
  unavailable: 'its embedding model is not available on this machine yet',
  failed: 'the search failed',
}

/**
 * The text the model reads for a result.
 * @param query - the searched query.
 * @param value - the result.
 * @returns the passages with their sources, then the knowledge bases not searched and why.
 */
export function renderSearchResult(query: string, value: KnowledgeSearchValue): string {
  const lines: string[] = value.hits.length === 0
    ? [`No passages in the selected knowledge bases matched "${query}".`]
    : [`Found ${String(value.hits.length)} passages for "${query}".`]
  value.hits.forEach((hit, index) => {
    const where = hit.source === undefined || hit.kind === 'url' ? '' : ` (${hit.source})`
    const address = hit.kind === 'url' && hit.source !== undefined ? `, ${hit.source}` : ''
    const place = `knowledge base "${hit.knowledgeBase}"${address}, chunk ${String(hit.chunk)}, relevance ${hit.score.toFixed(2)}`
    lines.push('', `[${String(index + 1)}] ${hit.item}${where} — ${place}`, hit.text)
  })
  for (const skip of value.skipped) {
    const detail = skip.message === undefined ? '' : `: ${skip.message}`
    lines.push('', `Not searched: "${skip.knowledgeBase}" — ${SKIP_TEXT[skip.reason]}${detail}.`)
  }
  return lines.join('\n')
}

/**
 * The citations a client shows for a result: each passage's source and a short start of its text.
 * @param value - the result.
 * @returns one citation per passage, best first.
 */
export function citationsOf(value: KnowledgeSearchValue): KnowledgeCitation[] {
  return value.hits.map(({ text, ...hit }) => {
    const flat = text.replace(/\s+/gu, ' ').trim()
    return { ...hit, snippet: flat.length > SNIPPET_CHARS ? `${flat.slice(0, SNIPPET_CHARS)}…` : flat }
  })
}
