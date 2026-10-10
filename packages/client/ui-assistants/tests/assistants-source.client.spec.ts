import { describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { AssistantsState, CreateAssistantInput } from '@deepseek-ai/dsh-assistants/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { assistantOf, assistantSessions, createAssistantsSource, shownAssistant, type BlankSession } from '../src/client/assistants-source.ts'

const state: AssistantsState = {
  revision: 1, tenantId: 't-a', templates: [],
  assistants: [
    { id: 'a1', name: '日常助手', description: 'd', avatar: { kind: 'preset', key: 'sun' }, createdAt: '2026-10-07T00:00:00Z' },
    { id: 'a2', name: '电商管家', description: '', avatar: { kind: 'preset', key: 'sun' }, createdAt: '2026-10-07T00:00:01Z' },
  ],
}
const sid = (id: string) => id as SessionSummary['id']
const unused = {
  sessionList: createSnapshotStore({ ids: [], byId: {} }) as never, openSession: vi.fn(),
  loadOptions: vi.fn(), squareAvatar: vi.fn(), read: vi.fn(), update: vi.fn(),
  duplicate: vi.fn(), remove: vi.fn(), sessionCount: vi.fn(), otherTenant: vi.fn(),
}
const refused = (message: string) => ({ ok: false, error: new RemoteError('assistants/not-found', message, { assistantId: 'x' }) }) as never

function harness(initial: BlankSession | undefined) {
  let blank = initial
  const select = vi.fn((_sessionId: SessionSummary['id'], assistantId: string | null) => Promise.resolve({ ok: true as const, value: assistantId }))
  const startSession = vi.fn()
  const create = vi.fn(async (_input: CreateAssistantInput) => ({ ok: true as const, value: { assistantId: 'a3', state: { ...state, revision: 2 } } }))
  const loadOptions = vi.fn(async () => ({ models: [], presets: [] }))
  const squareAvatar = vi.fn(async (_file: Blob) => 'data:image/webp;base64,AA')
  const ok = <T>(value: T) => ({ ok: true as const, value })
  const read = vi.fn(async (assistantId: string) => ok({ assistant: state.assistants[0]!, files: { 'IDENTITY.md': assistantId, 'SOUL.md': '', 'USER.md': '', 'AGENTS.md': '' } }))
  const update = vi.fn(async (_id: string, _input: object) => ok({ ...state, revision: 3 }))
  const duplicate = vi.fn(async (_id: string) => ok({ assistantId: 'a9', state: { ...state, revision: 5 } }))
  const remove = vi.fn(async (_id: string) => ok({ ...state, revision: 6, assistants: [state.assistants[1]!] }))
  const sessionCount = vi.fn((_id: string) => 3)
  const openSession = vi.fn()
  const source = createAssistantsSource({
    select, startSession, blankSession: () => blank, create, loadOptions, squareAvatar,
    read, update, duplicate, remove, sessionCount, sessionList: unused.sessionList, openSession,
    otherTenant: vi.fn(async () => ({ ok: true as const, value: [] })),
  })
  source.publish(state)
  return {
    source, select, startSession, create, loadOptions, squareAvatar, read, update, duplicate, remove, sessionCount, openSession,
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

  it('picks the first assistant created from a template, keeps a current one from it, and reports a missing template', async () => {
    const h = harness({ id: sid('s1'), assistantId: null })
    h.source.publish({
      ...state, revision: 2,
      assistants: [state.assistants[0]!, { ...state.assistants[1]!, templateId: 'ecommerce' }, { ...state.assistants[1]!, id: 'a3', templateId: 'ecommerce' }],
    })
    expect(await h.source.pickTemplate('ecommerce')).toBe(true)
    expect(h.select).toHaveBeenCalledWith('s1', 'a2')
    // Already showing an assistant from the template (here the copy a3): left as is.
    h.setBlank({ id: sid('s1'), assistantId: 'a3' })
    await h.source.sessionsChanged()
    h.select.mockClear()
    expect(await h.source.pickTemplate('ecommerce')).toBe(true)
    expect(h.select).not.toHaveBeenCalled()
    expect(await h.source.pickTemplate('daily')).toBe(false)
    expect(h.select).not.toHaveBeenCalled()
  })

  it('reports no template before the first state frame', async () => {
    const source = createAssistantsSource({
      select: vi.fn(), startSession: vi.fn(), blankSession: () => undefined, create: vi.fn(), ...unused,
    })
    expect(await source.pickTemplate('ecommerce')).toBe(false)
  })

  it('binds no assistant to the blank session when none is picked', async () => {
    const h = harness({ id: sid('s1'), assistantId: 'a1' })
    await h.source.onPick(null)
    expect(h.select).toHaveBeenCalledWith('s1', null)
    expect(h.snapshot()).toMatchObject({ staged: undefined, busy: false, bound: null, failure: null })
    expect(shownAssistant(h.snapshot())).toBeNull()
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

  it('shows no assistant before any session or pick, and before the first frame', () => {
    const empty = createAssistantsSource({
      ...unused, select: vi.fn(), startSession: vi.fn(), blankSession: () => undefined, create: vi.fn(),
    })
    expect(shownAssistant(empty.hooks.assistants.getSnapshot())).toBeNull()
    const h = harness(undefined)
    expect(shownAssistant(h.snapshot())).toBeNull()
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

  it('saves and deletes, adopting each newer state', async () => {
    const h = harness(undefined)
    expect(await h.source.onUpdate('a1', { name: '新' })).toBeUndefined()
    expect(h.update).toHaveBeenCalledWith('a1', { name: '新' })
    expect(h.snapshot().state?.revision).toBe(3)
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

describe('sessions of an assistant', () => {
  const row = (id: string, over: object = {}) => ({ id, displayTitle: `会话 ${id}`, blank: false, updatedAt: 1, retainedBy: {}, running: false, ...over }) as never
  it('reads the assistant a row is bound to', () => {
    expect(assistantOf(undefined)).toBeNull()
    expect(assistantOf(row('s1'))).toBeNull()
    expect(assistantOf(row('s1', { projectionValues: { assistant: 'a1' } }))).toBe('a1')
    expect(assistantOf(row('s1', { projectionValues: { assistant: null } }))).toBeNull()
  })

  it('lists the started main sessions of an assistant, latest first', () => {
    const list = {
      ids: ['old', 'new', 'blank', 'child', 'other', 'gone'],
      byId: {
        old: row('old', { updatedAt: 1, projectionValues: { assistant: 'a1' } }),
        new: row('new', { updatedAt: 9, projectionValues: { assistant: 'a1' } }),
        blank: row('blank', { blank: true, projectionValues: { assistant: 'a1' } }),
        child: row('child', { origin: 'subagent', projectionValues: { assistant: 'a1' } }),
        other: row('other', { projectionValues: { assistant: 'a2' } }),
      },
    } as never
    expect(assistantSessions(list, 'a1')).toEqual([{ id: 'new', title: '会话 new', updatedAt: 9 }, { id: 'old', title: '会话 old', updatedAt: 1 }])
  })

  it('opens a session through the workspace', () => {
    const h = harness(undefined)
    h.source.onOpenSession(sid('s9'))
    expect(h.openSession).toHaveBeenCalledWith('s9')
  })
})

describe('another company\'s assistants', () => {
  const listed = (bindings: Record<string, string | null>) => createSnapshotStore({
    ids: Object.keys(bindings),
    byId: Object.fromEntries(Object.entries(bindings)
      .map(([id, bound]) => [id, { id, projectionValues: bound === null ? {} : { assistant: bound } }])),
  })
  function lookup(bindings: Record<string, string | null>, answer: (ids: readonly string[]) => Promise<unknown>) {
    const sessionList = listed(bindings)
    const otherTenant = vi.fn(answer)
    const source = createAssistantsSource({
      ...unused, sessionList: sessionList as never, select: vi.fn(), startSession: vi.fn(), blankSession: () => undefined, create: vi.fn(),
      otherTenant: otherTenant as never,
    })
    return { source, sessionList, otherTenant, elsewhere: () => source.hooks.assistants.getSnapshot().elsewhere }
  }

  it('asks the Host once about bound ids the tenant lacks, and keeps the answers until the tenant changes', async () => {
    const l = lookup({ s1: 'a1', s2: 'b1', s3: 'gone', s4: null, s5: 'b1' }, async ids => ({ ok: true, value: ids.filter(id => id === 'b1') }))
    l.source.publish(state)
    await vi.waitFor(() => { expect(l.elsewhere()).toEqual({ asked: ['b1', 'gone'], otherTenant: ['b1'] }) })
    expect(l.otherTenant).toHaveBeenCalledWith(['b1', 'gone'])
    await l.source.sessionsChanged()
    l.source.publish({ ...state, revision: 2 })
    expect(l.otherTenant).toHaveBeenCalledTimes(1)
    // Another tenant: the answers are dropped and asked again, now with a1 outside it too.
    l.source.publish({ ...state, revision: 3, tenantId: 't-b', assistants: [] })
    await vi.waitFor(() => { expect(l.otherTenant).toHaveBeenLastCalledWith(['a1', 'b1', 'gone']) })
    // Signed out: nothing is kept and nothing is asked.
    l.source.publish({ ...state, revision: 4, tenantId: null, assistants: [] })
    expect(l.elsewhere()).toEqual({ asked: [], otherTenant: [] })
    expect(l.otherTenant).toHaveBeenCalledTimes(2)
  })

  it('drops an answer for a tenant no longer signed in, and asks again after a failure', async () => {
    let release: (value: unknown) => void = () => {}
    const answers: (() => Promise<unknown>)[] = [
      () => new Promise((resolve) => { release = resolve }),
      async () => ({ ok: true, value: ['b1'] }),
      async () => ({ ok: false, error: new Error('refused') }),
      async () => { throw new Error('disconnected') },
      async () => ({ ok: true, value: [] }),
    ]
    const l = lookup({ s1: 'b1' }, () => answers.shift()!())
    l.source.publish(state)
    l.source.publish({ ...state, revision: 2, tenantId: 't-c' })
    release({ ok: true, value: ['b1'] })
    await vi.waitFor(() => { expect(l.elsewhere()).toEqual({ asked: ['b1'], otherTenant: ['b1'] }) })
    expect(l.otherTenant).toHaveBeenCalledTimes(2)
    l.source.publish({ ...state, revision: 3, tenantId: 't-d' })
    await vi.waitFor(() => { expect(l.otherTenant).toHaveBeenCalledTimes(3) })
    expect(l.elsewhere()).toEqual({ asked: [], otherTenant: [] })
    await l.source.sessionsChanged()
    await vi.waitFor(() => { expect(l.otherTenant).toHaveBeenCalledTimes(4) })
    expect(l.elsewhere().asked).toEqual([])
    await l.source.sessionsChanged()
    await vi.waitFor(() => { expect(l.elsewhere()).toEqual({ asked: ['b1'], otherTenant: [] }) })
  })
})
