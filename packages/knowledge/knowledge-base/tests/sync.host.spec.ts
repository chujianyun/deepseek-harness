/**
 * The knowledge base sync over a stand-in knowledge base service and a scripted user center, for
 * answers the mock user center does not give: outages of single calls, tenants switching mid-pass,
 * records naming other accounts, and copies that change while they upload.
 */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ItemRow } from '../src/store.ts'
import { KnowledgeSync, mediaTypeOf, type LocalBase, type SyncHost } from '../src/sync.ts'
import { Watched } from './support.ts'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const ACCOUNT = 't-a/138****0001'

/** The sync record file, as far as the specs read it. */
interface RecordFile {
  accounts: Record<string, {
    cursor: number
    bases: Record<string, { revision: number; held?: string; from?: string | null }>
    items: Record<string, { revision: number; from?: string | null; copy?: { sha256: string } }>
    deletes: unknown[]
  }>
}
const SETTINGS = { chunkStrategy: 'structured', chunkSeparator: '\\n\\n', chunkSize: 1024, chunkOverlap: 200, documentCount: 6, threshold: 0 } as const
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

const row = (id: string, more: Partial<ItemRow> = {}): ItemRow => ({
  id, kind: 'note', parentId: null, name: id, source: null, size: 2, modifiedAt: null, skipped: [], skippedCount: 0,
  status: 'completed', error: null, chunkCount: 1, addedAt: '2026-10-15T00:00:00.000Z', ...more,
})

type Reply = Response | (() => Response | Promise<Response>)
const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
const ok = () => new Response(null, { status: 204 })
const listing = (changes: unknown[] = [], extra: object = {}) => json(200, { changes, cursor: 9, hasMore: false, reset: false, ...extra })

/**
 * A sync over a stand-in host whose tenant and knowledge bases a test sets, and a user center that
 * answers each request from `replies` by method and path, defaulting to empty listings and acceptance.
 */
async function harness(options: { record?: object; intervalMs?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-knowledge-sync-unit-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const statePath = join(dir, 'knowledge-sync.json')
  if (options.record !== undefined) await writeFile(statePath, JSON.stringify({ version: 1, accounts: options.record }))
  const host = {
    tenantId: 't-a' as string | null,
    bases: [] as LocalBase[],
    exists: false,
    /** Each snapshot shifts the next tenant off this list, when it has one. */
    tenants: [] as (string | null)[],
    snapshotError: undefined as Error | undefined,
    applied: [] as string[],
    applyResult: true,
  }
  const stand: SyncHost = {
    snapshot: () => {
      if (host.snapshotError !== undefined) return Promise.reject(host.snapshotError)
      if (host.tenants.length > 0) host.tenantId = host.tenants.shift() ?? null
      return Promise.resolve({ tenantId: host.tenantId, bases: host.bases })
    },
    baseExists: () => Promise.resolve(host.exists),
    applyBase: (_tenant, base) => { host.applied.push(`base:${base.id}`); return Promise.resolve(host.applyResult) },
    applyItem: (_tenant, item) => { host.applied.push(`item:${item.id}`); return Promise.resolve(host.applyResult) },
    removeBase: (_tenant, id) => { host.applied.push(`-base:${id}`); return Promise.resolve() },
    removeItem: (_tenant, _base, id) => { host.applied.push(`-item:${id}`); return Promise.resolve() },
  }
  const requests: string[] = []
  const replies = new Map<string, Reply[]>()
  const reply = (key: string, ...answers: Reply[]) => { replies.set(key, [...replies.get(key) ?? [], ...answers]) }
  const hub = new Watched<{ status: string; profile: { tenantId: string; phone: string } | null }>({
    status: 'signed-in', profile: { tenantId: 't-a', phone: '138****0001' },
  })
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  const warn = vi.fn()
  ctx.logger.warn = warn as never
  ctx.provide('hubAccount', {
    getState: () => Promise.resolve(hub.value),
    watch: (signal: AbortSignal) => hub.watch(signal),
    request: async (path: string, init: RequestInit) => {
      const key = `${init.method ?? 'GET'} ${path.split('?')[0]!}`
      requests.push(key)
      const queued = replies.get(key)?.shift()
      if (queued !== undefined) return typeof queued === 'function' ? queued() : queued
      if (key === 'GET /api/client/sync/knowledge') return listing()
      if (key === 'POST /api/client/sync/blobs/check') return json(200, { missing: [] })
      return init.method === 'DELETE' || path.startsWith('/api/client/sync/blobs/') ? ok() : json(200, {})
    },
  } as never)
  const sync = new KnowledgeSync(ctx, stand, {
    statePath, device: '前台电脑', debounceMs: 5, intervalMs: options.intervalMs ?? 3_600_000, retryMs: 50, requestTimeoutMs: 5_000,
  })
  await sync.start()
  const record = async () => (JSON.parse(await readFile(statePath, 'utf8')) as RecordFile).accounts[ACCOUNT]!
  return { ctx, sync, host, requests, reply, hub, warn, dir, record }
}

const base = (id: string, items: LocalBase['items'] = []): LocalBase => ({ id, name: id, embeddingModelId: 'local/m', settings: SETTINGS, createdAt: '2026-10-15T00:00:00.000Z', items })
const listedBase = (id: string, more: object = {}) => ({
  type: 'base', baseId: id, revision: 1, device: '家里电脑', name: id, embeddingModelId: 'local/m', settings: SETTINGS, createdAt: '2026-10-15T00:00:00.000Z',
  deleted: false, seq: 1, ...more,
})
const listedItem = (id: string, more: object = {}) => ({
  type: 'item', itemId: id, baseId: 'kb', revision: 1, device: '家里电脑', kind: 'note', parentId: null, name: id, source: null,
  sha256: null, sizeBytes: 0, addedAt: '2026-10-15T00:00:00.000Z', deleted: false, seq: 2, ...more,
})
const record = (more: object = {}) => ({ revision: 1, digest: 'd', from: null, ...more })

describe('knowledge sync passes', () => {
  it('names media types by kind and extension', () => {
    expect(mediaTypeOf('folder', 'a')).toBeNull()
    expect(mediaTypeOf('url', 'https://x')).toBe('text/markdown')
    expect(mediaTypeOf('file', '报告.PDF')).toBe('application/pdf')
    expect(mediaTypeOf('file', '表.xlsx')).toBeNull()
  })

  it('waits for the knowledge bases to follow the sign-in, and for a tenant that switches during a pass', async () => {
    const h = await harness()
    expect(h.sync.cameFrom('x')).toBeNull()
    h.host.tenants = ['t-b']
    h.sync.refresh()
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(h.requests).toEqual([])
    // Matching now, but switching again before the pull: the pull waits for the next pass.
    h.host.tenants = ['t-a', 't-b']
    h.sync.touched()
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(h.requests).toEqual([])
    h.host.tenants = ['t-a']
    h.sync.touched()
    await expect.poll(() => h.requests).toEqual(['GET /api/client/sync/knowledge'])
  })

  it('retries a pass that failed for another reason, and pulls on its interval', async () => {
    const h = await harness({ intervalMs: 100 })
    h.host.snapshotError = new Error('index locked')
    h.sync.touched()
    await expect.poll(() => h.warn.mock.calls.some(([message]) => String(message).includes('sync pass failed: Error: index locked'))).toBe(true)
    h.host.snapshotError = undefined
    await expect.poll(() => h.requests.filter(key => key === 'GET /api/client/sync/knowledge').length).toBeGreaterThan(1)
  })

  it('retries a deletion the user center refused, and sends each deletion once', async () => {
    const h = await harness({ record: { [ACCOUNT]: { bases: { kb: record(), dropped: record() }, items: { 'dropped-item': record({ baseId: 'kb' }) } } } })
    h.host.bases = [base('kb')]
    h.reply('DELETE /api/client/sync/knowledge/bases/dropped', json(500, {}))
    h.sync.touched()
    await expect.poll(async () => (await h.record()).deletes).toEqual([])
    expect(h.requests.filter(key => key.startsWith('DELETE'))).toEqual([
      'DELETE /api/client/sync/knowledge/bases/dropped', 'DELETE /api/client/sync/knowledge/bases/dropped', 'DELETE /api/client/sync/knowledge/items/dropped-item',
    ])
    expect(Object.keys((await h.record()).items)).toEqual([])
  })

  it('retries a listing or a download the user center could not answer', async () => {
    const h = await harness({ record: { [ACCOUNT]: { bases: { kb: record() } } } })
    h.host.exists = true
    const changed = () => listing([listedItem('n', { sha256: sha('x'), sizeBytes: 1 })])
    h.reply('GET /api/client/sync/knowledge', json(500, {}), changed, changed)
    h.reply('GET /api/client/sync/knowledge/items/n/content', json(500, {}), json(410, {}))
    h.sync.refresh()
    await expect.poll(() => h.requests.filter(key => key === 'GET /api/client/sync/knowledge/items/n/content').length).toBe(2)
    expect(h.host.applied).toEqual([])
  })

  it('skips what another account knows, what the knowledge bases refuse, and items of knowledge bases it does not know', async () => {
    const h = await harness({ record: { 't-a/139****0002': { bases: { other: record() } }, [ACCOUNT]: { bases: { kb: record() } } } })
    h.host.applyResult = false
    h.host.exists = true
    h.reply('GET /api/client/sync/knowledge', listing([
      listedBase('other', { revision: 3 }), listedBase('kb', { revision: 2 }), listedBase('new'), listedItem('n'), listedItem('stray', { baseId: 'unknown' }),
    ]))
    h.sync.refresh()
    await expect.poll(() => h.host.applied).toEqual(['base:kb', 'base:new', 'item:n'])
    expect((await h.record()).bases.kb?.revision).toBe(1)
    // Nothing recorded, the cursor included: the next pull lists it all again.
    expect(await h.record()).toEqual({ bases: { kb: record() } })
  })

  it('keeps listed items after a listing that starts over, and removes the rest', async () => {
    const h = await harness({
      record: { [ACCOUNT]: { cursor: 50, bases: { kb: record({ from: '家里电脑' }) }, items: { kept: record({ baseId: 'kb', from: '家里电脑' }), lost: record({ baseId: 'kb', from: '家里电脑' }) } } },
    })
    h.host.exists = true
    h.reply('GET /api/client/sync/knowledge', listing([listedBase('kb'), listedItem('kept')], { reset: true }))
    h.sync.refresh()
    await expect.poll(() => h.host.applied).toEqual(['-item:lost'])
  })

  it('retries an item whose content check failed, and holds back the files of a folder the user center refused', async () => {
    const h = await harness({ record: { [ACCOUNT]: { bases: { kb: record({ digest: 'old' }) }, items: { f: record({ baseId: 'kb', held: 'refused' }) } } } })
    const copy = join(h.dir, 'n.md')
    await writeFile(copy, 'hi')
    h.host.exists = true
    h.host.bases = [base('kb', [{ row: row('f', { kind: 'folder' }), copy: null }, { row: row('c', { parentId: 'f', kind: 'file' }), copy: null }, { row: row('n'), copy }])]
    h.reply('POST /api/client/sync/blobs/check', json(500, {}))
    // The folder changed and is refused again.
    h.reply('PUT /api/client/sync/knowledge/items/f', json(400, {}))
    h.sync.touched()
    await expect.poll(() => h.requests.filter(key => key === 'POST /api/client/sync/blobs/check').length).toBe(2)
    await expect.poll(async () => (await h.record()).items.n?.revision).toBe(1)
    expect(h.requests.filter(key => key.includes('/items/c'))).toEqual([])
  })

  it('stops at a conflict it cannot resolve, and uploads an item whose copy is missing without content', async () => {
    const h = await harness()
    h.host.bases = [base('kb', [{ row: row('n', { size: 7 }), copy: join(h.dir, 'missing.md') }])]
    h.reply('PUT /api/client/sync/knowledge/bases/kb', json(409, { code: 'unknown' }))
    h.sync.touched()
    await expect.poll(async () => (await h.record())?.items.n?.revision).toBe(1)
    expect(h.requests.filter(key => key === 'PUT /api/client/sync/knowledge/bases/kb')).toHaveLength(2)
    expect(h.requests).not.toContain('POST /api/client/sync/blobs/check')
  })

  it('reads a copy again that changed while it uploaded, and retries content the user center could not take now', async () => {
    const h = await harness()
    const copy = join(h.dir, 'n.md')
    await writeFile(copy, 'v1')
    h.host.bases = [base('kb', [{ row: row('n'), copy }])]
    h.reply('POST /api/client/sync/blobs/check', async () => {
      await writeFile(copy, 'v2!')
      return json(200, { missing: [sha('v1')] })
    })
    h.reply(`PUT /api/client/sync/blobs/${sha('v2!')}`, json(503, {}))
    h.reply('POST /api/client/sync/blobs/check', json(200, { missing: [sha('v2!')] }), json(200, { missing: [sha('v2!')] }))
    h.sync.touched()
    await expect.poll(() => h.warn.mock.calls.some(([message]) => String(message).includes('the copy changed while it was uploaded'))).toBe(true)
    await expect.poll(async () => (await h.record())?.items.n?.copy?.sha256).toBe(sha('v2!'))
    expect(h.requests.filter(key => key === `PUT /api/client/sync/blobs/${sha('v2!')}`)).toHaveLength(2)
  })

  it('deletes here what the user center says another computer deleted, when an upload finds it', async () => {
    const h = await harness()
    h.host.bases = [
      base('gone'),
      base('kb', [{ row: row('f', { kind: 'folder' }), copy: null }, { row: row('a'), copy: null }, { row: row('b', { parentId: 'f' }), copy: null }, { row: row('c'), copy: null }]),
    ]
    h.reply('PUT /api/client/sync/knowledge/bases/gone', json(410, { code: 'base_deleted' }))
    h.reply('PUT /api/client/sync/knowledge/items/a', json(410, { code: 'item_deleted' }))
    h.reply('PUT /api/client/sync/knowledge/items/b', json(410, { code: 'parent_deleted' }))
    h.reply('PUT /api/client/sync/knowledge/items/c', json(410, { code: 'base_deleted' }))
    h.sync.touched()
    await expect.poll(() => h.host.applied).toEqual(['-base:gone', '-item:a', '-item:f', '-base:kb'])
  })

  it('deletes here what another computer deleted although this one has no record of it, and tells its own from another\'s by what is stored here', async () => {
    const h = await harness({ record: { 't-a/139****0002': { bases: { theirs: record() } } } })
    h.host.exists = true
    h.host.bases = [base('mine', [{ row: row('own'), copy: null }])]
    // Its upload stops at a conflict, so the pull lists it before this computer has a record of it.
    h.reply('PUT /api/client/sync/knowledge/bases/mine', json(409, { code: 'unknown' }))
    h.reply('GET /api/client/sync/knowledge', listing([
      listedBase('mine', { device: '另一台' }), listedBase('twin', { device: '前台电脑' }),
      listedItem('own', { baseId: 'mine', device: '另一台' }), listedItem('lost', { deleted: true }), listedBase('old', { deleted: true }),
      // Another employee's on this computer: left alone.
      listedBase('theirs', { deleted: true }),
    ]))
    h.sync.refresh()
    await expect.poll(() => h.host.applied).toEqual(['base:mine', 'base:twin', '-item:lost', 'item:own', '-base:old'])
    const kept = await h.record()
    expect([kept.bases.mine?.from, kept.bases.twin?.from, kept.items.own?.from]).toEqual([null, '前台电脑', null])
  })

  it('retries a pass whose record cannot be written', async () => {
    const h = await harness()
    // A directory where the record's temporary file goes: every write fails.
    await mkdir(join(h.dir, `knowledge-sync.json.${String(process.pid)}.tmp`))
    h.reply('GET /api/client/sync/knowledge', listing([]), listing([]))
    h.sync.refresh()
    await expect.poll(() => h.warn.mock.calls.some(([message]) => String(message).includes('sync pass failed'))).toBe(true)
    await expect.poll(() => h.requests.filter(key => key === 'GET /api/client/sync/knowledge').length).toBe(2)
  })

  it('stops a pass when the sign-in changes during it, and names no computer while signed out', async () => {
    const h = await harness({ record: { [ACCOUNT]: { bases: { kb: record() } } } })
    h.host.exists = true
    h.reply('GET /api/client/sync/knowledge', async () => {
      h.hub.set({ status: 'signed-out', profile: null })
      await new Promise(resolve => setTimeout(resolve, 50))
      return listing([listedItem('n', { sha256: sha('x'), sizeBytes: 1 })])
    })
    h.sync.refresh()
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(h.requests).toEqual(['GET /api/client/sync/knowledge'])
    expect(h.sync.cameFrom('n')).toBeNull()
  })
})
