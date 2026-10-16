/**
 * Turn-scoped record of a scheduled run's unattended answers: the calls that would have asked for
 * approval, run because they are declared operations or refused, from the Host's
 * `automation-tasks/unattended` events. Client-only; the events never reach the model transcript.
 */
import type { TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-automation-tasks/client'

/** One answered call. */
export interface UnattendedAnswer {
  readonly seq: number
  readonly callId: string
  readonly command: string
  readonly allowed: boolean
  /** The declared operations it ran; empty when refused. */
  readonly operations: readonly string[]
}

/** The answers one scheduled run gave, in order. */
export interface UnattendedTurnData {
  readonly answers: readonly UnattendedAnswer[]
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationTurnDataMap {
    /** Calls a scheduled run answered without anyone, run or refused. */
    'automation-unattended': UnattendedTurnData
  }
}

interface UnattendedState extends UnattendedTurnData {
  readonly turn: number
}

/** Turn-local accumulator of unattended answers; it publishes no view Node. */
export const unattendedTurnDefinition: ConversationNodeDefinition<UnattendedState> = {
  kind: 'automation-unattended',
  match: (event) => {
    if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
    if (event.type === 'automation-tasks/unattended') return { id: String(event.data.turn), role: 'update' }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'turn/start') throw new Error('automation-unattended start requires turn/start')
    return { turn: match.event.data.turn, answers: [] }
  },
  update: (context, match) => {
    /* v8 ignore next -- the only update match is this event. */
    if (match.event.type !== 'automation-tasks/unattended') return context.state
    const { callId, command, allowed, operations } = match.event.data
    const answer: UnattendedAnswer = { seq: match.event.seq, callId: String(callId), command, allowed, operations }
    return { ...context.state, answers: [...context.state.answers, answer] }
  },
  buildLocationData: (context, scope, previous) => {
    if (scope !== 'turn' || context.state === undefined) return null
    if (previous?.kind === 'turn' && previous.turn === context.state.turn && previous.key === 'automation-unattended'
      && previous.value.answers === context.state.answers) return previous
    return { kind: 'turn', turn: context.state.turn, key: 'automation-unattended', value: { answers: context.state.answers } }
  },
}

/**
 * Claim the turn tail when its turn answered calls unattended. A call answered twice, at the tool gate
 * and again when it asked to run outside the sandbox, shows its last answer, in its first place.
 * @param owner - the closing turn.
 * @returns the answers, or null for a turn with none.
 */
export function selectUnattended(owner: TurnTailOwnerProps): readonly UnattendedAnswer[] | null {
  const last = new Map<string, UnattendedAnswer>()
  for (const answer of owner.turn.data.get('automation-unattended')?.answers ?? []) last.set(answer.callId, answer)
  return last.size === 0 ? null : [...last.values()]
}
