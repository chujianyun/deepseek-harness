/**
 * Pulling the conversations another machine of the same employee uploaded: two machines with their
 * own Session storage and record, signed in as the same account against one mock user center.
 */
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import SessionSync, { type SessionSyncView } from '../src/index.ts'
import { startMockUserCenter, type MockUserCenter } from '../../../credentials/hub-account/tests/mock-user-center.ts'
import { ACCOUNT, boot, cleanups, held, png, record, signIn, sleep, startSync, storeSession, text, turn, type Booted } from './support.ts'

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** Two machines of the mock employee, signed in and syncing. */
async function machines(
  options: { bAttachments?: boolean; bProjectionCache?: boolean } = {},
): Promise<{ center: MockUserCenter; a: Booted; b: Booted }> {
  const center = await startMockUserCenter()
  cleanups.push(() => center.close())
  const a = await boot({ center })
  const b = await boot({ center, attachments: options.bAttachments !== false, projectionCache: options.bProjectionCache === true })
  await startSync(a, { deviceName: '前台电脑' })
  await startSync(b, { deviceName: '家里电脑' })
  await signIn(a)
  await signIn(b)
  return { center, a, b }
}

const view = (ctx: Context): Promise<SessionSyncView> => ctx.sessionSync.getState()
const pulledIds = async (ctx: Context) => (await view(ctx)).pulled.map(item => item.sessionId)
const stored = async (ctx: Context, id: string) => ctx.sessionPersistence.stat(SessionId(id))
const eventTypes = async (ctx: Context, id: string) => (await ctx.sessionQuery.readSession(SessionId(id))).events.map(event => event.type)

/** Wait until a machine has written its copy of a pulled conversation completely. */
async function written(machine: Booted, sessionId: string): Promise<void> {
  await expect.poll(async () => {
    const entry = (await record(machine.dshHome)).pulled[sessionId]
    return entry !== undefined && entry.behind === undefined
  }).toBe(true)
}

/** Ask a machine to pull now, as the window coming to the front does. */
async function pull(machine: Booted): Promise<void> {
  await machine.ctx.sessionSync.refresh()
}

describe('sessionSync pulling', () => {
  it('pulls another machine\'s conversation, with its subagent Sessions and attachments, as view-only', async () => {
    const { center, a, b } = await machines()
    const [image] = await a.ctx.attachments.saveImages([{ data: png(), mediaType: 'image/png', name: '截图.png' }])
    const file = await a.ctx.attachments.saveFile({ data: new TextEncoder().encode('订单'), name: '订单.csv' })
    const parent = await storeSession(a.ctx, 'from-a', [{ type: 'text', text: '看图' }, { type: 'image', attachment: image! }, { type: 'file', attachment: file }])
    await storeSession(a.ctx, 'from-a-child', text('子任务'), { origin: 'subagent', parentSession: parent, delegationDepth: 1 })
    await pull(a)
    await expect.poll(() => held(center, parent)?.meta.revision).toBe(1)

    await pull(b)
    await expect.poll(() => stored(b.ctx, 'from-a-child')).toBeDefined()
    expect(await view(b.ctx)).toMatchObject({ signedIn: true, pulled: [{ sessionId: parent, device: '前台电脑', revision: 1 }] })
    expect(await eventTypes(b.ctx, 'from-a')).toEqual(await eventTypes(a.ctx, 'from-a'))
    expect((await b.ctx.attachments.readImage(image!)).data).toEqual((await a.ctx.attachments.readImage(image!)).data)
    expect(await b.ctx.attachments.saveFile({ data: new TextEncoder().encode('订单'), name: '订单.csv' })).toEqual(file)
    // View-only here: no prompt is admitted, opening starts no Agent, and it is never uploaded back.
    expect(b.ctx.bail('api-session/prompt-admission', parent)).toMatchObject({ code: 'session-sync/view-only', details: { sessionId: parent } })
    expect(b.ctx.bail('api-session/view-only', parent)).toBe(true)
    expect(a.ctx.bail('api-session/view-only', parent)).toBeUndefined()
    expect(a.ctx.bail('api-session/prompt-admission', parent)).toBeUndefined()
    await sleep(200)
    expect(held(center, parent)?.meta.device).toBe('前台电脑')
    expect(await pulledIds(a.ctx)).toEqual([])
  })

  it('appends the other machine\'s later turns to the copy here', async () => {
    const { center, a, b } = await machines()
    const { agent } = await a.ctx.agents.create({ sessionId: SessionId('live-a'), agentOptions: { provider: 'mock', model: 'mock' } })
    await turn(a.ctx, agent, '第一问')
    await expect.poll(() => held(center, 'live-a')?.meta.revision).toBe(1)
    await pull(b)
    await expect.poll(() => pulledIds(b.ctx)).toEqual(['live-a'])
    const first = await eventTypes(b.ctx, 'live-a')
    await turn(a.ctx, agent, '第二问')
    await expect.poll(() => held(center, 'live-a')?.meta.revision).toBe(2)
    await pull(b)
    await expect.poll(async () => (await eventTypes(b.ctx, 'live-a')).length).toBeGreaterThan(first.length)
    await a.ctx.sessions.flush(agent.session)
    expect(await eventTypes(b.ctx, 'live-a')).toEqual(await eventTypes(a.ctx, 'live-a'))
  })

  it('replaces the copy here when the other machine\'s log no longer continues it', async () => {
    const { center, a, b } = await machines({ bProjectionCache: true })
    await storeSession(a.ctx, 'redo', text('第一版'))
    await pull(a)
    await expect.poll(() => held(center, 'redo')?.meta.revision).toBe(1)
    await pull(b)
    await expect.poll(() => pulledIds(b.ctx)).toEqual(['redo'])
    // A revision whose log differs from the start, as after the other machine restored a backup.
    const store = center.sync['t-a']!
    const rewritten = gzipSync(gunzipSync(store.sessions.redo!.bundle!).toString('utf8').replace('第一版', '第二版'))
    store.seq = (store.seq ?? 0) + 1
    const redo = store.sessions.redo!
    store.sessions = { ...store.sessions, redo: { ...redo, meta: { ...redo.meta, revision: 2 }, bundle: rewritten, seq: store.seq } }
    await pull(b)
    await expect.poll(async () => JSON.stringify((await b.ctx.sessionQuery.readSession(SessionId('redo'))).events)).toContain('第二版')
    expect(await pulledIds(b.ctx)).toEqual(['redo'])
    // The replaced copy is cached again, so the sidebar still names it.
    await written(b, 'redo')
    const header = (await b.ctx.sessionPersistence.stat(SessionId('redo')))!.header
    await expect.poll(() => b.ctx.sessionProjectionCache.cachedSnapshot(header)).toBeDefined()
  })

  it('removes the copy here when the other machine deletes its conversation', async () => {
    const { center, a, b } = await machines()
    const own = await storeSession(a.ctx, 'from-a', text('复盘'))
    await pull(a)
    await expect.poll(() => held(center, own)?.meta.revision).toBe(1)
    await pull(b)
    await expect.poll(() => pulledIds(b.ctx)).toEqual([own])
    await a.ctx.sessionPersistence.delete(own)
    await expect.poll(() => held(center, own)?.deleted).toBe(true)
    await pull(b)
    await expect.poll(() => pulledIds(b.ctx)).toEqual([])
    expect(await stored(b.ctx, own)).toBeUndefined()
    // Removing the copy is not a deletion by this machine's user: nothing more is sent.
    expect((await record(b.dshHome)).deletes).toEqual({})
  })

  it('deleting the copy here deletes the conversation on the user center and on its machine', async () => {
    const { center, a, b } = await machines()
    const own = await storeSession(a.ctx, 'from-a', text('复盘'))
    await storeSession(a.ctx, 'from-a-child', text('子任务'), { origin: 'subagent', parentSession: own, delegationDepth: 1 })
    await pull(a)
    await expect.poll(() => held(center, own)?.meta.revision).toBe(1)
    await pull(b)
    await expect.poll(() => pulledIds(b.ctx)).toEqual([own])
    await b.ctx.sessionPersistence.delete(own)
    await expect.poll(() => held(center, own)?.deleted).toBe(true)
    await expect.poll(() => pulledIds(b.ctx)).toEqual([])
    await pull(a)
    await expect.poll(() => stored(a.ctx, own)).toBeUndefined()
    expect(await stored(a.ctx, 'from-a-child')).toBeUndefined()
    // The record goes right after the logs.
    await expect.poll(async () => (await record(a.dshHome)).sessions[own]).toBeUndefined()
  })

  it('waits while the copy here is open, then catches up', async () => {
    const { center, a, b } = await machines()
    const { agent } = await a.ctx.agents.create({ sessionId: SessionId('live-a'), agentOptions: { provider: 'mock', model: 'mock' } })
    await turn(a.ctx, agent, '第一问')
    await expect.poll(() => held(center, 'live-a')?.meta.revision).toBe(1)
    await pull(b)
    await expect.poll(() => pulledIds(b.ctx)).toEqual(['live-a'])
    await written(b, 'live-a')
    const writer = await b.ctx.sessionPersistence.open(SessionId('live-a'), 'write')
    await turn(a.ctx, agent, '第二问')
    await expect.poll(() => held(center, 'live-a')?.meta.revision).toBe(2)
    await pull(b)
    await expect.poll(async () => (await record(b.dshHome)).pulled['live-a']?.behind).toBe(2)
    expect(b.ctx.bail('api-session/view-only', SessionId('live-a'))).toBe(true)
    await writer.close()
    await pull(b)
    await expect.poll(async () => (await record(b.dshHome)).pulled['live-a'])
      .toEqual(expect.objectContaining({ revision: 2 }))
    expect((await record(b.dshHome)).pulled['live-a']?.behind).toBeUndefined()
  })

  it('keeps an open copy deleted elsewhere until it is closed', async () => {
    const { center, a, b } = await machines()
    const own = await storeSession(a.ctx, 'from-a', text('复盘'))
    await pull(a)
    await expect.poll(() => held(center, own)?.meta.revision).toBe(1)
    await pull(b)
    await expect.poll(() => pulledIds(b.ctx)).toEqual([own])
    await written(b, own)
    const writer = await b.ctx.sessionPersistence.open(own, 'write')
    await a.ctx.sessionPersistence.delete(own)
    await expect.poll(() => held(center, own)?.deleted).toBe(true)
    await pull(b)
    await sleep(200)
    expect(await pulledIds(b.ctx)).toEqual([own])
    await expect.poll(async () => (await record(b.dshHome)).pulled[own]?.gone).toBe(true)
    await writer.close()
    await pull(b)
    await expect.poll(() => pulledIds(b.ctx)).toEqual([])
  })

  it('removes the copies of another account when the sign-in changes, and pulls them again on switching back', async () => {
    const { center, a, b } = await machines()
    const own = await storeSession(a.ctx, 'from-a', text('复盘'))
    await pull(a)
    await expect.poll(() => held(center, own)?.meta.revision).toBe(1)
    await pull(b)
    await expect.poll(() => pulledIds(b.ctx)).toEqual([own])
    await signIn(b, { tenantId: 't-b', tenantName: '乙公司' })
    await expect.poll(() => stored(b.ctx, own)).toBeUndefined()
    // The record of the copy goes right after its logs.
    await expect.poll(() => view(b.ctx)).toMatchObject({ signedIn: true, pulled: [] })
    expect(held(center, own)?.deleted).toBe(false)
    await signIn(b, { tenantId: 't-a', tenantName: '甲公司' })
    await expect.poll(() => pulledIds(b.ctx)).toEqual([own])
    expect((await record(b.dshHome)).cursors[ACCOUNT]).toBeGreaterThan(0)
  })

  it('streams the pulled conversations', async () => {
    const { center, a, b } = await machines()
    const seen: SessionSyncView[] = []
    const controller = new AbortController()
    cleanups.push(() => {
      controller.abort()
      return Promise.resolve()
    })
    void (async () => { for await (const state of b.ctx.sessionSync.watch(controller.signal)) seen.push(state) })()
    await storeSession(a.ctx, 'from-a', text('复盘'))
    await pull(a)
    await expect.poll(() => held(center, 'from-a')?.meta.revision).toBe(1)
    await pull(b)
    await expect.poll(() => seen.at(-1)?.pulled).toEqual([{ sessionId: 'from-a', device: '前台电脑', revision: 1 }])
    expect(seen.at(-1)!.changes).toBeGreaterThan(seen[0]!.changes)
  })

  it('reads as signed out without a sign-in', async () => {
    const machine = await boot()
    await startSync(machine)
    expect(await view(machine.ctx)).toMatchObject({ signedIn: false, pulled: [] })
  })

  it('skips what the user center no longer holds and attachments whose bytes do not match', async () => {
    const { center, a, b } = await machines()
    const file = await a.ctx.attachments.saveFile({ data: new TextEncoder().encode('订单'), name: '订单.csv' })
    const digest = file.attachmentId.slice('sha256:'.length)
    await storeSession(a.ctx, 'from-a', [{ type: 'file', attachment: file }, { type: 'text', text: '看' }])
    await storeSession(a.ctx, 'gone-bundle', text('没包'))
    await pull(a)
    await expect.poll(() => [held(center, 'from-a')?.meta.revision, held(center, 'gone-bundle')?.meta.revision]).toEqual([1, 1])
    center.syncHook = (method, path) => {
      if (method !== 'GET') return undefined
      if (path === '/api/client/sync/sessions/gone-bundle/bundle') return { status: 404, body: '{}' }
      return path === `/api/client/sync/blobs/${digest}` ? { status: 200, body: 'tampered' } : undefined
    }
    await pull(b)
    await expect.poll(() => pulledIds(b.ctx)).toEqual(['from-a'])
    await expect(stat(b.ctx.attachments.fileHostPath(file)!)).rejects.toThrow()
    expect(await stored(b.ctx, 'gone-bundle')).toBeUndefined()
  })

  it('pulls without fetching attachments where no attachment store is composed, and fetches each attachment once', async () => {
    const { center, a, b } = await machines({ bAttachments: false })
    const file = await a.ctx.attachments.saveFile({ data: new TextEncoder().encode('订单'), name: '订单.csv' })
    await storeSession(a.ctx, 'from-a', [{ type: 'file', attachment: file }, { type: 'text', text: '看' }])
    await pull(a)
    await expect.poll(() => held(center, 'from-a')?.meta.revision).toBe(1)
    await pull(b)
    await expect.poll(() => pulledIds(b.ctx)).toEqual(['from-a'])
    expect(center.clientRequests.filter(path => path.includes('/blobs/') && !path.endsWith('/check'))).toEqual([`/api/client/sync/blobs/${file.attachmentId.slice(7)}`])
  })

  it('fetches an attachment it already holds no more, and skips one the user center lacks', async () => {
    const { center, a, b } = await machines()
    const shared = await a.ctx.attachments.saveFile({ data: new TextEncoder().encode('共享'), name: '共享.csv' })
    await b.ctx.attachments.saveFile({ data: new TextEncoder().encode('共享'), name: '共享.csv' })
    const lost = await a.ctx.attachments.saveFile({ data: new TextEncoder().encode('丢了'), name: '丢了.csv' })
    await storeSession(a.ctx, 'from-a', [{ type: 'file', attachment: shared }, { type: 'file', attachment: lost }, { type: 'text', text: '看' }])
    await pull(a)
    await expect.poll(() => held(center, 'from-a')?.meta.revision).toBe(1)
    center.sync['t-a']!.blobs = Object.fromEntries(Object.entries(center.sync['t-a']!.blobs).filter(([digest]) => digest === shared.attachmentId.slice(7)))
    await pull(b)
    await expect.poll(() => pulledIds(b.ctx)).toEqual(['from-a'])
    const fetched = center.clientRequests.filter(path => /\/blobs\/[0-9a-f]{64}$/u.test(path) && path.includes(lost.attachmentId.slice(7)))
    expect(fetched.length).toBeGreaterThan(0)
    expect(center.clientRequests.filter(path => path === `/api/client/sync/blobs/${shared.attachmentId.slice(7)}`)).toHaveLength(1)
  })

  it('tries again later when a download fails', async () => {
    const { center, a, b } = await machines()
    const file = await a.ctx.attachments.saveFile({ data: new TextEncoder().encode('订单'), name: '订单.csv' })
    await storeSession(a.ctx, 'from-a', [{ type: 'file', attachment: file }, { type: 'text', text: '看' }])
    await pull(a)
    await expect.poll(() => held(center, 'from-a')?.meta.revision).toBe(1)
    const failures = ['/api/client/sync/sessions/from-a/bundle', `/api/client/sync/blobs/${file.attachmentId.slice(7)}`, '/api/client/sync/sessions']
    center.syncHook = (method, path) => (method === 'GET' && failures[0] === path ? (failures.shift(), { status: 503, body: '{}' }) : undefined)
    await pull(b)
    await expect.poll(() => pulledIds(b.ctx), { timeout: 5_000 }).toEqual(['from-a'])
    expect(failures).toEqual([])
  })

  it('never pulls this machine\'s own conversation, even when its record was lost', async () => {
    const center = await startMockUserCenter()
    cleanups.push(() => center.close())
    const a = await boot({ center })
    const own = await storeSession(a.ctx, 'own', text('自己的'))
    const fiber = await a.ctx.plugin(SessionSync, { dshHome: a.dshHome, deviceName: '前台电脑', debounceMs: 20, retryMs: 150 })
    await signIn(a)
    await expect.poll(() => held(center, own)?.meta.revision).toBe(1)
    await fiber.dispose()
    await writeFile(join(a.dshHome, 'session-sync.json'), JSON.stringify({ version: 2, sessions: {}, deletes: {} }))
    await startSync(a, { deviceName: '前台电脑' })
    await pull(a)
    await sleep(300)
    expect(await pulledIds(a.ctx)).toEqual([])
    expect(a.ctx.bail('api-session/view-only', own)).toBeUndefined()
  })

  it('does not fetch a revision it already holds again', async () => {
    const { center, a, b } = await machines()
    await storeSession(a.ctx, 'from-a', text('复盘'))
    await pull(a)
    await expect.poll(() => held(center, 'from-a')?.meta.revision).toBe(1)
    await pull(b)
    await expect.poll(() => pulledIds(b.ctx)).toEqual(['from-a'])
    const store = center.sync['t-a']!
    store.seq = (store.seq ?? 0) + 1
    store.sessions = { ...store.sessions, 'from-a': { ...store.sessions['from-a']!, seq: store.seq } }
    await pull(b)
    await sleep(300)
    expect(center.clientRequests.filter(path => path === '/api/client/sync/sessions/from-a/bundle')).toHaveLength(1)
  })

  it('keeps an open copy of another account until it can be removed', async () => {
    const { center, a, b } = await machines()
    const own = await storeSession(a.ctx, 'from-a', text('复盘'))
    await pull(a)
    await expect.poll(() => held(center, own)?.meta.revision).toBe(1)
    await pull(b)
    await expect.poll(() => pulledIds(b.ctx)).toEqual([own])
    await written(b, own)
    const writer = await b.ctx.sessionPersistence.open(own, 'write')
    await signIn(b, { tenantId: 't-b', tenantName: '乙公司' })
    await pull(b)
    await sleep(300)
    expect(await stored(b.ctx, own)).toBeDefined()
    await writer.close()
    await pull(b)
    await expect.poll(() => stored(b.ctx, own)).toBeUndefined()
  })

  it('tries an upload the user center could not take again later', async () => {
    const { center, a } = await machines()
    await storeSession(a.ctx, 'from-a', text('复盘'))
    let failed = false
    center.syncHook = (method, path) => (method === 'PUT' && path.endsWith('/from-a') && !failed ? (failed = true, { status: 503, body: '{}' }) : undefined)
    await pull(a)
    await expect.poll(() => held(center, 'from-a')?.meta.revision).toBe(1)
    expect(failed).toBe(true)
  })

  it('deletes this machine\'s own conversation deleted elsewhere once it is no longer open', async () => {
    const { center, a, b } = await machines()
    const own = await storeSession(a.ctx, 'from-a', text('复盘'))
    await pull(a)
    await expect.poll(() => held(center, own)?.meta.revision).toBe(1)
    await pull(b)
    await written(b, own)
    const writer = await a.ctx.sessionPersistence.open(own, 'write')
    await b.ctx.sessionPersistence.delete(own)
    await expect.poll(() => held(center, own)?.deleted).toBe(true)
    await pull(a)
    await expect.poll(async () => (await record(a.dshHome)).sessions[own]).toMatchObject({ held: 'deleted' })
    expect(await stored(a.ctx, own)).toBeDefined()
    await writer.close()
    await pull(a)
    await expect.poll(() => stored(a.ctx, own)).toBeUndefined()
  })

  it('caches the projections of a pulled conversation, so the sidebar can name it without opening it', async () => {
    const { center, a, b } = await machines({ bProjectionCache: true })
    await storeSession(a.ctx, 'from-a', text('复盘'))
    await pull(a)
    await expect.poll(() => held(center, 'from-a')?.meta.revision).toBe(1)
    await pull(b)
    await written(b, 'from-a')
    const header = (await b.ctx.sessionPersistence.stat(SessionId('from-a')))!.header
    expect(b.ctx.sessionProjectionCache.cachedSnapshot(header)).toBeDefined()
  })

  it('pulls a conversation even when caching its projections fails', async () => {
    const { center, a, b } = await machines()
    b.ctx.provide('sessionProjectionCache', { coldSnapshot: () => { throw new Error('cache broke') } } as never)
    await storeSession(a.ctx, 'from-a', text('复盘'))
    await pull(a)
    await expect.poll(() => held(center, 'from-a')?.meta.revision).toBe(1)
    await pull(b)
    await written(b, 'from-a')
    expect(await stored(b.ctx, 'from-a')).toBeDefined()
  })

  it('puts a pulled conversation under this computer\'s matching assistant', async () => {
    const { center, a, b } = await machines()
    const assistants = (list: { id: string; name: string; templateId?: string }[]) =>
      ({ getState: async () => ({ assistants: list }) }) as never
    a.ctx.provide('assistants', assistants([{ id: 'a-shop', name: '电商管家', templateId: 'ecommerce' }]))
    b.ctx.provide('assistants', assistants([{ id: 'b-shop', name: '电商管家', templateId: 'ecommerce' }, { id: 'b-daily', name: '日常助手' }]))
    const writer = await a.ctx.sessionPersistence.create({ version: SESSION_FORMAT_VERSION, id: SessionId('shop'), createdAt: 1_000, cwd: '/work', isSeeded: false })
    await writer.append([
      { type: 'assistant/selected', seq: SessionSeq(0), time: 1_500, data: { assistantId: 'a-shop' } },
      { type: 'user/message', seq: SessionSeq(1), time: 2_000, data: createUserMessage({ content: text('上新'), source: { kind: 'user' } }), surfaceOp: 'append' },
    ] as SessionEvent[])
    await writer.close()
    await pull(a)
    await expect.poll(() => held(center, 'shop')?.meta.assistantId).toBe('a-shop')
    await pull(b)
    await written(b, 'shop')
    const events = (await b.ctx.sessionQuery.readSession(SessionId('shop'))).events
    expect(events.find(item => item.type === 'assistant/selected')?.data).toEqual({ assistantId: 'b-shop' })
  })

  it('skips a conversation it cannot store, and keeps pulling and uploading everything else', async () => {
    const { center, a, b } = await machines()
    await storeSession(a.ctx, 'good', text('好的'))
    await pull(a)
    await expect.poll(() => held(center, 'good')?.meta.revision).toBe(1)
    const store = center.sync['t-a']!
    store.seq = (store.seq ?? 0) + 1
    store.sessions = { ...store.sessions, broken: { meta: { revision: 1, device: '前台电脑' }, bundle: gzipSync('{"format":9}'), deleted: false, seq: store.seq } }
    await storeSession(b.ctx, 'own-b', text('B 自己的'))
    await pull(b)
    await expect.poll(async () => [held(center, 'own-b')?.meta.revision, (await pulledIds(b.ctx)).sort()]).toEqual([1, ['good']])
    expect(await stored(b.ctx, 'broken')).toBeUndefined()
  })

  it('stops retrying a waiting revision that cannot be stored', async () => {
    const { center, a, b } = await machines()
    await storeSession(a.ctx, 'from-a', text('复盘'))
    await pull(a)
    await expect.poll(() => held(center, 'from-a')?.meta.revision).toBe(1)
    await pull(b)
    await written(b, 'from-a')
    const writer = await b.ctx.sessionPersistence.open(SessionId('from-a'), 'write')
    const store = center.sync['t-a']!
    store.seq = (store.seq ?? 0) + 1
    store.sessions = { ...store.sessions, 'from-a': { ...store.sessions['from-a']!, meta: { ...store.sessions['from-a']!.meta, revision: 2 }, seq: store.seq } }
    await pull(b)
    await expect.poll(async () => (await record(b.dshHome)).pulled['from-a']?.behind).toBe(2)
    store.sessions = { ...store.sessions, 'from-a': { ...store.sessions['from-a']!, bundle: gzipSync('{"format":9}') } }
    await writer.close()
    await pull(b)
    await expect.poll(async () => (await record(b.dshHome)).pulled['from-a']?.behind).toBeUndefined()
    expect((await record(b.dshHome)).pulled['from-a']?.revision).toBe(1)
  })

  it('removes the copies a listing that starts over no longer names', async () => {
    const { center, a, b } = await machines()
    await storeSession(a.ctx, 'kept', text('留下'))
    await storeSession(a.ctx, 'lost', text('丢了'))
    await pull(a)
    await expect.poll(() => [held(center, 'kept')?.meta.revision, held(center, 'lost')?.meta.revision]).toEqual([1, 1])
    await pull(b)
    await expect.poll(async () => (await pulledIds(b.ctx)).sort()).toEqual(['kept', 'lost'])
    // The user center restored from a backup that predates 'lost', with a lower change count.
    const store = center.sync['t-a']!
    store.sessions = { kept: { ...store.sessions.kept!, seq: 1 } }
    store.seq = 1
    await pull(b)
    await expect.poll(() => pulledIds(b.ctx)).toEqual(['kept'])
    expect(await stored(b.ctx, 'lost')).toBeUndefined()
  })

  it('removes all pulled copies when signed out, and keeps their subagent Sessions view-only meanwhile', async () => {
    const { center, a, b } = await machines()
    const parent = await storeSession(a.ctx, 'from-a', text('派个子任务'))
    await storeSession(a.ctx, 'from-a-child', text('子任务'), { origin: 'subagent', parentSession: parent, delegationDepth: 1 })
    await pull(a)
    await expect.poll(() => held(center, parent)?.meta.revision).toBe(1)
    await pull(b)
    await written(b, 'from-a')
    expect(b.ctx.bail('api-session/view-only', SessionId('from-a-child'))).toBe(true)
    expect(b.ctx.bail('api-session/prompt-admission', SessionId('from-a-child'))).toMatchObject({ code: 'session-sync/view-only' })
    expect(b.ctx.bail('api-session/view-only', SessionId('elsewhere'))).toBeUndefined()
    await b.ctx.hubAccount.signOut()
    await expect.poll(() => stored(b.ctx, 'from-a')).toBeUndefined()
    expect(await stored(b.ctx, 'from-a-child')).toBeUndefined()
    expect(await view(b.ctx)).toMatchObject({ signedIn: false, pulled: [] })
  })

  it('keeps a conversation deleted here while its download was under way deleted', async () => {
    const { center, a, b } = await machines()
    await storeSession(a.ctx, 'from-a', text('复盘'))
    await pull(a)
    await expect.poll(() => held(center, 'from-a')?.meta.revision).toBe(1)
    await pull(b)
    await written(b, 'from-a')
    const store = center.sync['t-a']!
    store.seq = (store.seq ?? 0) + 1
    store.sessions = { ...store.sessions, 'from-a': { ...store.sessions['from-a']!, meta: { ...store.sessions['from-a']!.meta, revision: 2 }, seq: store.seq } }
    let deleting: Promise<void> | undefined
    center.syncHook = (method, path) => {
      if (method === 'GET' && path === '/api/client/sync/sessions/from-a/bundle' && deleting === undefined) deleting = b.ctx.sessionPersistence.delete(SessionId('from-a'))
      return deleting?.then(() => undefined)
    }
    await pull(b)
    await expect.poll(() => held(center, 'from-a')?.deleted).toBe(true)
    await sleep(300)
    expect(await stored(b.ctx, 'from-a')).toBeUndefined()
    expect(await pulledIds(b.ctx)).toEqual([])
  })

  it('leaves an open subagent Session\'s conversation whole until it can remove all of it', async () => {
    const { center, a, b } = await machines()
    const own = await storeSession(a.ctx, 'from-a', text('派个子任务'))
    await storeSession(a.ctx, 'from-a-child', text('子任务'), { origin: 'subagent', parentSession: own, delegationDepth: 1 })
    await pull(a)
    await expect.poll(() => held(center, own)?.meta.revision).toBe(1)
    await pull(b)
    await written(b, own)
    const writer = await a.ctx.sessionPersistence.open(SessionId('from-a-child'), 'write')
    await b.ctx.sessionPersistence.delete(own)
    await expect.poll(() => held(center, own)?.deleted).toBe(true)
    await pull(a)
    await expect.poll(async () => (await record(a.dshHome)).sessions[own]).toMatchObject({ held: 'deleted' })
    await sleep(200)
    expect([await stored(a.ctx, 'from-a'), await stored(a.ctx, 'from-a-child')].map(item => item !== undefined)).toEqual([true, true])
    await writer.close()
    await pull(a)
    await expect.poll(async () => [await stored(a.ctx, 'from-a'), await stored(a.ctx, 'from-a-child')]).toEqual([undefined, undefined])
  })

  it('removes what it wrote when the conversation is deleted here while it is being written', async () => {
    const { center, a, b } = await machines()
    await storeSession(a.ctx, 'from-a', text('复盘'))
    await pull(a)
    await expect.poll(() => held(center, 'from-a')?.meta.revision).toBe(1)
    const persistence = b.ctx.sessionPersistence
    const create = persistence.create.bind(persistence)
    // The user's deletion arrives while the copy is being created.
    vi.spyOn(persistence, 'create').mockImplementationOnce(async (header, options) => {
      b.ctx.emit('session/deleted', header.id)
      await sleep(50)
      return create(header, options)
    })
    await pull(b)
    await expect.poll(async () => (await record(b.dshHome)).deletes).toEqual({})
    await expect.poll(() => held(center, 'from-a')?.deleted).toBe(true)
    await expect.poll(() => stored(b.ctx, 'from-a')).toBeUndefined()
    expect(await pulledIds(b.ctx)).toEqual([])
  })

  it('offers the folder a pulled conversation worked in, and continues it here as a new conversation', async () => {
    const center = await startMockUserCenter()
    cleanups.push(() => center.close())
    const forks: { sessionId: string; cwd?: string }[] = []
    const a = await boot({ center })
    const b = await boot({ center, fork: async (request) => {
      forks.push(request)
      // The real fork stores a new conversation that starts with the pulled one.
      await storeSession(b.ctx, 'continued-1', text('继续'), { parentSession: request.sessionId })
      return { sessionId: SessionId('continued-1') }
    } })
    await startSync(a, { deviceName: '前台电脑' })
    await startSync(b, { deviceName: '家里电脑' })
    await signIn(a)
    await signIn(b)
    const here = await mkdtemp(join(tmpdir(), 'dsh-session-sync-folder-'))
    cleanups.push(() => rm(here, { recursive: true, force: true }))
    await storeSession(a.ctx, 'from-a', text('复盘'), { cwd: here })
    await storeSession(a.ctx, 'elsewhere', text('别处'), { cwd: '/not/on/this/computer' })
    const nowhere = await a.ctx.sessionPersistence.create({ version: SESSION_FORMAT_VERSION, id: SessionId('nowhere'), createdAt: 1_000, isSeeded: false })
    await nowhere.append([
      { type: 'user/message', seq: SessionSeq(0), time: 2_000, data: createUserMessage({ content: text('没有文件夹'), source: { kind: 'user' } }), surfaceOp: 'append' },
    ] as SessionEvent[])
    await nowhere.close()
    await pull(a)
    await expect.poll(() => ['from-a', 'elsewhere', 'nowhere'].map(id => held(center, id)?.meta.revision)).toEqual([1, 1, 1])
    await pull(b)
    for (const id of ['from-a', 'elsewhere', 'nowhere']) await written(b, id)
    expect(await b.ctx.sessionSync.continueInfo({ sessionId: SessionId('nowhere') })).toEqual({ folder: null, folderHere: false })

    expect(await b.ctx.sessionSync.continueInfo({ sessionId: SessionId('from-a') })).toEqual({ folder: here, folderHere: true })
    expect(await b.ctx.sessionSync.continueInfo({ sessionId: SessionId('elsewhere') })).toEqual({ folder: '/not/on/this/computer', folderHere: false })
    await expect(b.ctx.sessionSync.continueInfo({ sessionId: SessionId('own') })).rejects.toMatchObject({ code: 'session-sync/not-pulled' })
    await expect(b.ctx.sessionSync.continueConversation({ sessionId: SessionId('own'), cwd: here })).rejects.toMatchObject({ code: 'session-sync/not-pulled' })

    expect(await b.ctx.sessionSync.continueConversation({ sessionId: SessionId('from-a'), cwd: here })).toEqual({ sessionId: 'continued-1' })
    expect(forks).toEqual([{ sessionId: 'from-a', cwd: here }])
    expect((await view(b.ctx)).continuations).toEqual([{ sessionId: 'continued-1', sourceId: 'from-a', title: null, device: '前台电脑' }])
    // The continuation is this computer's own conversation: writable, and uploaded.
    expect(b.ctx.bail('api-session/view-only', SessionId('continued-1'))).toBeUndefined()
    await pull(b)
    await expect.poll(() => held(center, 'continued-1')?.meta.device).toBe('家里电脑')
    // The pulled conversation stays as it was.
    expect(await pulledIds(b.ctx)).toEqual(expect.arrayContaining(['from-a']))
    await b.ctx.sessionPersistence.delete(SessionId('continued-1'))
    await expect.poll(async () => (await view(b.ctx)).continuations).toEqual([])
  })

  it('keeps a continuation even when its record cannot be written, lists continuations per account, and forgets gone ones', async () => {
    const center = await startMockUserCenter()
    cleanups.push(() => center.close())
    const a = await boot({ center })
    let next = 0
    const b = await boot({ center, fork: async (request) => {
      next += 1
      await storeSession(b.ctx, `continued-${String(next)}`, text('继续'), { parentSession: request.sessionId })
      return { sessionId: SessionId(`continued-${String(next)}`) }
    } })
    await startSync(a, { deviceName: '前台电脑' })
    await startSync(b, { deviceName: '家里电脑', scanIntervalMs: 300 })
    await signIn(a)
    await signIn(b)
    const here = await mkdtemp(join(tmpdir(), 'dsh-session-sync-folder-'))
    cleanups.push(() => rm(here, { recursive: true, force: true }))
    await storeSession(a.ctx, 'from-a', text('复盘'), { cwd: here })
    await pull(a)
    await expect.poll(() => held(center, 'from-a')?.meta.revision).toBe(1)
    await pull(b)
    await written(b, 'from-a')
    // A record write that fails still answers with the new conversation; only its label is missing.
    await chmod(b.dshHome, 0o500)
    cleanups.push(() => chmod(b.dshHome, 0o700))
    expect(await b.ctx.sessionSync.continueConversation({ sessionId: SessionId('from-a'), cwd: here })).toEqual({ sessionId: 'continued-1' })
    await chmod(b.dshHome, 0o700)
    expect((await view(b.ctx)).continuations).toEqual([])
    await b.ctx.sessionSync.continueConversation({ sessionId: SessionId('from-a'), cwd: here })
    expect((await view(b.ctx)).continuations.map(item => item.sessionId)).toEqual(['continued-2'])
    // Another account does not see it; the record stays for when the account signs in again.
    await signIn(b, { tenantId: 't-b', tenantName: '乙公司' })
    await expect.poll(async () => (await view(b.ctx)).continuations).toEqual([])
    expect(Object.keys((await record(b.dshHome) as never as { continuations: object }).continuations)).toEqual(['continued-2'])
    // Gone from storage while the sync was not running: its next scan forgets it.
    await b.ctx.fiber.dispose()
    const again = await boot({ center, home: b.home })
    await again.ctx.sessionPersistence.delete(SessionId('continued-2'))
    await startSync(again, { deviceName: '家里电脑', scanIntervalMs: 300 })
    const kept = async () => Object.keys((await record(again.dshHome) as never as { continuations: object }).continuations)
    await expect.poll(kept).toEqual([])
  })
})
