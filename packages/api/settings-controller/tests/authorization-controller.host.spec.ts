import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import type { AuthorizationFlow, AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { remoteErrorOf, remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import AuthorizationController from '../src/authorization.ts'
import type { AuthorizationAttemptId, AuthorizationFlowView, AuthorizationPromptId } from '../src/types.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'

const KEY = credentialKey('llm-pi-ai', 'openai-codex')
const roots: Context[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function boot(): Promise<Context> {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(MemoryCredentials)
  await ctx.plugin(AuthorizationService)
  await ctx.plugin(AuthorizationController)
  return ctx
}

/**
 * A flow shaped like pi-ai's Codex login: pick a method, report the page to
 * open, ask for the redirect URL, then commit the grant it was given.
 */
function codexFlow(ctx: Context, run?: (session: AuthorizationSession) => Promise<void>): AuthorizationFlow {
  return {
    key: KEY,
    label: 'ChatGPT (Codex)',
    methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }, { id: 'api-key', label: 'Paste a key' }],
    run: run ?? (async (session) => {
      const how = await session.prompt({ kind: 'select', message: 'How?', options: [{ id: 'browser', label: 'Browser' }] })
      session.notify({ message: `Open the page (${how})`, url: 'https://auth.example/authorize' })
      const redirect = await session.prompt({ kind: 'secret', message: 'Paste the redirect URL', placeholder: 'http://localhost:1455/auth/callback' })
      await ctx.credentials.modifyRecord(KEY, () => Promise.resolve({ kind: 'grant', payload: { redirect } }))
    }),
  }
}

/** Wait until the controller's view for KEY satisfies `ready`. */
async function until(ctx: Context, ready: (view: AuthorizationFlowView) => boolean): Promise<AuthorizationFlowView> {
  for (let tries = 0; tries < 200; tries++) {
    const view = (await ctx.authorizationController.list()).find(flow => flow.key === KEY)
    if (view !== undefined && ready(view)) return view
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('the view never reached the expected state')
}

function rejectionOf(call: () => unknown): Promise<unknown> {
  return Promise.resolve().then(call).then(() => { throw new Error('expected a rejection') }, (error: unknown) => error)
}

describe('the authorization Remote namespace a configuration surface calls', () => {
  it('publishes the authorization namespace from its own service key', async () => {
    const ctx = await boot()
    const binding = ctx.authorizationController.typertRemote
    expect(binding.serviceKey).toBe('authorizationController')
    expect(binding.namespace).toBe('authorization')
    expect(remoteMethods(ctx.authorizationController).map(method => method.method))
      .toEqual(['list', 'begin', 'answer', 'decline', 'cancel', 'signOut', 'watch'])
  })

  it('lists registered flows with their sign-in state', async () => {
    const ctx = await boot()
    ctx.authorization.registerFlow(codexFlow(ctx))
    expect(await ctx.authorizationController.list()).toEqual([{
      key: 'llm-pi-ai/openai-codex',
      label: 'ChatGPT (Codex)',
      methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }, { id: 'api-key', label: 'Paste a key' }],
      signedIn: false,
      attempt: null,
    }])
  })

  it('runs a sign-in through its questions and notices to a stored credential', async () => {
    const ctx = await boot()
    ctx.authorization.registerFlow(codexFlow(ctx))

    const started = await ctx.authorizationController.begin(KEY, 'oauth')
    expect(started.attempt).toMatchObject({ method: 'oauth', phase: 'running' })
    const attemptId = started.attempt!.id

    const asked = await until(ctx, view => view.attempt?.prompts.length === 1)
    expect(asked.attempt?.prompts).toEqual([{ id: '1', kind: 'select', message: 'How?', options: [{ id: 'browser', label: 'Browser' }] }])
    ctx.authorizationController.answer(attemptId, asked.attempt!.prompts[0]!.id, 'browser')

    const pasted = await until(ctx, view => view.attempt?.prompts[0]?.kind === 'secret')
    expect(pasted.attempt?.notices).toEqual([{ message: 'Open the page (browser)', url: 'https://auth.example/authorize' }])
    expect(pasted.attempt?.prompts).toEqual([{ id: '2', kind: 'secret', message: 'Paste the redirect URL', placeholder: 'http://localhost:1455/auth/callback' }])
    ctx.authorizationController.answer(attemptId, pasted.attempt!.prompts[0]!.id, 'http://localhost:1455/auth/callback?code=secret-code')

    const done = await until(ctx, view => view.attempt?.phase === 'authorized')
    expect(done.signedIn).toBe(true)
    expect(done.attempt?.prompts).toEqual([])
    // The secret answer reached the flow and never a view.
    expect(JSON.stringify(done)).not.toContain('secret-code')
    expect(await ctx.credentials.readRecord(KEY)).toEqual({ kind: 'grant', payload: { redirect: 'http://localhost:1455/auth/callback?code=secret-code' } })
  })

  it('joins the running attempt instead of starting a second one, unless another method is asked for', async () => {
    const ctx = await boot()
    ctx.authorization.registerFlow(codexFlow(ctx))
    const first = await ctx.authorizationController.begin(KEY)
    expect((await ctx.authorizationController.begin(KEY)).attempt?.id).toBe(first.attempt?.id)
    expect((await ctx.authorizationController.begin(KEY, 'oauth')).attempt?.id).toBe(first.attempt?.id)
    expect(remoteErrorOf(await rejectionOf(() => ctx.authorizationController.begin(KEY, 'api-key'))))
      .toMatchObject({ code: 'authorization/rejected' })
  })

  it('validates wire arguments and select answers', async () => {
    const ctx = await boot()
    ctx.authorization.registerFlow(codexFlow(ctx))
    const started = await ctx.authorizationController.begin(KEY)
    const asked = await until(ctx, view => view.attempt?.prompts.length === 1)
    const attemptId = started.attempt!.id
    const promptId = asked.attempt!.prompts[0]!.id
    for (const call of [
      () => ctx.authorizationController.begin(42 as never),
      () => ctx.authorizationController.begin(KEY, ''),
      () => { ctx.authorizationController.answer(attemptId, promptId, { not: 'text' } as never) },
      () => { ctx.authorizationController.answer(attemptId, promptId, 'carrier-pigeon') },
      () => { ctx.authorizationController.decline(attemptId, 7 as never) },
      () => { ctx.authorizationController.cancel(null as never) },
      () => ctx.authorizationController.signOut(''),
    ]) {
      expect(remoteErrorOf(await rejectionOf(call))).toMatchObject({ code: 'gateway/bad-request' })
    }
    // A refused answer leaves the question waiting.
    expect((await ctx.authorizationController.list())[0]?.attempt?.prompts).toHaveLength(1)
  })

  it('refuses questions and drops notices from a flow left running after its attempt ended', async () => {
    const ctx = await boot()
    let session: AuthorizationSession | undefined
    ctx.authorization.registerFlow(codexFlow(ctx, (given) => {
      session = given
      // Ignores its signal, as a flow may: the seam abandons it on withdrawal.
      return new Promise(() => undefined)
    }))
    const started = await ctx.authorizationController.begin(KEY)
    await until(ctx, () => session !== undefined)
    ctx.authorizationController.cancel(started.attempt!.id)
    await until(ctx, view => view.attempt?.phase === 'cancelled')
    session!.notify({ message: 'still here' })
    await expect(session!.prompt({ kind: 'text', message: 'anyone?' })).rejects.toThrow('the sign-in has finished')
    expect((await ctx.authorizationController.list())[0]?.attempt).toMatchObject({ phase: 'cancelled', notices: [], prompts: [] })
  })

  it('reports a declined question and a cancelled attempt as cancelled', async () => {
    const ctx = await boot()
    ctx.authorization.registerFlow(codexFlow(ctx))
    const declined = await ctx.authorizationController.begin(KEY)
    const asked = await until(ctx, view => view.attempt?.prompts.length === 1)
    ctx.authorizationController.decline(declined.attempt!.id, asked.attempt!.prompts[0]!.id)
    expect((await until(ctx, view => view.attempt?.phase !== 'running')).attempt?.phase).toBe('cancelled')

    const cancelled = await ctx.authorizationController.begin(KEY)
    expect(cancelled.attempt?.id).not.toBe(declined.attempt?.id)
    await until(ctx, view => view.attempt?.prompts.length === 1)
    ctx.authorizationController.cancel(cancelled.attempt!.id)
    const settled = await until(ctx, view => view.attempt?.phase !== 'running')
    expect(settled.attempt).toMatchObject({ phase: 'cancelled', prompts: [] })
    expect(settled.signedIn).toBe(false)
  })

  it('reports a flow failing with a bare value', async () => {
    const ctx = await boot()
    ctx.authorization.registerFlow(codexFlow(ctx, async () => { throw 'upstream said no' }))
    await ctx.authorizationController.begin(KEY)
    expect((await until(ctx, view => view.attempt?.phase !== 'running')).attempt)
      .toMatchObject({ phase: 'failed', error: 'The sign-in failed; the Host log has the details.' })
  })

  it('copies option descriptions and notice codes, and keeps only the latest notices', async () => {
    const ctx = await boot()
    let release!: () => void
    ctx.authorization.registerFlow(codexFlow(ctx, async (session) => {
      session.notify({ message: 'Enter the code', url: 'https://auth.example/device', code: 'ABCD-1234' })
      for (let index = 0; index < 20; index++) session.notify({ message: `progress ${String(index)}` })
      void session.prompt({ kind: 'select', message: 'Method?', options: [{ id: 'device', label: 'Device code', description: 'For headless machines' }] })
        .catch(() => undefined)
      await new Promise<void>((resolve) => { release = resolve })
    }))
    await ctx.authorizationController.begin(KEY)
    const view = await until(ctx, flow => flow.attempt?.prompts.length === 1)
    expect(view.attempt?.notices).toHaveLength(20)
    expect(view.attempt?.notices[0]).toEqual({ message: 'progress 0' })
    expect(view.attempt?.prompts[0]).toEqual({
      id: '1', kind: 'select', message: 'Method?',
      options: [{ id: 'device', label: 'Device code', description: 'For headless machines' }],
    })
    release()
  })

  it('shows a device code notice field by field', async () => {
    const ctx = await boot()
    let release!: () => void
    ctx.authorization.registerFlow(codexFlow(ctx, async (session) => {
      session.notify({ message: 'Enter the code', url: 'https://auth.example/device', code: 'ABCD-1234' })
      session.notify({ message: 'Code only', code: 'EFGH-5678' })
      await new Promise<void>((resolve) => { release = resolve })
    }))
    await ctx.authorizationController.begin(KEY)
    const view = await until(ctx, flow => flow.attempt?.notices.length === 2)
    expect(view.attempt?.notices).toEqual([
      { message: 'Enter the code', url: 'https://auth.example/device', code: 'ABCD-1234' },
      { message: 'Code only', code: 'EFGH-5678' },
    ])
    release()
  })

  it('refuses a question the flow already withdrew, and ignores a withdrawal after the answer', async () => {
    const ctx = await boot()
    const answered = new AbortController()
    const gone = new AbortController()
    gone.abort()
    let outcome: unknown
    ctx.authorization.registerFlow(codexFlow(ctx, async (session) => {
      outcome = await session.prompt({ kind: 'text', message: 'Already gone', signal: gone.signal }).catch((error: unknown) => error)
      const code = await session.prompt({ kind: 'text', message: 'Code?', signal: answered.signal })
      answered.abort()
      await ctx.credentials.modifyRecord(KEY, () => Promise.resolve({ kind: 'grant', payload: { code } }))
    }))
    const started = await ctx.authorizationController.begin(KEY)
    const asked = await until(ctx, view => view.attempt?.prompts.length === 1)
    expect(asked.attempt?.prompts[0]?.message).toBe('Code?')
    expect(outcome).toBeInstanceOf(Error)
    ctx.authorizationController.answer(started.attempt!.id, asked.attempt!.prompts[0]!.id, '42')
    expect((await until(ctx, view => view.attempt?.phase !== 'running')).attempt?.phase).toBe('authorized')
  })

  it('keeps a failing flow\'s message, which can quote tokens, out of every view and the log', async () => {
    const ctx = await boot()
    const warnings: unknown[][] = []
    ctx.logger.warn = (...args: unknown[]) => { warnings.push(args) }
    ctx.authorization.registerFlow(codexFlow(ctx, () => Promise.reject(
      new Error('token exchange response missing fields: {"access_token":"leaked-token"}'))))
    await ctx.authorizationController.begin(KEY)
    const failed = await until(ctx, view => view.attempt?.phase !== 'running')
    expect(failed.attempt).toMatchObject({ phase: 'failed', error: 'The sign-in failed; the Host log has the details.' })
    expect(JSON.stringify(failed)).not.toContain('leaked-token')
    expect(JSON.stringify(warnings)).not.toContain('leaked-token')
    expect(warnings).toContainEqual([
      'authorization: sign-in for "%s" failed: %s', KEY, 'token exchange response missing fields: …',
    ])
  })

  it('drops a question the flow withdraws while the attempt continues', async () => {
    const ctx = await boot()
    const withdraw = new AbortController()
    let finish!: () => void
    ctx.authorization.registerFlow(codexFlow(ctx, async (session) => {
      void session.prompt({ kind: 'text', message: 'Paste the code', signal: withdraw.signal }).catch(() => undefined)
      await new Promise<void>((resolve) => { finish = resolve })
      await ctx.credentials.modifyRecord(KEY, () => Promise.resolve({ kind: 'grant', payload: {} }))
    }))
    const started = await ctx.authorizationController.begin(KEY)
    const asked = await until(ctx, view => view.attempt?.prompts.length === 1)
    withdraw.abort()
    await until(ctx, view => view.attempt?.prompts.length === 0)
    expect(remoteErrorOf(await rejectionOf(() => {
      ctx.authorizationController.answer(started.attempt!.id, asked.attempt!.prompts[0]!.id, 'late')
    }))).toMatchObject({ code: 'authorization/not-found' })
    finish()
    expect((await until(ctx, view => view.attempt?.phase !== 'running')).attempt?.phase).toBe('authorized')
  })

  it('signs out only after a committing attempt finishes, so the deletion lands last', async () => {
    const ctx = await boot()
    const gate = Promise.withResolvers<undefined>()
    ctx.authorization.registerFlow(codexFlow(ctx, async (session) => {
      await session.commit({ kind: 'grant', payload: {} })
      // Once committing, the seam no longer withdraws the attempt.
      await gate.promise
    }))
    await ctx.authorizationController.begin(KEY)
    await until(ctx, view => view.signedIn)
    let resolved = false
    const signedOut = ctx.authorizationController.signOut(KEY).then((view) => { resolved = true; return view })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(resolved).toBe(false)
    gate.resolve(undefined)
    const view = await signedOut
    expect(view.signedIn).toBe(false)
    expect(view.attempt?.phase).toBe('authorized')
    expect(await ctx.credentials.readRecord(KEY)).toBeUndefined()
  })

  it('signs out by forgetting the record and cancelling a running attempt', async () => {
    const ctx = await boot()
    ctx.authorization.registerFlow(codexFlow(ctx))
    await ctx.credentials.modifyRecord(KEY, () => Promise.resolve({ kind: 'grant', payload: {} }))
    await ctx.authorizationController.begin(KEY)
    const after = await ctx.authorizationController.signOut(KEY)
    expect(after.signedIn).toBe(false)
    expect(await ctx.credentials.readRecord(KEY)).toBeUndefined()
    expect((await until(ctx, view => view.attempt?.phase !== 'running')).attempt?.phase).toBe('cancelled')
  })

  it('refuses keys and methods no flow offers, and attempts it never started', async () => {
    const ctx = await boot()
    ctx.authorization.registerFlow(codexFlow(ctx))
    for (const call of [
      () => ctx.authorizationController.begin('not a key'),
      () => ctx.authorizationController.begin('llm-pi-ai/anthropic'),
      () => ctx.authorizationController.begin(KEY, 'carrier-pigeon'),
      () => ctx.authorizationController.signOut('llm-pi-ai/anthropic'),
    ]) {
      expect(remoteErrorOf(await rejectionOf(call))).toMatchObject({ code: 'authorization/rejected' })
    }
    await ctx.authorizationController.begin(KEY)
    const unknown = 'missing' as AuthorizationAttemptId
    const prompt = '1' as AuthorizationPromptId
    for (const call of [
      () => { ctx.authorizationController.answer(unknown, prompt, 'x') },
      () => { ctx.authorizationController.decline(unknown, prompt) },
      () => { ctx.authorizationController.cancel(unknown) },
    ]) {
      expect(remoteErrorOf(await rejectionOf(call))).toMatchObject({ code: 'authorization/not-found', details: { attemptId: 'missing' } })
    }
  })

  it('refuses to start while another surface runs the same flow', async () => {
    const ctx = await boot()
    ctx.authorization.registerFlow(codexFlow(ctx))
    const elsewhere = new AbortController()
    void ctx.authorization.begin({
      key: KEY, signal: elsewhere.signal,
      interaction: { notify: () => undefined, prompt: () => new Promise<string>(() => undefined) },
    }).catch(() => undefined)
    expect(remoteErrorOf(await rejectionOf(() => ctx.authorizationController.begin(KEY))))
      .toMatchObject({ code: 'authorization/rejected' })
    elsewhere.abort()
  })

  it('streams the views now and after every change', async () => {
    const ctx = await boot()
    ctx.authorization.registerFlow(codexFlow(ctx))
    const lifetime = new AbortController()
    const stream = ctx.authorizationController.watch(lifetime.signal)[Symbol.asyncIterator]()
    expect((await stream.next()).value).toEqual([expect.objectContaining({ signedIn: false, attempt: null })])
    const next = stream.next()
    await ctx.credentials.modifyRecord(KEY, () => Promise.resolve({ kind: 'grant', payload: {} }))
    expect((await next).value).toEqual([expect.objectContaining({ signedIn: true })])
    lifetime.abort()
    expect((await stream.next()).done).toBe(true)
  })

  it('wakes watchers when another surface\'s attempt settles, and ends their streams on disposal', async () => {
    const ctx = await boot()
    ctx.authorization.registerFlow(codexFlow(ctx))
    const lifetime = new AbortController()
    const stream = ctx.authorizationController.watch(lifetime.signal)[Symbol.asyncIterator]()
    await stream.next()
    const elsewhere = new AbortController()
    const outside = ctx.authorization.begin({
      key: KEY, signal: elsewhere.signal,
      interaction: { notify: () => undefined, prompt: () => new Promise<string>(() => undefined) },
    })
    const next = stream.next()
    elsewhere.abort()
    await outside
    expect((await next).done).toBe(false)
    const ended = stream.next()
    await ctx.fiber.dispose()
    expect((await ended).done).toBe(true)
  })

  it('cancels running attempts when it is disposed', async () => {
    const ctx = await boot()
    let signal!: AbortSignal
    ctx.authorization.registerFlow(codexFlow(ctx, (session) => {
      signal = session.signal
      return new Promise(() => undefined)
    }))
    await ctx.authorizationController.begin(KEY)
    await until(ctx, () => signal !== undefined)
    await ctx.fiber.dispose()
    expect(signal.aborted).toBe(true)
  })

  it('reports the actionable configuration error while a service is absent', async () => {
    const ctx = new Context()
    roots.push(ctx)
    await ctx.plugin(AuthorizationController)
    expect(remoteErrorOf(await rejectionOf(() => ctx.authorizationController.list())))
      .toMatchObject({ code: 'gateway/internal' })
    await ctx.plugin(AuthorizationService)
    expect(remoteErrorOf(await rejectionOf(() => ctx.authorizationController.list())))
      .toMatchObject({ code: 'gateway/internal' })
  })
})
