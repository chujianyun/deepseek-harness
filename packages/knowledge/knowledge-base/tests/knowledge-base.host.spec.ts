/** Knowledge bases over controllable stand-ins for the embedding models and the Hub sign-in. */
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { EmbeddingState } from '@deepseek-ai/dsh-embedding'
import { RemoteError, remoteErrorOf, remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import KnowledgeBaseService, { type Config, type KnowledgeState } from '../src/index.ts'

/** Plugin options a test passes. */
type Options = Pick<Config, 'maxFileBytes'>
import { BaseStore } from '../src/store.ts'
import { terms } from '../src/terms.ts'

const FIXTURES = join(import.meta.dirname, 'fixtures')
const LOCAL = 'local/qwen3-embedding-0.6b'
const API = 'acme/bge-m3'
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
})

/** A pushable state with a Remote-style watch stream. */
class Watched<T> {
  private readonly listeners = new Set<() => void>()
  constructor(public value: T) {}
  set(next: T): void { this.value = next; for (const listener of this.listeners) listener() }
  async *watch(signal: AbortSignal): AsyncIterable<T> {
    let dirty = true
    let wake: (() => void) | undefined
    const changed = (): void => { dirty = true; wake?.() }
    this.listeners.add(changed)
    signal.addEventListener('abort', changed, { once: true })
    try {
      while (!signal.aborted) {
        if (dirty) { dirty = false; yield this.value; continue }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally { this.listeners.delete(changed) }
  }
}

/** A 64-dimension bag of hashed terms: texts sharing words point the same way. */
function vectorize(text: string): number[] {
  const vector = new Array<number>(64).fill(0)
  for (const term of terms(text)) {
    let hash = 0
    for (const char of term) hash = (hash * 31 + char.codePointAt(0)!) % 64
    vector[hash]! += 1
  }
  return vector
}

function embeddingState(localStatus: EmbeddingState['local']['status'] = 'installed'): EmbeddingState {
  return {
    local: { id: LOCAL, name: 'Qwen3-Embedding-0.6B', status: localStatus, receivedBytes: 0, totalBytes: 1, dimensions: 64, error: null },
    apiModels: [{ id: API, provider: 'acme', providerName: 'Acme', model: 'bge-m3', dimensions: 64, available: true }],
  }
}

async function boot(options: { tenant?: string | null; home?: string; config?: Options; localStatus?: EmbeddingState['local']['status'] } = {}) {
  const home = options.home ?? await mkdtemp(join(tmpdir(), 'dsh-knowledge-'))
  if (options.home === undefined) cleanups.push(() => rm(home, { recursive: true, force: true }))
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  const embeddingWatched = new Watched(embeddingState(options.localStatus))
  const usages: ((id: string) => Promise<readonly string[]>)[] = []
  const embedding = {
    gate: undefined as Promise<unknown> | undefined,
    entered: undefined as (() => void) | undefined,
    failure: undefined as Error | undefined,
    calls: [] as { id: string; texts: readonly string[] }[],
    getState: () => Promise.resolve(embeddingWatched.value),
    watch: (signal: AbortSignal) => embeddingWatched.watch(signal),
    registerUsage: (usage: (id: string) => Promise<readonly string[]>) => { usages.push(usage) },
    async embed(id: string, texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
      embedding.calls.push({ id, texts })
      if (embedding.gate !== undefined) {
        embedding.entered?.()
        await Promise.race([embedding.gate, new Promise((_, reject) => { signal?.addEventListener('abort', () => { reject(signal.reason as Error) }, { once: true }) })])
      }
      if (embedding.failure !== undefined) throw embedding.failure
      return texts.map(vectorize)
    },
  }
  const hub = new Watched({ status: 'signed-in', profile: options.tenant === null ? null : { tenantId: options.tenant ?? 't-a' } })
  ctx.provide('embedding', embedding as never)
  ctx.provide('hubAccount', { getState: () => Promise.resolve(hub.value), watch: (signal: AbortSignal) => hub.watch(signal) } as never)
  const fiber = ctx.plugin(KnowledgeBaseService, { dshHome: home, ...options.config })
  await fiber
  const service = ctx.get('knowledgeBases')!
  const stream = new AbortController()
  cleanups.push(async () => { stream.abort() })
  const iterator = service.watch(stream.signal)[Symbol.asyncIterator]()
  const until = async (predicate: (state: KnowledgeState) => boolean): Promise<KnowledgeState> => {
    for (;;) {
      const next = await iterator.next()
      if (next.done === true) throw new Error('state stream ended')
      if (predicate(next.value)) return next.value
    }
  }
  const switchTenant = (tenantId: string | null) => { hub.set({ status: 'signed-in', profile: tenantId === null ? null : { tenantId } }) }
  return { ctx, fiber, service, home, embedding, embeddingWatched, usages, until, switchTenant }
}

const fixture = (name: string) => join(FIXTURES, name)
const settled = (state: KnowledgeState) => state.bases.every(base => base.items.every(item => item.status === 'completed' || item.status === 'failed'))

describe('knowledge bases', () => {
  it('publishes the namespace and its methods', async () => {
    const { service } = await boot()
    expect(service.typertRemote.namespace).toBe('knowledgeBases')
    expect(remoteMethods(service).map(method => method.method)).toEqual([
      'getState', 'watch', 'createBase', 'renameBase', 'deleteBase', 'addFiles', 'reprocessItem', 'deleteItem',
    ])
  })

  it('shows nothing and refuses to create while signed out', async () => {
    const { service } = await boot({ tenant: null })
    expect(await service.getState()).toEqual({ tenantId: null, bases: [] })
    expect(remoteErrorOf(await service.createBase('制度库', LOCAL).catch((error: unknown) => error))).toMatchObject({ code: 'hub-account/signed-out' })
  })

  it('creates a knowledge base with a valid, unique name and an offered embedding model', async () => {
    const { service, home } = await boot()
    const failure = async (name: string, model: string) =>
      remoteErrorOf(await service.createBase(name, model).catch((error: unknown) => error))?.code
    expect(await failure('  ', LOCAL)).toBe('knowledge/invalid-name')
    expect(await failure('名'.repeat(51), LOCAL)).toBe('knowledge/invalid-name')
    expect(await failure('制度库', 'local/other')).toBe('knowledge/embedding-model-unavailable')
    const state = await service.createBase(' 制度库 ', LOCAL)
    expect(state.bases).toEqual([expect.objectContaining({ name: '制度库', embeddingModelId: LOCAL, embeddingModelName: 'Qwen3-Embedding-0.6B', status: 'ready', items: [] })])
    expect(await failure('制度库', API)).toBe('knowledge/duplicate-name')
    const created = (await service.createBase('产品资料', API)).bases[1]!
    expect(created.embeddingModelName).toBe('bge-m3')
    const settings = JSON.parse(await readFile(join(home, 'knowledge', 't-a', created.id, 'base.json'), 'utf8')) as Record<string, unknown>
    expect(settings).toMatchObject({ version: 1, name: '产品资料', embeddingModelId: API, chunkSize: 1024, chunkOverlap: 200 })
  })

  it('adds the four document kinds, refuses what it cannot take, and makes them searchable', async () => {
    const { service, until, home, embedding } = await boot({ config: { maxFileBytes: 50_000 } })
    const { id } = (await service.createBase('制度库', LOCAL)).bases[0]!
    const dir = await mkdtemp(join(tmpdir(), 'dsh-knowledge-src-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    await writeFile(join(dir, 'logo.png'), 'png')
    const result = await service.addFiles(id, [
      fixture('annual-leave.docx'), fixture('meeting-notes.txt'), fixture('product-manual.md'),
      fixture('expense-policy.pdf'), join(dir, 'logo.png'), join(dir, 'missing.md'), dir + '.txt',
    ])
    expect(result).toEqual({
      added: 3,
      rejected: [{ name: 'expense-policy.pdf', reason: 'too-large' }, { name: 'logo.png', reason: 'unsupported' }, { name: 'missing.md', reason: 'unreadable' }, { name: `${dir.split('/').at(-1)!}.txt`, reason: 'unreadable' }],
    })
    const state = await until(next => next.bases[0]!.items.length === 3 && settled(next))
    expect(state.bases[0]!.items.map(item => [item.name, item.status, item.chunkCount > 0])).toEqual([
      ['annual-leave.docx', 'completed', true], ['meeting-notes.txt', 'completed', true], ['product-manual.md', 'completed', true],
    ])
    expect(embedding.calls.every(call => call.id === LOCAL)).toBe(true)
    // Copies are kept under the knowledge base.
    expect((await readdir(join(home, 'knowledge', 't-a', id, 'files'))).map(name => extname(name)).sort()).toEqual(['.docx', '.md', '.txt'])
    const hits = await service.search(id, '员工每年有几天年假', { limit: 2, threshold: 0 })
    expect(hits[0]!.itemName).toBe('annual-leave.docx')
    expect(hits[0]!.text).toContain('带薪年假')
  })

  it('reports an empty file, an unreadable file, and an embedding failure, and reprocesses an item', async () => {
    const { service, until, embedding } = await boot()
    const { id } = (await service.createBase('杂项', LOCAL)).bases[0]!
    const dir = await mkdtemp(join(tmpdir(), 'dsh-knowledge-src-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    await writeFile(join(dir, 'blank.txt'), '  \n\n ')
    await writeFile(join(dir, 'scan.pdf'), 'not a pdf')
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    await service.addFiles(id, [join(dir, 'blank.txt'), join(dir, 'scan.pdf')])
    let state = await until(next => next.bases[0]!.items.length === 2 && settled(next))
    expect(state.bases[0]!.items.map(item => item.error)).toEqual(['empty', 'unreadable'])
    embedding.failure = new RemoteError('embedding/request-failed', 'HTTP 401: invalid key', { status: 401 })
    await service.addFiles(id, [fixture('meeting-notes.txt')])
    state = await until(next => next.bases[0]!.items.length === 3 && settled(next))
    const notes = state.bases[0]!.items[2]!
    expect(notes).toMatchObject({ status: 'failed', error: 'embedding' })
    embedding.failure = undefined
    expect((await service.reprocessItem(id, notes.id)).bases[0]!.items[2]!.status).toMatch(/pending|processing/u)
    state = await until(next => next.bases[0]!.items[2]!.status === 'completed')
    expect(state.bases[0]!.items[2]!.error).toBeNull()
    expect(remoteErrorOf(await service.reprocessItem(id, 'nope').catch((error: unknown) => error))).toMatchObject({ code: 'knowledge/not-found' })
  })

  it('renames and deletes knowledge bases and items with their files', async () => {
    const { service, until, home } = await boot()
    const { id } = (await service.createBase('甲', LOCAL)).bases[0]!
    await service.createBase('乙', LOCAL)
    expect(remoteErrorOf(await service.renameBase(id, '乙').catch((error: unknown) => error))).toMatchObject({ code: 'knowledge/duplicate-name' })
    expect((await service.renameBase(id, '甲公司制度')).bases[0]!.name).toBe('甲公司制度')
    expect((await service.renameBase(id, '甲公司制度')).bases[0]!.name).toBe('甲公司制度')
    await service.addFiles(id, [fixture('meeting-notes.txt')])
    const item = (await until(next => next.bases[0]!.items[0]?.status === 'completed')).bases[0]!.items[0]!
    const after = await service.deleteItem(id, item.id)
    expect(after.bases[0]!.items).toEqual([])
    expect(await readdir(join(home, 'knowledge', 't-a', id, 'files'))).toEqual([])
    expect((await service.deleteBase(id)).bases.map(base => base.name)).toEqual(['乙'])
    expect(await readdir(join(home, 'knowledge', 't-a'))).toHaveLength(1)
    for (const call of [() => service.renameBase(id, 'x'), () => service.deleteBase(id), () => service.addFiles(id, []), () => service.deleteItem(id, item.id), () => service.search(id, 'q', { limit: 1, threshold: 0 })]) {
      expect(remoteErrorOf(await call().catch((error: unknown) => error))).toMatchObject({ code: 'knowledge/not-found' })
    }
  })

  it('keeps each tenant\'s knowledge bases apart', async () => {
    const { service, switchTenant, until } = await boot()
    await service.createBase('甲公司制度', LOCAL)
    switchTenant('t-b')
    await until(state => state.tenantId === 't-b')
    expect((await service.getState()).bases).toEqual([])
    await service.createBase('乙公司资料', LOCAL)
    switchTenant(null)
    expect((await until(state => state.tenantId === null)).bases).toEqual([])
    switchTenant('t-a')
    expect((await until(state => state.tenantId === 't-a')).bases.map(base => base.name)).toEqual(['甲公司制度'])
  })

  it('stops processing on a tenant switch and resumes local-model items on return', async () => {
    const { service, switchTenant, until, embedding } = await boot()
    const { id } = (await service.createBase('制度库', LOCAL)).bases[0]!
    const gate = Promise.withResolvers<undefined>()
    const entered = Promise.withResolvers<undefined>()
    embedding.gate = gate.promise
    embedding.entered = () => { entered.resolve(undefined) }
    await service.addFiles(id, [fixture('meeting-notes.txt'), fixture('product-manual.md')])
    await entered.promise
    switchTenant('t-b')
    await until(state => state.tenantId === 't-b')
    embedding.gate = undefined
    gate.resolve(undefined)
    switchTenant('t-a')
    const state = await until(next => next.tenantId === 't-a' && next.bases[0]!.items.every(item => item.status === 'completed'))
    expect(state.bases[0]!.items).toHaveLength(2)
  })

  it('at startup resumes local-model items and fails API-model items left unfinished', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-knowledge-'))
    cleanups.push(() => rm(home, { recursive: true, force: true }))
    const first = await boot({ home })
    const local = (await first.service.createBase('本地', LOCAL)).bases[0]!.id
    const api = (await first.service.createBase('接口', API)).bases[1]!.id
    await first.ctx.fiber.dispose()
    // Items a previous run left behind.
    for (const [base, ids] of [[local, ['1', '2']], [api, ['3', '4']]] as const) {
      const dir = join(home, 'knowledge', 't-a', base)
      const store = new BaseStore(join(dir, 'index.sqlite'))
      // A finished item stays as it is.
      store.addItem({ id: `${base}-done`, name: 'done.txt', size: 1, status: 'completed', error: null, chunkCount: 1, addedAt: '2026-10-05T00:00:00.000Z' })
      for (const [index, itemId] of ids.entries()) {
        await copyFile(fixture('meeting-notes.txt'), join(dir, 'files', `${itemId}.txt`))
        store.addItem({ id: itemId, name: 'notes.txt', size: 1, status: index === 0 ? 'processing' : 'pending', error: null, chunkCount: 0, addedAt: `2026-10-05T00:00:0${itemId}.000Z` })
      }
      store.close()
    }
    const second = await boot({ home })
    const state = await second.until(next => next.bases.length === 2 && settled(next))
    expect(state.bases.map(base => base.items.map(item => [item.status, item.error]))).toEqual([
      [['completed', null], ['completed', null], ['completed', null]],
      [['completed', null], ['failed', 'interrupted'], ['failed', 'interrupted']],
    ])
  })

  it('holds a local-model knowledge base unavailable until the local model is installed', async () => {
    const { service, until, embeddingWatched } = await boot({ localStatus: 'downloading' })
    const { id } = (await service.createBase('制度库', LOCAL)).bases[0]!
    await service.addFiles(id, [fixture('meeting-notes.txt')])
    expect((await service.getState()).bases[0]).toMatchObject({ status: 'unavailable', items: [expect.objectContaining({ status: 'pending' })] })
    embeddingWatched.set(embeddingState('installed'))
    const state = await until(next => next.bases[0]!.items[0]!.status === 'completed')
    expect(state.bases[0]!.status).toBe('ready')
    // An unsupported local model is not offered.
    embeddingWatched.set(embeddingState('unsupported'))
    await until(next => next.bases[0]!.status === 'unavailable')
    expect(remoteErrorOf(await service.createBase('另一个', LOCAL).catch((error: unknown) => error))).toMatchObject({ code: 'knowledge/embedding-model-unavailable' })
  })

  it('names the knowledge bases of every tenant using an embedding model', async () => {
    const { service, usages, switchTenant, until, home } = await boot()
    // Nothing on disk yet.
    expect(await usages[0]!(LOCAL)).toEqual([])
    await service.createBase('甲公司制度', LOCAL)
    switchTenant('t-b')
    await until(state => state.tenantId === 't-b')
    await service.createBase('乙公司资料', LOCAL)
    await service.createBase('乙公司接口', API)
    // A stray directory is not a knowledge base, and a stray file is not a tenant.
    await mkdir(join(home, 'knowledge', 't-b', 'stray'), { recursive: true })
    await writeFile(join(home, 'knowledge', 'notes.txt'), 'x')
    expect([...await usages[0]!(LOCAL)].sort()).toEqual(['乙公司资料', '甲公司制度'])
    expect(await usages[0]!(API)).toEqual(['乙公司接口'])
    expect(await usages[0]!('local/none')).toEqual([])
    switchTenant('t-a')
    await until(state => state.tenantId === 't-a')
    switchTenant('t-b')
    expect((await until(state => state.tenantId === 't-b')).bases.map(base => base.name)).toEqual(['乙公司资料', '乙公司接口'])
  })

  it('stops the item being processed when it or its knowledge base is deleted', async () => {
    const { service, until, embedding } = await boot()
    const { id } = (await service.createBase('制度库', LOCAL)).bases[0]!
    const other = (await service.createBase('产品库', LOCAL)).bases[1]!.id
    const gate = Promise.withResolvers<undefined>()
    let entered = Promise.withResolvers<undefined>()
    embedding.gate = gate.promise
    embedding.entered = () => { entered.resolve(undefined) }
    await service.addFiles(id, [fixture('meeting-notes.txt'), fixture('product-manual.md')])
    await entered.promise
    const first = (await service.getState()).bases[0]!.items[0]!
    entered = Promise.withResolvers<undefined>()
    await service.deleteItem(id, first.id)
    await entered.promise
    await service.addFiles(other, [fixture('meeting-notes.txt')])
    await service.deleteBase(id)
    embedding.gate = undefined
    gate.resolve(undefined)
    const state = await until(next => next.bases.length === 1 && next.bases[0]!.items[0]?.status === 'completed')
    expect(state.bases[0]!.name).toBe('产品库')
  })

  it('fails an item whose vectors do not match its chunks, or whose chunks cannot be stored, and keeps going', async () => {
    const { service, until, embedding } = await boot()
    const { id } = (await service.createBase('制度库', LOCAL)).bases[0]!
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(embedding, 'embed').mockResolvedValueOnce([])
    const complete = vi.spyOn(BaseStore.prototype, 'complete').mockImplementationOnce(() => { throw new Error('disk full') })
    await service.addFiles(id, [fixture('meeting-notes.txt'), fixture('product-manual.md'), fixture('annual-leave.docx')])
    const state = await until(next => next.bases[0]!.items.length === 3 && settled(next))
    expect(state.bases[0]!.items.map(item => [item.status, item.error])).toEqual([['failed', 'embedding'], ['failed', 'storage'], ['completed', null]])
    // When the index cannot even record the failure, the item is left as processing and the queue still moves on.
    complete.mockImplementationOnce(() => { throw new Error('disk full') })
    const original: (this: BaseStore, ...args: Parameters<BaseStore['setStatus']>) => void = Reflect.get(BaseStore.prototype, 'setStatus')
    vi.spyOn(BaseStore.prototype, 'setStatus').mockImplementation(function (this: BaseStore, itemId, status, error) {
      if (status === 'failed') throw new Error('database is locked')
      original.call(this, itemId, status, error)
    })
    await service.addFiles(id, [fixture('meeting-notes.txt'), fixture('product-manual.md')])
    const after = await until(next => next.bases[0]!.items.length === 5 && next.bases[0]!.items[4]!.status === 'completed')
    expect(after.bases[0]!.items[3]!.status).toBe('processing')
    expect(warn).toHaveBeenCalledWith('[knowledge-base] could not record a failure', expect.objectContaining({ unrecorded: 'Error: database is locked' }))
  })

  it('skips a knowledge base whose index is damaged, and refuses a search whose base went away while embedding', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-knowledge-'))
    cleanups.push(() => rm(home, { recursive: true, force: true }))
    const first = await boot({ home })
    const broken = (await first.service.createBase('损坏', LOCAL)).bases[0]!.id
    await first.service.createBase('完好', LOCAL)
    await first.ctx.fiber.dispose()
    await writeFile(join(home, 'knowledge', 't-a', broken, 'index.sqlite'), 'not a database'.repeat(100))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { service, embedding } = await boot({ home })
    const state = await service.getState()
    expect(state.bases.map(base => base.name)).toEqual(['完好'])
    expect(warn).toHaveBeenCalledWith('[knowledge-base] skipped a base whose index cannot be opened', expect.objectContaining({ dir: join(home, 'knowledge', 't-a', broken) }))
    const gate = Promise.withResolvers<undefined>()
    const entered = Promise.withResolvers<undefined>()
    embedding.gate = gate.promise
    embedding.entered = () => { entered.resolve(undefined) }
    const id = state.bases[0]!.id
    const search = service.search(id, '年假', { limit: 1, threshold: 0 }).catch((error: unknown) => error)
    await entered.promise
    embedding.gate = undefined
    await service.deleteBase(id)
    gate.resolve(undefined)
    expect(remoteErrorOf(await search)).toMatchObject({ code: 'knowledge/not-found' })
  })

  it('restarts an item being processed when asked to reprocess it', async () => {
    const { service, until, embedding } = await boot()
    const { id } = (await service.createBase('制度库', LOCAL)).bases[0]!
    const gate = Promise.withResolvers<undefined>()
    const entered = Promise.withResolvers<undefined>()
    embedding.gate = gate.promise
    embedding.entered = () => { entered.resolve(undefined) }
    await service.addFiles(id, [fixture('meeting-notes.txt')])
    await entered.promise
    const item = (await service.getState()).bases[0]!.items[0]!
    embedding.gate = undefined
    await service.reprocessItem(id, item.id)
    gate.resolve(undefined)
    expect((await until(next => next.bases[0]!.items[0]!.status === 'completed')).bases[0]!.items[0]!.chunkCount).toBe(1)
  })

  it('refuses a file that cannot be copied, and names a model the embedding settings no longer list by its id', async () => {
    const { service, embeddingWatched, until } = await boot()
    const { id } = (await service.createBase('接口', API)).bases[0]!
    const dir = await mkdtemp(join(tmpdir(), 'dsh-knowledge-src-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    await writeFile(join(dir, 'secret.txt'), 'x', { mode: 0o000 })
    expect(await service.addFiles(id, [join(dir, 'secret.txt')])).toEqual({ added: 0, rejected: [{ name: 'secret.txt', reason: 'unreadable' }] })
    embeddingWatched.set({ ...embeddingState(), apiModels: [] })
    expect((await until(state => state.bases[0]!.embeddingModelName === API)).bases[0]!.status).toBe('ready')
  })

  it('ends a watch when its subscriber leaves, and when the service is disposed', async () => {
    const { ctx, service } = await boot()
    const controller = new AbortController()
    const stream = service.watch(controller.signal)[Symbol.asyncIterator]()
    expect((await stream.next()).value).toMatchObject({ tenantId: 't-a' })
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
