import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import type { AuthorizationInteraction, AuthorizationNotice, AuthorizationPrompt } from '@deepseek-ai/dsh-authorization'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials'
import type { AuthEvent, AuthInteraction, AuthPrompt, AuthType, Credential } from '@earendil-works/pi-ai'

const login = vi.hoisted(() => vi.fn())
const probe = vi.hoisted(() => ({ refusals: {} as Record<string, string>, binds: [] as string[] }))

// The callback-port probe binds real loopback addresses; specs run concurrently
// beside e2e runs whose real ChatGPT login holds that port, so each bind is
// answered here instead: an address in `refusals` fails with that error code.
vi.mock('node:net', async importOriginal => ({
  ...await importOriginal<typeof import('node:net')>(),
  createServer: () => {
    let refused: ((error: { code: string }) => void) | undefined
    return {
      once: (_event: 'error', listener: (error: { code: string }) => void) => { refused = listener },
      listen: (options: { port: number; host: string }, listening: () => void) => {
        probe.binds.push(`${options.host} ${options.port}`)
        const code = probe.refusals[options.host]
        if (code === undefined) listening()
        else refused?.({ code })
      },
      close: (closed: () => void) => { closed() },
    }
  },
}))

// The whole of what this module does with pi-ai is run one provider's login
// against a collection built with the harness store, so the collection is the
// boundary worth observing; a real login would open a browser.
vi.mock('../src/models.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/models.ts')>(),
  createModels: () => ({ setProvider: () => {}, login }),
}))

const { credentialStoreFrom, authContextFrom, recordKeyFor } = await import('../src/auth.ts')
const { callbackPortTakenNotice, registerPiAiFlows } = await import('../src/login.ts')

const CODEX = recordKeyFor('openai-codex')
const dirs: string[] = []

/** A context with the record store, the seam, and every pi-ai login flow. */
async function harness(): Promise<Context> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pi-login-'))
  dirs.push(dir)
  const ctx = new Context()
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
  await ctx.plugin(AuthorizationService)
  registerPiAiFlows(ctx, { credentials: credentialStoreFrom(ctx), authContext: authContextFrom(ctx) })
  return ctx
}

/** An interaction recording everything a flow says, answering every question. */
function surface(answer = 'typed'): AuthorizationInteraction & {
  notices: AuthorizationNotice[]
  prompts: AuthorizationPrompt[]
} {
  const notices: AuthorizationNotice[] = []
  const prompts: AuthorizationPrompt[] = []
  return {
    notices,
    prompts,
    notify: (notice) => { notices.push(notice) },
    prompt: (prompt) => {
      prompts.push(prompt)
      return Promise.resolve(answer)
    },
  }
}

/** Drive one attempt, letting the mocked login talk back through `converse`. */
async function attempt(
  ctx: Context,
  converse: (interaction: AuthInteraction) => Promise<void>,
  request: { key?: CredentialKey; method?: string } = {},
): Promise<ReturnType<typeof surface>> {
  const ui = surface()
  login.mockImplementation(async (providerId: string, _type: AuthType, interaction: AuthInteraction) => {
    await converse(interaction)
    const granted: Credential = { type: 'oauth', access: 'at', refresh: 'rt', expires: 1 }
    await credentialStoreFrom(ctx).modify(providerId, () => Promise.resolve(granted))
    return granted
  })
  await expect(ctx.authorization.begin({
    key: request.key ?? CODEX,
    interaction: ui,
    ...request.method === undefined ? {} : { method: request.method },
  })).resolves.toEqual({ status: 'authorized' })
  return ui
}

afterEach(async () => {
  login.mockReset()
  probe.refusals = {}
  probe.binds.length = 0
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('pi-ai login flows', () => {
  it('offers one flow per installed provider, with the methods that provider ships', async () => {
    const ctx = await harness()
    const offered = ctx.authorization.list()

    // The OAuth-only provider is exactly the case this exists for: nothing
    // else could ever configure it.
    expect(offered.find(entry => entry.key === CODEX)?.methods)
      .toEqual([{ id: 'oauth', label: expect.stringContaining('ChatGPT') as string }])
    // A provider offering both keeps both, the subscription login first.
    expect(offered.find(entry => entry.key === recordKeyFor('anthropic'))?.methods.map(one => one.id))
      .toEqual(['oauth', 'api-key'])
    // A key-only provider still gets a flow, because pi-ai collects the key
    // through its own prompt rather than leaving it to the settings form.
    expect(offered.find(entry => entry.key === recordKeyFor('deepseek'))?.methods.map(one => one.id))
      .toEqual(['api-key'])
  })

  it('runs the pi-ai auth type the chosen method names', async () => {
    const ctx = await harness()

    await attempt(ctx, () => Promise.resolve())
    expect(login).toHaveBeenLastCalledWith('openai-codex', 'oauth', expect.anything())

    await attempt(ctx, () => Promise.resolve(), { key: recordKeyFor('anthropic'), method: 'api-key' })
    expect(login).toHaveBeenLastCalledWith('anthropic', 'api_key', expect.anything())
  })

  it('commits what the login produced, where the adapter reads it back', async () => {
    const ctx = await harness()

    await attempt(ctx, () => Promise.resolve())

    await expect(ctx.credentials.readRecord(CODEX)).resolves.toEqual({
      kind: 'grant',
      payload: { type: 'oauth', access: 'at', refresh: 'rt', expires: 1 },
    })
  })

  it('restates every pi-ai login event in the neutral vocabulary', async () => {
    const ctx = await harness()
    const events: AuthEvent[] = [
      { type: 'info', message: 'Read this first', links: [{ url: 'https://help.example' }] },
      { type: 'info', message: 'Nothing to open' },
      { type: 'auth_url', url: 'https://auth.example/start', instructions: 'Approve in the tab' },
      { type: 'auth_url', url: 'https://auth.example/plain' },
      { type: 'device_code', userCode: 'WXYZ-1234', verificationUri: 'https://device.example' },
      { type: 'progress', message: 'Exchanging the code' },
      // pi-ai's event union is open; an unrecognised member must still show
      // the human that something is happening.
      { type: 'quantum-handshake' } as unknown as AuthEvent,
    ]

    const ui = await attempt(ctx, (interaction) => {
      for (const event of events) interaction.notify(event)
      return Promise.resolve()
    })

    expect(ui.notices).toEqual([
      { message: 'Read this first', url: 'https://help.example' },
      { message: 'Nothing to open' },
      { message: 'Approve in the tab', url: 'https://auth.example/start' },
      { message: 'Open this page to continue signing in.', url: 'https://auth.example/plain' },
      {
        message: 'Enter this code on the verification page to finish signing in.',
        url: 'https://device.example',
        code: 'WXYZ-1234',
      },
      { message: 'Exchanging the code' },
      { message: 'Signing in…' },
    ])
  })

  it('restates every pi-ai prompt, carrying the per-prompt withdrawal signal', async () => {
    const ctx = await harness()
    const withdraw = new AbortController()
    const prompts: AuthPrompt[] = [
      { type: 'text', message: 'Your workspace', placeholder: 'acme' },
      { type: 'secret', message: 'Paste the key' },
      { type: 'secret', message: 'Paste the token', placeholder: 'sk-…' },
      { type: 'select', message: 'Which account?', options: [{ id: 'a', label: 'Work' }] },
      // The manual-code question a browser callback can win the race against.
      { type: 'manual_code', message: 'Paste the code', signal: withdraw.signal },
    ]

    const ui = await attempt(ctx, async (interaction) => {
      for (const prompt of prompts) await interaction.prompt(prompt)
    })

    expect(ui.prompts).toEqual([
      { kind: 'text', message: 'Your workspace', placeholder: 'acme' },
      { kind: 'secret', message: 'Paste the key' },
      { kind: 'secret', message: 'Paste the token', placeholder: 'sk-…' },
      { kind: 'select', message: 'Which account?', options: [{ id: 'a', label: 'Work' }] },
      { kind: 'text', message: 'Paste the code', signal: withdraw.signal },
    ])
  })

  it('hands the flow the attempt-wide cancellation signal', async () => {
    const ctx = await harness()
    let seen: AbortSignal | undefined
    const controller = new AbortController()
    login.mockImplementation((_id: string, _type: AuthType, interaction: AuthInteraction) => {
      seen = interaction.signal
      controller.abort()
      return new Promise(() => {})
    })

    await expect(ctx.authorization.begin({
      key: CODEX,
      interaction: surface(),
      signal: controller.signal,
    })).resolves.toEqual({ status: 'cancelled' })
    expect(seen?.aborted).toBe(true)
  })
})

describe('a browser login whose redirect port is already in use', () => {
  const page = 'https://auth.openai.com/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback'
  const browserLogin = (interaction: AuthInteraction): Promise<void> => {
    interaction.notify({ type: 'auth_url', url: page, instructions: 'A browser window should open.' })
    return Promise.resolve()
  }

  it('says so on the sign-in page notice and names both ways to finish', async () => {
    const ctx = await harness()
    probe.refusals = { '127.0.0.1': 'EADDRINUSE' }

    const ui = await attempt(ctx, browserLogin)

    expect(probe.binds).toEqual(['127.0.0.1 1455', '::1 1455'])
    expect(ui.notices).toEqual([{ message: callbackPortTakenNotice(1455), url: page }])
    expect(callbackPortTakenNotice(1455)).toBe('Port 1455 on this computer is already in use (by another program or'
      + ' another sign-in), so the browser cannot hand the sign-in back here. Cancel and choose device code login, or'
      + " sign in on the page and paste the full address from the browser's address bar below.")
  })

  it('counts a listener on the IPv6 loopback a browser may try first', async () => {
    const ctx = await harness()
    probe.refusals = { '::1': 'EADDRINUSE' }

    const ui = await attempt(ctx, browserLogin)

    expect(ui.notices.map(notice => notice.message)).toEqual([callbackPortTakenNotice(1455)])
  })

  it('probes the callback host pi-ai is told to bind', async () => {
    const ctx = await harness()
    vi.stubEnv('PI_OAUTH_CALLBACK_HOST', '127.0.0.9')
    try {
      await attempt(ctx, browserLogin)
    } finally {
      vi.unstubAllEnvs()
    }

    expect(probe.binds).toEqual(['127.0.0.9 1455', '::1 1455'])
  })

  it('keeps the provider’s instructions when the port is free or cannot be bound for another reason', async () => {
    const ctx = await harness()
    probe.refusals = { '127.0.0.1': 'EACCES', '::1': 'EADDRNOTAVAIL' }

    const ui = await attempt(ctx, browserLogin)

    expect(ui.notices).toEqual([{ message: 'A browser window should open.', url: page }])
  })

  it('probes again once the login method is chosen', async () => {
    const ctx = await harness()

    const ui = await attempt(ctx, async (interaction) => {
      // Free while the method question is open; taken by the time it is answered.
      probe.refusals = { '127.0.0.1': 'EADDRINUSE' }
      await interaction.prompt({ type: 'select', message: 'Method', options: [{ id: 'browser', label: 'Browser' }] })
      await browserLogin(interaction)
    })

    expect(probe.binds).toHaveLength(4)
    expect(ui.notices.map(notice => notice.message)).toEqual([callbackPortTakenNotice(1455)])
  })

  it('keeps the provider’s instructions for a page that does not return to that port', async () => {
    const ctx = await harness()
    probe.refusals = { '127.0.0.1': 'EADDRINUSE' }

    const ui = await attempt(ctx, (interaction) => {
      interaction.notify({ type: 'auth_url', url: 'https://auth.example/start?redirect_uri=https%3A%2F%2Fexample.com%3A1455%2F' })
      interaction.notify({ type: 'auth_url', url: 'https://auth.example/plain' })
      return Promise.resolve()
    })

    expect(ui.notices.map(notice => notice.message)).toEqual([
      'Open this page to continue signing in.',
      'Open this page to continue signing in.',
    ])
  })

  it('probes nothing for a provider or method without a fixed redirect port', async () => {
    const ctx = await harness()

    await attempt(ctx, () => Promise.resolve(), { key: recordKeyFor('anthropic'), method: 'api-key' })
    await attempt(ctx, () => Promise.resolve(), { key: recordKeyFor('anthropic'), method: 'oauth' })

    expect(probe.binds).toEqual([])
  })
})
