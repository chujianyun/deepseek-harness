import { describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { AssistantsState } from '@deepseek-ai/dsh-assistants/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { createAssistantsSource, shownAssistant, type BlankSession } from '../src/client/assistants-source.ts'

const state: AssistantsState = {
  revision: 1, tenantId: 't-a', defaultId: 'a1',
  assistants: [
    { id: 'a1', name: '日常助手', description: 'd', avatar: { kind: 'preset', key: 'sun' }, createdAt: '2026-10-07T00:00:00Z' },
    { id: 'a2', name: '电商管家', description: '', avatar: { kind: 'preset', key: 'sun' }, createdAt: '2026-10-07T00:00:01Z' },
  ],
}
const sid = (id: string) => id as SessionSummary['id']

function harness(initial: BlankSession | undefined) {
  let blank = initial
  const select = vi.fn((_sessionId: SessionSummary['id'], assistantId: string) => Promise.resolve({ ok: true as const, value: assistantId }))
  const startSession = vi.fn()
  const source = createAssistantsSource({ select, startSession, blankSession: () => blank })
  source.publish(state)
  return {
    source, select, startSession,
    setBlank: (next: BlankSession | undefined) => { blank = next },
    snapshot: () => source.hooks.assistants.getSnapshot(),
  }
}

describe('assistants source', () => {
  it('binds a pick to the blank session the main view shows', async () => {
    const h = harness({ id: sid('s1'), assistantId: 'a1' })
    await h.source.onPick('a2')
    expect(h.select).toHaveBeenCalledWith('s1', 'a2')
    expect(h.snapshot()).toMatchObject({ staged: undefined, busy: false, bound: 'a2', failure: null })
    expect(shownAssistant(h.snapshot())).toBe('a2')
  })

  it('keeps a pick staged until a blank session appears, then binds it once', async () => {
    const h = harness(undefined)
    await h.source.onPick('a2')
    expect(h.select).not.toHaveBeenCalled()
    expect(shownAssistant(h.snapshot())).toBe('a2')
    h.setBlank({ id: sid('s2'), assistantId: 'a1' })
    await h.source.sessionsChanged()
    await h.source.sessionsChanged()
    expect(h.select).toHaveBeenCalledTimes(1)
    expect(h.select).toHaveBeenCalledWith('s2', 'a2')
  })

  it('drops a pick the blank session already carries without calling the Host', async () => {
    const h = harness({ id: sid('s1'), assistantId: 'a2' })
    await h.source.onPick('a2')
    expect(h.select).not.toHaveBeenCalled()
    expect(h.snapshot().staged).toBeUndefined()
  })

  it('opens the new-session screen for Chat and binds the session it brings', async () => {
    const h = harness(undefined)
    await h.source.onChat('a2')
    expect(h.startSession).toHaveBeenCalledOnce()
    h.setBlank({ id: sid('s3'), assistantId: 'a1' })
    await h.source.sessionsChanged()
    expect(h.select).toHaveBeenCalledWith('s3', 'a2')
  })

  it('reports a refused or failed bind and keeps showing the session\'s own assistant', async () => {
    const h = harness({ id: sid('s1'), assistantId: 'a1' })
    h.select.mockResolvedValueOnce({ ok: false, error: new RemoteError('assistants/not-found', 'gone', { assistantId: 'a2' }) } as never)
    await h.source.onPick('a2')
    expect(h.snapshot()).toMatchObject({ failure: 'gone', bound: 'a1', staged: undefined })
    h.source.onDismiss()
    expect(h.snapshot().failure).toBeNull()
    h.select.mockRejectedValueOnce(new Error('offline'))
    await h.source.onPick('a2')
    expect(h.snapshot().failure).toBe('offline')
    h.select.mockRejectedValueOnce('down')
    await h.source.onPick('a2')
    expect(h.snapshot().failure).toBe('down')
  })

  it('shows the tenant default before any session or pick, and nothing before the first frame', () => {
    const empty = createAssistantsSource({ select: vi.fn(), startSession: vi.fn(), blankSession: () => undefined })
    expect(shownAssistant(empty.hooks.assistants.getSnapshot())).toBeNull()
    const h = harness(undefined)
    expect(shownAssistant(h.snapshot())).toBe('a1')
  })
})
