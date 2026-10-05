/**
 * Citations derived from logged `knowledge_search` results: each result's presentation metadata
 * carries the passages the model read, so a reloaded or replayed session shows the same sources.
 */
import type { ChatNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { KnowledgeCitation } from '@deepseek-ai/dsh-knowledge-selection/client'

/** The citations of one `knowledge_search` result. */
export interface KnowledgeCitations {
  readonly callId: string
  readonly citations: readonly KnowledgeCitation[]
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** Passages one knowledge_search call returned. */
    'knowledge-citations': KnowledgeCitations
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function citation(value: unknown): value is KnowledgeCitation {
  if (!record(value)) return false
  const { knowledgeBaseId, knowledgeBase, itemId, item, kind, chunk, score, snippet, source } = value
  return [knowledgeBaseId, knowledgeBase, itemId, item, snippet].every(field => typeof field === 'string')
    && (kind === 'file' || kind === 'url' || kind === 'note') && typeof chunk === 'number' && typeof score === 'number'
    && (source === undefined || typeof source === 'string')
}

/**
 * Read the citations of a logged event.
 * @param event - any Session history event.
 * @returns the citations of a `knowledge_search` result, or undefined for anything else or malformed data.
 */
export function knowledgeCitations(event: { readonly type: string; readonly data: unknown }): KnowledgeCitations | undefined {
  if (event.type !== 'tool/result' || !record(event.data)) return undefined
  const { message, meta } = event.data
  if (!record(message) || typeof message.toolCallId !== 'string' || !record(meta) || !Array.isArray(meta.citations)) return undefined
  const citations: unknown[] = meta.citations
  return citations.every(citation) ? { callId: message.toolCallId, citations } : undefined
}

/**
 * The sources one Turn cited: each item once, best passage first, in order of relevance.
 * @param results - the Turn's citation results, in call order.
 * @returns one citation per item.
 */
export function turnSources(results: readonly KnowledgeCitations[]): KnowledgeCitation[] {
  const best = new Map<string, KnowledgeCitation>()
  for (const entry of results.flatMap(result => result.citations)) {
    const key = `${entry.knowledgeBaseId}/${entry.itemId}`
    const current = best.get(key)
    if (current === undefined || entry.score > current.score) best.set(key, entry)
  }
  return [...best.values()].sort((a, b) => b.score - a.score)
}

/** One hidden node per result; the Turn's tail renders them together. */
export const citationsDefinition = {
  kind: 'knowledge-citations',
  target: 'chat',
  match: (event) => {
    const found = knowledgeCitations(event)
    return found === undefined ? null : { id: found.callId, role: 'start' }
  },
  start: (_context, match) => knowledgeCitations(match.event) as KnowledgeCitations,
  update: context => context.state,
  buildViewNode: (context) => {
    const start = context.start ?? context.matches[0]
    if (context.state === undefined || start === undefined) return null
    return {
      key: context.key, kind: 'knowledge-citations', id: context.id, target: 'chat',
      anchorSeq: start.event.seq, location: start.location, visibility: 'hidden', data: context.state,
    } satisfies ChatNode<'knowledge-citations'>
  },
} satisfies ConversationNodeDefinition<KnowledgeCitations>
