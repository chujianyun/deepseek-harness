/** Knowledge bases over controllable stand-ins for the embedding models and the Hub sign-in. */
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const opened = vi.hoisted(() => ({ paths: [] as string[], canOpen: true }))
vi.mock('@deepseek-ai/dsh-native-command', () => ({
  canOpenNativePath: () => opened.canOpen,
  openNativeAssociatedPath: (path: string) => { opened.paths.push(path); return Promise.resolve() },
}))
import { Context } from '@deepseek-ai/cordis'
import { WebError } from '@deepseek-ai/dsh-web'
import type { EmbeddingState } from '@deepseek-ai/dsh-embedding'
import { RemoteError, remoteErrorOf, remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import KnowledgeBaseService, { type Config, type KnowledgeState } from '../src/index.ts'

/** Plugin options a test passes. */
type Options = Pick<Config, 'maxFileBytes' | 'maxFolderFiles' | 'maxNoteChars'>
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

/** A stand-in for `ctx.web`: pages by URL, each a page, a thrown error, or missing (an error too). */
function fakeWeb() {
  const pages = new Map<string, { statusCode?: number; kind?: 'html' | 'text'; content: string } | Error>()
  return {
    pages,
    fetched: [] as string[],
    async fetch(request: { url: string }) {
      this.fetched.push(request.url)
      const page = pages.get(request.url) ?? new Error(`could not reach ${request.url}`)
      if (page instanceof Error) throw page
      return { url: request.url, statusCode: page.statusCode ?? 200, truncated: false, body: { kind: page.kind ?? 'html', content: page.content } }
    },
  }
}

async function boot(options: {
  tenant?: string | null
  home?: string
  config?: Options
  localStatus?: EmbeddingState['local']['status']
  web?: boolean
} = {}) {
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
      // The trial embedding of a model change is never held.
      if (embedding.gate !== undefined && texts[0]?.includes('probe') !== true) {
        embedding.entered?.()
        await Promise.race([embedding.gate, new Promise((_, reject) => {
          if (signal?.aborted === true) reject(signal.reason as Error)
          signal?.addEventListener('abort', () => { reject(signal.reason as Error) }, { once: true })
        })])
      }
      if (embedding.failure !== undefined) throw embedding.failure
      return texts.map(vectorize)
    },
  }
  const hub = new Watched({ status: 'signed-in', profile: options.tenant === null ? null : { tenantId: options.tenant ?? 't-a' } })
  ctx.provide('embedding', embedding as never)
  ctx.provide('hubAccount', { getState: () => Promise.resolve(hub.value), watch: (signal: AbortSignal) => hub.watch(signal) } as never)
  const web = fakeWeb()
  if (options.web !== false) ctx.provide('web', web as never)
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
  return { ctx, fiber, service, home, embedding, embeddingWatched, usages, until, switchTenant, web }
}

const fixture = (name: string) => join(FIXTURES, name)
const settled = (state: KnowledgeState) => state.bases.every(base => base.items.every(item => item.status === 'completed' || item.status === 'failed'))

describe('knowledge bases', () => {
  it('publishes the namespace and its methods', async () => {
    const { service } = await boot()
    expect(service.typertRemote.namespace).toBe('knowledgeBases')
    expect(remoteMethods(service).map(method => method.method)).toEqual([
      'getState', 'watch', 'createBase', 'renameBase', 'updateSettings', 'reprocessAll', 'recall', 'deleteBase', 'addFiles',
      'addFolder', 'addUrl', 'createNote', 'updateNote', 'getNote', 'openItem', 'reprocessItem', 'deleteItem',
    ])
  })

  it('shows nothing and refuses to create while signed out', async () => {
    const { service } = await boot({ tenant: null })
    const state = await service.getState()
    expect(state).toMatchObject({ tenantId: null, bases: [] })
    // Every change raises the revision.
    await service.createBase('x', LOCAL).catch(() => undefined)
    expect((await service.getState()).revision).toBe(state.revision)
    expect(remoteErrorOf(await service.createBase('制度库', LOCAL).catch((error: unknown) => error))).toMatchObject({ code: 'hub-account/signed-out' })
  })

  it('creates a knowledge base with a valid, unique name and an offered embedding model', async () => {
    const { service, home } = await boot()
    const before = (await service.getState()).revision
    const failure = async (name: string, model: string) =>
      remoteErrorOf(await service.createBase(name, model).catch((error: unknown) => error))?.code
    expect(await failure('  ', LOCAL)).toBe('knowledge/invalid-name')
    expect(await failure('名'.repeat(51), LOCAL)).toBe('knowledge/invalid-name')
    expect(await failure('制度库', 'local/other')).toBe('knowledge/embedding-model-unavailable')
    const state = await service.createBase(' 制度库 ', LOCAL)
    expect(state.revision).toBeGreaterThan(before)
    expect(state.bases).toEqual([expect.objectContaining({ name: '制度库', embeddingModelId: LOCAL, embeddingModelName: 'Qwen3-Embedding-0.6B', status: 'ready', items: [] })])
    expect(await failure('制度库', API)).toBe('knowledge/duplicate-name')
    const created = (await service.createBase('产品资料', API)).bases[1]!
    expect(created.embeddingModelName).toBe('bge-m3')
    const settings = JSON.parse(await readFile(join(home, 'knowledge', 't-a', created.id, 'base.json'), 'utf8')) as Record<string, unknown>
    expect(settings).toMatchObject({ version: 1, name: '产品资料', embeddingModelId: API, chunkSize: 1024, chunkOverlap: 200 })
    // Cherry Studio's defaults, and the vector length Settings reports for the model.
    expect(created).toMatchObject({
      dimensions: 64,
      settings: { chunkStrategy: 'structured', chunkSeparator: '\\n\\n', chunkSize: 1024, chunkOverlap: 200, documentCount: 6, threshold: 0 },
    })
  })

  it('validates settings, and the recall test follows the retrieval settings', async () => {
    const { service, until, home } = await boot()
    const { id } = (await service.createBase('制度库', LOCAL)).bases[0]!
    await service.addFiles(id, [fixture('annual-leave.docx'), fixture('meeting-notes.txt'), fixture('product-manual.md'), fixture('expense-policy.pdf')])
    await until(next => next.bases[0]!.items.length === 4 && settled(next))
    const invalid = async (patch: Record<string, unknown>) =>
      remoteErrorOf(await service.updateSettings(id, patch as never).catch((error: unknown) => error))
    expect(await invalid({ documentCount: 0 })).toMatchObject({ code: 'knowledge/invalid-settings', details: { field: 'documentCount' } })
    expect(await invalid({ documentCount: 51 })).toMatchObject({ details: { field: 'documentCount' } })
    expect(await invalid({ threshold: 1.5 })).toMatchObject({ details: { field: 'threshold' } })
    expect(await invalid({ chunkSize: 0 })).toMatchObject({ details: { field: 'chunkSize' } })
    expect(await invalid({ chunkSize: 100, chunkOverlap: 100 })).toMatchObject({ details: { field: 'chunkOverlap' } })
    expect(await invalid({ chunkStrategy: 'delimiter', chunkSeparator: '' })).toMatchObject({ details: { field: 'chunkSeparator' } })
    expect(await invalid({ rerankModelId: 'x' })).toMatchObject({ details: { field: 'settings' } })
    expect(await invalid({ chunkStrategy: 'words' })).toMatchObject({ details: { field: 'chunkStrategy' } })
    expect(remoteErrorOf(await service.updateSettings('nope', {}).catch((error: unknown) => error))).toMatchObject({ code: 'knowledge/not-found' })

    const all = await service.recall(id, '年假有几天')
    expect(all.hits).toHaveLength(4)
    expect(all.hits[0]!.itemName).toBe('annual-leave.docx')
    expect(all.durationMs).toBeGreaterThanOrEqual(0)
    let state = await service.updateSettings(id, { documentCount: 2 })
    expect(state.bases[0]!.settings).toMatchObject({ documentCount: 2, chunkSize: 1024 })
    expect((await service.recall(id, '年假有几天')).hits).toHaveLength(2)
    state = await service.updateSettings(id, { threshold: all.hits[0]!.score - 0.01 })
    expect(state.bases[0]!.settings.threshold).toBeCloseTo(all.hits[0]!.score - 0.01)
    expect((await service.recall(id, '年假有几天')).hits.map(hit => hit.itemName)).toEqual(['annual-leave.docx'])
    // Settings are saved with the knowledge base.
    const saved = JSON.parse(await readFile(join(home, 'knowledge', 't-a', id, 'base.json'), 'utf8')) as Record<string, unknown>
    expect(saved).toMatchObject({ documentCount: 2, chunkStrategy: 'structured', rebuilding: false })
  })

  it('applies chunking changes to items processed afterwards, and to every item when reprocessing all', async () => {
    const { service, until } = await boot()
    const { id } = (await service.createBase('产品库', LOCAL)).bases[0]!
    await service.addFiles(id, [fixture('product-manual.md')])
    await until(next => next.bases[0]!.items[0]?.status === 'completed')
    expect((await service.getState()).bases[0]!.items[0]!.chunkCount).toBe(1)
    let state = await service.updateSettings(id, { chunkSize: 20, chunkOverlap: 0, chunkStrategy: 'delimiter', chunkSeparator: '\\n' })
    // Nothing is processed again on its own.
    expect(state.bases[0]!.items[0]).toMatchObject({ status: 'completed', chunkCount: 1 })
    expect(state.bases[0]!.status).toBe('ready')
    state = await service.reprocessAll(id)
    expect(state.bases[0]!.items[0]!.status).toMatch(/pending|processing/u)
    state = await until(next => next.bases[0]!.items[0]!.status === 'completed')
    expect(state.bases[0]!.items[0]!.chunkCount).toBeGreaterThan(1)
    const { hits } = await service.recall(id, '无法登录')
    expect(hits[0]!.text.length).toBeLessThan(60)
    expect(remoteErrorOf(await service.reprocessAll('nope').catch((error: unknown) => error))).toMatchObject({ code: 'knowledge/not-found' })
  })

  it('rebuilds in place on a new embedding model after a trial embedding, and cannot be searched meanwhile', async () => {
    const { service, until, embedding } = await boot()
    const { id } = (await service.createBase('制度库', LOCAL)).bases[0]!
    // With no items, the model just changes.
    const empty = (await service.createBase('空库', LOCAL)).bases[1]!.id
    expect((await service.updateSettings(empty, { embeddingModelId: API })).bases[1]).toMatchObject({ embeddingModelId: API, status: 'ready', dimensions: 64 })
    await service.addFiles(id, [fixture('meeting-notes.txt'), fixture('product-manual.md')])
    await until(next => settled(next) && next.bases[0]!.items.length === 2)
    const failure = async (patch: Record<string, unknown>) =>
      remoteErrorOf(await service.updateSettings(id, patch as never).catch((error: unknown) => error))
    expect(await failure({ embeddingModelId: 'acme/none' })).toMatchObject({ code: 'knowledge/embedding-model-unavailable' })
    embedding.failure = new Error('HTTP 401: invalid key')
    expect(await failure({ embeddingModelId: API })).toMatchObject({ code: 'knowledge/embedding-probe-failed', details: { id: API, message: 'HTTP 401: invalid key' } })
    embedding.failure = undefined
    vi.spyOn(embedding, 'embed').mockResolvedValueOnce([[]])
    expect(await failure({ embeddingModelId: API })).toMatchObject({ details: { message: 'the model returned no vector' } })
    vi.spyOn(embedding, 'embed').mockRejectedValueOnce('offline')
    expect(await failure({ embeddingModelId: API })).toMatchObject({ details: { message: 'offline' } })
    expect((await service.getState()).bases[0]).toMatchObject({ embeddingModelId: LOCAL, status: 'ready' })

    const gate = Promise.withResolvers<undefined>()
    embedding.gate = gate.promise
    const state = await service.updateSettings(id, { embeddingModelId: API })
    expect(state.bases[0]).toMatchObject({ embeddingModelId: API, embeddingModelName: 'bge-m3', status: 'rebuilding', dimensions: 64 })
    expect(state.bases[0]!.items.every(item => item.chunkCount === 0 && item.status !== 'completed')).toBe(true)
    expect(remoteErrorOf(await service.recall(id, '会议').catch((error: unknown) => error))).toMatchObject({ code: 'knowledge/rebuilding' })
    embedding.gate = undefined
    gate.resolve(undefined)
    const rebuilt = await until(next => next.bases[0]!.status === 'ready')
    expect(rebuilt.bases[0]!.items.map(item => item.status)).toEqual(['completed', 'completed'])
    expect(embedding.calls.filter(call => !call.texts[0]!.includes('probe')).at(-1)!.id).toBe(API)
    expect((await service.recall(id, '会议纪要')).hits[0]!.itemName).toBe('meeting-notes.txt')
  })

  it('refuses a search a rebuild overtakes, and keeps the rebuild flag when it cannot be cleared on disk', async () => {
    const { service, until, embedding, home } = await boot()
    const { id } = (await service.createBase('制度库', LOCAL)).bases[0]!
    await service.addFiles(id, [fixture('meeting-notes.txt')])
    await until(next => next.bases[0]!.items[0]?.status === 'completed')
    const gate = Promise.withResolvers<undefined>()
    const entered = Promise.withResolvers<undefined>()
    embedding.gate = gate.promise
    embedding.entered = () => { entered.resolve(undefined) }
    const search = service.recall(id, '会议').catch((error: unknown) => error)
    await entered.promise
    await service.updateSettings(id, { embeddingModelId: API })
    const dir = join(home, 'knowledge', 't-a', id)
    // A directory where the settings' temporary file goes refuses the write that would end the rebuild.
    await mkdir(join(dir, 'base.json.tmp'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    embedding.gate = undefined
    gate.resolve(undefined)
    expect(remoteErrorOf(await search)).toMatchObject({ code: 'knowledge/rebuilding' })
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith('[knowledge-base] could not end a rebuild', expect.anything()) })
    expect((await service.getState()).bases[0]).toMatchObject({ status: 'rebuilding', items: [expect.objectContaining({ status: 'completed' })] })
  })

  it('ends a rebuild when its last pending item is deleted, or when a restart interrupts its API model', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-knowledge-'))
    cleanups.push(() => rm(home, { recursive: true, force: true }))
    const first = await boot({ home })
    const { id } = (await first.service.createBase('制度库', LOCAL)).bases[0]!
    await first.service.addFiles(id, [fixture('meeting-notes.txt'), fixture('product-manual.md')])
    await first.until(next => settled(next) && next.bases[0]!.items.length === 2)
    const gate = Promise.withResolvers<undefined>()
    const entered = Promise.withResolvers<undefined>()
    first.embedding.gate = gate.promise
    first.embedding.entered = () => { entered.resolve(undefined) }
    await first.service.updateSettings(id, { embeddingModelId: API })
    await entered.promise
    await first.ctx.fiber.dispose()
    gate.resolve(undefined)
    // Restarted, the API model's unfinished items fail as interrupted, and the rebuild is over.
    const second = await boot({ home })
    const state = await second.until(next => next.bases.length === 1 && settled(next))
    expect(state.bases[0]).toMatchObject({ status: 'ready', items: [expect.objectContaining({ error: 'interrupted' }), expect.objectContaining({ error: 'interrupted' })] })
    // Rebuilding again, then deleting every item, ends the rebuild too.
    const again = Promise.withResolvers<undefined>()
    let busy = Promise.withResolvers<undefined>()
    second.embedding.gate = again.promise
    second.embedding.entered = () => { busy.resolve(undefined) }
    await second.service.updateSettings(id, { embeddingModelId: LOCAL })
    // Both stop the item being processed first.
    await busy.promise
    busy = Promise.withResolvers<undefined>()
    await second.service.reprocessAll(id)
    await busy.promise
    expect((await second.service.updateSettings(id, { embeddingModelId: API })).bases[0]!.status).toBe('rebuilding')
    for (const item of (await second.service.getState()).bases[0]!.items) await second.service.deleteItem(id, item.id)
    expect((await second.service.getState()).bases[0]).toMatchObject({ status: 'ready', items: [] })
    again.resolve(undefined)
  })

  it('reads a knowledge base saved before these settings existed with the defaults', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-knowledge-'))
    cleanups.push(() => rm(home, { recursive: true, force: true }))
    const dir = join(home, 'knowledge', 't-a', 'old')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'base.json'), JSON.stringify({
      version: 1, id: 'old', name: '旧库', embeddingModelId: LOCAL, chunkSize: 512, chunkOverlap: 50, createdAt: '2026-10-01T00:00:00.000Z',
    }))
    const { service } = await boot({ home })
    expect((await service.getState()).bases[0]).toMatchObject({
      name: '旧库', status: 'ready', dimensions: null,
      settings: { chunkStrategy: 'structured', chunkSeparator: '\\n\\n', chunkSize: 512, chunkOverlap: 50, documentCount: 6, threshold: 0 },
    })
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

  it('adds a folder\'s supported files as its items, lists what it skipped, and finds them', async () => {
    const { service, until } = await boot({ config: { maxFolderFiles: 3 } })
    const { id } = (await service.createBase('制度库', LOCAL)).bases[0]!
    const dir = await mkdtemp(join(tmpdir(), 'dsh-knowledge-folder-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    await mkdir(join(dir, '人事', '假期'), { recursive: true })
    await mkdir(join(dir, '.git'))
    await copyFile(fixture('annual-leave.docx'), join(dir, '人事', '假期', 'annual-leave.docx'))
    await copyFile(fixture('meeting-notes.txt'), join(dir, 'meeting-notes.txt'))
    await copyFile(fixture('product-manual.md'), join(dir, '人事', 'product-manual.md'))
    await copyFile(fixture('expense-policy.pdf'), join(dir, '人事', '假期', 'z-expense.pdf'))
    await writeFile(join(dir, 'logo.png'), 'png')
    await writeFile(join(dir, '.DS_Store'), 'x')
    await writeFile(join(dir, '.git', 'HEAD'), 'ref')
    let state = await service.addFolder(id, dir)
    const folder = state.bases[0]!.items[0]!
    expect(folder).toMatchObject({ kind: 'folder', name: dir.split('/').at(-1), source: dir, parentId: null })
    expect(folder.skipped).toEqual([{ path: 'logo.png', reason: 'unsupported' }, { path: '人事/假期/z-expense.pdf', reason: 'limit' }])
    expect(folder.skippedCount).toBe(2)
    state = await until(next => next.bases[0]!.items.length === 4 && settled(next))
    const [view, ...files] = state.bases[0]!.items
    expect(files.map(file => [file.kind, file.parentId, file.source, file.status])).toEqual([
      ['file', folder.id, 'meeting-notes.txt', 'completed'], ['file', folder.id, '人事/product-manual.md', 'completed'],
      ['file', folder.id, '人事/假期/annual-leave.docx', 'completed'],
    ])
    expect(view).toMatchObject({ status: 'completed', chunkCount: 3, size: files.reduce((sum, file) => sum + file.size, 0) })
    expect((await service.recall(id, '员工每年有几天带薪年假')).hits[0]!.itemName).toBe('annual-leave.docx')
    // A path that is not a folder is refused.
    for (const path of [join(dir, 'logo.png'), join(dir, 'missing')]) {
      expect(remoteErrorOf(await service.addFolder(id, path).catch((error: unknown) => error))).toMatchObject({ code: 'knowledge/not-a-folder' })
    }
  })

  it('syncs a folder when it is reprocessed, and fails it, keeping its files, once it is gone', async () => {
    const { service, until } = await boot()
    const { id } = (await service.createBase('制度库', LOCAL)).bases[0]!
    const dir = await mkdtemp(join(tmpdir(), 'dsh-knowledge-folder-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    await writeFile(join(dir, 'a.md'), '# 甲\n\n第一版内容')
    await writeFile(join(dir, 'b.md'), '# 乙\n\n乙的内容')
    await writeFile(join(dir, 'c.md'), '# 丙\n\n丙的内容')
    const folderId = (await service.addFolder(id, dir)).bases[0]!.items[0]!.id
    await until(next => next.bases[0]!.items.length === 4 && settled(next))
    const before = new Map((await service.getState()).bases[0]!.items.map(item => [item.source, item]))
    // Changed, deleted, added, and unchanged files; a failed unchanged file is tried again.
    await writeFile(join(dir, 'a.md'), '# 甲\n\n第二版内容，增加了很多文字')
    await rm(join(dir, 'b.md'))
    await writeFile(join(dir, 'd.txt'), '丁的内容')
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    let state = await service.reprocessItem(id, folderId)
    expect(state.bases[0]!.items[0]!.status).toBe('processing')
    state = await until(next => next.bases[0]!.items.length === 4 && settled(next))
    const after = new Map(state.bases[0]!.items.map(item => [item.source, item]))
    expect([...after.keys()]).toEqual([dir, 'a.md', 'c.md', 'd.txt'])
    expect(after.get('a.md')!.id).toBe(before.get('a.md')!.id)
    expect(after.get('a.md')!.size).toBeGreaterThan(before.get('a.md')!.size)
    expect(after.get('c.md')!.addedAt).toBe(before.get('c.md')!.addedAt)
    expect((await service.recall(id, '第二版内容')).hits[0]!.itemName).toBe('a.md')
    expect((await service.recall(id, '乙的内容')).hits.some(hit => hit.itemName === 'b.md')).toBe(false)
    // A file that cannot be copied fails as unreadable, and is copied again on the next sync.
    await writeFile(join(dir, 'c.md'), '# 丙\n\n丙改过的内容')
    await chmod(join(dir, 'c.md'), 0o000)
    await writeFile(join(dir, 'e.md'), '戊')
    await chmod(join(dir, 'e.md'), 0o000)
    state = await service.reprocessItem(id, folderId)
    expect(state.bases[0]!.items.filter(item => item.error === 'unreadable').map(item => item.source).sort()).toEqual(['c.md', 'e.md'])
    // Gone (the unreadable files go with it): the folder fails and keeps its files.
    await rm(dir, { recursive: true, force: true })
    state = await service.reprocessItem(id, folderId)
    expect(state.bases[0]!.items[0]).toMatchObject({ status: 'failed', error: 'folder-missing' })
    expect(state.bases[0]!.items).toHaveLength(5)
    // Deleting the folder deletes its files too.
    expect((await service.deleteItem(id, folderId)).bases[0]!.items).toEqual([])
  })

  it('fetches a page into Markdown, refetches it on reprocessing, and keeps the last copy when it is unreachable', async () => {
    const { service, until, web } = await boot()
    const { id } = (await service.createBase('网页库', LOCAL)).bases[0]!
    const url = 'https://intra.example.com/hr/leave'
    web.pages.set(url, { content: '<html><head><title>年假制度</title></head><body><nav>首页</nav><article><h1>员工年假</h1><p>员工每年享有 5 天带薪年假，满十年享有 10 天。年假需提前三个工作日申请。</p></article></body></html>' })
    let state = await service.addUrl(id, ` ${url} `)
    expect(state.bases[0]!.items[0]).toMatchObject({ kind: 'url', name: url, source: url })
    expect(state.bases[0]!.items[0]!.status).toMatch(/pending|processing/u)
    state = await until(next => next.bases[0]!.items[0]!.status === 'completed')
    const page = state.bases[0]!.items[0]!
    expect(page).toMatchObject({ name: '年假制度', chunkCount: 1 })
    expect(page.size).toBeGreaterThan(0)
    expect((await service.recall(id, '带薪年假几天')).hits[0]!.text).toContain('5 天带薪年假')
    // Unreachable: marked failed, and its last copy stays indexed and searchable.
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    web.pages.set(url, new Error('getaddrinfo ENOTFOUND intra.example.com'))
    await service.reprocessItem(id, page.id)
    state = await until(next => next.bases[0]!.items[0]!.status === 'failed')
    expect(state.bases[0]!.items[0]).toMatchObject({ error: 'unreachable', name: '年假制度', chunkCount: 1 })
    expect((await service.recall(id, '带薪年假几天')).hits[0]!.itemName).toBe('年假制度')
    expect(web.fetched).toEqual([url, url])
    // A non-success status, a plain-text page, and a page never fetched.
    web.pages.set(url, { statusCode: 404, content: 'not found' })
    await service.reprocessItem(id, page.id)
    await until(next => next.bases[0]!.items[0]!.status === 'failed' && web.fetched.length === 3)
    web.pages.set('http://example.com/a.txt', { kind: 'text', content: '纯文本页面的内容' })
    await service.addUrl(id, 'http://example.com/a.txt')
    await service.addUrl(id, 'https://never.example.com/')
    state = await until(next => next.bases[0]!.items.length === 3 && settled(next))
    expect(state.bases[0]!.items.slice(1).map(item => [item.name, item.status, item.error])).toEqual([
      ['http://example.com/a.txt', 'completed', null], ['https://never.example.com/', 'failed', 'unreachable'],
    ])
    for (const bad of ['ftp://example.com/x', 'not a url']) {
      expect(remoteErrorOf(await service.addUrl(id, bad).catch((error: unknown) => error))).toMatchObject({ code: 'knowledge/invalid-url' })
    }
    // An address with credentials is refused before it is kept, and the error does not repeat it.
    for (const secret of ['https://admin:pw@intra.example.com/wiki', 'https://:pw@intra.example.com/']) {
      const refused = remoteErrorOf(await service.addUrl(id, secret).catch((error: unknown) => error))
      expect(refused).toMatchObject({ code: 'knowledge/credentials-in-url' })
      expect(JSON.stringify(refused)).not.toContain('pw')
    }
    expect((await service.getState()).bases[0]!.items).toHaveLength(3)
  })

  it('fails a page the web service blocks, such as an intranet address, as blocked rather than unreachable', async () => {
    const { service, until, web } = await boot()
    const { id } = (await service.createBase('网页库', LOCAL)).bases[0]!
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const url = 'http://127.0.0.1:5181/page.html'
    web.pages.set(url, new WebError('URL hostname "127.0.0.1" resolves to a non-public IP address', 'WEB_BLOCKED_URL'))
    await service.addUrl(id, url)
    expect((await until(next => settled(next) && next.bases[0]!.items.length === 1)).bases[0]!.items[0]).toMatchObject({ status: 'failed', error: 'blocked' })
  })

  it('fails a page as unreachable when this Host cannot fetch the web', async () => {
    const { service, until } = await boot({ web: false })
    const { id } = (await service.createBase('网页库', LOCAL)).bases[0]!
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    await service.addUrl(id, 'https://example.com/')
    expect((await until(next => settled(next) && next.bases[0]!.items.length === 1)).bases[0]!.items[0]!.error).toBe('unreachable')
  })

  it('writes and edits notes, processing only the edited one, within the length limits', async () => {
    const { service, until, embedding } = await boot({ config: { maxNoteChars: 40 } })
    const { id } = (await service.createBase('笔记库', LOCAL)).bases[0]!
    await service.createNote(id, ' 报销提醒 ', '发票要在十五个工作日内提交。')
    await service.createNote(id, '会议', '周一十点开会。')
    let state = await until(next => next.bases[0]!.items.length === 2 && settled(next))
    const [first, second] = state.bases[0]!.items
    expect(first).toMatchObject({ kind: 'note', name: '报销提醒', status: 'completed', chunkCount: 1 })
    expect(await service.getNote(id, first!.id)).toEqual({ title: '报销提醒', content: '发票要在十五个工作日内提交。' })
    // The title is indexed with the body.
    expect((await service.recall(id, '报销提醒')).hits[0]!.text).toBe('# 报销提醒\n\n发票要在十五个工作日内提交。')
    const calls = embedding.calls.length
    await service.updateNote(id, first!.id, '报销提醒（新）', '发票要在十个工作日内提交。')
    state = await until(next => next.bases[0]!.items[0]!.status === 'completed' && next.bases[0]!.items[0]!.name === '报销提醒（新）')
    expect(embedding.calls.slice(calls).map(call => call.texts[0])).toEqual(['# 报销提醒（新）\n\n发票要在十个工作日内提交。'])
    expect(state.bases[0]!.items[1]!.id).toBe(second!.id)
    const invalid = async (title: string, content: string) =>
      remoteErrorOf(await service.createNote(id, title, content).catch((error: unknown) => error))
    expect(await invalid('  ', '正文')).toMatchObject({ code: 'knowledge/invalid-note', details: { field: 'title', max: 100 } })
    expect(await invalid('题'.repeat(101), '正文')).toMatchObject({ details: { field: 'title' } })
    expect(await invalid('标题', '字'.repeat(41))).toMatchObject({ details: { field: 'content', max: 40 } })
    expect(remoteErrorOf(await service.updateNote(id, first!.id, '标题', '字'.repeat(41)).catch((error: unknown) => error))).toMatchObject({ code: 'knowledge/invalid-note' })
    // Only notes are read and edited as notes.
    await service.addUrl(id, 'https://example.com/')
    const page = (await service.getState()).bases[0]!.items[2]!.id
    expect(remoteErrorOf(await service.getNote(id, page).catch((error: unknown) => error))).toMatchObject({ code: 'knowledge/not-found' })
    expect(remoteErrorOf(await service.updateNote(id, 'nope', 't', 'c').catch((error: unknown) => error))).toMatchObject({ code: 'knowledge/not-found' })
  })

  it('stops a note or a folder\'s file being processed when it is edited or synced', async () => {
    const { service, until, embedding } = await boot()
    const { id } = (await service.createBase('制度库', LOCAL)).bases[0]!
    const gate = Promise.withResolvers<undefined>()
    let entered = Promise.withResolvers<undefined>()
    embedding.gate = gate.promise
    embedding.entered = () => { entered.resolve(undefined) }
    const noteId = (await service.createNote(id, '草稿', '第一稿')).bases[0]!.items[0]!.id
    await entered.promise
    entered = Promise.withResolvers<undefined>()
    await service.updateNote(id, noteId, '定稿', '第二稿')
    await entered.promise
    const dir = await mkdtemp(join(tmpdir(), 'dsh-knowledge-folder-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    await writeFile(join(dir, 'a.md'), '甲')
    const folderId = (await service.addFolder(id, dir)).bases[0]!.items[1]!.id
    embedding.gate = undefined
    gate.resolve(undefined)
    await until(next => settled(next) && next.bases[0]!.items.length === 3)
    const again = Promise.withResolvers<undefined>()
    entered = Promise.withResolvers<undefined>()
    embedding.gate = again.promise
    await writeFile(join(dir, 'a.md'), '甲的新内容')
    await service.reprocessItem(id, folderId)
    await entered.promise
    await writeFile(join(dir, 'a.md'), '甲的第三版内容')
    await service.reprocessItem(id, folderId)
    embedding.gate = undefined
    again.resolve(undefined)
    const state = await until(next => settled(next) && next.bases[0]!.items[2]!.status === 'completed')
    expect(state.bases[0]!.items.map(item => item.name)).toEqual(['定稿', dir.split('/').at(-1), 'a.md'])
    expect((await service.recall(id, '第三版')).hits[0]!.text).toBe('甲的第三版内容')
  })

  it('opens an item\'s own copy, and tells each hit\'s kind and source', async () => {
    const { service, until, web } = await boot()
    const { id } = (await service.createBase('制度库', LOCAL)).bases[0]!
    web.pages.set('https://intra.example.com/leave', { content: '<html><head><title>年假</title></head><body><article><p>员工每年享有五天带薪年假，满十年享有十天，需提前三天申请。</p></article></body></html>' })
    const dir = await mkdtemp(join(tmpdir(), 'dsh-knowledge-folder-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    await copyFile(fixture('meeting-notes.txt'), join(dir, 'meeting-notes.txt'))
    await service.addFiles(id, [fixture('product-manual.md')])
    await service.addFolder(id, dir)
    await service.addUrl(id, 'https://intra.example.com/leave')
    await service.createNote(id, '报销提醒', '发票十五天内提交')
    await service.addUrl(id, 'https://never.example.com/')
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const state = await until(next => next.bases[0]!.items.length === 6 && next.bases[0]!.items.every(item => item.status === 'completed' || item.status === 'failed'))
    const items = new Map(state.bases[0]!.items.map(item => [item.name, item]))
    const hits = new Map((await service.recall(id, '年假 发票 会议 产品')).hits.map(hit => [hit.itemName, [hit.itemKind, hit.source]]))
    expect(Object.fromEntries(hits)).toMatchObject({
      'product-manual.md': ['file', null], 'meeting-notes.txt': ['file', 'meeting-notes.txt'],
      '年假': ['url', 'https://intra.example.com/leave'], '报销提醒': ['note', null],
    })
    for (const name of ['product-manual.md', 'meeting-notes.txt', '年假', '报销提醒']) await service.openItem(id, items.get(name)!.id)
    expect(opened.paths.map(path => extname(path))).toEqual(['.md', '.txt', '.md', '.md'])
    const refused = async (itemId: string) => remoteErrorOf(await service.openItem(id, itemId).catch((error: unknown) => error))?.code
    expect(await refused(items.get(dir.split('/').at(-1)!)!.id)).toBe('knowledge/cannot-open')
    expect(await refused(items.get('https://never.example.com/')!.id)).toBe('knowledge/cannot-open')
    expect(await refused('nope')).toBe('knowledge/not-found')
    opened.canOpen = false
    expect(await refused(items.get('报销提醒')!.id)).toBe('knowledge/cannot-open')
    opened.canOpen = true
  })
})
