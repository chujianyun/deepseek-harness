/** Embedding models over a loopback mirror, a stand-in runtime, and a mock OpenAI-compatible endpoint. */
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, stat, truncate, writeFile } from 'node:fs/promises'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { type LlmRouteEndpoint } from '@deepseek-ai/dsh-llm'
import { remoteErrorOf, remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import EmbeddingService, { type Config, type EmbeddingState } from '../src/index.ts'

/** Plugin options a test passes: everything but the live API model list. */
type Options = Omit<Config, 'apiModels'>
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'
import { buildFixtures, HIDDEN, startMirror } from './fixtures.ts'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
})

async function fixtures(weights?: string) {
  const built = await buildFixtures(weights)
  cleanups.push(built.cleanup)
  const mirror = await startMirror(built.served)
  cleanups.push(() => mirror.close())
  const home = await mkdtemp(join(tmpdir(), 'dsh-embedding-'))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  return { ...built, mirror, home }
}

function sourceConfig(f: Awaited<ReturnType<typeof fixtures>>, mirrors?: string[]): Options {
  return {
    dshHome: f.home, localModel: f.model, runtime: f.runtime,
    modelMirrors: mirrors ?? [`${f.mirror.origin}/models/{repo}/{file}`],
    npmRegistries: [`${f.mirror.origin}/npm`],
  }
}

/** Boot the service behind Loader so its API model list is a live, writable setting. */
async function boot(config: Options, provider?: { endpoint: LlmRouteEndpoint | undefined }) {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  const claude = { provider: 'claude', displayName: 'Claude', settingsNs: 'llm-test', settingsPath: ['providers', 'claude'] }
  const directory = ctx.llm.registerConfigurableProviders([
    { provider: 'acme', displayName: 'Acme 网关', settingsNs: 'llm-test', settingsPath: ['providers', 'acme'] }, claude,
  ])
  ctx.llm.registerEndpointResolver('llm-test', name => name === 'acme' ? provider?.endpoint
    : name === 'claude' ? { baseURL: 'https://anthropic.example', api: 'anthropic-messages', headers: undefined, resolveApiKey: () => Promise.resolve(undefined) }
      : undefined)
  const live = await liveConfig(ctx, EmbeddingService, config)
  ctx.provide('settings', { update: async (_entry: string, patch: Record<string, unknown>) => { await live.update(patch) } } as never)
  const service = ctx.get('embedding')!
  const states: EmbeddingState[] = []
  const stream = new AbortController()
  cleanups.push(async () => { stream.abort() })
  const iterator = service.watch(stream.signal)[Symbol.asyncIterator]()
  /** Wait for a state that satisfies the predicate. */
  const until = async (predicate: (state: EmbeddingState) => boolean): Promise<EmbeddingState> => {
    for (;;) {
      const next = await iterator.next()
      if (next.done === true) throw new Error('state stream ended')
      states.push(next.value)
      if (predicate(next.value)) return next.value
    }
  }
  /** Drop the acme route from the configurable-provider directory, as deleting it under Settings → Models does. */
  const dropAcme = (): void => { directory.replace([claude]) }
  return { ctx, service, until, states, live, dropAcme }
}

const installed = (state: EmbeddingState) => state.local.status === 'installed' && state.local.dimensions !== null

describe('local embedding model', () => {
  it('publishes the namespace and its methods', async () => {
    const f = await fixtures()
    const { service } = await boot({ ...sourceConfig(f), autoDownload: false })
    expect(service.typertRemote.namespace).toBe('embedding')
    expect(remoteMethods(service).map(method => method.method)).toEqual([
      'getState', 'watch', 'pauseDownload', 'startDownload', 'removeLocalModel', 'listProviders', 'addApiModel', 'removeApiModel',
    ])
  })

  it('downloads at startup, keeps only this platform\'s runtime files, and embeds with the last token', async () => {
    const f = await fixtures()
    const { service, until } = await boot(sourceConfig(f))
    const done = await until(installed)
    const total = [...f.model.files, ...f.runtime.packages].reduce((sum, item) => sum + item.size, 0)
    expect(done.local).toEqual({ id: 'local/tiny', name: 'Tiny', status: 'installed', receivedBytes: total, totalBytes: total, dimensions: HIDDEN, error: null })
    const runtime = join(f.home, 'models', 'runtime', 'onnxruntime-9.9.9')
    const extracted = (await readdir(join(runtime, 'node_modules', 'onnxruntime-node'), { recursive: true })).map(String)
    expect(extracted).toContain(join('bin', 'napi-v6', process.platform, process.arch, 'onnxruntime_binding.node'))
    expect(extracted.some(path => path.includes('other') || path.startsWith('script'))).toBe(false)
    expect(await readdir(join(runtime, 'downloads'))).toEqual([])
    // "annual leave policy" + <eos>: the last token (id 0) gives [0, 1, 2, 3], normalized.
    const [vector] = await service.embed('local/tiny', ['annual leave policy'])
    expect(vector!.map(value => Number(value.toFixed(4)))).toEqual([0, 0.2673, 0.5345, 0.8018])
    const runs = (globalThis as { ortRuns?: Record<string, { dims: number[]; data: ArrayLike<number> }>[] }).ortRuns!
    const feeds = runs.at(-1)!
    expect(Object.keys(feeds)).toEqual(['input_ids', 'attention_mask', 'position_ids', 'past_key_values.0.key'])
    expect(Array.from(feeds.position_ids!.data, Number)).toEqual([0, 1, 2, 3])
    expect(feeds['past_key_values.0.key']!.dims).toEqual([1, 1, 0, 2])
    // Longer than maxTokens (4): cut, keeping the final <eos>.
    await service.embed('local/tiny', ['annual leave policy weather leave'])
    expect(Array.from(runs.at(-1)!.input_ids!.data, Number)).toEqual([5, 2, 3, 0])
    const aborted = new AbortController()
    aborted.abort('stop')
    await expect(service.embed('local/tiny', ['annual'], aborted.signal)).rejects.toBe('stop')
    // A failed run does not block the next one.
    expect(await service.embed('local/tiny', ['weather'])).toHaveLength(1)
  })

  it('falls back to the next mirror and registry when the first one fails', async () => {
    const f = await fixtures()
    f.mirror.fail = path => path.startsWith('/first') ? 503 : undefined
    // The second model mirror drops the weights midway.
    for (const [path, data] of [...f.served]) if (path.startsWith('/models/')) f.served.set(path.replace('/models/', '/second/'), data)
    f.mirror.drop = path => path === '/second/acme/tiny/onnx/model.onnx'
    const { until } = await boot({
      ...sourceConfig(f, [`${f.mirror.origin}/first/{repo}/{file}`, 'http://127.0.0.1:9/{repo}/{file}', `${f.mirror.origin}/second/{repo}/{file}`, `${f.mirror.origin}/models/{repo}/{file}`]),
      npmRegistries: ['http://127.0.0.1:9', `${f.mirror.origin}/npm/`],
    })
    await until(installed)
    expect(f.mirror.requests.filter(request => request.path.startsWith('/first'))).toHaveLength(f.model.files.length)
    expect(f.mirror.requests.map(request => request.path)).toContain('/models/acme/tiny/onnx/model.onnx')
  })

  it('verifies a partial file that is already complete without fetching it', async () => {
    const f = await fixtures()
    const dir = join(f.home, 'models', 'embedding', 'tiny')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'config.json.part'), f.served.get('/models/acme/tiny/config.json')!)
    const { until } = await boot(sourceConfig(f))
    await until(installed)
    expect(f.mirror.requests.map(request => request.path)).not.toContain('/models/acme/tiny/config.json')
  })

  it('pauses with the partial file kept and resumes it with a Range request', async () => {
    const f = await fixtures('w'.repeat(200_000))
    const release = Promise.withResolvers<undefined>()
    const sent = Promise.withResolvers<undefined>()
    f.mirror.hold = { path: 'model.onnx', release: release.promise, sent: () => { sent.resolve(undefined) } }
    const { service, until } = await boot(sourceConfig(f))
    await sent.promise
    const weights = f.model.files.find(item => item.path === f.model.weights)!.size
    await until(state => state.local.receivedBytes > state.local.totalBytes - weights)
    const pausing = service.pauseDownload()
    release.resolve(undefined)
    // The answer reflects the stopped transfer, never the download it interrupted.
    const state = await pausing
    expect(state.local.status).toBe('paused')
    const part = join(f.home, 'models', 'embedding', 'tiny', 'onnx', 'model.onnx.part')
    const kept = (await stat(part)).size
    expect(kept).toBeGreaterThan(0)
    expect(state.local.receivedBytes).toBeLessThan(state.local.totalBytes)
    await service.startDownload()
    await until(installed)
    expect(f.mirror.requests.at(-1)).toEqual({ path: '/models/acme/tiny/onnx/model.onnx', range: `bytes=${String(kept)}-` })
    // Pausing when nothing runs changes nothing; starting an installed model does nothing.
    expect((await service.pauseDownload()).local.status).toBe('installed')
    expect((await service.startDownload()).local.status).toBe('installed')
  })

  it('restarts a file from zero when the mirror ignores Range, counting progress once', async () => {
    const f = await fixtures('w'.repeat(200_000))
    const release = Promise.withResolvers<undefined>()
    const sent = Promise.withResolvers<undefined>()
    f.mirror.hold = { path: 'model.onnx', release: release.promise, sent: () => { sent.resolve(undefined) } }
    const { service, until } = await boot(sourceConfig(f))
    await sent.promise
    const weights = f.model.files.find(item => item.path === f.model.weights)!.size
    await until(state => state.local.receivedBytes > state.local.totalBytes - weights)
    await service.pauseDownload()
    release.resolve(undefined)
    await until(state => state.local.status === 'paused')
    f.mirror.ignoreRange = true
    await service.startDownload()
    const done = await until(installed)
    expect(done.local.receivedBytes).toBe(done.local.totalBytes)
  })

  it('reports network and verification failures, and retries', async () => {
    const f = await fixtures()
    f.mirror.fail = () => 500
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const { service, until } = await boot(sourceConfig(f))
    expect((await until(state => state.local.status === 'failed')).local.error).toBe('network')
    f.mirror.fail = undefined
    f.mirror.replace = path => path.endsWith('config.json') ? Buffer.from('{"tampered":true}'.padEnd(f.model.files[0]!.size)) : undefined
    await service.startDownload()
    expect((await until(state => state.local.status === 'failed')).local.error).toBe('verification')
    expect(await stat(join(f.home, 'models', 'embedding', 'tiny', 'config.json.part')).catch(() => undefined)).toBeUndefined()
    f.mirror.replace = undefined
    await service.startDownload()
    await until(installed)
  })

  it('reports a runtime tarball that cannot be extracted as a storage failure', async () => {
    const f = await fixtures()
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const garbage = Buffer.from('not a gzip tarball')
    f.served.set('/npm/onnxruntime-common/-/onnxruntime-common-9.9.9.tgz', garbage)
    const runtime = { ...f.runtime, packages: [{ name: 'onnxruntime-common', size: garbage.length, sha256: createHash('sha256').update(garbage).digest('hex') }, f.runtime.packages[1]!] }
    const { until } = await boot({ ...sourceConfig(f), runtime })
    expect((await until(state => state.local.status === 'failed')).local.error).toBe('storage')
    expect(await readdir(join(f.home, 'models', 'runtime', 'onnxruntime-9.9.9', 'node_modules'))).toEqual([])
  })

  it('reports a file it cannot write as a storage failure', async () => {
    const f = await fixtures()
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    // A file where the model directory should be.
    await writeFile(join(f.home, 'models'), 'not a directory')
    const { until } = await boot(sourceConfig(f))
    expect((await until(state => state.local.status === 'failed')).local.error).toBe('storage')
  })

  it('finds a damaged install at startup and repairs it, including a same-size corruption', async () => {
    const f = await fixtures()
    const first = await boot(sourceConfig(f))
    await first.until(installed)
    await first.ctx.fiber.dispose()
    // An intact install is ready at the next startup without a request.
    const requests = f.mirror.requests.length
    const intact = await boot(sourceConfig(f))
    await intact.until(installed)
    expect(f.mirror.requests).toHaveLength(requests)
    await intact.ctx.fiber.dispose()
    const dir = join(f.home, 'models', 'embedding', 'tiny')
    await truncate(join(dir, 'onnx', 'model.onnx'), 3)
    const second = await boot(sourceConfig(f))
    expect((await second.service.getState()).local.status).toBe('damaged')
    // Same size, wrong bytes: only the repair's sha256 check notices; a missing file is downloaded too.
    await writeFile(join(dir, 'config.json'), 'x'.repeat(f.model.files[0]!.size))
    await rm(join(dir, 'tokenizer_config.json'))
    await second.service.startDownload()
    await second.until(installed)
    const requested = f.mirror.requests.slice(-3).map(request => request.path)
    expect(requested.sort()).toEqual(['/models/acme/tiny/config.json', '/models/acme/tiny/onnx/model.onnx', '/models/acme/tiny/tokenizer_config.json'])
  })

  it('resumes a model file deleted after install at the next startup', async () => {
    const f = await fixtures()
    const first = await boot(sourceConfig(f))
    await first.until(installed)
    await first.ctx.fiber.dispose()
    await rm(join(f.home, 'models', 'embedding', 'tiny', 'tokenizer.json'))
    const second = await boot(sourceConfig(f))
    await second.until(installed)
    expect(f.mirror.requests.at(-1)?.path).toBe('/models/acme/tiny/tokenizer.json')
  })

  it('reports a model file it cannot read while repairing as a storage failure', async () => {
    const f = await fixtures()
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const dir = join(f.home, 'models', 'embedding', 'tiny')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'tokenizer.json'), 'short')
    await mkdir(join(dir, 'config.json'))
    const { service, until } = await boot(sourceConfig(f))
    expect((await service.getState()).local.status).toBe('damaged')
    await service.startDownload()
    expect((await until(state => state.local.status === 'failed')).local.error).toBe('storage')
  })

  it('marks an installed model that does not load as damaged', async () => {
    const f = await fixtures('broken weights')
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const { service, until } = await boot(sourceConfig(f))
    await until(state => state.local.status === 'damaged')
    expect(remoteErrorOf(await service.embed('local/tiny', ['annual']).catch((error: unknown) => error))).toMatchObject({ code: 'embedding/local-model-unavailable' })
  })

  it('deletes the model and its runtime, and stays missing without automatic download', async () => {
    const f = await fixtures('w'.repeat(200_000))
    const release = Promise.withResolvers<undefined>()
    const sent = Promise.withResolvers<undefined>()
    f.mirror.hold = { path: 'model.onnx', release: release.promise, sent: () => { sent.resolve(undefined) } }
    const first = await boot(sourceConfig(f))
    await sent.promise
    // Deleting during a download stops it first.
    const removing = first.service.removeLocalModel()
    release.resolve(undefined)
    const runtimeBytes = f.runtime.packages.reduce((sum, pkg) => sum + pkg.size, 0)
    expect((await removing).local).toMatchObject({ status: 'missing', receivedBytes: runtimeBytes, dimensions: null })
    expect(await readdir(join(f.home, 'models', 'embedding'))).toEqual([])
    // The runtime stays: once loaded, its native library cannot be deleted on Windows.
    expect(await readdir(join(f.home, 'models', 'runtime', 'onnxruntime-9.9.9', 'node_modules'))).toEqual(['onnxruntime-common', 'onnxruntime-node'])
    await first.ctx.fiber.dispose()
    const second = await boot({ ...sourceConfig(f), autoDownload: false })
    expect((await second.service.getState()).local.status).toBe('missing')
    await second.service.startDownload()
    await second.until(installed)
  })

  it('skips a mirror whose bytes fail verification', async () => {
    const f = await fixtures()
    for (const [path, data] of [...f.served]) if (path.startsWith('/models/')) f.served.set(path.replace('/models/', '/bad/'), Buffer.from('x'.repeat(data.length)))
    const { until } = await boot(sourceConfig(f, [`${f.mirror.origin}/bad/{repo}/{file}`, `${f.mirror.origin}/models/{repo}/{file}`]))
    await until(installed)
  })

  it('reports a partial file it cannot write as a storage failure without trying more mirrors', async () => {
    const f = await fixtures()
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    // A read-only partial file: the mirror answers the Range request, then appending to it fails.
    const dir = join(f.home, 'models', 'embedding', 'tiny')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'config.json.part'), '{', { mode: 0o444 })
    const { until } = await boot(sourceConfig(f, [`${f.mirror.origin}/models/{repo}/{file}`, `${f.mirror.origin}/second/{repo}/{file}`]))
    expect((await until(state => state.local.status === 'failed')).local.error).toBe('storage')
    expect(f.mirror.requests.filter(request => request.path.startsWith('/second'))).toEqual([])
  })

  it('ignores a model load that a deletion overtook, whether it succeeds or fails', async () => {
    for (const weights of ['slow weights', 'slow broken weights']) {
      const f = await fixtures(weights)
      const gate = Promise.withResolvers<undefined>()
      Object.assign(globalThis, { ortGate: gate.promise, ortWaiting: false })
      const { service, until } = await boot(sourceConfig(f))
      await until(state => state.local.status === 'installed')
      // The load is past its file reads and waiting on the session.
      await vi.waitFor(() => { expect((globalThis as { ortWaiting?: boolean }).ortWaiting).toBe(true) })
      expect((await service.removeLocalModel()).local.status).toBe('missing')
      gate.resolve(undefined)
      await new Promise(resolve => setTimeout(resolve, 20))
      expect((await service.getState()).local).toMatchObject({ status: 'missing', dimensions: null })
    }
  })

  it('stays unsupported on a platform the runtime has no build for', async () => {
    const f = await fixtures()
    const { service } = await boot({ ...sourceConfig(f), runtime: { ...f.runtime, platforms: ['plan9-mips'] } })
    expect((await service.getState()).local.status).toBe('unsupported')
    expect(remoteErrorOf(await service.startDownload().catch((error: unknown) => error))).toMatchObject({ code: 'embedding/local-model-unavailable' })
    expect((await service.removeLocalModel()).local.status).toBe('unsupported')
    expect(f.mirror.requests).toEqual([])
  })

  it('ends a watch when its subscriber leaves, and when the service is disposed', async () => {
    const f = await fixtures()
    const { ctx, service } = await boot({ ...sourceConfig(f), autoDownload: false })
    const controller = new AbortController()
    const stream = service.watch(controller.signal)[Symbol.asyncIterator]()
    expect((await stream.next()).value).toMatchObject({ local: { status: 'missing' } })
    const pending = stream.next()
    controller.abort()
    expect(await pending).toMatchObject({ done: true })
    const other = service.watch(new AbortController().signal)[Symbol.asyncIterator]()
    await other.next()
    const ending = other.next()
    await ctx.fiber.dispose()
    expect(await ending).toMatchObject({ done: true })
  })
})

/** A mock OpenAI-compatible `/v1/embeddings`; a reply of `hang` never answers, and `cut` drops the body midway. */
async function startEndpoint() {
  const requests: { headers: IncomingHttpHeaders; body: { model: string; input: string[] } }[] = []
  let reply: ((body: { model: string; input: string[] }) => { status: number; body: string } | 'hang' | 'cut') | undefined
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => { raw += chunk.toString() })
    req.on('end', () => {
      const body = JSON.parse(raw) as { model: string; input: string[] }
      requests.push({ headers: req.headers, body })
      const custom = reply?.(body)
      if (custom === 'hang') return
      if (custom === 'cut') {
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' })
        res.write('{"data": [', () => { res.destroy() })
        return
      }
      if (custom !== undefined) { res.writeHead(custom.status, { 'content-type': 'application/json' }).end(custom.body); return }
      // Answer out of order to prove the client sorts by index.
      const data = body.input.map((text, index) => ({ index, embedding: [text.length, index, 1] })).reverse()
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data }))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  cleanups.push(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) }))
  return {
    baseURL: `http://127.0.0.1:${String((server.address() as { port: number }).port)}/v1/`,
    requests,
    setReply: (next: typeof reply) => { reply = next },
  }
}

describe('API embedding models', () => {
  async function bootApi() {
    const f = await fixtures()
    const api = await startEndpoint()
    const provider: { endpoint: LlmRouteEndpoint | undefined } = {
      endpoint: { baseURL: api.baseURL, api: 'openai-completions', headers: { 'X-Company-Code': 'acme' }, resolveApiKey: () => Promise.resolve('sk-acme') },
    }
    const booted = await boot({ ...sourceConfig(f), autoDownload: false }, provider)
    return { ...booted, api, provider }
  }

  it('lists only configured routes with an OpenAI-protocol endpoint', async () => {
    const { service, provider } = await bootApi()
    expect(await service.listProviders()).toEqual([{ provider: 'acme', displayName: 'Acme 网关' }])
    provider.endpoint = undefined
    expect(await service.listProviders()).toEqual([])
  })

  it('adds a model after measuring its vector size, and embeds through the route with its credential and headers', async () => {
    const { service, api } = await bootApi()
    const state = await service.addApiModel('acme', ' bge-m3 ')
    expect(state.apiModels).toEqual([{ id: 'acme/bge-m3', provider: 'acme', providerName: 'Acme 网关', model: 'bge-m3', dimensions: 3, available: true }])
    expect(api.requests[0]).toMatchObject({ body: { model: 'bge-m3', input: ['dimension probe'] }, headers: { authorization: 'Bearer sk-acme', 'x-company-code': 'acme' } })
    expect(await service.embed('acme/bge-m3', ['ab', 'abcd'])).toEqual([[2, 0, 1], [4, 1, 1]])
    // More texts than one request may carry go in consecutive requests of at most ten, in order.
    const texts = Array.from({ length: 23 }, (_, index) => 'x'.repeat(index + 1))
    const before = api.requests.length
    expect((await service.embed('acme/bge-m3', texts)).map(vector => vector[0])).toEqual(texts.map(text => text.length))
    expect(api.requests.slice(before).map(request => (request.body as { input: string[] }).input.length)).toEqual([10, 10, 3])
    expect(remoteErrorOf(await service.addApiModel('acme', 'bge-m3').catch((error: unknown) => error))).toMatchObject({ code: 'embedding/duplicate-model' })
    expect((await service.removeApiModel('acme/bge-m3')).apiModels).toEqual([])
    expect(remoteErrorOf(await service.removeApiModel('acme/bge-m3').catch((error: unknown) => error))).toMatchObject({ code: 'embedding/model-not-found' })
    expect(remoteErrorOf(await service.embed('acme/bge-m3', ['x']).catch((error: unknown) => error))).toMatchObject({ code: 'embedding/model-not-found' })
  })

  it('refuses a route without an OpenAI endpoint, and an empty model id', async () => {
    const { service } = await bootApi()
    for (const [provider, model] of [['claude', 'voyage-3'], ['gone', 'x'], ['acme', '  ']] as const) {
      expect(remoteErrorOf(await service.addApiModel(provider, model).catch((error: unknown) => error))).toMatchObject({ code: 'embedding/provider-unavailable' })
    }
  })

  it('reports the endpoint\'s refusal, an unreadable reply, and an unreachable endpoint', async () => {
    const { service, api, provider } = await bootApi()
    const failed = async () => remoteErrorOf(await service.addApiModel('acme', 'm').catch((error: unknown) => error))
    api.setReply(() => ({ status: 401, body: JSON.stringify({ error: { message: 'Invalid API key' } }) }))
    expect(await failed()).toMatchObject({ code: 'embedding/request-failed', message: 'HTTP 401: Invalid API key', details: { status: 401 } })
    api.setReply(() => ({ status: 404, body: JSON.stringify({ message: 'model not found' }) }))
    expect((await failed())?.message).toBe('HTTP 404: model not found')
    api.setReply(() => ({ status: 502, body: 'Bad gateway' }))
    expect((await failed())?.message).toBe('HTTP 502: Bad gateway')
    api.setReply(() => ({ status: 200, body: JSON.stringify({ data: [] }) }))
    expect(await failed()).toMatchObject({ code: 'embedding/request-failed', details: { status: 200 } })
    api.setReply(() => ({ status: 200, body: 'not json' }))
    expect(await failed()).toMatchObject({ code: 'embedding/request-failed' })
    provider.endpoint = { ...provider.endpoint!, baseURL: 'http://127.0.0.1:9/v1', resolveApiKey: () => Promise.resolve(undefined) }
    expect(await failed()).toMatchObject({ code: 'embedding/request-failed', details: { status: null } })
  })

  it('reports a request past its deadline and a body cut midway as request failures', async () => {
    const f = await fixtures()
    const api = await startEndpoint()
    const endpoint: LlmRouteEndpoint = { baseURL: api.baseURL, api: 'openai-completions', headers: undefined, resolveApiKey: () => Promise.resolve(undefined) }
    const { service } = await boot({ ...sourceConfig(f), autoDownload: false, requestTimeoutMs: 100 }, { endpoint })
    api.setReply(() => 'hang')
    expect(remoteErrorOf(await service.addApiModel('acme', 'm').catch((error: unknown) => error)))
      .toMatchObject({ code: 'embedding/request-failed', message: 'the embedding endpoint did not answer in time', details: { status: null } })
    api.setReply(() => 'cut')
    expect(remoteErrorOf(await service.addApiModel('acme', 'm').catch((error: unknown) => error)))
      .toMatchObject({ code: 'embedding/request-failed', details: { status: 200 } })
  })

  it('keeps one entry when the same model is added twice at once', async () => {
    const { service } = await bootApi()
    const results = await Promise.allSettled([service.addApiModel('acme', 'bge-m3'), service.addApiModel('acme', 'bge-m3')])
    expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(remoteErrorOf(results.find(result => result.status === 'rejected')!.reason)).toMatchObject({ code: 'embedding/duplicate-model' })
    expect((await service.getState()).apiModels).toHaveLength(1)
  })

  it('marks a model whose route is gone as unavailable and refuses to embed with it', async () => {
    const { service, provider, api, dropAcme } = await bootApi()
    await service.addApiModel('acme', 'bge-m3')
    provider.endpoint = undefined
    expect((await service.getState()).apiModels[0]).toMatchObject({ available: false, providerName: 'Acme 网关' })
    dropAcme()
    expect((await service.getState()).apiModels[0]).toMatchObject({ available: false, providerName: 'acme' })
    expect(remoteErrorOf(await service.embed('acme/bge-m3', ['x']).catch((error: unknown) => error))).toMatchObject({ code: 'embedding/provider-unavailable' })
    expect(api.requests).toHaveLength(1)
  })

  it('cancels an embedding request with the caller', async () => {
    const { service } = await bootApi()
    await service.addApiModel('acme', 'bge-m3')
    const controller = new AbortController()
    controller.abort('cancelled')
    await expect(service.embed('acme/bge-m3', ['x'], controller.signal)).rejects.toBe('cancelled')
  })

  it('refuses to remove a model something uses, naming the users, and allows it once they let go', async () => {
    const { ctx, service, until } = await bootApi()
    await service.addApiModel('acme', 'bge-m3')
    const users = new Map<string, string[]>([['acme/bge-m3', ['产品手册']], ['local/tiny', ['制度库', '合同库']]])
    const consumer = ctx.plugin({ inject: ['embedding'], apply: (inner: Context) => { inner.embedding.registerUsage(id => Promise.resolve(users.get(id) ?? [])) } })
    await consumer
    expect(remoteErrorOf(await service.removeApiModel('acme/bge-m3').catch((error: unknown) => error)))
      .toMatchObject({ code: 'embedding/model-in-use', details: { id: 'acme/bge-m3', users: ['产品手册'] } })
    await service.startDownload()
    await until(installed)
    expect(remoteErrorOf(await service.removeLocalModel().catch((error: unknown) => error)))
      .toMatchObject({ code: 'embedding/model-in-use', details: { users: ['制度库', '合同库'] } })
    // Withdrawn with its fiber.
    await consumer.dispose()
    expect((await service.removeApiModel('acme/bge-m3')).apiModels).toEqual([])
    expect((await service.removeLocalModel()).local.status).toBe('missing')
  })

  it('needs the settings service to edit the list', async () => {
    const f = await fixtures()
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerConfigurableProviders([{ provider: 'acme', displayName: 'Acme', settingsNs: 'llm-test', settingsPath: [] }])
    ctx.llm.registerEndpointResolver('llm-test', () => ({ baseURL: 'http://127.0.0.1:9/v1', api: 'openai-responses', headers: undefined, resolveApiKey: () => Promise.resolve(undefined) }))
    await ctx.plugin(EmbeddingService, { ...sourceConfig(f), autoDownload: false })
    const api = await startEndpoint()
    ctx.llm.registerEndpointResolver('llm-other', () => undefined)
    vi.spyOn(ctx.llm, 'routeEndpoint').mockReturnValue({ baseURL: api.baseURL, api: 'openai-responses', headers: undefined, resolveApiKey: () => Promise.resolve(undefined) })
    await expect(ctx.embedding.addApiModel('acme', 'bge-m3')).rejects.toThrow('requires the settings service')
    expect((await ctx.embedding.getState()).apiModels).toEqual([])
  })
})
