// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { AssistantsState } from '@deepseek-ai/dsh-assistants/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { AssistantsSnapshot } from '../src/client/assistants-source.ts'
import { en, zh } from '../src/client/locales.ts'
import { assistantGrouping } from '../src/client/session-grouping.tsx'

afterEach(() => { cleanup() })

const noLocaleChanges = () => () => {}

const state: AssistantsState = {
  revision: 1, tenantId: 't-a', templates: [],
  assistants: [
    { id: 'a1', name: '电商管家', description: '', avatar: { kind: 'preset', key: 'sun' }, createdAt: '2026-10-07T00:00:00Z' },
    { id: 'a2', name: '日常助手', description: '', avatar: { kind: 'image', dataUrl: 'data:image/png;base64,AA==' }, createdAt: '2026-10-07T00:00:00Z' },
  ],
}
const snapshot = (value: AssistantsState | undefined): AssistantsSnapshot => ({
  state: value, bound: null, staged: undefined, busy: false, failure: null, elsewhere: { asked: [], otherTenant: [] },
})
const session = (assistant?: string) => ({ projectionValues: assistant === undefined ? {} : { assistant } }) as never as SessionSummary
/** The text and tone an icon element draws. */
const drawn = (icon: unknown) => {
  const { container } = render(<>{icon as never}</>)
  const node = container.firstElementChild
  return { tag: node?.tagName, text: node?.textContent, tone: node?.getAttribute('data-tone') }
}

describe('the Assistant grouping', () => {
  it.each([
    [zh, '智能体', '通用模式', '其他'],
    [en, 'Assistant', 'General mode', 'Other'],
  ])('sections Sessions by their assistant, with General mode for none and Other for one it cannot name', (copy, label, general, other) => {
    const grouping = assistantGrouping(key => copy[key], createSnapshotStore(snapshot(state)), noLocaleChanges)
    expect(grouping).toMatchObject({ id: 'assistant', order: 50 })
    expect(grouping.label()).toBe(label)
    expect(drawn(grouping.icon).tag).toBe('svg')

    const first = grouping.groupOf(session('a1'))
    expect(first).toMatchObject({ key: 'assistant:a1', label: '电商管家' })
    expect(first.rank).toBeUndefined()
    expect(drawn(first.icon)).toEqual({ tag: 'SPAN', text: '电', tone: 'sun' })
    const second = grouping.groupOf(session('a2'))
    expect(second).toMatchObject({ key: 'assistant:a2', label: '日常助手' })
    expect(drawn(second.icon).tag).toBe('IMG')

    const none = grouping.groupOf(session())
    expect(none).toMatchObject({ key: 'general', label: general })
    expect(drawn(none.icon)).toEqual({ tag: 'SPAN', text: Array.from(general)[0], tone: 'neutral' })
    // Deleted, or another company's: the group names nothing about the assistant.
    const unknown = grouping.groupOf(session('gone'))
    expect(unknown).toMatchObject({ key: 'other', label: other })
    expect(drawn(unknown.icon)).toEqual({ tag: 'SPAN', text: '?', tone: 'neutral' })
  })

  it('puts every bound Session under Other while signed out or before the first state', () => {
    for (const value of [undefined, { ...state, tenantId: null, assistants: [] }]) {
      const grouping = assistantGrouping(key => zh[key], createSnapshotStore(snapshot(value)), noLocaleChanges)
      expect(grouping.groupOf(session('a1')).key).toBe('other')
      expect(grouping.groupOf(session()).key).toBe('general')
      // The sidebar keeps stored folds until the tenant's assistants are known.
      expect(grouping.ready!()).toBe(false)
    }
    expect(assistantGrouping(key => zh[key], createSnapshotStore(snapshot(state)), noLocaleChanges).ready!()).toBe(true)
  })

  it('reports a new assistants state or a language switch until unsubscribed, and regroups by the new state', () => {
    const store = createSnapshotStore(snapshot(state))
    const localeListeners = new Set<() => void>()
    const grouping = assistantGrouping(key => zh[key], store, (onChange) => {
      localeListeners.add(onChange)
      return () => { localeListeners.delete(onChange) }
    })
    const onChange = vi.fn()
    const stop = grouping.subscribe!(onChange)
    // The same heading object serves every Session of an assistant while the state stands.
    expect(grouping.groupOf(session('a1'))).toBe(grouping.groupOf(session('a1')))
    // A pick in progress changes the snapshot, not the assistants.
    store.set({ ...snapshot(state), busy: true })
    expect(onChange).not.toHaveBeenCalled()
    store.set(snapshot({ ...state, revision: 2, assistants: [{ ...state.assistants[0]!, name: '店铺管家' }] }))
    expect(onChange).toHaveBeenCalledOnce()
    expect(grouping.groupOf(session('a1')).label).toBe('店铺管家')
    expect(grouping.groupOf(session('a2')).key).toBe('other')
    for (const listener of localeListeners) listener()
    expect(onChange).toHaveBeenCalledTimes(2)
    stop()
    expect(localeListeners.size).toBe(0)
    store.set(snapshot(state))
    expect(onChange).toHaveBeenCalledTimes(2)
  })
})
