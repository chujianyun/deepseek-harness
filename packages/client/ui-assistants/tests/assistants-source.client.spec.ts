import { describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { AssistantsState, CreateAssistantInput } from '@deepseek-ai/dsh-assistants/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { createAssistantsSource, shownAssistant, type BlankSession } from '../src/client/assistants-source.ts'

const state: AssistantsState = {
  revision: 1, tenantId: 't-a', defaultId: 'a1', templates: [],
  assistants: [
    { id: 'a1', name: '日常助手', description: 'd', avatar: { kind: 'preset', key: 'sun' }, createdAt: '2026-10-07T00:00:00Z' },
    { id: 'a2', name: '电商管家', description: '', avatar: { kind: 'preset', key: 'sun' }, createdAt: '2026-10-07T00:00:01Z' },
  ],
}
const sid = (id: string) => id as SessionSummary['id']
const unused = {
  loadOptions: vi.fn(), squareAvatar: vi.fn(), read: vi.fn(), update: vi.fn(),
  setDefault: vi.fn(), duplicate: vi.fn(), remove: vi.fn(), sessionCount: vi.fn(),
}
const refused = (message: string) => ({ ok: false, error: new RemoteError('assistants/not-found', message, { assistantId: 'x' }) }) as never

function harness(initial: BlankSession | undefined) {
  let blank = initial
  const select = vi.fn((_sessionId: SessionSummary['id'], assistantId: string) => Promise.resolve({ ok: true as const, value: assistantId }))
  const startSession = vi.fn()
  const create = vi.fn(async (_input: CreateAssistantInput) => ({ ok: true as const, value: { assistantId: 'a3', state: { ...state, revision: 2 } } }))
  const loadOptions = vi.fn(async () => ({ models: [], presets: [] }))
  const squareAvatar = vi.fn(async (_file: Blob) => 'data:image/webp;base64,AA')
  const ok = <T>(value: T) => ({ ok: true as const, value })
  const read = vi.fn(async (assistantId: string) => ok({ assistant: state.assistants[0]!, files: { 'IDENTITY.md': assistantId, 'SOUL.md': '', 'USER.md': '', 'AGENTS.md': '' } }))
  const update = vi.fn(async (_id: string, _input: object) => ok({ ...state, revision: 3 }))
  const setDefault = vi.fn(async (_id: string) => ok({ ...state, revision: 4, defaultId: 'a2' }))
  const duplicate = vi.fn(async (_id: string) => ok({ assistantId: 'a9', state: { ...state, revision: 5 } }))
  const remove = vi.fn(async (_id: string) => ok({ ...state, revision: 6, assistants: [state.assistants[1]!] }))
  const sessionCount = vi.fn((_id: string) => 3)
  const source = createAssistantsSource({
    select, startSession, blankSession: () => blank, create, loadOptions, squareAvatar,
    read, update, setDefault, duplicate, remove, sessionCount,
  })
  source.publish(state)
  return {
    source, select, startSession, create, loadOptions, squareAvatar, read, update, setDefault, duplicate, remove, sessionCount,
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
    const empty = createAssistantsSource({
      ...unused, select: vi.fn(), startSession: vi.fn(), blankSession: () => undefined, create: vi.fn(),
    })
    expect(shownAssistant(empty.hooks.assistants.getSnapshot())).toBeNull()
    const h = harness(undefined)
    expect(shownAssistant(h.snapshot())).toBe('a1')
  })

  it('creates through the Host, keeping the newer of its answer and the stream, and reports a refusal', async () => {
    const h = harness(undefined)
    const user = { name: '', language: '', notes: '', background: '' }
    const input = { templateId: null, name: 'x', description: '', avatar: { kind: 'preset', key: 'sun' }, user } as const
    expect(await h.source.onCreate(input)).toBeUndefined()
    expect(h.snapshot().state?.revision).toBe(2)
    h.source.publish({ ...state, revision: 5 })
    expect(await h.source.onCreate(input)).toBeUndefined()
    expect(h.snapshot().state?.revision).toBe(5)
    h.create.mockResolvedValueOnce({ ok: false, error: new RemoteError('assistants/invalid-name', 'bad name', { name: 'x' }) } as never)
    expect(await h.source.onCreate(input)).toBe('bad name')
    await h.source.onLoadOptions()
    expect(h.loadOptions).toHaveBeenCalledOnce()
    expect(await h.source.squareAvatar(new Blob(['x']))).toBe('data:image/webp;base64,AA')
  })

  it('creates before the first frame arrives', async () => {
    const create = vi.fn(async () => ({ ok: true as const, value: { assistantId: 'a', state } }))
    const source = createAssistantsSource({
      ...unused, select: vi.fn(), startSession: vi.fn(), blankSession: () => undefined, create,
    })
    const user = { name: '', language: '', notes: '', background: '' }
    await source.onCreate({ templateId: null, name: 'x', description: '', avatar: { kind: 'preset', key: 'sun' }, user })
    expect(source.hooks.assistants.getSnapshot().state).toBe(state)
  })
})

describe('managing assistants through the source', () => {
  it('reads an assistant, or reports the refusal', async () => {
    const h = harness(undefined)
    expect(await h.source.onRead('a1')).toMatchObject({ files: { 'IDENTITY.md': 'a1' } })
    h.read.mockResolvedValueOnce(refused('gone'))
    expect(await h.source.onRead('a1')).toBe('gone')
  })

  it('saves, sets the default, and deletes, adopting each newer state', async () => {
    const h = harness(undefined)
    expect(await h.source.onUpdate('a1', { name: '新' })).toBeUndefined()
    expect(h.update).toHaveBeenCalledWith('a1', { name: '新' })
    expect(h.snapshot().state?.revision).toBe(3)
    expect(await h.source.onSetDefault('a2')).toBeUndefined()
    expect(h.snapshot().state?.defaultId).toBe('a2')
    expect(await h.source.onDelete('a1')).toBeUndefined()
    expect(h.snapshot().state?.assistants.map(item => item.id)).toEqual(['a2'])
    h.remove.mockResolvedValueOnce(refused('gone'))
    expect(await h.source.onDelete('a1')).toBe('gone')
  })

  it('duplicates, returning the copy\'s id, or reports the refusal', async () => {
    const h = harness(undefined)
    expect(await h.source.onDuplicate('a1')).toEqual({ assistantId: 'a9' })
    expect(h.snapshot().state?.revision).toBe(5)
    h.duplicate.mockResolvedValueOnce(refused('gone'))
    expect(await h.source.onDuplicate('a1')).toBe('gone')
  })

  it('counts the assistant\'s sessions', () => {
    const h = harness(undefined)
    expect(h.source.sessionCount('a1')).toBe(3)
    expect(h.sessionCount).toHaveBeenCalledWith('a1')
  })
})
