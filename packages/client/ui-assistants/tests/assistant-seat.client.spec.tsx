// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { AssistantsState } from '@deepseek-ai/dsh-assistants/types'
import type { SessionRetainInfo } from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { AssistantsSnapshot } from '../src/client/assistants-source.ts'
import { AssistantSeat, type AssistantSeatProps } from '../src/client/AssistantSeat.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.useRealTimers() })

const state: AssistantsState = {
  revision: 1, tenantId: 't-a', defaultId: 'a1', templates: [{ id: 'daily', name: '日常助手', description: 'd', avatar: { kind: 'preset', key: 'sun' } }],
  assistants: [
    { id: 'a1', name: '日常助手', description: '通用日常助手', avatar: { kind: 'preset', key: 'sun' }, createdAt: '2026-10-07T00:00:00Z' },
    { id: 'a2', name: '电商管家', description: '', avatar: { kind: 'preset', key: 'sun' }, createdAt: '2026-10-07T00:00:01Z' },
  ],
}

function mount(extra: Partial<AssistantsSnapshot> = {}, mainView: number | null = 1, sessionId: string | null = 's1') {
  const initial: AssistantsSnapshot = {
    state, bound: null, staged: undefined, busy: false, failure: null, elsewhere: { asked: [], otherTenant: [] },
  }
  const store = createSnapshotStore<AssistantsSnapshot>({ ...initial, ...extra })
  const retainInfo = mainView === null ? undefined : { retainedBy: { mainView } } as SessionRetainInfo
  const props = {
    t: makeTranslate(zh), useAssistants: bindSnapshotSelector(store),
    useSessionRetainInfo: <Selected,>(selector: (value: SessionRetainInfo | undefined) => Selected) => selector(retainInfo),
    sessionId: sessionId === null ? undefined : SessionId(sessionId),
    onPick: vi.fn(async (_id: string) => {}), onChat: vi.fn(async (_id: string) => {}), onDismiss: vi.fn(),
    onCreate: vi.fn(), onLoadOptions: vi.fn(), squareAvatar: vi.fn(),
  } as AssistantSeatProps
  render(<AssistantSeat {...props} />)
  return { props, store }
}

describe('assistant picker', () => {
  it('shows the tenant default, then the session\'s own and a staged pick', () => {
    const { store } = mount()
    const chip = screen.getByRole('button', { name: '选择这个会话的智能体' })
    expect(chip.textContent).toContain('日常助手')
    act(() => { store.set({ ...store.getSnapshot(), bound: 'a2' }) })
    expect(chip.textContent).toContain('电商管家')
    act(() => { store.set({ ...store.getSnapshot(), staged: 'a1' }) })
    expect(chip.textContent).toContain('日常助手')
  })

  it('picks another assistant from the menu', () => {
    const { props } = mount()
    fireEvent.click(screen.getByRole('button', { name: '选择这个会话的智能体' }))
    fireEvent.click(screen.getByText('电商管家'))
    expect(props.onPick).toHaveBeenCalledWith('a2')
  })

  it('renders nothing outside the main view or when the tenant has no assistants', () => {
    mount({}, 0)
    expect(screen.queryByRole('button')).toBeNull()
    cleanup()
    mount({ state: { ...state, assistants: [], defaultId: null } })
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('shows the picker on the new-session screen before any session exists', () => {
    mount({}, 0, null)
    expect(screen.getByRole('button', { name: '选择这个会话的智能体' })).toBeTruthy()
  })

  it('falls back to the panel name when the shown assistant is gone, and is disabled while binding', () => {
    mount({ bound: 'gone', busy: true })
    const chip = screen.getByRole('button', { name: '选择这个会话的智能体' }) as HTMLButtonElement
    expect(chip.textContent).toContain('智能体')
    expect(chip.disabled).toBe(true)
  })

  it('closes its menu on Escape, and when the tenant loses every assistant', () => {
    const { store } = mount({ state: { ...state, defaultId: null } })
    const chip = screen.getByRole('button', { name: '选择这个会话的智能体' })
    expect(chip.textContent).toContain('智能体')
    fireEvent.click(chip)
    expect(chip.getAttribute('aria-expanded')).toBe('true')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(chip.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(chip)
    act(() => { store.set({ ...store.getSnapshot(), state: { ...state, assistants: [] } }) })
    expect(screen.queryByRole('button')).toBeNull()
    act(() => { store.set({ ...store.getSnapshot(), state }) })
    expect(screen.getByRole('button', { name: '选择这个会话的智能体' }).getAttribute('aria-expanded')).toBe('false')
  })

  it('renders nothing while the session\'s retain info is unknown', () => {
    mount({}, null)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('renders nothing before the first frame', () => {
    mount({ state: undefined })
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('announces a refused pick in a toast', () => {
    vi.useFakeTimers()
    const { props } = mount({ failure: 'gone' })
    expect(screen.getByText('无法切换智能体：gone')).toBeTruthy()
    act(() => { vi.runAllTimers() })
    expect(props.onDismiss).toHaveBeenCalled()
  })
})
