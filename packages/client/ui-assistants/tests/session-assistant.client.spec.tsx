// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { AssistantsState } from '@deepseek-ai/dsh-assistants/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { AssistantsSnapshot } from '../src/client/assistants-source.ts'
import { en, zh } from '../src/client/locales.ts'
import { SessionAssistantBadge, SessionAssistantHover } from '../src/client/SessionAssistant.tsx'

afterEach(() => { cleanup() })

const state: AssistantsState = {
  revision: 1, tenantId: 't-a', defaultId: 'a1', templates: [],
  assistants: [{ id: 'a1', name: '店铺复盘助手', description: '', avatar: { kind: 'preset', key: 'sun' }, createdAt: '2026-10-07T00:00:00Z' }],
}

function mount(
  Component: typeof SessionAssistantBadge, bound: string | null | undefined,
  value: AssistantsState | null = state, copy: Record<string, string> = zh,
) {
  // null stands for no state yet.
  const assistants = createSnapshotStore<AssistantsSnapshot>({
    state: value ?? undefined, bound: null, staged: undefined, busy: false, failure: null,
  })
  const byId = bound === undefined ? {} : { s1: { id: 's1', projectionValues: bound === null ? {} : { assistant: bound } } }
  const sessions = createSnapshotStore({ ids: Object.keys(byId), byId })
  const props = {
    sessionId: 's1', t: makeTranslate(copy), useAssistants: bindSnapshotSelector(assistants), useSessions: bindSnapshotSelector(sessions),
  } as never as Parameters<typeof SessionAssistantBadge>[0]
  return render(<Component {...props} />)
}

describe('session row assistant', () => {
  it('shows the assistant\'s avatar, named on hover', () => {
    mount(SessionAssistantBadge, 'a1')
    const badge = screen.getByRole('img', { name: '智能体：店铺复盘助手' })
    expect(badge.getAttribute('title')).toBe('智能体：店铺复盘助手')
    expect(badge.getAttribute('data-assistant-badge')).toBe('assistant')
    expect(badge.textContent).toBe('店')
  })

  it('marks a session whose assistant is gone, in English too', () => {
    mount(SessionAssistantBadge, 'gone', state, en)
    const badge = screen.getByRole('img', { name: 'Deleted assistant' })
    expect(badge.getAttribute('data-assistant-badge')).toBe('deleted')
    expect(badge.textContent).toBe('?')
  })

  it('shows nothing for a session without an assistant, an unlisted one, or before the state is known or while signed out', () => {
    expect(mount(SessionAssistantBadge, null).container.innerHTML).toBe('')
    cleanup()
    expect(mount(SessionAssistantBadge, undefined).container.innerHTML).toBe('')
    cleanup()
    expect(mount(SessionAssistantBadge, 'a1', null).container.innerHTML).toBe('')
    cleanup()
    expect(mount(SessionAssistantBadge, 'a1', { ...state, tenantId: null, assistants: [] }).container.innerHTML).toBe('')
  })

  it('names the assistant, or the deleted one, in the hover card', () => {
    mount(SessionAssistantHover, 'a1')
    expect(screen.getByText('智能体：店铺复盘助手')).toBeTruthy()
    cleanup()
    mount(SessionAssistantHover, 'gone')
    expect(screen.getByText('已删除的智能体')).toBeTruthy()
    cleanup()
    expect(mount(SessionAssistantHover, null).container.innerHTML).toBe('')
  })
})
