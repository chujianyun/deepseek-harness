/** A route signed into through OAuth serves requests with the stored grant and no `apiKeyEnv`. */
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { recordKeyFor } from '../src/auth.ts'
import { assemble } from './assemble.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'oauth-route-test': { kind: 'oauth-route-test' } & ContextFormed
  }
}

const dirs: string[] = []
const roots: Context[] = []
const servers: Server[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    server.close(() => { resolve() })
    server.closeAllConnections()
  })))
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/**
 * A Codex endpoint stand-in that records each HTTP request and refuses it. The
 * Codex transport first tries a WebSocket upgrade, which is cut off so it falls
 * back to HTTP at once.
 */
async function codexEndpoint(): Promise<{ url: string; requests: { path: string; headers: IncomingHttpHeaders }[] }> {
  const requests: { path: string; headers: IncomingHttpHeaders }[] = []
  const server = createServer((request, response) => {
    requests.push({ path: request.url ?? '', headers: request.headers })
    request.resume()
    response.writeHead(400, { 'content-type': 'application/json' })
    response.end('{"error":{"message":"stop here"}}')
  })
  server.on('upgrade', (_request, socket) => { socket.destroy() })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { url: `http://127.0.0.1:${address.port}`, requests }
}

/** An access token shaped like ChatGPT's: the Codex transport reads the account id from its claims. */
function chatgptToken(accountId: string): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })}.sig`
}

it('authenticates a keyless OAuth-only route with the signed-in grant', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pi-oauth-'))
  dirs.push(dir)
  const endpoint = await codexEndpoint()
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmPiAi, { providers: { 'openai-codex': { baseURL: endpoint.url, retryPolicy: { mode: 'normal', maxRetries: 0 } } } })
  const access = chatgptToken('acct-123')
  await ctx.credentials.modifyRecord(recordKeyFor('openai-codex'), () => Promise.resolve({
    kind: 'grant',
    payload: { type: 'oauth', access, refresh: 'refresh-token', expires: Date.now() + 3_600_000 },
  }))

  const result = await assemble(ctx, {
    provider: 'openai-codex',
    model: 'gpt-5.5',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'oauth-route-test' } })],
  })

  expect(result.finish.kind).toBe('error')
  expect(endpoint.requests).toHaveLength(1)
  expect(endpoint.requests[0]?.path).toBe('/codex/responses')
  expect(endpoint.requests[0]?.headers.authorization).toBe(`Bearer ${access}`)
  expect(endpoint.requests[0]?.headers['chatgpt-account-id']).toBe('acct-123')
})

it('tells a signed-out OAuth route to sign in again before any request goes out', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pi-oauth-'))
  dirs.push(dir)
  const endpoint = await codexEndpoint()
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmPiAi, { providers: { 'openai-codex': { baseURL: endpoint.url, retryPolicy: { mode: 'normal', maxRetries: 0 } } } })

  const result = await assemble(ctx, {
    provider: 'openai-codex',
    model: 'gpt-5.5',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'oauth-route-test' } })],
  })

  expect(result.finish).toMatchObject({
    kind: 'error',
    failure: {
      code: 'SIGN_IN_REQUIRED',
      message: 'The "openai-codex" account is not signed in. Sign in to it under Settings → Models, then send the message again.',
    },
  })
  expect(endpoint.requests).toHaveLength(0)
})

it('keeps pi-ai’s refusal for a signed-out route that also takes a key', async () => {
  // The missing piece there may be the key, so the sign-in wording would mislead.
  for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_TOKEN']) vi.stubEnv(name, '')
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmPiAi, { providers: { anthropic: { retryPolicy: { mode: 'normal', maxRetries: 0 } } } })

  const result = await assemble(ctx, {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'oauth-route-test' } })],
  })

  expect(result.finish).toMatchObject({
    kind: 'error',
    failure: { code: 'PI_AI_ERROR', message: 'Provider is not configured: anthropic' },
  })
})
