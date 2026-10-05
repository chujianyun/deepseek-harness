/** The `knowledge_search` tool: its schema, the text and citations of its result, and its cards. */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  citationsOf, KNOWLEDGE_SEARCH, KNOWLEDGE_SEARCH_DESCRIPTION, QUERY_DESCRIPTION, renderSearchResult, type KnowledgeSearchValue,
} from './search.ts'

/**
 * Define the `knowledge_search` tool over a search of the calling session's selection.
 * @param search - searches the knowledge bases the session selected for a trimmed query.
 * @returns the tool, to register in an agent's scope.
 */
export function knowledgeSearchTool(search: (session: Session, query: string) => Promise<KnowledgeSearchValue>): ToolDefinition {
  return defineTool({
    name: KNOWLEDGE_SEARCH,
    description: KNOWLEDGE_SEARCH_DESCRIPTION,
    parameters: {
      query: { type: 'string', required: true, description: QUERY_DESCRIPTION },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          hits: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                knowledgeBaseId: { type: 'string', required: true },
                knowledgeBase: { type: 'string', required: true },
                itemId: { type: 'string', required: true },
                item: { type: 'string', required: true },
                kind: { type: 'string', enum: ['file', 'url', 'note'], required: true },
                source: { type: 'string' },
                chunk: { type: 'integer', required: true },
                score: { type: 'number', required: true },
                text: { type: 'string', required: true },
              },
            },
          },
          skipped: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                knowledgeBaseId: { type: 'string', required: true },
                knowledgeBase: { type: 'string', required: true },
                reason: { type: 'string', enum: ['missing', 'rebuilding', 'unavailable', 'failed'], required: true },
                message: { type: 'string' },
              },
            },
          },
        },
      },
      render: (args, value) => [{ type: 'text', text: renderSearchResult(args.query.trim(), value) }],
      presentationMeta: (_args, value) => ({ citations: citationsOf(value) }),
    },
    // Searching reads local indexes and does not change agent state.
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      // The tool is registered only in an agent's own scope, so a call always has one.
      const session = (exec.agent as Agent).session
      return search(session, args.query.trim())
    },
    presentCall: args => ({ card: 'generic', title: `Search knowledge: ${args.query}`, kind: 'search' }),
    presentResult: (_args, result) => ({ card: 'generic', content: result.content }),
  })
}
