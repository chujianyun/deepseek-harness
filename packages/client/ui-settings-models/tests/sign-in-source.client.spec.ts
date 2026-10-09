/** Account sign-in source: Host frames, per-key busy and refusal state, and opening a started attempt's page. */
import { describe, expect, it, vi } from 'vitest'
import type {
  AuthorizationAttemptId, AuthorizationAttemptView, AuthorizationFlowView, AuthorizationPromptId,
} from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { createSignInSource, type SignInDependencies } from '../src/client/sign-in-source.ts'

const KEY = 'llm-pi-ai/openai-codex'
const OTHER = 'llm-pi-ai/anthropic'

function attempt(id: string, overrides: Partial<AuthorizationAttemptView> = {}): AuthorizationAttemptView {
  return { id: id as AuthorizationAttemptId, method: 'oauth', phase: 'running', notices: [], prompts: [], ...overrides }
}

function flow(key: string, overrides: Partial<AuthorizationFlowView> = {}): AuthorizationFlowView {
  return { key, label: key, methods: [{ id: 'oauth', label: 'Sign in' }], signedIn: false, attempt: null, ...overrides }
}

const okay = <T>(value: T) => Promise.resolve({ ok: true as const, value })
const refused = (message: string) => Promise.resolve({ ok: false as const, error: new RemoteError('authorization/rejected', message, { key: KEY }) })

function source(opensPages = true) {
  const deps = {
    opensPages,
    begin: vi.fn<SignInDependencies['begin']>(key => okay(flow(key, { attempt: attempt('a1') }))),
    answer: vi.fn<SignInDependencies['answer']>(() => okay(undefined)),
    cancel: vi.fn<SignInDependencies['cancel']>(() => okay(undefined)),
    signOut: vi.fn<SignInDependencies['signOut']>(key => okay(flow(key))),
    open: vi.fn<SignInDependencies['open']>(),
  }
  return { deps, ...createSignInSource(deps) }
}

const promptId = '1' as AuthorizationPromptId

describe('createSignInSource', () => {
  it('replaces every flow view with each Host frame', () => {
    const s = source()
    s.publish([flow(KEY), flow(OTHER, { signedIn: true })])
    expect(Object.keys(s.store.getSnapshot().flows)).toEqual([KEY, OTHER])
    s.publish([flow(KEY, { signedIn: true })])
    expect(s.store.getSnapshot().flows).toEqual({ [KEY]: flow(KEY, { signedIn: true }) })
  })

  it('opens the first page an attempt it started reports, once', async () => {
    const s = source()
    await s.actions.begin(KEY, 'oauth')
    expect(s.deps.begin).toHaveBeenCalledWith(KEY, 'oauth')
    expect(s.store.getSnapshot().flows[KEY]?.attempt?.id).toBe('a1')
    expect(s.deps.open).not.toHaveBeenCalled()
    const withPage = attempt('a1', { notices: [{ message: 'Pick a method' }, { message: 'Open it', url: 'https://auth.example/1' }] })
    s.publish([flow(KEY, { attempt: withPage })])
    s.publish([flow(KEY, { attempt: { ...withPage, notices: [...withPage.notices, { message: 'Again', url: 'https://auth.example/2' }] } })])
    expect(s.deps.open).toHaveBeenCalledExactlyOnceWith('https://auth.example/1')
  })

  it('opens a page the begin answer already carries, even when a frame announced the attempt first', async () => {
    const s = source()
    const started = attempt('a2', { notices: [{ message: 'Open it', url: 'https://auth.example/2' }] })
    s.deps.begin.mockImplementationOnce((key) => {
      s.publish([flow(key, { attempt: started })])
      return okay(flow(key, { attempt: started }))
    })
    await s.actions.begin(KEY, 'oauth')
    expect(s.deps.open).toHaveBeenCalledExactlyOnceWith('https://auth.example/2')
  })

  it('keeps a newer stream frame over the begin answer for the same attempt', async () => {
    const s = source()
    const asked = attempt('a4', { prompts: [{ id: promptId, kind: 'select', message: 'How?', options: [{ id: 'browser', label: 'Browser' }] }] })
    s.deps.begin.mockImplementationOnce((key) => {
      // The flow asked its first question before the call answered.
      s.publish([flow(key, { attempt: asked })])
      return okay(flow(key, { attempt: attempt('a4') }))
    })
    await s.actions.begin(KEY, 'oauth')
    expect(s.store.getSnapshot().flows[KEY]?.attempt?.prompts).toHaveLength(1)
  })

  it('does not open pages for an attempt it joined or one that ended before naming a page', async () => {
    const s = source()
    s.publish([flow(KEY, { attempt: attempt('a1') })])
    await s.actions.begin(KEY, 'oauth')
    s.publish([flow(KEY, { attempt: attempt('a1', { notices: [{ message: 'Open', url: 'https://auth.example' }] }) })])
    expect(s.deps.open).not.toHaveBeenCalled()

    s.deps.begin.mockImplementationOnce(key => okay(flow(key, { attempt: attempt('a3') })))
    await s.actions.begin(KEY, 'oauth')
    s.publish([flow(KEY, { attempt: attempt('a3', { phase: 'cancelled' }) })])
    s.publish([flow(KEY, { attempt: attempt('a3', { notices: [{ message: 'Open', url: 'https://late.example' }] }) })])
    expect(s.deps.open).not.toHaveBeenCalled()
  })

  it('marks a key busy while its action runs and keeps its refusal until the next action', async () => {
    const s = source()
    let finish!: (value: Awaited<ReturnType<SignInDependencies['begin']>>) => void
    s.deps.begin.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const pending = s.actions.begin(KEY, 'oauth')
    expect(s.store.getSnapshot().busy).toEqual({ [KEY]: true })
    finish(await refused('no such method'))
    await pending
    expect(s.store.getSnapshot()).toMatchObject({ busy: {}, failures: { [KEY]: 'no such method' } })
    await s.actions.begin(KEY, 'oauth')
    expect(s.store.getSnapshot().failures).toEqual({})
  })

  it('answers and cancels through the key\'s current attempt, and does nothing without one', async () => {
    const s = source()
    await s.actions.answer(KEY, promptId, 'x')
    await s.actions.cancel(KEY)
    s.publish([flow(KEY)])
    await s.actions.cancel(KEY)
    expect(s.deps.answer).not.toHaveBeenCalled()
    expect(s.deps.cancel).not.toHaveBeenCalled()

    s.publish([flow(KEY, { attempt: attempt('a1') })])
    await s.actions.answer(KEY, promptId, 'browser')
    await s.actions.cancel(KEY)
    expect(s.deps.answer).toHaveBeenCalledWith('a1', '1', 'browser')
    expect(s.deps.cancel).toHaveBeenCalledWith('a1')
  })

  it('never opens a page by itself where the window may not, which leaves the link to the user', async () => {
    const s = source(false)
    await s.actions.begin(KEY, 'oauth')
    s.publish([flow(KEY, { attempt: attempt('a1', { notices: [{ message: 'Open it', url: 'https://auth.example/1' }] }) })])
    expect(s.deps.open).not.toHaveBeenCalled()
  })

  it('adopts the view a sign-out answers, and records a refused one', async () => {
    const s = source()
    s.publish([flow(KEY, { signedIn: true })])
    await s.actions.signOut(KEY)
    expect(s.store.getSnapshot().flows[KEY]?.signedIn).toBe(false)
    s.deps.signOut.mockImplementationOnce(() => refused('the store is read-only'))
    await s.actions.signOut(KEY)
    expect(s.store.getSnapshot().failures[KEY]).toBe('the store is read-only')
  })

  it('opens a page on request', () => {
    const s = source()
    s.actions.open('https://auth.example/again')
    expect(s.deps.open).toHaveBeenCalledWith('https://auth.example/again')
  })
})
