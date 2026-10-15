/** Which Sessions and attachments one upload carries, and the facts it names. */
import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionSeq, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { boundAssistant, bundleAttachments, bundleGroups, lastChange, rootOf } from '../src/bundle.ts'
import type { SessionSyncBundle } from '../src/types.ts'

const header = (id: string, more: Partial<SessionHeader> = {}): SessionHeader =>
  ({ version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 1_000, isSeeded: false, ...more })
const child = (id: string, parent: string) => header(id, { origin: 'subagent', parentSession: SessionId(parent) })
const headers = (...list: SessionHeader[]) => new Map(list.map(item => [item.id, item]))
const event = (type: string, time: number, data: unknown) => ({ type, seq: SessionSeq(0), time, data }) as never as SessionEvent
const bundle = (first: SessionEvent[], ...rest: SessionEvent[][]): SessionSyncBundle => {
  const log = (events: SessionEvent[], index: number) => ({ header: header(`s${String(index)}`), inheritedEventCount: 0, events })
  return { format: 1, sessions: [log(first, 0), ...rest.map((events, index) => log(events, index + 1))] }
}

describe('rootOf and bundleGroups', () => {
  const all = headers(header('root'), child('a', 'root'), child('b', 'a'), header('fork', { parentSession: SessionId('root') }), child('orphan', 'gone'),
    child('loop-1', 'loop-2'), child('loop-2', 'loop-1'), header('none', { origin: 'subagent' }))

  it('follows subagent parents to the top-level Session; a fork is its own', () => {
    expect(rootOf(SessionId('b'), all)).toBe('root')
    expect(rootOf(SessionId('root'), all)).toBe('root')
    expect(rootOf(SessionId('fork'), all)).toBe('fork')
  })

  it('finds none for a missing, parentless, orphaned, or circular subagent Session', () => {
    expect(rootOf(SessionId('missing'), all)).toBeUndefined()
    expect(rootOf(SessionId('none'), all)).toBeUndefined()
    expect(rootOf(SessionId('orphan'), all)).toBeUndefined()
    expect(rootOf(SessionId('loop-1'), all)).toBeUndefined()
  })

  it('lists each top-level Session, newest first, then its subagent Sessions by id', () => {
    const items = [...all.values()].map(item => ({ header: item.id === 'fork' ? { ...item, createdAt: 2_000 } : item }))
    expect(bundleGroups(items).map(group => group.map(item => item.header.id))).toEqual([['fork'], ['root', 'a', 'b']])
  })
})

describe('bundleAttachments', () => {
  const sha = (char: string) => char.repeat(64)
  const image = { attachmentId: `sha256:${sha('a')}`, mediaType: 'image/png', bytes: 3, width: 1, height: 1 }
  const file = { attachmentId: `sha256:${sha('b')}`, name: '表.csv', bytes: 5 }

  it('finds image and file references anywhere in the events, once per digest, in order', () => {
    const found = bundleAttachments(bundle(
      [event('user/message', 1, { content: [{ type: 'image', attachment: image }, { type: 'file', attachment: file }] })],
      [event('tool/result', 2, { nested: { deeper: [file, image] } })],
    ))
    expect(found).toEqual([{ kind: 'image', sha256: sha('a'), ref: image }, { kind: 'file', sha256: sha('b'), ref: file }])
  })

  it('ignores ids that do not name a sha256 digest', () => {
    expect(bundleAttachments(bundle([event('user/message', 1, { attachmentId: 'opaque', inner: { attachmentId: 7 } })]))).toEqual([])
  })
})

describe('boundAssistant and lastChange', () => {
  it('reads the last assistant selection, where an empty id goes back to none', () => {
    expect(boundAssistant([])).toBeNull()
    expect(boundAssistant([event('assistant/selected', 1, { assistantId: 'a-shop' })])).toBe('a-shop')
    expect(boundAssistant([event('assistant/selected', 1, { assistantId: 'a-shop' }), event('assistant/selected', 2, { assistantId: '' })])).toBeNull()
  })

  it('is the latest event time across the bundle, or the creation of a bundle without events', () => {
    expect(lastChange(bundle([event('turn/start', 5_000, {})], [event('turn/start', 9_000, {}), event('turn/end', 7_000, {})]))).toBe(9_000)
    expect(lastChange(bundle([]))).toBe(1_000)
  })
})
