import { describe, expect, it, vi } from 'vitest'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createSessionGroupingRegistry, dateGrouping, type SessionGrouping } from '../src/client/groupings.ts'
import { deriveGroupingSections } from '../src/client/tree.ts'
import { en, zh } from '../src/client/locales.ts'

const sid = (id: string) => id as SessionId
const summary = (id: string, updatedAt: number, patch: Partial<SessionSummary> = {}): SessionSummary => ({
  id: sid(id), title: id, displayTitle: id, running: false, blank: false, updatedAt, retainedBy: {}, ...patch,
})
const list = (...items: SessionSummary[]): SessionListState => ({
  ids: items.map(item => item.id), byId: Object.fromEntries(items.map(item => [item.id, item])), phase: 'ready', projectionsBySession: {},
})
const rows = (patch: { pinned?: string[]; archived?: string[]; archivedFilter?: 'default' | 'show' | 'only' } = {}) => ({
  pinnedSessionIds: (patch.pinned ?? []).map(sid), archivedSessionIds: (patch.archived ?? []).map(sid),
  archivedFilter: patch.archivedFilter ?? 'default' as const,
})
const statuses: SessionStatusSnapshot = new Map()
const noLocaleChanges = () => () => {}
/** Group by the first letter of the title; `z` sessions rank first. */
const byLetter: Pick<SessionGrouping, 'groupOf'> = {
  groupOf: session => ({ key: session.title!.slice(0, 1), label: session.title!.slice(0, 1).toUpperCase(), ...(session.title!.startsWith('z') ? { rank: 0 } : {}) }),
}

describe('the grouping registry', () => {
  it('lists registrations in registration order until each is disposed, and refuses a taken id', () => {
    const registry = createSessionGroupingRegistry()
    const date: SessionGrouping = { id: 'date', label: () => 'Date', order: 300, groupOf: () => ({ key: 'x', label: 'x' }) }
    const assistant: SessionGrouping = { id: 'assistant', label: () => 'Assistant', order: 50, groupOf: () => ({ key: 'x', label: 'x' }) }
    const removeDate = registry.register(date)
    const removeAssistant = registry.register(assistant)
    expect(registry.groupings.getSnapshot().map(item => item.id)).toEqual(['date', 'assistant'])
    expect(() => registry.register({ ...date })).toThrow('a session grouping "date" already exists')
    expect(() => registry.register({ ...date, id: 'flat' })).toThrow('a session grouping "flat" already exists')
    removeDate()
    expect(registry.groupings.getSnapshot()).toEqual([assistant])
    removeAssistant()
    expect(registry.groupings.getSnapshot()).toEqual([])
  })
})

describe('sections of a registered grouping', () => {
  it('orders ranked sections first, then by latest activity, with rows newest first and the same visibility rules', () => {
    const state = list(
      summary('apple', 10), summary('avocado', 30), summary('banana', 20), summary('zebra', 5),
      summary('blank', 99, { blank: true }), summary('child', 50, { origin: 'subagent' }), summary('archived', 40),
    )
    // An id whose summary has not arrived is skipped.
    const sections = deriveGroupingSections({ ...state, ids: [...state.ids, sid('pending')] }, byLetter, rows({ archived: ['archived'] }), statuses, {})
    expect(sections.map(section => [section.key, section.sessions.map(row => row.id)])).toEqual([
      ['z', ['zebra']], ['a', ['avocado', 'apple']], ['b', ['banana']],
    ])
    expect(sections[1]).toMatchObject({ heading: { label: 'A' }, sessionIds: ['avocado', 'apple'], collapsed: false, containsCurrent: false })
  })

  it('leads with the current New Session and pinned rows, marks the current section, and empties a collapsed one', () => {
    const state = list(
      summary('apple', 30), summary('anchor', 5), summary('arc', 1, { blank: true, title: 'a', retainedBy: { mainView: 1 } }),
      summary('banana', 20),
    )
    const sections = deriveGroupingSections(state, byLetter, rows({ pinned: ['anchor'] }), statuses, { b: true })
    expect(sections[0]).toMatchObject({ key: 'a', containsCurrent: true })
    expect(sections[0]!.sessions.map(row => row.id)).toEqual(['arc', 'anchor', 'apple'])
    expect(sections[1]).toMatchObject({ key: 'b', collapsed: true, sessionIds: ['banana'], sessions: [] })
  })

  it('follows the archived filter', () => {
    const state = list(summary('apple', 10), summary('avocado', 30))
    const only = deriveGroupingSections(state, byLetter, rows({ archived: ['apple'], archivedFilter: 'only' }), statuses, {})
    expect(only.flatMap(section => section.sessions.map(row => row.id))).toEqual(['apple'])
    const all = deriveGroupingSections(state, byLetter, rows({ archived: ['apple'], archivedFilter: 'show' }), statuses, {})
    expect(all.flatMap(section => section.sessions.map(row => [row.id, row.archived]))).toEqual([['avocado', false], ['apple', true]])
  })
})

describe('the Date grouping', () => {
  // A Thursday noon, local time.
  const now = new Date(2026, 9, 15, 12, 0).getTime()
  const at = (daysAgo: number, hour = 9) => new Date(2026, 9, 15 - daysAgo, hour, 0).getTime()

  it.each([
    [zh, '今天', '昨天', '10月12日', '更早'],
    [en, 'Today', 'Yesterday', 'October 12', 'Earlier'],
  ])('sections Sessions by day: today, yesterday, each day of the past week, then earlier', (copy, today, yesterday, threeDays, earlier) => {
    const grouping = dateGrouping(key => copy[key], noLocaleChanges, () => now)
    expect(grouping).toMatchObject({ id: 'date', order: 300 })
    expect(grouping.label()).toBe(copy['groupBy.date'])
    expect(grouping.groupOf(summary('a', at(0, 0)))).toEqual({ key: 'today', label: today, rank: 0 })
    expect(grouping.groupOf(summary('b', at(1, 23)))).toEqual({ key: 'yesterday', label: yesterday, rank: 1 })
    expect(grouping.groupOf(summary('c', at(3)))).toEqual({ key: 'day:2026-10-12', label: threeDays, rank: 3 })
    expect(grouping.groupOf(summary('d', at(7)))).toEqual({ key: 'earlier', label: earlier, rank: 7 })
    // A clock behind the Session's time still reads as today.
    expect(grouping.groupOf(summary('e', now + 3_600_000)).key).toBe('today')
  })

  it('reads the clock at each grouping', () => {
    const clock = vi.fn(() => now)
    const grouping = dateGrouping(key => en[key], noLocaleChanges, clock)
    grouping.groupOf(summary('a', now))
    grouping.groupOf(summary('b', now))
    expect(clock).toHaveBeenCalledTimes(2)
    expect(dateGrouping(key => en[key], noLocaleChanges).groupOf(summary('c', Date.now())).key).toBe('today')
  })

  it('labels days in the current language', () => {
    let copy: typeof en | typeof zh = en
    const grouping = dateGrouping(key => copy[key], noLocaleChanges, () => now)
    expect(grouping.groupOf(summary('a', at(3))).label).toBe('October 12')
    expect(grouping.groupOf(summary('b', at(4))).label).toBe('October 11')
    copy = zh
    expect(grouping.groupOf(summary('c', at(3))).label).toBe('10月12日')
  })

  it('reports each local midnight and each language switch until unsubscribed', () => {
    vi.useFakeTimers({ now })
    try {
      const localeListeners = new Set<() => void>()
      const grouping = dateGrouping(key => en[key], (onChange) => {
        localeListeners.add(onChange)
        return () => { localeListeners.delete(onChange) }
      })
      const onChange = vi.fn()
      const stop = grouping.subscribe!(onChange)
      vi.advanceTimersByTime(12 * 3_600_000 - 1)
      expect(onChange).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(onChange).toHaveBeenCalledOnce()
      vi.advanceTimersByTime(24 * 3_600_000)
      expect(onChange).toHaveBeenCalledTimes(2)
      for (const listener of localeListeners) listener()
      expect(onChange).toHaveBeenCalledTimes(3)
      stop()
      expect(localeListeners.size).toBe(0)
      vi.advanceTimersByTime(48 * 3_600_000)
      expect(onChange).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })
})
