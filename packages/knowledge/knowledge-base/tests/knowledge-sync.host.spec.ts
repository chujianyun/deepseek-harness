/**
 * Knowledge base sync between computers of one employee, each a real knowledge base service with a
 * real Hub sign-in, over the mock user center's knowledge sync endpoints.
 */
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import HubAccount from '@deepseek-ai/dsh-hub-account'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { browse, startMockUserCenter, type MockSync, type MockTenant, type MockUserCenter } from '../../../credentials/hub-account/tests/mock-user-center.ts'
import KnowledgeBaseService, { type KnowledgeState } from '../src/index.ts'
import type { SyncHost } from '../src/sync.ts'
import { API, embeddingState, fakeEmbedding, fakeWeb, LOCAL, Watched } from './support.ts'

const FIXTURES = join(import.meta.dirname, 'fixtures')
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
})

/** Polls long enough for a pass on each computer: uploads wait for the other's processing and token refreshes. */
const poll = <T>(read: () => T | Promise<T>) => expect.poll(read, { timeout: 10_000 })

const FRONT = '前台电脑'
const HOME = '家里电脑'

async function startCenter(): Promise<MockUserCenter> {
  const center = await startMockUserCenter()
  cleanups.push(() => center.close())
  return center
}

const store = (center: MockUserCenter, key = 't-a'): MockSync => center.sync[key]!
const knowledgeOf = (center: MockUserCenter, key = 't-a') => store(center, key).knowledge!

/** One computer of the employee: a knowledge base service signed in to the center. */
async function computer(center: MockUserCenter, device: string, options: { home?: string; apiModels?: boolean; tenant?: MockTenant; local?: 'unsupported' } = {}) {
  const home = options.home ?? await realpath(await mkdtemp(join(tmpdir(), 'dsh-knowledge-sync-')))
  if (options.home === undefined) cleanups.push(() => rm(home, { recursive: true, force: true }))
  const dshHome = join(home, '.dsh')
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(LocalCredentialProvider, { path: join(home, 'credentials.yaml'), watch: false })
  await ctx.plugin(AuthorizationService)
  await ctx.plugin(HubAccount, { origin: center.origin, clientId: center.clientId, allowLoopbackHttp: true, dshHome })
  const models = embeddingState(options.local)
  const embeddingWatched = new Watched(options.apiModels === false ? { ...models, apiModels: [] } : models)
  const embedding = fakeEmbedding(embeddingWatched)
  ctx.provide('embedding', embedding as never)
  const web = fakeWeb()
  ctx.provide('web', web as never)
  const warn = vi.fn()
  await ctx.plugin(KnowledgeBaseService, { dshHome, deviceName: device, syncDebounceMs: 20, syncRetryMs: 150, syncIntervalMs: 3_600_000 })
  const service = ctx.get('knowledgeBases')!
  ctx.logger.warn = warn as never
  const signIn = async (tenant?: MockTenant) => {
    if (tenant !== undefined) center.tenant = tenant
    const hub = ctx.get('hubAccount')!
    await hub.signIn()
    await poll(async () => (await hub.getState()).attempt?.authorizeUrl).toBeDefined()
    await browse((await hub.getState()).attempt!.authorizeUrl!)
    await poll(async () => (await hub.getState()).profile?.tenantId).toBe(center.tenant.tenantId)
    await poll(async () => (await service.getState()).tenantId).toBe(center.tenant.tenantId)
  }
  await signIn(options.tenant)
  const state = () => service.getState()
  /** Poll the state until it matches, pulling first. */
  const pulled = async (predicate: (state: KnowledgeState) => boolean) => {
    await poll(async () => {
      await service.syncNow()
      return predicate(await state())
    }).toBe(true)
    return state()
  }
  /** Poll a read, pulling before each attempt. */
  const pulling = <T>(read: () => T | Promise<T>) => poll(async () => {
    await service.syncNow()
    return read()
  })
  return { ctx, service, home, dshHome, embedding, embeddingWatched, web, warn, signIn, state, pulled, pulling }
}

type Computer = Awaited<ReturnType<typeof computer>>

const settled = (state: KnowledgeState) => state.bases.every(base => base.items.every(item => item.status === 'completed' || item.status === 'failed'))
const itemsOf = (state: KnowledgeState, name: string) => state.bases.find(base => base.name === name)?.items ?? []

/** A base on `a` with a file, a note, a fetched page, and a folder of two files, synced to the center. */
async function seed(a: Computer, center: MockUserCenter, model = LOCAL) {
  const { id } = (await a.service.createBase('店铺资料', model)).bases[0]!
  await a.service.addFiles(id, [join(FIXTURES, 'meeting-notes.txt')])
  await a.service.createNote(id, '客服话术', '先道歉，再给退货方案。')
  a.web.pages.set('https://example.com/faq', { content: '<html><head><title>常见问题</title></head><body><p>七天无理由退货</p></body></html>' })
  await a.service.addUrl(id, 'https://example.com/faq')
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'dsh-knowledge-folder-')))
  cleanups.push(() => rm(folder, { recursive: true, force: true }))
  await writeFile(join(folder, '退货.txt'), '退货要保留包装。')
  await mkdir(join(folder, '子目录'))
  await writeFile(join(folder, '子目录', '换货.md'), '# 换货\n换货三天内寄出。')
  await a.service.addFolder(id, folder)
  await poll(async () => settled(await a.state())).toBe(true)
  await poll(() => Object.values(knowledgeOf(center).items).filter(item => item.meta.name === '常见问题').length).toBe(1)
  await poll(() => Object.keys(knowledgeOf(center).items).length).toBe(6)
  return { id, folder }
}

describe('knowledge base sync', { timeout: 60_000 }, () => {
  it('uploads a knowledge base with its items, and another computer pulls it and processes it there', async () => {
    const center = await startCenter()
    const a = await computer(center, FRONT)
    const { id } = await seed(a, center)
    const held = knowledgeOf(center)
    expect(held.bases[id]!.meta).toMatchObject({ revision: 1, device: FRONT, name: '店铺资料', embeddingModelId: LOCAL, settings: { chunkStrategy: 'structured' } })
    const note = itemsOf(await a.state(), '店铺资料').find(item => item.kind === 'note')!
    expect(held.items[note.id]!.meta).toMatchObject({ baseId: id, kind: 'note', name: '客服话术', mediaType: 'text/markdown', device: FRONT })
    expect(store(center).blobs[String(held.items[note.id]!.meta.sha256)]!.toString()).toBe('先道歉，再给退货方案。')

    const b = await computer(center, HOME)
    b.web.pages.set('https://example.com/faq', { content: '<html><head><title>常见问题</title></head><body><p>七天无理由退货</p></body></html>' })
    const state = await b.pulled(next => itemsOf(next, '店铺资料').length === 6 && settled(next))
    const base = state.bases[0]!
    expect(base).toMatchObject({ id, name: '店铺资料', embeddingModelId: LOCAL, status: 'ready', modelMissing: false })
    expect(base.items.every(item => item.status === 'completed')).toBe(true)
    expect((await b.service.getNote(id, note.id)).content).toBe('先道歉，再给退货方案。')
    expect((await b.service.recall(id, '退货 包装')).hits[0]!.text).toContain('退货要保留包装')
    // The page is indexed from its pulled copy, not fetched again; the folder is scanned again only on the computer it was added on.
    expect(b.web.fetched).toEqual([])
    const folder = base.items.find(item => item.kind === 'folder')!
    expect(folder.scannedOn).toBe(FRONT)
    expect(itemsOf(await a.state(), '店铺资料').find(item => item.kind === 'folder')!.scannedOn).toBeNull()
    expect(remoteErrorOf(await b.service.reprocessItem(id, folder.id).catch((error: unknown) => error))).toMatchObject({
      code: 'knowledge/folder-elsewhere', details: { id: folder.id, device: FRONT },
    })
    // Processing it here changed nothing to upload; neither did pulling.
    const seq = store(center).seq
    await b.service.syncNow()
    await a.service.syncNow()
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(store(center).seq).toBe(seq)
  })

  it('carries edits both ways; of two edits made before either pulled, the later upload wins', async () => {
    const center = await startCenter()
    const a = await computer(center, FRONT)
    const { id } = (await a.service.createBase('话术', LOCAL)).bases[0]!
    await a.service.createNote(id, '开场', '您好')
    const note = (await a.state()).bases[0]!.items[0]!
    await poll(() => knowledgeOf(center).items[note.id]?.meta.revision).toBe(1)
    const b = await computer(center, HOME)
    await b.pulled(state => state.bases[0]?.items.length === 1)

    await a.service.updateNote(id, note.id, '开场', '您好，在的')
    await b.pulling(async () => (await b.service.getNote(id, note.id)).content).toBe('您好，在的')
    await b.service.renameBase(id, '客服话术')
    await a.pulled(state => state.bases[0]?.name === '客服话术')

    await a.service.updateNote(id, note.id, '开场', '甲的版本')
    await poll(() => knowledgeOf(center).items[note.id]?.meta.device).toBe(FRONT)
    await b.service.updateNote(id, note.id, '开场', '乙的版本')
    await poll(() => knowledgeOf(center).items[note.id]?.meta.device).toBe(HOME)
    expect(knowledgeOf(center).items[note.id]!.meta.revision).toBe(4)
    await a.pulling(async () => (await a.service.getNote(id, note.id)).content).toBe('乙的版本')
    // Chunking settings reach the other computer too.
    await a.service.updateSettings(id, { chunkSize: 256, chunkOverlap: 16 })
    await b.pulled(state => state.bases[0]?.settings.chunkSize === 256)
  })

  it('leaves what is pulled for an API model to the user, and shows a model this computer lacks as missing', async () => {
    const center = await startCenter()
    const a = await computer(center, FRONT)
    const { id } = (await a.service.createBase('接口', API)).bases[0]!
    await a.service.createNote(id, '说明', '接口说明正文')
    await poll(async () => settled(await a.state())).toBe(true)
    const note = (await a.state()).bases[0]!.items[0]!
    await poll(() => knowledgeOf(center).items[note.id]?.meta.revision).toBe(1)

    const b = await computer(center, HOME)
    let state = await b.pulled(next => next.bases[0]?.items[0]?.status === 'failed')
    expect(state.bases[0]!.items[0]).toMatchObject({ error: 'synced' })
    expect(b.embedding.calls).toEqual([])
    await b.service.reprocessItem(id, note.id)
    await poll(async () => (await b.state()).bases[0]!.items[0]!.status).toBe('completed')

    const c = await computer(center, '会议室电脑', { apiModels: false })
    state = await c.pulled(next => next.bases[0]?.items.length === 1)
    expect(state.bases[0]).toMatchObject({ status: 'unavailable', modelMissing: true })
    expect(state.bases[0]!.items[0]!.status).toBe('failed')

    // Moved to the local model elsewhere: processed here on its own; moved back to an API model: left to the user again.
    await a.service.updateSettings(id, { embeddingModelId: LOCAL })
    state = await b.pulled(next => next.bases[0]?.embeddingModelId === LOCAL && next.bases[0].items[0]?.status === 'completed' && next.bases[0].status === 'ready')
    expect(state.bases[0]!.dimensions).toBe(64)
    await a.service.updateSettings(id, { embeddingModelId: API })
    state = await b.pulled(next => next.bases[0]?.embeddingModelId === API && next.bases[0].items[0]?.error === 'synced')
    expect(state.bases[0]!.items[0]!.chunkCount).toBe(0)
  })

  it('carries deletions both ways', async () => {
    const center = await startCenter()
    const a = await computer(center, FRONT)
    const { id } = await seed(a, center)
    const b = await computer(center, HOME)
    await b.pulled(state => itemsOf(state, '店铺资料').length === 6)
    const items = itemsOf(await a.state(), '店铺资料')
    const note = items.find(item => item.kind === 'note')!
    const folder = items.find(item => item.kind === 'folder')!

    await b.service.deleteItem(id, note.id)
    await poll(() => knowledgeOf(center).items[note.id]?.deleted).toBe(true)
    await a.pulled(state => !itemsOf(state, '店铺资料').some(item => item.id === note.id))
    await a.service.deleteItem(id, folder.id)
    await poll(() => knowledgeOf(center).items[folder.id]?.deleted).toBe(true)
    await b.pulled(state => itemsOf(state, '店铺资料').length === 2)
    await b.service.deleteBase(id)
    await poll(() => knowledgeOf(center).bases[id]?.deleted).toBe(true)
    await a.pulled(state => state.bases.length === 0)
    await expect(stat(join(a.dshHome, 'knowledge', 't-a', id))).rejects.toThrow()
    // The deletions are acknowledged: nothing is sent again.
    const seq = store(center).seq
    await a.service.syncNow()
    await b.service.syncNow()
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(store(center).seq).toBe(seq)
  })

  it('removes here what a restored user center no longer lists, and uploads this computer\'s own again', async () => {
    const center = await startCenter()
    const a = await computer(center, FRONT)
    const { id } = (await a.service.createBase('甲的库', LOCAL)).bases[0]!
    await a.service.createNote(id, '笔记', '正文')
    await poll(() => Object.keys(knowledgeOf(center).items).length).toBe(1)
    const b = await computer(center, HOME)
    await b.pulled(state => state.bases[0]?.items.length === 1)
    await b.service.createBase('乙的库', LOCAL)
    await poll(() => Object.keys(knowledgeOf(center).bases).length).toBe(2)
    await a.pulled(state => state.bases.length === 2)
    // Let the passes the polls asked for finish before the restore.
    await new Promise(resolve => setTimeout(resolve, 300))

    // Restored from a backup taken before anything was synced.
    center.sync['t-a'] = { sessions: {}, blobs: {} }
    await b.pulled(state => state.bases.length === 1 && state.bases[0]!.name === '乙的库')
    await a.pulling(() => Object.values(knowledgeOf(center).bases).map(base => base.meta.name).sort()).toEqual(['乙的库', '甲的库'])
    expect((await a.state()).bases.map(base => base.name).sort()).toEqual(['乙的库', '甲的库'])
    await poll(() => Object.keys(knowledgeOf(center).items).length).toBe(1)
  })

  it('reads a damaged sync record as empty and uploads everything again', async () => {
    const center = await startCenter()
    const a = await computer(center, FRONT)
    await a.service.createBase('甲的库', LOCAL)
    await poll(() => Object.keys(knowledgeOf(center).bases).length).toBe(1)
    await a.ctx.fiber.dispose()
    await writeFile(join(a.dshHome, 'knowledge-sync.json'), '{ damaged')
    const again = await computer(center, FRONT, { home: a.home })
    await again.service.syncNow()
    // Its own knowledge base comes back in the listing as its own: recorded again, nothing to upload.
    const id = (await again.state()).bases[0]!.id
    await poll(async () => (JSON.parse(await readFile(join(a.dshHome, 'knowledge-sync.json'), 'utf8')) as { accounts: Record<string, { bases: Record<string, object> }> })
      .accounts['t-a/138****0001']?.bases[id])
      .toMatchObject({ revision: 1, from: null })
    expect(knowledgeOf(center).bases[id]!.meta.revision).toBe(1)
    expect((await again.state()).bases).toHaveLength(1)
  })
})

describe('knowledge base sync failures', { timeout: 60_000 }, () => {
  it('retries after the user center could not be reached, and stops for a sign-in that may not sync', async () => {
    const center = await startCenter()
    center.syncReply = 'drop'
    const a = await computer(center, FRONT)
    await a.service.createBase('甲的库', LOCAL)
    await new Promise(resolve => setTimeout(resolve, 200))
    center.syncReply = undefined
    await poll(() => Object.keys(knowledgeOf(center).bases).length).toBe(1)

    center.syncReply = { status: 403, body: '{"message":"超管不是公司成员，不能同步"}' }
    await a.service.createBase('乙的库', LOCAL)
    await poll(() => a.warn.mock.calls.some(([message]) => String(message).includes('does not sync'))).toBe(true)
    center.syncReply = undefined
    await a.service.syncNow()
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(Object.keys(knowledgeOf(center).bases)).toHaveLength(1)
    // Another sign-in syncs again.
    await a.signIn({ tenantId: 't-a', tenantName: '甲公司', phone: '139****0002' })
    await poll(() => Object.keys(knowledgeOf(center, 't-a/139****0002').bases).length).toBe(1)
  })

  it('records a refusal for good and tries again only after a change; re-sends content the user center lost', async () => {
    const center = await startCenter()
    const a = await computer(center, FRONT)
    const { id } = (await a.service.createBase('甲的库', LOCAL)).bases[0]!
    await poll(() => Object.keys(knowledgeOf(center).bases).length).toBe(1)
    let refuse = true
    center.syncHook = (method, path) => (method === 'PUT' && path.includes('/knowledge/items/') && refuse
      ? { status: 400, body: '{"message":"名称不合法"}' }
      : undefined)
    await a.service.createNote(id, '笔记', '正文')
    await poll(() => a.warn.mock.calls.some(([message]) => String(message).includes('refused'))).toBe(true)
    refuse = false
    await a.service.syncNow()
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(knowledgeOf(center).items).toEqual({})
    const note = (await a.state()).bases[0]!.items[0]!
    await a.service.updateNote(id, note.id, '笔记', '改过的正文')
    await poll(() => knowledgeOf(center).items[note.id]?.meta.revision).toBe(1)

    // The content went missing between its check and the item's upload: it is sent again.
    let lose = true
    center.syncHook = (method, path) => {
      if (method === 'PUT' && path.includes('/knowledge/items/') && lose) {
        lose = false
        store(center).blobs = {}
      }
      return undefined
    }
    await a.service.updateNote(id, note.id, '笔记', '第三版')
    await poll(() => knowledgeOf(center).items[note.id]?.meta.revision).toBe(2)
    expect(store(center).blobs[String(knowledgeOf(center).items[note.id]!.meta.sha256)]!.toString()).toBe('第三版')
  })

  it('refuses content the user center will not take, and leaves an item deleted elsewhere to the next pull', async () => {
    const center = await startCenter()
    const a = await computer(center, FRONT)
    const { id } = (await a.service.createBase('甲的库', LOCAL)).bases[0]!
    center.syncHook = (method, path) => (method === 'PUT' && path.startsWith('/api/client/sync/blobs/') ? { status: 413, body: '{"message":"太大"}' } : undefined)
    await a.service.createNote(id, '大笔记', '很大的正文')
    await poll(() => a.warn.mock.calls.some(([message]) => String(message).includes('refused by the user center (413)'))).toBe(true)
    expect(knowledgeOf(center).items).toEqual({})
    center.syncHook = undefined

    const b = await computer(center, HOME)
    await a.service.createNote(id, '笔记', '正文')
    const note = (await a.state()).bases[0]!.items[1]!
    await poll(() => knowledgeOf(center).items[note.id]?.meta.revision).toBe(1)
    await b.pulled(state => state.bases[0]?.items.some(item => item.id === note.id) === true)
    await b.service.deleteItem(id, note.id)
    await poll(() => knowledgeOf(center).items[note.id]?.deleted).toBe(true)
    // Edited here before pulling the deletion: the upload is refused as deleted, and the pull removes it.
    await a.service.updateNote(id, note.id, '笔记', '改了')
    await poll(async () => (await a.state()).bases[0]!.items.some(item => item.id === note.id)).toBe(false)
  })

  it('uploads a knowledge base again that the user center lost, and an item when its folder arrives', async () => {
    const center = await startCenter()
    const a = await computer(center, FRONT)
    const { id } = (await a.service.createBase('甲的库', LOCAL)).bases[0]!
    await poll(() => Object.keys(knowledgeOf(center).bases).length).toBe(1)
    let answer: string | undefined = '{"code":"base_missing","message":"知识库还没上传"}'
    center.syncHook = (method, path) => {
      if (method !== 'PUT' || !path.includes('/knowledge/items/') || answer === undefined) return undefined
      const body = answer
      answer = answer.includes('base_missing') ? '{"code":"parent_missing","message":"所属文件夹还没上传"}' : undefined
      return { status: 409, body }
    }
    await a.service.createNote(id, '笔记', '正文')
    await poll(() => Object.keys(knowledgeOf(center).items).length).toBe(1)
    expect(center.clientRequests.filter(path => path === `/api/client/sync/knowledge/bases/${id}`)).toHaveLength(2)
  })

  it('gives up an upload the user center keeps answering with conflicts, and a download that does not match its digest', async () => {
    const center = await startCenter()
    const a = await computer(center, FRONT)
    center.syncHook = (method, path) => (method === 'PUT' && path.includes('/knowledge/bases/') ? { status: 409, body: '{"code":"stale_revision","revision":7}' } : undefined)
    await a.service.createBase('甲的库', LOCAL)
    await poll(() => a.warn.mock.calls.some(([message]) => String(message).includes('kept answering conflicts'))).toBe(true)
    center.syncHook = undefined
    const { id } = (await a.state()).bases[0]!
    await poll(() => knowledgeOf(center).bases[id]?.meta.revision).toBe(1)

    await a.service.createNote(id, '笔记', '正文')
    await poll(() => Object.keys(knowledgeOf(center).items).length).toBe(1)
    const b = await computer(center, HOME)
    center.syncHook = (method, path) => (method === 'GET' && path.endsWith('/content') ? { status: 200, body: '别的内容' } : undefined)
    await b.service.syncNow()
    await poll(() => b.warn.mock.calls.some(([message]) => String(message).includes('does not match its digest'))).toBe(true)
    center.syncHook = (method, path) => (method === 'GET' && path.endsWith('/content') ? { status: 404, body: '{}' } : undefined)
    await b.service.syncNow()
    await new Promise(resolve => setTimeout(resolve, 200))
    expect((await b.state()).bases[0]!.items).toEqual([])
  })

  it('syncs another employee\'s sign-in on this computer under that employee, and leaves the first one\'s knowledge bases alone', async () => {
    const center = await startCenter()
    const a = await computer(center, FRONT)
    await a.service.createBase('甲的库', LOCAL)
    await poll(() => Object.keys(knowledgeOf(center).bases).length).toBe(1)
    await a.signIn({ tenantId: 't-a', tenantName: '甲公司', phone: '139****0002' })
    await a.service.createBase('同事的库', LOCAL)
    await poll(() => Object.keys(knowledgeOf(center, 't-a/139****0002').bases).length).toBe(1)
    expect(Object.values(knowledgeOf(center, 't-a/139****0002').bases)[0]!.meta.name).toBe('同事的库')
  })
})

/** The changes the sync makes through the service, reached past the sync for races a pass cannot set up. */
const hostOf = (c: Computer): SyncHost => (c.service as never as { sync: { host: SyncHost } }).sync.host

describe('knowledge bases receiving a sync', { timeout: 60_000 }, () => {
  it('refuses to load with an empty device name', async () => {
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    ctx.provide('embedding', fakeEmbedding(new Watched(embeddingState())) as never)
    ctx.provide('hubAccount', { getState: () => Promise.resolve({ status: 'signed-out', profile: null }) } as never)
    await expect(ctx.plugin(KnowledgeBaseService, { dshHome: tmpdir(), deviceName: '  ' })).rejects.toThrow('device name is empty')
  })

  it('keeps on the user center a knowledge base whose index does not open here', async () => {
    const center = await startCenter()
    const a = await computer(center, FRONT)
    const { id } = (await a.service.createBase('甲的库', LOCAL)).bases[0]!
    await poll(() => knowledgeOf(center).bases[id]?.meta.revision).toBe(1)
    await a.ctx.fiber.dispose()
    await writeFile(join(a.dshHome, 'knowledge', 't-a', id, 'index.sqlite'), 'not a database')
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const again = await computer(center, FRONT, { home: a.home })
    expect((await again.state()).bases).toEqual([])
    await again.service.syncNow()
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(knowledgeOf(center).bases[id]!.deleted).toBe(false)
  })

  it('applies a pulled change only to the tenant, knowledge base, and folder it names', async () => {
    const center = await startCenter()
    const a = await computer(center, FRONT)
    const { id } = (await a.service.createBase('甲的库', LOCAL)).bases[0]!
    await a.service.createNote(id, '笔记', '正文')
    const note = (await a.state()).bases[0]!.items[0]!
    const host = hostOf(a)
    const settings = (await a.state()).bases[0]!.settings
    const item = { id: 'pulled', baseId: id, kind: 'file' as const, parentId: null, name: 'a.txt', source: null, size: 1, addedAt: '2026-10-15T00:00:00.000Z' }
    expect(await host.applyBase('t-b', { id: 'x', name: 'x', embeddingModelId: LOCAL, settings, createdAt: '2026-10-15T00:00:00.000Z' })).toBe(false)
    expect(await host.applyItem('t-b', item, null)).toBe(false)
    expect(await host.applyItem('t-a', { ...item, baseId: 'missing' }, null)).toBe(false)
    expect(await host.applyItem('t-a', { ...item, parentId: note.id }, null)).toBe(false)
    expect(await host.applyItem('t-a', { ...item, id: note.id }, null)).toBe(false)
    await host.removeBase('t-b', id)
    await host.removeItem('t-a', id, 'missing')
    await host.removeItem('t-b', id, note.id)
    expect((await a.state()).bases[0]!.items.map(entry => entry.id)).toEqual([note.id])
  })

  it('replaces a renamed file\'s copy, keeps a page never fetched without one, and leaves a folder\'s own state', async () => {
    const center = await startCenter()
    const a = await computer(center, FRONT)
    const { id } = (await a.service.createBase('甲的库', LOCAL)).bases[0]!
    const host = hostOf(a)
    const item = { id: 'pulled', baseId: id, kind: 'file' as const, parentId: null, name: 'a.txt', source: null, size: 2, addedAt: '2026-10-15T00:00:00.000Z' }
    expect(await host.applyItem('t-a', item, new TextEncoder().encode('一'))).toBe(true)
    const files = join(a.dshHome, 'knowledge', 't-a', id, 'files')
    expect(await readFile(join(files, 'pulled.txt'), 'utf8')).toBe('一')
    expect(await host.applyItem('t-a', { ...item, name: 'a.md' }, new TextEncoder().encode('二'))).toBe(true)
    await expect(stat(join(files, 'pulled.txt'))).rejects.toThrow()
    expect(await readFile(join(files, 'pulled.md'), 'utf8')).toBe('二')
    expect(await host.applyItem('t-a', { ...item, id: 'page', kind: 'url', name: 'https://example.com/', source: 'https://example.com/', size: 0 }, null)).toBe(true)
    await expect(stat(join(files, 'page.md'))).rejects.toThrow()
    const folder = { ...item, id: 'folder', kind: 'folder' as const, name: '资料', source: '/elsewhere/资料', size: 0 }
    expect(await host.applyItem('t-a', folder, null)).toBe(true)
    expect(await host.applyItem('t-a', { ...folder, size: 9 }, null)).toBe(true)
    await poll(async () => (await a.state()).bases[0]!.items.find(entry => entry.id === 'folder')).toMatchObject({ size: 9, status: 'completed' })
    // Moved to an API model: the files wait for the user, the folder keeps its state.
    const settings = (await a.state()).bases[0]!.settings
    expect(await host.applyBase('t-a', { id, name: '甲的库', embeddingModelId: API, settings, createdAt: '2026-10-15T00:00:00.000Z' })).toBe(true)
    const items = (await a.state()).bases[0]!.items
    expect(items.find(entry => entry.id === 'folder')!.error).toBeNull()
    expect(items.find(entry => entry.id === 'pulled')!.error).toBe('synced')
  })

  it('stops processing an item a pull replaces, and a knowledge base whose model a pull changes', async () => {
    const center = await startCenter()
    const a = await computer(center, FRONT)
    const { id } = (await a.service.createBase('甲的库', LOCAL)).bases[0]!
    const host = hostOf(a)
    const settings = (await a.state()).bases[0]!.settings
    let release!: () => void
    a.embedding.gate = new Promise<void>((resolve) => { release = resolve })
    const entered = new Promise<void>((resolve) => { a.embedding.entered = resolve })
    const item = { id: 'pulled', baseId: id, kind: 'note' as const, parentId: null, name: '笔记', source: null, size: 3, addedAt: '2026-10-15T00:00:00.000Z' }
    await host.applyItem('t-a', item, new TextEncoder().encode('第一版'))
    await entered
    await host.applyItem('t-a', item, new TextEncoder().encode('第二版'))
    const again = new Promise<void>((resolve) => { a.embedding.entered = resolve })
    await again
    await host.applyBase('t-a', { id, name: '甲的库', embeddingModelId: API, settings, createdAt: '2026-10-15T00:00:00.000Z' })
    release()
    await poll(async () => (await a.state()).bases[0]!.items[0]!.error).toBe('synced')
  })

  it('keeps a pulled item that did not change as it is, and processes it again once it does', async () => {
    const center = await startCenter()
    const a = await computer(center, FRONT)
    const { id } = (await a.service.createBase('甲的库', LOCAL)).bases[0]!
    const host = hostOf(a)
    const note = { id: 'pulled', baseId: id, kind: 'note' as const, parentId: null, name: '笔记', source: null, size: 6, addedAt: '2026-10-15T00:00:00.000Z' }
    await host.applyItem('t-a', note, new TextEncoder().encode('正文'))
    await poll(async () => (await a.state()).bases[0]!.items[0]!.status).toBe('completed')
    const embedded = a.embedding.calls.length
    expect(await host.applyItem('t-a', note, new TextEncoder().encode('正文'))).toBe(true)
    expect((await a.state()).bases[0]!.items[0]!.status).toBe('completed')
    // Same size, other bytes: processed again; so is one whose copy is gone.
    await host.applyItem('t-a', note, new TextEncoder().encode('改了'))
    await poll(() => a.embedding.calls.length).toBeGreaterThan(embedded)
    await poll(async () => (await a.state()).bases[0]!.items[0]!.status).toBe('completed')
    await rm(join(a.dshHome, 'knowledge', 't-a', id, 'files', 'pulled.md'))
    await host.applyItem('t-a', note, new TextEncoder().encode('改了'))
    expect(await readFile(join(a.dshHome, 'knowledge', 't-a', id, 'files', 'pulled.md'), 'utf8')).toBe('改了')
    // A folder carries no content: the same fields are the same folder.
    const folder = { ...note, id: 'folder', kind: 'folder' as const, name: '资料', size: 0 }
    await host.applyItem('t-a', folder, null)
    expect(await host.applyItem('t-a', folder, null)).toBe(true)
  })

  it('names a local model this platform cannot run as missing', async () => {
    const center = await startCenter()
    const a = await computer(center, FRONT, { local: 'unsupported' })
    const settings = { chunkStrategy: 'structured' as const, chunkSeparator: '\\n\\n', chunkSize: 1024, chunkOverlap: 200, documentCount: 6, threshold: 0 }
    expect(await hostOf(a).applyBase('t-a', { id: 'kb', name: '本地库', embeddingModelId: LOCAL, settings, createdAt: '2026-10-15T00:00:00.000Z' })).toBe(true)
    expect((await a.state()).bases[0]).toMatchObject({ status: 'unavailable', modelMissing: true })
  })
})
