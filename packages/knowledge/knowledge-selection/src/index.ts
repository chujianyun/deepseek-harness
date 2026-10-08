/**
 * Knowledge selection: the knowledge bases a session may search, and the `knowledge_search` tool
 * that searches them. The selection is logged per session as the whole-value `knowledge/selection`
 * event, so resume and fork restore it; the `knowledgeSelection` projection serves it to clients.
 *
 * The tool is registered only in the scope of an agent whose session has selected knowledge bases,
 * so a session without a selection never offers it to the model. A selection made between turns is
 * logged at once; one made during a turn changes the tool at once — the turn's next request is
 * assembled with it — and is logged by the next accepted step, before that request is sent. The
 * tool searches only the logged selection, each knowledge base under its own retrieval settings,
 * and reports a knowledge base it cannot search instead of failing the call. A filter added with
 * `restrict()`, such as a session assistant's allowed knowledge bases, narrows what a session may
 * select and search.
 *
 * @module @deepseek-ai/dsh-knowledge-selection
 */

import { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-knowledge-base'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { Remote, RemoteError, remoteErrorOf, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import type { KnowledgeSearchHitValue, KnowledgeSearchSkipValue, KnowledgeSearchValue } from './search.ts'
import { knowledgeSearchTool } from './tool.ts'
import type { KnowledgeSelectionBase, KnowledgeSelectionProjection, KnowledgeSelectionResult } from './types.ts'

export type * from './types.ts'
export { KNOWLEDGE_SEARCH, KNOWLEDGE_SEARCH_DESCRIPTION, renderSearchResult, citationsOf } from './search.ts'
export type { KnowledgeSearchValue } from './search.ts'
export { knowledgeSearchTool } from './tool.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The knowledge bases each session may search, and the search tool over them. */
    knowledgeSelection: KnowledgeSelectionService
  }
}

const selectionSchema = z.object({ bases: z.array(z.object({ id: z.string(), name: z.string() }).strict()) }).strict()

/** Projection of the logged knowledge selection. */
export const knowledgeSelectionProjection = {
  key: 'knowledgeSelection',
  stateVersion: 1,
  stateSchema: selectionSchema,
  init: () => ({ bases: [] }),
  apply: (state, event) => (event.type === 'knowledge/selection' ? { bases: event.data.bases } : state),
  wire: { viewSchema: selectionSchema, view: state => state },
} satisfies ProjectionDefinition<'knowledgeSelection', KnowledgeSelectionProjection>

const sameBases = (a: readonly KnowledgeSelectionBase[], b: readonly KnowledgeSelectionBase[]): boolean =>
  a.length === b.length && a.every((base, index) => base.id === b[index]?.id && base.name === b[index].name)

/**
 * Decides whether a session's agent may search a knowledge base.
 * @param agent - the agent of the session.
 * @param baseId - the knowledge base.
 * @returns false to keep the knowledge base out of that session.
 */
export type KnowledgeFilter = (agent: Agent, baseId: string) => boolean

/** Host owner of the knowledge selection and of the `knowledgeSelection` Remote namespace. */
export class KnowledgeSelectionService extends TypertRemoteService {
  static inject = ['agents', 'tools', 'sessionProjections', 'knowledgeBases']

  /** Selections made during a turn, waiting for its next accepted step. */
  private readonly pending = new WeakMap<Session, KnowledgeSelectionBase[]>()
  /** Disposers of the tool registered in an agent's scope. */
  private readonly installed = new Map<Agent, () => void>()
  /** Filters every session's knowledge bases pass; see {@link KnowledgeSelectionService.restrict}. */
  private readonly filters = new Set<KnowledgeFilter>()

  /** @param ctx - Host with agents, tools, session projections, and knowledge bases. */
  constructor(ctx: Context) {
    super(ctx, 'knowledgeSelection', { namespace: 'knowledgeSelection' })
    ctx.sessionProjections.register(knowledgeSelectionProjection)
    ctx.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
      const decision = await next()
      if (decision.kind === 'reject' || signal.aborted) return decision
      try {
        this.commitPending(agent.session)
      } catch (error) {
        // The selection stays pending for a later step; the step itself goes on.
        ctx.logger.warn('dsh-knowledge-selection: failed to log the selection at step start: %o', error)
      }
      this.sync(agent)
      return decision
    })
    for (const agent of ctx.agents.list()) this.sync(agent)
    ctx.on('agent/created', ({ agent }) => { this.sync(agent) })
    ctx.on('agent/disposed', ({ agent }) => { this.uninstall(agent) })
    ctx.effect(() => () => { for (const agent of [...this.installed.keys()]) this.uninstall(agent) }, 'knowledge-selection: tools')
  }

  /**
   * Select the knowledge bases a session searches; an empty list selects none. Between turns the
   * selection is logged at once; during a turn it applies from the turn's next step.
   * @param sessionId - the session.
   * @param baseIds - knowledge bases of the signed-in tenant, in the order to show them.
   * @returns the selection and when it applies.
   * @throws RemoteError `knowledge-selection/unknown-base`, `knowledge-selection/not-allowed` for a
   *   knowledge base the session may not search, or the session's resolution failure.
   */
  @Remote
  async select(sessionId: SessionId, baseIds: readonly string[]): Promise<KnowledgeSelectionResult> {
    const { bases: known } = await this.ctx.knowledgeBases.getState()
    const bases = [...new Set(baseIds)].map((id) => {
      const base = known.find(entry => entry.id === id)
      if (base === undefined) throw new RemoteError('knowledge-selection/unknown-base', `no knowledge base ${id}`, { id })
      return { id, name: base.name }
    })
    const agent = await this.resolveAgent(sessionId)
    const refused = bases.find(base => !this.allowed(agent, base.id))
    if (refused !== undefined) {
      throw new RemoteError('knowledge-selection/not-allowed', `this session may not search the knowledge base ${refused.name}`, { id: refused.id })
    }
    const session = agent.session
    const turnOpen = (this.ctx.sessionProjections.stateOf(session, 'turnBoundary')?.openTurnStartSeq ?? null) !== null
    if (turnOpen) {
      this.pending.set(session, bases)
      this.sync(agent)
      return { bases, applies: 'next-step' }
    }
    this.pending.delete(session)
    if (!sameBases(bases, this.logged(session))) session.append('knowledge/selection', { bases })
    this.sync(agent)
    return { bases, applies: 'now' }
  }

  /**
   * List the signed-in tenant's knowledge bases a session may select.
   * @param sessionId - the session.
   * @returns the ids, in the tenant's order.
   * @throws the session's resolution failure.
   */
  @Remote
  async allowedBases(sessionId: SessionId): Promise<readonly string[]> {
    const { bases } = await this.ctx.knowledgeBases.getState()
    const agent = await this.resolveAgent(sessionId)
    return bases.filter(base => this.allowed(agent, base.id)).map(base => base.id)
  }

  /**
   * Narrow the knowledge bases sessions may select and search. A session can no longer select a
   * knowledge base a filter refuses, and its search skips one already selected; the search tool
   * leaves a session whose selection the filters empty. Every live agent is checked again when a
   * filter is added or removed, and each agent before every step.
   * @param filter - returns false for a knowledge base the agent's session must not search.
   * @returns the disposer that removes the filter.
   */
  restrict(filter: KnowledgeFilter): () => void {
    this.filters.add(filter)
    for (const agent of this.ctx.agents.list()) this.sync(agent)
    return () => {
      this.filters.delete(filter)
      for (const agent of this.ctx.agents.list()) this.sync(agent)
    }
  }

  /** Whether every filter lets the agent's session search the knowledge base. */
  private allowed(agent: Agent, baseId: string): boolean {
    for (const filter of this.filters) if (!filter(agent, baseId)) return false
    return true
  }

  /** The selection, pending or logged, without the knowledge bases the session may not search. */
  private effective(agent: Agent, selection = this.pending.get(agent.session) ?? this.logged(agent.session)): KnowledgeSelectionBase[] {
    return selection.filter(base => this.allowed(agent, base.id))
  }

  private async resolveAgent(sessionId: SessionId): Promise<Agent> {
    const live = this.ctx.agents.get(sessionId)
    if (live !== undefined) return live
    const controller = this.ctx.get('sessionController')
    if (controller === undefined) throw new RemoteError('session/not-found', `session "${sessionId}" is not attached`, { sessionId })
    const resolved = await controller.resolveAgent(sessionId)
    if ('error' in resolved) throw resolved.error
    return resolved.agent
  }

  /** The logged selection of a session. */
  private logged(session: Session): readonly KnowledgeSelectionBase[] {
    // This service registers the projection, so every session has its state.
    return (this.ctx.sessionProjections.stateOf(session, 'knowledgeSelection') as KnowledgeSelectionProjection).bases
  }

  /** Log a selection made during the turn, before the next request is assembled. */
  private commitPending(session: Session): void {
    const bases = this.pending.get(session)
    if (bases === undefined) return
    if (!sameBases(bases, this.logged(session))) session.append('knowledge/selection', { bases })
    // Only after a successful append, so a failed write is retried at a later step.
    this.pending.delete(session)
  }

  /** Offer the tool in an agent's scope exactly while its session's selection, pending or logged, is not empty. */
  private sync(agent: Agent): void {
    const wanted = this.effective(agent).length > 0
    if (wanted === this.installed.has(agent)) return
    if (!wanted) { this.uninstall(agent); return }
    const tool = knowledgeSearchTool(async (session, query) => this.search(this.effective(agent, this.logged(session)), query))
    this.installed.set(agent, agent.ctx.tools.register(tool))
  }

  private uninstall(agent: Agent): void {
    this.installed.get(agent)?.()
    this.installed.delete(agent)
  }

  /** Search each selected knowledge base under its own settings, best passages first. */
  private async search(selection: readonly KnowledgeSelectionBase[], query: string): Promise<KnowledgeSearchValue> {
    const { bases } = await this.ctx.knowledgeBases.getState()
    const hits: KnowledgeSearchHitValue[] = []
    const skipped: KnowledgeSearchSkipValue[] = []
    let limit = 0
    for (const selected of selection) {
      const base = bases.find(entry => entry.id === selected.id)
      const skip = (reason: KnowledgeSearchSkipValue['reason'], message?: string): void => {
        const name = base?.name ?? selected.name
        skipped.push({ knowledgeBaseId: selected.id, knowledgeBase: name, reason, ...message === undefined ? {} : { message } })
      }
      if (base === undefined) { skip('missing'); continue }
      if (base.status !== 'ready') { skip(base.status); continue }
      limit = Math.max(limit, base.settings.documentCount)
      try {
        const result = await this.ctx.knowledgeBases.recall(base.id, query)
        for (const hit of result.hits) {
          hits.push({
            knowledgeBaseId: base.id, knowledgeBase: base.name, itemId: hit.itemId, item: hit.itemName,
            // A folder holds files; it is never a hit itself.
            kind: hit.itemKind as KnowledgeSearchHitValue['kind'],
            ...hit.source === null ? {} : { source: hit.source },
            chunk: hit.ordinal + 1, score: Number(hit.score.toFixed(4)), text: hit.text,
          })
        }
      } catch (error) {
        const reason = remoteErrorOf(error)?.code === 'knowledge/rebuilding' ? 'rebuilding' : 'failed'
        skip(reason, reason === 'failed' ? (error instanceof Error ? error.message : String(error)) : undefined)
      }
    }
    hits.sort((a, b) => b.score - a.score)
    return { hits: hits.slice(0, limit), skipped }
  }
}

export default KnowledgeSelectionService
