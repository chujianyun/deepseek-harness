// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import type { SessionLiveEventEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { ConversationNodeAssembler } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  ConversationLocationDataSource, ConversationLocationDataStore, ConversationTimelineSnapshot,
  ConversationTurnDataMap, ConversationViewDefinition, ConversationViewNode, TurnLocation,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { en, zh } from '../src/client/locales.ts'
import { UnattendedRecord, type UnattendedRecordProps } from '../src/client/UnattendedRecord.tsx'
import { selectUnattended, unattendedTurnDefinition, type UnattendedTurnData } from '../src/client/unattended-turn.ts'

afterEach(cleanup)

const at = (seq: number, type: string, data: unknown): SessionLiveEventEntry => ({
  type: 'event', event: { seq, time: seq * 1000, type, data } as SessionEvent,
})
const answer = (seq: number, turn: number, callId: string, command: string, operations: string[]) => at(seq, 'automation-tasks/unattended', {
  callId, turn, command, allowed: operations.length > 0, operations,
})

interface TimelineSnapshot { readonly timeline: ConversationTimelineSnapshot }

const timelineView: ConversationViewDefinition<ConversationViewNode, TimelineSnapshot> = {
  target: 'test',
  create: () => {
    let current: TimelineSnapshot = { timeline: { turnOrder: [], turns: new Map() } }
    return { empty: current, replace: ({ timeline }) => (current = { timeline }), apply: ({ timeline }) => (current = { timeline }) }
  },
}

/** Turn data per turn after the engine folds the entries. */
function turnData(entries: readonly SessionLiveEventEntry[]): (turn: number) => UnattendedTurnData | undefined {
  const assembler = new ConversationNodeAssembler(
    { entries: () => [unattendedTurnDefinition], fallbackEntry: () => undefined },
    { entries: () => [timelineView] },
  )
  assembler.replaceWindow(entries, false)
  assembler.activateTarget('test')
  const snapshot = assembler.snapshot('test') as TimelineSnapshot
  return turn => snapshot.timeline.turns.get(turn)?.data.get('automation-unattended')
}

class TurnData implements ConversationLocationDataStore<ConversationTurnDataMap> {
  constructor(private readonly value: UnattendedTurnData | undefined) {}
  get<Key extends Extract<keyof ConversationTurnDataMap, string>>(key: Key): Readonly<ConversationTurnDataMap[Key]> | undefined {
    return (key === 'automation-unattended' ? this.value : undefined) as Readonly<ConversationTurnDataMap[Key]> | undefined
  }
  source<Key extends Extract<keyof ConversationTurnDataMap, string>>(
    key: Key,
  ): ConversationLocationDataSource<Readonly<ConversationTurnDataMap[Key]> | undefined> {
    return { getSnapshot: () => this.get(key), subscribe: () => () => {} }
  }
}

const owner = (value: UnattendedTurnData | undefined): TurnTailOwnerProps => {
  const turn: TurnLocation = { turn: 1, start: undefined, end: undefined, status: 'closed', steps: [], data: new TurnData(value) }
  return { turn, seq: 99, openFile: () => {} }
}

/** The record's props: the record reads only its Turn and copy, so the session-standard kit is left out. */
function recordProps(value: UnattendedTurnData | undefined, copy: typeof zh): UnattendedRecordProps {
  const props: Partial<UnattendedRecordProps> = { ...owner(value), t: makeTranslate(copy) }
  return props as UnattendedRecordProps
}

describe('the unattended run record', () => {
  it('collects each turn\'s answers in order, and none for a turn without', () => {
    const data = turnData([
      at(1, 'turn/start', { turn: 1 }),
      answer(2, 1, 'c1', 'lark-cli sheets +write --range A1', ['lark-cli sheets +write']),
      answer(3, 1, 'c2', 'lark-cli drive +delete', []),
      at(4, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      at(5, 'turn/start', { turn: 2 }),
    ])
    expect(data(1)?.answers.map(item => [item.callId, item.allowed, item.operations])).toEqual([['c1', true, ['lark-cli sheets +write']], ['c2', false, []]])
    expect(data(2)).toEqual({ answers: [] })
    expect(selectUnattended(owner(data(2)))).toBeNull()
    expect(selectUnattended(owner(undefined))).toBeNull()
    expect(() => unattendedTurnDefinition.start(
      { key: 'x', kind: 'automation-unattended', id: '1', matches: [], start: undefined, state: undefined, current: new Map() },
      { event: at(1, 'turn/end', { turn: 1 }).event, role: 'start', location: { kind: 'unresolved' } } as never,
      { previous: () => undefined },
    )).toThrow('automation-unattended start requires turn/start')
  })

  it('keeps the published data while the answers are unchanged, and publishes only for a turn', () => {
    const answers = [{ seq: 2, callId: 'c1', command: 'x', allowed: false, operations: [] }]
    const context = { key: 'k', kind: 'automation-unattended', id: '1', matches: [], start: undefined as never, current: new Map(), state: { turn: 1, answers } }
    const build = unattendedTurnDefinition.buildLocationData!.bind(unattendedTurnDefinition)
    const first = build(context, 'turn', null)
    expect(first).toEqual({ kind: 'turn', turn: 1, key: 'automation-unattended', value: { answers } })
    expect(build(context, 'turn', first as never)).toBe(first)
    for (const previous of [{ ...first, turn: 2 }, { ...first, key: 'other' }, { ...first, value: { answers: [...answers] } }, { kind: 'step' }]) {
      expect(build(context, 'turn', previous as never)).toEqual(first)
    }
    expect(build(context, 'step', null)).toBeNull()
    expect(build({ ...context, state: undefined }, 'turn', null)).toBeNull()
  })

  it.each([['zh', zh], ['en', en]] as const)('lists refused calls first, then those that ran, with their operations (%s)', (_lang, copy) => {
    const data = turnData([
      at(1, 'turn/start', { turn: 1 }),
      answer(2, 1, 'c1', 'lark-cli sheets +write --range A1', ['lark-cli sheets +write']),
      answer(3, 1, 'c2', 'lark-cli drive +delete', []),
    ])(1)
    render(<UnattendedRecord {...recordProps(data, copy)} />)
    const record = screen.getByRole('region', { name: copy['unattended.title'] })
    const groups = within(record).getAllByRole('list')
    expect(within(groups[0]!).getByText('lark-cli drive +delete')).toBeTruthy()
    expect(within(groups[1]!).getByText('lark-cli sheets +write --range A1')).toBeTruthy()
    expect(record.textContent).toContain(copy['unattended.refused'].replace('{count}', '1'))
    expect(record.textContent).toContain(copy['unattended.matched'].replace('{operations}', 'lark-cli sheets +write'))
    expect(record.textContent).toContain(copy['unattended.hint'])
  })

  it('shows a call answered twice once, with its last answer', () => {
    const data = turnData([
      at(1, 'turn/start', { turn: 1 }),
      answer(2, 1, 'c1', 'lark-cli sheets +write > out.txt', ['lark-cli sheets +write']),
      answer(3, 1, 'c2', 'dsh-ecommerce browser a1', ['dsh-ecommerce browser']),
      answer(4, 1, 'c1', 'lark-cli sheets +write > out.txt', []),
    ])(1)
    expect(selectUnattended(owner(data))?.map(item => [item.callId, item.allowed])).toEqual([['c1', false], ['c2', true]])
  })

  it('shows no hint when everything ran, and nothing for a turn without answers', () => {
    const { container, rerender } = render(<UnattendedRecord {...recordProps(turnData([
      at(1, 'turn/start', { turn: 1 }), answer(2, 1, 'c1', 'dsh-ecommerce browser a1', ['dsh-ecommerce browser']),
    ])(1), zh)} />)
    expect(container.textContent).not.toContain(zh['unattended.hint'])
    rerender(<UnattendedRecord {...recordProps(undefined, zh)} />)
    expect(container.textContent).toBe('')
  })
})
