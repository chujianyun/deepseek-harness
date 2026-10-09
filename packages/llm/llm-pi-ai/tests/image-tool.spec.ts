/** `generate_image`: registered while a Codex sign-in is stored, generating through the Codex endpoint into an attachment. */
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { chatgptAccountId, NOT_SIGNED_IN, readImageStream, resolveImageRequest } from '../src/image-tool.ts'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'
import { recordKeyFor } from '../src/auth.ts'

const KEY = recordKeyFor('openai-codex')
/** A 2x2 PNG, so the attachment store's decode and dimension checks pass. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP4z8DwnwGMgRQAH+4D/dJQfRoAAAAASUVORK5CYII='

const dirs: string[] = []
const roots: Context[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    server.close(() => { resolve() })
    server.closeAllConnections()
  })))
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

function token(claims: Record<string, unknown>): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode(claims)}.sig`
}
const ACCESS = token({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-img' } })

const event = (value: Record<string, unknown>): string => `event: ${String(value['type'])}\ndata: ${JSON.stringify(value)}\n\n`
const imageEvents = (item: Record<string, unknown> = {}): string =>
  event({ type: 'response.created', response: { id: 'r1' } })
  + 'data: not json\n\n'
  + event({ type: 'response.output_item.done', output_index: 0, item: { type: 'image_generation_call', id: 'ig1', result: PNG, output_format: 'png', revised_prompt: 'A red square, flat.', ...item } })
  + event({ type: 'response.completed', response: { id: 'r1', status: 'completed' } })
  + 'data: [DONE]\n\n'

/** A Codex endpoint stand-in answering each request with the next scripted reply. */
async function codexEndpoint(replies: { status?: number; body: string; hang?: boolean }[]) {
  const requests: { path: string; headers: IncomingHttpHeaders; body: Record<string, unknown> }[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8') })
    req.on('end', () => {
      requests.push({ path: req.url ?? '', headers: req.headers, body: JSON.parse(raw) as Record<string, unknown> })
      const reply = replies.shift() ?? { status: 500, body: 'script exhausted' }
      res.writeHead(reply.status ?? 200, { 'content-type': 'text/event-stream' })
      // A hanging reply sends its headers and then nothing, as a stalled generation does.
      if (reply.hang === true) res.write(reply.body)
      else res.end(reply.body)
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { url: `http://127.0.0.1:${String(address.port)}/backend-api/`, requests, replies }
}

/** The live plugin entry of each context, so a case can update or unload it. */
const plugins = new WeakMap<Context, Awaited<ReturnType<typeof liveConfig>>>()

/** Boot llm-pi-ai through the loader, with the Codex route pointed at `baseURL` when one is given. */
async function boot(baseURL?: string, imageGeneration: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-image-tool-'))
  dirs.push(dir)
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  await ctx.plugin(LocalAttachmentStore, { dshHome: dir })
  await ctx.plugin(LlmRuntime)
  plugins.set(ctx, await liveConfig(ctx, LlmPiAi, {
    providers: baseURL === undefined ? {} : { 'openai-codex': { baseURL } },
    imageGeneration,
  }))
  return ctx
}

async function signIn(ctx: Context, access = ACCESS): Promise<void> {
  await ctx.credentials.modifyRecord(KEY, () => Promise.resolve({
    kind: 'grant', payload: { type: 'oauth', access, refresh: 'refresh', expires: Date.now() + 3_600_000 },
  }))
}

const offered = (ctx: Context): boolean => ctx.tools.get('generate_image') !== undefined

/** A calling agent routed to a Codex model, which takes image input. */
const VISION_AGENT = { options: { provider: 'openai-codex', model: 'gpt-5.5' }, session: { requestHeader: () => undefined } }
/** A calling agent whose route cannot be resolved, which is treated as text-only. */
const TEXT_AGENT = { options: { provider: 'openai-codex', model: 'no-such-model' }, session: { requestHeader: () => undefined } }

let calls = 0
function generate(ctx: Context, args: Record<string, unknown>, agent: object | null = VISION_AGENT, signal = new AbortController().signal) {
  return ctx.tools.execute({
    signal, callId: ToolCallId(`gen-${String(++calls)}`), name: 'generate_image', arguments: args,
    ...agent === null ? {} : { agent: agent as never },
  })
}
const text = (result: { content: { type: string; text?: string }[] }): string =>
  result.content.filter(block => block.type === 'text').map(block => block.text).join('')

describe('generate_image registration', () => {
  it('is offered only while a Codex sign-in is stored, and withdrawn with the plugin', async () => {
    const ctx = await boot()
    await vi.waitFor(() => { expect(offered(ctx)).toBe(false) })
    await signIn(ctx)
    await vi.waitFor(() => { expect(offered(ctx)).toBe(true) })
    // Another record changing leaves the registration alone.
    await ctx.credentials.modifyRecord(recordKeyFor('anthropic'), () => Promise.resolve({ kind: 'api-key', key: 'k' }))
    expect(offered(ctx)).toBe(true)
    await ctx.credentials.deleteRecord(KEY)
    await vi.waitFor(() => { expect(offered(ctx)).toBe(false) })
    await signIn(ctx)
    await vi.waitFor(() => { expect(offered(ctx)).toBe(true) })
    await plugins.get(ctx)!.fiber.dispose()
    expect(offered(ctx)).toBe(false)
  })

  it('keeps its registration and logs when the sign-in cannot be read', async () => {
    const ctx = await boot()
    await signIn(ctx)
    await vi.waitFor(() => { expect(offered(ctx)).toBe(true) })
    const warnings: unknown[] = []
    ctx.logger.warn = (...args: unknown[]) => { warnings.push(args[0]) }
    vi.spyOn(ctx.credentials, 'describeRecord').mockRejectedValueOnce(new Error('store unreadable'))
    ctx.emit('credentials/record-updated', KEY)
    await vi.waitFor(() => { expect(warnings).toContain('llm-pi-ai: could not read the ChatGPT (Codex) sign-in; generate_image stays as it was') })
    expect(offered(ctx)).toBe(true)
  })

  it('describes the tool from the model\'s side', async () => {
    const ctx = await boot()
    await signIn(ctx)
    await vi.waitFor(() => { expect(offered(ctx)).toBe(true) })
    const schema = ctx.tools.schemas().find(tool => tool.name === 'generate_image')!
    expect(JSON.stringify(schema)).toContain('ChatGPT account the user signed in to')
    expect(JSON.stringify(schema)).toContain('1536x1024')
  })
})

describe('generate_image execution', () => {
  it('generates through the Codex endpoint and returns the stored image', async () => {
    const endpoint = await codexEndpoint([{ body: imageEvents() }])
    const ctx = await boot(endpoint.url)
    await signIn(ctx)
    await vi.waitFor(() => { expect(offered(ctx)).toBe(true) })

    const result = await generate(ctx, { prompt: '  a red square  ', size: '1536x1024', quality: 'high', background: 'transparent' })

    expect(result.isError).toBeFalsy()
    expect(endpoint.requests).toHaveLength(1)
    const [request] = endpoint.requests
    expect(request!.path).toBe('/backend-api/codex/responses')
    expect(request!.headers.authorization).toBe(`Bearer ${ACCESS}`)
    expect(request!.headers['chatgpt-account-id']).toBe('acct-img')
    expect(request!.headers['originator']).toBe('pi')
    expect(request!.headers['user-agent']).toMatch(/^pi \(/u)
    expect(request!.body).toMatchObject({
      model: 'gpt-5.6-sol',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'a red square' }] }],
      tools: [{ type: 'image_generation', size: '1536x1024', quality: 'high', background: 'transparent' }],
      tool_choice: { type: 'image_generation' },
      stream: true,
      store: false,
    })
    expect(text(result)).toBe('Generated a 2x2 image/png image; it is shown to the user.\nRevised prompt: A red square, flat.')
    const image = result.content.find(block => block.type === 'image') as { attachment: { width: number } }
    expect(image.attachment.width).toBe(2)
    expect((await ctx.attachments.readImage(image.attachment as never)).ref.mediaType).toBe('image/png')
  })

  it('defaults size, quality, and background, and takes a JPEG without a revised prompt', async () => {
    const endpoint = await codexEndpoint([{ body: imageEvents({ output_format: 'jpeg', revised_prompt: '' }) }])
    const ctx = await boot(endpoint.url.replace(/\/$/u, ''))
    await signIn(ctx)
    await vi.waitFor(() => { expect(offered(ctx)).toBe(true) })
    // The PNG bytes are labelled JPEG here, which the store refuses as a type mismatch.
    const result = await generate(ctx, { prompt: 'a square' })
    expect(endpoint.requests[0]!.body['tools']).toEqual([{ type: 'image_generation', size: '1024x1024', quality: 'medium', background: 'auto' }])
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('the generated image could not be stored (IMAGE_TYPE_MISMATCH)')
  })

  it('stores an image of an unnamed format as PNG and reports no revised prompt it was not given', async () => {
    const endpoint = await codexEndpoint([{ body: imageEvents({ output_format: 'tiff', revised_prompt: undefined }) }])
    const ctx = await boot(endpoint.url)
    await signIn(ctx)
    await vi.waitFor(() => { expect(offered(ctx)).toBe(true) })
    const result = await generate(ctx, { prompt: 'a square' })
    expect(text(result)).toBe('Generated a 2x2 image/png image; it is shown to the user.')
  })

  it('passes a storage failure that is not an attachment refusal through unchanged', async () => {
    const endpoint = await codexEndpoint([{ body: imageEvents() }])
    const ctx = await boot(endpoint.url)
    await signIn(ctx)
    await vi.waitFor(() => { expect(offered(ctx)).toBe(true) })
    vi.spyOn(ctx.attachments, 'saveImage').mockRejectedValueOnce(new Error('disk full'))
    expect(text(await generate(ctx, { prompt: 'a square' }))).toContain('disk full')
  })

  it.each([
    [{ status: 401, body: 'denied' }, 'ChatGPT no longer accepts the signed-in account'],
    [{ status: 403, body: 'denied' }, 'refused the request (HTTP 403)'],
    [{ status: 500, body: 'boom' }, 'refused the request (HTTP 500)'],
    [{ body: event({ type: 'response.failed', response: { error: { message: 'content policy' } } }) }, 'Image generation failed: content policy'],
    [{ body: event({ type: 'response.failed', response: {} }) }, 'the image service reported a failure'],
    [{ body: event({ type: 'error', message: 'rate limited' }) }, 'Image generation failed: rate limited'],
    [{ body: event({ type: 'response.completed', response: {} }) }, 'returned no image'],
    [{ body: imageEvents({ result: '' }) }, 'returned no image'],
  ])('reports %j as a tool error', async (reply, message) => {
    const endpoint = await codexEndpoint([reply])
    const ctx = await boot(endpoint.url)
    await signIn(ctx)
    await vi.waitFor(() => { expect(offered(ctx)).toBe(true) })
    const result = await generate(ctx, { prompt: 'a square' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(message)
  })

  it('tells the model to have the user sign in when no usable sign-in remains', async () => {
    const endpoint = await codexEndpoint([])
    const ctx = await boot(endpoint.url)
    await signIn(ctx, token({}))
    await vi.waitFor(() => { expect(offered(ctx)).toBe(true) })
    expect(text(await generate(ctx, { prompt: 'a square' }))).toContain(NOT_SIGNED_IN)
    // Signed out after the tool was offered: the call still explains what to do.
    vi.spyOn(ctx.credentials, 'describeRecord').mockResolvedValue({ configured: true, writable: true })
    await ctx.credentials.deleteRecord(KEY)
    expect(offered(ctx)).toBe(true)
    expect(text(await generate(ctx, { prompt: 'a square' }))).toContain(NOT_SIGNED_IN)
    // An expired sign-in whose refresh the service refuses reads the same.
    await signIn(ctx)
    await ctx.credentials.modifyRecord(KEY, () => Promise.resolve({
      kind: 'grant', payload: { type: 'oauth', access: ACCESS, refresh: 'refresh', expires: 0 },
    }))
    const refusal = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{}', { status: 400 }))
    expect(text(await generate(ctx, { prompt: 'a square' }))).toContain(NOT_SIGNED_IN)
    refusal.mockRestore()
    expect(endpoint.requests).toHaveLength(0)
  })

  it('refuses an empty prompt before any request', async () => {
    const ctx = await boot()
    await signIn(ctx)
    await vi.waitFor(() => { expect(offered(ctx)).toBe(true) })
    expect(text(await generate(ctx, { prompt: '   ' }))).toContain('prompt must describe the image to generate')
  })
})

describe('generate_image settings and transport', () => {
  it('follows the setting live: off withdraws the tool, on offers it again', async () => {
    const ctx = await boot()
    await signIn(ctx)
    await vi.waitFor(() => { expect(offered(ctx)).toBe(true) })
    await plugins.get(ctx)!.update({ imageGeneration: { enabled: false } })
    await vi.waitFor(() => { expect(offered(ctx)).toBe(false) })
    await plugins.get(ctx)!.update({ imageGeneration: { enabled: true } })
    await vi.waitFor(() => { expect(offered(ctx)).toBe(true) })
  })

  it('does not register after the plugin is gone, even when a check was in flight', async () => {
    const ctx = await boot()
    let release!: () => void
    vi.spyOn(ctx.credentials, 'describeRecord').mockImplementationOnce(() => new Promise((resolve) => {
      release = () => { resolve({ configured: true, writable: true }) }
    }))
    await signIn(ctx)
    await vi.waitFor(() => { expect(release).toBeDefined() })
    await plugins.get(ctx)!.fiber.dispose()
    release()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(offered(ctx)).toBe(false)
  })

  it('keeps the image from a text-only route and says so, while the conversation still gets it', async () => {
    const endpoint = await codexEndpoint([{ body: imageEvents() }])
    const ctx = await boot(endpoint.url)
    await signIn(ctx)
    await vi.waitFor(() => { expect(offered(ctx)).toBe(true) })
    for (const agent of [TEXT_AGENT, null]) {
      endpoint.requests.length = 0
      endpoint.replies.push({ body: imageEvents() })
      const result = await generate(ctx, { prompt: 'a square' }, agent)
      expect(result.content.some(block => block.type === 'image')).toBe(false)
      expect(text(result)).toContain('The current model cannot view images')
      expect(result.meta).toMatchObject({ image: { mediaType: 'image/png', width: 2, height: 2 } })
    }
  })

  it('posts to the catalog Codex endpoint when the route sets no base URL', async () => {
    const ctx = await boot()
    await signIn(ctx)
    await vi.waitFor(() => { expect(offered(ctx)).toBe(true) })
    const fetched = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('', { status: 503 }))
    expect(text(await generate(ctx, { prompt: 'a square' }))).toContain('HTTP 503')
    expect(fetched.mock.calls[0]![0]).toBe('https://chatgpt.com/backend-api/codex/responses')
    fetched.mockRestore()
  })

  it('words a timeout, an unreachable service, an oversized stream, and passes a cancellation through', async () => {
    const hanging = await codexEndpoint([{ body: ': waiting\n\n', hang: true }, { body: ': waiting\n\n', hang: true }])
    const slow = await boot(hanging.url, { timeoutMs: 50 })
    await signIn(slow)
    await vi.waitFor(() => { expect(offered(slow)).toBe(true) })
    expect(text(await generate(slow, { prompt: 'a square' }))).toContain('no image arrived within 0 seconds')
    const cancel = new AbortController()
    const cancelled = generate(slow, { prompt: 'a square' }, VISION_AGENT, cancel.signal)
    await vi.waitFor(() => { expect(hanging.requests).toHaveLength(2) })
    cancel.abort()
    expect((await cancelled).isError).toBe(true)

    const unreachable = await boot('http://127.0.0.1:9')
    await signIn(unreachable)
    await vi.waitFor(() => { expect(offered(unreachable)).toBe(true) })
    expect(text(await generate(unreachable, { prompt: 'a square' }))).toContain('could not be reached')

    const big = await codexEndpoint([{ body: imageEvents() }])
    const bounded = await boot(big.url, { maxResponseBytes: 100 })
    await signIn(bounded)
    await vi.waitFor(() => { expect(offered(bounded)).toBe(true) })
    expect(text(await generate(bounded, { prompt: 'a square' }))).toContain('sent more than 100 bytes')
  })
})

describe('Codex image helpers', () => {
  it('fills the schema\'s defaults in one place', () => {
    expect(resolveImageRequest({ prompt: '  cat  ' })).toEqual({ prompt: 'cat', size: '1024x1024', quality: 'medium', background: 'auto' })
    expect(resolveImageRequest({ prompt: 'cat', size: '1536x1024', quality: 'high', background: 'opaque' }))
      .toEqual({ prompt: 'cat', size: '1536x1024', quality: 'high', background: 'opaque' })
  })

  it('reads the account id only from a JWT that names one', () => {
    expect(chatgptAccountId(ACCESS)).toBe('acct-img')
    expect(chatgptAccountId('opaque')).toBeUndefined()
    expect(chatgptAccountId('a.not-base64-json.c')).toBeUndefined()
    expect(chatgptAccountId(token({ 'https://api.openai.com/auth': { chatgpt_account_id: '' } }))).toBeUndefined()
  })

  it('finds the image call in a Responses stream and ignores what it does not need', () => {
    expect(readImageStream(imageEvents())).toEqual({ kind: 'image', data: PNG, format: 'png', revisedPrompt: 'A red square, flat.' })
    expect(readImageStream(imageEvents({ output_format: undefined, revised_prompt: undefined }))).toEqual({ kind: 'image', data: PNG, format: 'png' })
    expect(readImageStream('event: x\ndata:\n\n')).toEqual({ kind: 'none' })
    expect(readImageStream(event({ type: 'error' }))).toEqual({ kind: 'failed', message: 'the image service reported a failure' })
  })
})
