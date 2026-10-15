/**
 * Session sync over real Session storage, real turns of a mock model, real attachments, and a real
 * Hub sign-in against the mock user center.
 */
import { chmod, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateSync, gunzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import HubAccount from '@deepseek-ai/dsh-hub-account'
import LlmRuntime, { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import SessionStore, { SESSION_FORMAT_VERSION, SessionSeq, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SessionSync, { type SessionSyncBundle } from '../src/index.ts'
import { encodeBundle } from '../src/bundle.ts'
import { browse, startMockUserCenter, type MockTenant, type MockUserCenter } from '../../../credentials/hub-account/tests/mock-user-center.ts'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const DEVICE = '前台电脑'
/** The account the mock employee of tenant t-a syncs as. */
const ACCOUNT = 't-a/138****0001'

interface Booted {
  ctx: Context
  center: MockUserCenter
  home: string
  dshHome: string
}

/** Mount real Session storage and a mock-model loop; Session sync mounts later with `startSync`. */
async function boot(options: { replies?: number; home?: string; center?: MockUserCenter; attachments?: boolean; compression?: 'none' } = {}): Promise<Booted> {
  const center = options.center ?? await startMockUserCenter()
  if (options.center === undefined) cleanups.push(() => center.close())
  const home = options.home ?? await realpath(await mkdtemp(join(tmpdir(), 'dsh-session-sync-')))
  if (options.home === undefined) cleanups.push(() => rm(home, { recursive: true, force: true }))
  const dshHome = join(home, '.dsh')
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose().then(() => undefined))
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root: join(dshHome, 'sessions'), ...options.compression === undefined ? {} : { compression: options.compression } })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SqliteSessionQueryEngine, { path: join(home, 'session-query.db') })
  if (options.attachments !== false) await ctx.plugin(LocalAttachmentStore, { dshHome })
  await ctx.plugin(LocalCredentialProvider, { path: join(home, 'credentials.yaml'), watch: false })
  await ctx.plugin(AuthorizationService)
  await ctx.plugin(HubAccount, { origin: center.origin, clientId: center.clientId, allowLoopbackHttp: true, dshHome })
  ctx.llm.registerAdapter(['mock'], new MockAdapter(Array.from({ length: options.replies ?? 4 }, (_, index) => textResponse(`答复 ${String(index + 1)}`))))
  return { ctx, center, home, dshHome }
}

async function signIn({ ctx, center }: Booted, tenant?: MockTenant): Promise<void> {
  if (tenant !== undefined) center.tenant = tenant
  const hub = ctx.get('hubAccount')!
  await hub.signIn()
  await expect.poll(async () => (await hub.getState()).attempt?.authorizeUrl).toBeDefined()
  await browse((await hub.getState()).attempt!.authorizeUrl!)
  await expect.poll(async () => (await hub.getState()).profile?.tenantId).toBe(center.tenant.tenantId)
}

async function startSync({ ctx, dshHome }: Booted, config: { scanIntervalMs?: number } = {}): Promise<void> {
  const scanIntervalMs = config.scanIntervalMs ?? 3_600_000
  await ctx.plugin(SessionSync, { dshHome, deviceName: DEVICE, debounceMs: 20, retryMs: 150, scanIntervalMs })
}

/** Store a closed one-turn Session directly, as an earlier run of the app left it. */
async function storeSession(ctx: Context, id: string, content: ContentBlock[], header: Partial<SessionHeader> = {}): Promise<SessionId> {
  const sessionId = SessionId(id)
  const writer = await ctx.sessionPersistence.create({ version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 1_000, cwd: '/work/双十一', isSeeded: false, ...header })
  const events = [
    { type: 'turn/start', seq: SessionSeq(0), time: 2_000, data: { turn: 1 } },
    { type: 'user/message', seq: SessionSeq(1), time: 2_000, data: createUserMessage({ content, source: { kind: 'user' } }), surfaceOp: 'append' },
    { type: 'turn/end', seq: SessionSeq(2), time: 3_000, data: { turn: 1, reason: { kind: 'completed' } } },
  ] as SessionEvent[]
  await writer.append(events)
  await writer.close()
  return sessionId
}

const text = (value: string): ContentBlock[] => [{ type: 'text', text: value }]

/** A promise the test resolves, to hold a request of the mock user center. */
function gate(): { opened: Promise<void>; open: () => void } {
  let open!: () => void
  const opened = new Promise<void>((resolve) => { open = resolve })
  return { opened, open }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const record = async (dshHome: string): Promise<{ sessions: Record<string, object>; deletes: Record<string, string> }> =>
  JSON.parse(await readFile(join(dshHome, 'session-sync.json'), 'utf8')) as never
/** A 2×2 RGB PNG. */
function png(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(2, 0)
  header.writeUInt32BE(2, 4)
  header.set([8, 2, 0, 0, 0], 8)
  const rows = Buffer.from([0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255])
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}

function idle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
}

/** Run one real turn of a live Session with the mock model. */
async function turn(ctx: Context, agent: Agent, prompt: string): Promise<void> {
  const done = idle(ctx, agent)
  agent.followup(createUserMessage({ content: text(prompt), source: { kind: 'user' } }))
  await done
}

const held = (center: MockUserCenter, sessionId: string, tenantId = 't-a') => center.sync[tenantId]?.sessions[sessionId]
const bundleOf = (center: MockUserCenter, sessionId: string, tenantId = 't-a'): SessionSyncBundle =>
  JSON.parse(gunzipSync(held(center, sessionId, tenantId)!.bundle!).toString('utf8')) as SessionSyncBundle
const puts = (center: MockUserCenter, path: string) => center.clientRequests.filter(request => request === path).length
const userTexts = (bundle: SessionSyncBundle) => bundle.sessions[0].events
  .flatMap(event => (event.type === 'user/message' ? event.data.content : []))
  .flatMap(block => (block.type === 'text' ? [block.text] : []))

describe('sessionSync', () => {
  it('uploads the Sessions already on this machine after sign-in, with their facts and full logs', async () => {
    const booted = await boot()
    const { ctx, center } = booted
    const old = await storeSession(ctx, 'old-1', text('复盘双十一'))
    const empty = await ctx.sessionPersistence.create({ version: SESSION_FORMAT_VERSION, id: SessionId('empty-1'), createdAt: 1_000, isSeeded: false })
    await empty.flush()
    await empty.close()
    await startSync(booted)
    expect(center.sync).toEqual({})
    await signIn(booted)
    await expect.poll(() => held(center, old)?.meta.revision).toBe(1)
    expect(held(center, old)!.meta).toEqual({
      revision: 1, cwd: '/work/双十一', device: DEVICE, title: null, assistantId: null, attachments: [], updatedAt: new Date(3_000).toISOString(),
    })
    const bundle = bundleOf(center, old)
    expect(bundle.format).toBe(1)
    expect(bundle.sessions.map(log => log.header.id)).toEqual([old])
    expect(bundle.sessions[0].events.map(event => event.type)).toEqual(['turn/start', 'user/message', 'turn/end'])
    // A Session with no user message has nothing to read on another machine.
    expect(held(center, 'empty-1')).toBeUndefined()
  })

  it('uploads a live Session after each turn, with a higher revision each time', async () => {
    const booted = await boot()
    const { ctx, center } = booted
    await startSync(booted)
    await signIn(booted)
    const { agent } = await ctx.agents.create({ sessionId: SessionId('live-1'), agentOptions: { provider: 'mock', model: 'mock' } })
    await turn(ctx, agent, '第一问')
    await expect.poll(() => held(center, 'live-1')?.meta.revision).toBe(1)
    expect(userTexts(bundleOf(center, 'live-1'))).toEqual(['第一问'])
    await turn(ctx, agent, '第二问')
    await expect.poll(() => held(center, 'live-1')?.meta.revision).toBe(2)
    expect(userTexts(bundleOf(center, 'live-1'))).toEqual(['第一问', '第二问'])
  })

  it('does not upload an unchanged Session again on a later scan', async () => {
    const booted = await boot()
    const { ctx, center } = booted
    const old = await storeSession(ctx, 'old-1', text('复盘'))
    await startSync(booted, { scanIntervalMs: 1_000 })
    await signIn(booted)
    await expect.poll(() => held(center, old)?.meta.revision).toBe(1)
    const lists = () => center.clientRequests.length
    const before = lists()
    await new Promise(resolve => setTimeout(resolve, 2_300))
    expect(puts(center, `/api/client/sync/sessions/${old}`)).toBe(1)
    expect(lists()).toBe(before)
  })

  it('puts the subagent Sessions in their parent\'s upload and never uploads them alone', async () => {
    const booted = await boot()
    const { ctx, center } = booted
    const parent = await storeSession(ctx, 'parent-1', text('派个子任务'))
    await storeSession(ctx, 'child-1', text('子任务'), { origin: 'subagent', parentSession: parent, delegationDepth: 1 })
    await storeSession(ctx, 'grandchild-1', text('孙任务'), { origin: 'subagent', parentSession: SessionId('child-1'), delegationDepth: 2 })
    await startSync(booted)
    await signIn(booted)
    await expect.poll(() => held(center, parent)?.meta.revision).toBe(1)
    expect(bundleOf(center, parent).sessions.map(log => log.header.id)).toEqual(['parent-1', 'child-1', 'grandchild-1'])
    expect(held(center, 'child-1')).toBeUndefined()
    expect(held(center, 'grandchild-1')).toBeUndefined()
  })

  it('uploads each attachment once, and lists it with every Session that references it', async () => {
    const booted = await boot()
    const { ctx, center } = booted
    const file = await ctx.attachments.saveFile({ data: new TextEncoder().encode('订单号,金额\n1,99\n'), name: '订单.csv' })
    const digest = file.attachmentId.slice('sha256:'.length)
    const first = await storeSession(ctx, 'with-file-1', [{ type: 'text', text: '看看这个表' }, { type: 'file', attachment: file }])
    const second = await storeSession(ctx, 'with-file-2', [{ type: 'file', attachment: file }])
    await startSync(booted)
    await signIn(booted)
    await expect.poll(() => [held(center, first)?.meta.revision, held(center, second)?.meta.revision]).toEqual([1, 1])
    expect(held(center, first)!.meta.attachments).toEqual([digest])
    expect(held(center, second)!.meta.attachments).toEqual([digest])
    expect(center.sync['t-a']!.blobs[digest]!.toString('utf8')).toBe('订单号,金额\n1,99\n')
    expect(puts(center, `/api/client/sync/blobs/${digest}`)).toBe(1)
  })

  it('leaves out an attachment whose stored file is gone, and uploads the conversation anyway', async () => {
    const booted = await boot()
    const { ctx, center } = booted
    const file = await ctx.attachments.saveFile({ data: new TextEncoder().encode('gone'), name: 'gone.txt' })
    await rm(ctx.attachments.fileHostPath(file)!, { force: true })
    const session = await storeSession(ctx, 'lost-file-1', [{ type: 'file', attachment: file }, { type: 'text', text: '附件丢了' }])
    await startSync(booted)
    await signIn(booted)
    await expect.poll(() => held(center, session)?.meta.revision).toBe(1)
    expect(held(center, session)!.meta.attachments).toEqual([])
  })

  it('deletes a deleted Session on the user center', async () => {
    const booted = await boot()
    const { ctx, center } = booted
    const old = await storeSession(ctx, 'old-1', text('复盘'))
    await startSync(booted)
    await signIn(booted)
    await expect.poll(() => held(center, old)?.meta.revision).toBe(1)
    await ctx.sessionPersistence.delete(old)
    await expect.poll(() => held(center, old)?.deleted).toBe(true)
  })

  it('keeps uploads and deletions while the user center cannot be reached, and sends them once it can', async () => {
    const booted = await boot()
    const { ctx, center, dshHome } = booted
    const kept = await storeSession(ctx, 'kept-1', text('留着'))
    const doomed = await storeSession(ctx, 'doomed-1', text('要删的'))
    await startSync(booted)
    await signIn(booted)
    await expect.poll(() => [held(center, kept)?.meta.revision, held(center, doomed)?.meta.revision]).toEqual([1, 1])
    center.syncReply = 'drop'
    await ctx.sessionPersistence.delete(doomed)
    const { agent } = await ctx.agents.create({ sessionId: SessionId('offline-1'), agentOptions: { provider: 'mock', model: 'mock' } })
    await turn(ctx, agent, '断网时问的')
    await expect.poll(async () => JSON.parse(await readFile(join(dshHome, 'session-sync.json'), 'utf8')) as object)
      .toMatchObject({ deletes: { 'doomed-1': ACCOUNT } })
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(held(center, 'offline-1')).toBeUndefined()
    expect(held(center, doomed)?.deleted).toBe(false)
    center.syncReply = undefined
    await expect.poll(() => [held(center, 'offline-1')?.meta.revision, held(center, doomed)?.deleted]).toEqual([1, true])
    await expect.poll(async () => JSON.parse(await readFile(join(dshHome, 'session-sync.json'), 'utf8')) as object).toMatchObject({ deletes: {} })
  })

  it('sends a deletion recorded before a restart after the restart', async () => {
    const center = await startMockUserCenter()
    cleanups.push(() => center.close())
    const first = await boot({ center })
    const old = await storeSession(first.ctx, 'old-1', text('复盘'))
    await startSync(first)
    await signIn(first)
    await expect.poll(() => held(center, old)?.meta.revision).toBe(1)
    center.syncReply = { status: 503, body: '{}' }
    await first.ctx.sessionPersistence.delete(old)
    await expect.poll(async () => JSON.parse(await readFile(join(first.dshHome, 'session-sync.json'), 'utf8')) as object)
      .toMatchObject({ deletes: { 'old-1': ACCOUNT } })
    await first.ctx.fiber.dispose()
    center.syncReply = undefined
    const second = await boot({ center, home: first.home })
    await startSync(second)
    await expect.poll(() => held(center, old)?.deleted).toBe(true)
  })

  it('keeps each Session with the tenant it first synced under', async () => {
    const booted = await boot()
    const { ctx, center } = booted
    const ofA = await storeSession(ctx, 'of-a', text('甲公司的'))
    await startSync(booted)
    await signIn(booted)
    await expect.poll(() => held(center, ofA)?.meta.revision).toBe(1)
    const ofB = await storeSession(ctx, 'of-b', text('乙公司的'))
    await signIn(booted, { tenantId: 't-b', tenantName: '乙公司' })
    const { agent } = await ctx.agents.create({ sessionId: SessionId('live-b'), agentOptions: { provider: 'mock', model: 'mock' } })
    await turn(ctx, agent, '乙公司问的')
    await expect.poll(() => [held(center, ofB, 't-b')?.meta.revision, held(center, 'live-b', 't-b')?.meta.revision]).toEqual([1, 1])
    expect(held(center, ofA, 't-b')).toBeUndefined()
    // A Session of tenant A deleted under tenant B waits for tenant A's sign-in.
    await ctx.sessionPersistence.delete(ofA)
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(held(center, ofA)?.deleted).toBe(false)
    await signIn(booted, { tenantId: 't-a', tenantName: '甲公司' })
    await expect.poll(() => held(center, ofA)?.deleted).toBe(true)
  })

  it('continues from the user center\'s revision when this machine lost its record', async () => {
    const booted = await boot()
    const { ctx, center } = booted
    const old = await storeSession(ctx, 'old-1', text('复盘'))
    center.sync['t-a'] = { sessions: { [old]: { meta: { revision: 7, device: DEVICE }, bundle: Buffer.from('x'), deleted: false } }, blobs: {} }
    await startSync(booted)
    await signIn(booted)
    await expect.poll(() => held(center, old)?.meta.revision).toBe(8)
  })

  it('stops uploading a Session deleted on another machine', async () => {
    const booted = await boot()
    const { ctx, center } = booted
    const old = await storeSession(ctx, 'old-1', text('复盘'))
    center.sync['t-a'] = { sessions: { [old]: { meta: { revision: 1 }, bundle: null, deleted: true } }, blobs: {} }
    await startSync(booted, { scanIntervalMs: 1_000 })
    await signIn(booted)
    await expect.poll(() => puts(center, `/api/client/sync/sessions/${old}`)).toBe(1)
    await new Promise(resolve => setTimeout(resolve, 1_300))
    expect(puts(center, `/api/client/sync/sessions/${old}`)).toBe(1)
  })

  it('stops for a sign-in the user center refuses, until the sign-in changes', async () => {
    const booted = await boot()
    const { ctx, center } = booted
    await storeSession(ctx, 'old-1', text('复盘'))
    center.syncReply = { status: 403, body: '{"message":"超管不是公司成员，不能同步对话"}' }
    await startSync(booted)
    await signIn(booted)
    await expect.poll(() => center.clientRequests.filter(path => path.startsWith('/api/client/sync/')).length).toBeGreaterThan(0)
    const refused = center.clientRequests.length
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(center.clientRequests.length).toBe(refused)
    center.syncReply = undefined
    await signIn(booted, { tenantId: 't-b', tenantName: '乙公司' })
    await expect.poll(() => held(center, 'old-1', 't-b')?.meta.revision).toBe(1)
  })

  it('does nothing while signed out', async () => {
    const booted = await boot()
    const { ctx, center } = booted
    await storeSession(ctx, 'old-1', text('复盘'))
    await startSync(booted)
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(center.clientRequests).toEqual([])
  })

  it('stops syncing when its plugin is disposed', async () => {
    const booted = await boot()
    const { ctx, center, dshHome } = booted
    const fiber = await ctx.plugin(SessionSync, { dshHome, deviceName: DEVICE, debounceMs: 20, retryMs: 150, scanIntervalMs: 200 })
    await signIn(booted)
    await fiber.dispose()
    const syncRequests = () => center.clientRequests.filter(path => path.startsWith('/api/client/sync/'))
    const requests = syncRequests().length
    await storeSession(ctx, 'after-1', text('卸载后'))
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(syncRequests().slice(requests)).toEqual([])
  })

  it('names this machine by its host name unless configured', async () => {
    const booted = await boot()
    const { ctx, center, dshHome } = booted
    await storeSession(ctx, 'old-1', text('复盘'))
    await ctx.plugin(SessionSync, { dshHome, debounceMs: 20, retryMs: 150 })
    await signIn(booted)
    await expect.poll(() => held(center, 'old-1')?.meta.device).toBe(hostname().replace(/\.local$/u, '').slice(0, 100))
  })

  it('uploads an image attachment', async () => {
    const booted = await boot()
    const { ctx, center } = booted
    const [image] = await ctx.attachments.saveImages([{ data: png(), mediaType: 'image/png', name: '截图.png' }])
    const digest = image!.attachmentId.slice('sha256:'.length)
    const session = await storeSession(ctx, 'with-image-1', [{ type: 'text', text: '看图' }, { type: 'image', attachment: image! }])
    await startSync(booted)
    await signIn(booted)
    await expect.poll(() => held(center, session)?.meta.attachments).toEqual([digest])
    expect(new Uint8Array(center.sync['t-a']!.blobs[digest]!)).toEqual((await ctx.attachments.readImage(image!)).data)
  })

  it('lists no attachments where no attachment store is composed', async () => {
    const booted = await boot({ attachments: false })
    const { ctx, center } = booted
    const ref = { attachmentId: `sha256:${'a'.repeat(64)}`, name: 'x.txt', bytes: 1 } as never
    const session = await storeSession(ctx, 'no-store-1', [{ type: 'file', attachment: ref }, { type: 'text', text: '附件' }])
    await startSync(booted)
    await signIn(booted)
    await expect.poll(() => held(center, session)?.meta.attachments).toEqual([])
    expect(center.clientRequests.filter(path => path.startsWith('/api/client/sync/blobs'))).toEqual([])
  })

  it('uploads an attachment again when the user center lost it between its check and the upload', async () => {
    const booted = await boot()
    const { ctx, center } = booted
    const file = await ctx.attachments.saveFile({ data: new TextEncoder().encode('表'), name: '表.csv' })
    const digest = file.attachmentId.slice('sha256:'.length)
    const session = await storeSession(ctx, 'lost-blob-1', [{ type: 'file', attachment: file }, { type: 'text', text: '看' }])
    let dropped = false
    center.syncHook = (method, path) => {
      if (method === 'PUT' && path === `/api/client/sync/sessions/${session}` && !dropped) {
        dropped = true
        center.sync['t-a']!.blobs = {}
      }
      return undefined
    }
    await startSync(booted)
    await signIn(booted)
    await expect.poll(() => held(center, session)?.meta.revision).toBe(1)
    expect(puts(center, `/api/client/sync/blobs/${digest}`)).toBe(2)
  })

  it('retries when the attachment check or an attachment upload fails', async () => {
    const booted = await boot()
    const { ctx, center } = booted
    const file = await ctx.attachments.saveFile({ data: new TextEncoder().encode('表'), name: '表.csv' })
    const digest = file.attachmentId.slice('sha256:'.length)
    const session = await storeSession(ctx, 'flaky-1', [{ type: 'file', attachment: file }, { type: 'text', text: '看' }])
    const failures = ['/api/client/sync/blobs/check', `/api/client/sync/blobs/${digest}`]
    center.syncHook = (_method, path) => (failures[0] === path ? (failures.shift(), { status: 503, body: '{}' }) : undefined)
    await startSync(booted)
    await signIn(booted)
    await expect.poll(() => held(center, session)?.meta.attachments).toEqual([digest])
    expect(failures).toEqual([])
  })

  it('leaves out a conversation the user center refuses, until it changes', async () => {
    const booted = await boot()
    const { ctx, center, dshHome } = booted
    const session = await storeSession(ctx, 'huge-1', text('很大'))
    center.syncHook = method => (method === 'PUT' ? { status: 413, body: '{"message":"对话包不能超过 50MB"}' } : undefined)
    await startSync(booted, { scanIntervalMs: 300 })
    await signIn(booted)
    await expect.poll(async () => (await record(dshHome)).sessions[session]).toMatchObject({ held: 'refused', revision: 0 })
    await sleep(700)
    expect(puts(center, `/api/client/sync/sessions/${session}`)).toBe(1)
  })

  it('gives up for the pass after repeated conflicts and on an unreadable conflict, and tries again later', async () => {
    const booted = await boot()
    const { ctx, center } = booted
    const session = await storeSession(ctx, 'conflict-1', text('冲突'))
    const replies = [...Array.from({ length: 3 }, () => ({ status: 409, body: '{"code":"stale_revision","revision":1}' })), { status: 409, body: 'not json' }]
    center.syncHook = method => (method === 'PUT' ? replies.shift() : undefined)
    await startSync(booted)
    await signIn(booted)
    await expect.poll(() => held(center, session)?.meta.revision).toBe(1)
    expect(puts(center, `/api/client/sync/sessions/${session}`)).toBe(5)
  })

  it('leaves out a conversation whose subagent log cannot be read', async () => {
    const booted = await boot({ compression: 'none' })
    const { ctx, center, dshHome } = booted
    const parent = await storeSession(ctx, 'parent-1', text('派个子任务'))
    await storeSession(ctx, 'child-1', text('子任务'), { origin: 'subagent', parentSession: parent, delegationDepth: 1 })
    const projects = join(dshHome, 'sessions')
    const [project] = await readdir(projects)
    const dir = join(projects, project!, 'child-1')
    const [log] = (await readdir(dir)).filter(name => name.endsWith('.jsonl'))
    const lines = (await readFile(join(dir, log!), 'utf8')).split('\n')
    lines[1] = '{"bogus":true}'
    await writeFile(join(dir, log!), lines.join('\n'))
    await expect(ctx.sessionQuery.readSession(SessionId('child-1'))).rejects.toThrow()
    await storeSession(ctx, 'other-1', text('别的'))
    await startSync(booted, { scanIntervalMs: 300 })
    await signIn(booted)
    await expect.poll(() => held(center, 'other-1')?.meta.revision).toBe(1)
    // Later scans skip it until it changes.
    await sleep(700)
    expect(held(center, parent)).toBeUndefined()
  })

  it('refreshes the record of an unchanged Session without uploading it', async () => {
    const booted = await boot()
    const { ctx, center, dshHome } = booted
    const session = await storeSession(ctx, 'old-1', text('复盘'))
    const { session: header, inheritedEventCount, events } = await ctx.sessionQuery.readSession(session)
    const { digest } = await encodeBundle({ format: 1, sessions: [{ header, inheritedEventCount, events }] })
    await writeFile(join(dshHome, 'session-sync.json'), JSON.stringify({ version: 2, sessions: { [session]: { account: ACCOUNT, revision: 3, digest, token: 'old' } }, deletes: {} }))
    await startSync(booted)
    await signIn(booted)
    await expect.poll(async () => (await record(dshHome)).sessions[session]).not.toMatchObject({ token: 'old' })
    expect(held(center, session)).toBeUndefined()
  })

  it('reads a damaged record as empty and compares every Session again', async () => {
    const booted = await boot()
    const { ctx, center, dshHome } = booted
    const session = await storeSession(ctx, 'old-1', text('复盘'))
    await writeFile(join(dshHome, 'session-sync.json'), '{ damaged')
    await startSync(booted)
    await signIn(booted)
    await expect.poll(() => held(center, session)?.meta.revision).toBe(1)
  })

  it('keeps going after its record cannot be written', async () => {
    const booted = await boot()
    const { ctx, center, dshHome } = booted
    const session = await storeSession(ctx, 'old-1', text('复盘'))
    await startSync(booted)
    await signIn(booted)
    await expect.poll(() => held(center, session)?.meta.revision).toBe(1)
    await chmod(dshHome, 0o500)
    cleanups.push(() => chmod(dshHome, 0o700))
    const { agent } = await ctx.agents.create({ sessionId: SessionId('live-1'), agentOptions: { provider: 'mock', model: 'mock' } })
    await turn(ctx, agent, '记录写不进去')
    await expect.poll(() => held(center, 'live-1')?.meta.revision).toBe(1)
    await ctx.sessionPersistence.delete(session)
    await sleep(300)
    await chmod(dshHome, 0o700)
    // The live Session uploads again with its record now written; the deletion was not recorded.
    await expect.poll(async () => (await record(dshHome)).sessions['live-1']).toBeDefined()
    expect(held(center, session)?.deleted).toBe(false)
  })

  it('uploads a Session whose turn ended before it reached storage on a scan shortly after', async () => {
    const booted = await boot()
    const { ctx, center } = booted
    await startSync(booted)
    await signIn(booted)
    const live = ctx.sessions.create(SessionId('unstored-1'), { meta: { createdAt: 1_000, cwd: '/work' } })
    live.append('turn/start', { turn: 1 })
    live.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const syncRequests = () => center.clientRequests.filter(path => path.startsWith('/api/client/sync/')).length
    const scansBefore = syncRequests()
    await sleep(300)
    expect(syncRequests()).toBe(scansBefore)
    expect(held(center, 'unstored-1')).toBeUndefined()
  })

  it('runs a pass asked for while one is running right after it', async () => {
    const booted = await boot()
    const { ctx, center } = booted
    const old = await storeSession(ctx, 'old-1', text('复盘'))
    const hold = gate()
    const reached = gate()
    center.syncHook = async (method, path) => {
      if (method === 'PUT' && path === `/api/client/sync/sessions/${old}`) {
        reached.open()
        await hold.opened
      }
      return undefined
    }
    await startSync(booted)
    await signIn(booted)
    await reached.opened
    const { agent } = await ctx.agents.create({ sessionId: SessionId('live-1'), agentOptions: { provider: 'mock', model: 'mock' } })
    await turn(ctx, agent, '排队的')
    await sleep(100)
    hold.open()
    await expect.poll(() => [held(center, old)?.meta.revision, held(center, 'live-1')?.meta.revision]).toEqual([1, 1])
  })

  it('stops a pass when the sign-in switches tenant during it', async () => {
    const booted = await boot()
    const { ctx, center } = booted
    const older = await storeSession(ctx, 'older-1', text('早的'), { createdAt: 1_000 })
    const newer = await storeSession(ctx, 'newer-1', text('新的'), { createdAt: 5_000 })
    const hold = gate()
    const reached = gate()
    center.syncHook = async (method, path) => {
      if (method === 'PUT' && path === `/api/client/sync/sessions/${newer}`) {
        reached.open()
        await hold.opened
      }
      return undefined
    }
    await startSync(booted)
    await signIn(booted)
    await reached.opened
    await signIn(booted, { tenantId: 't-b', tenantName: '乙公司' })
    hold.open()
    await expect.poll(() => held(center, older, 't-b')?.meta.revision).toBe(1)
    expect(held(center, newer)?.meta.revision).toBe(1)
    expect(held(center, older)).toBeUndefined()
    expect(held(center, newer, 't-b')).toBeUndefined()
  })

  it('deletes a Session deleted while it was uploading once the upload is done', async () => {
    const booted = await boot()
    const { ctx, center, dshHome } = booted
    const old = await storeSession(ctx, 'old-1', text('复盘'))
    const hold = gate()
    const reached = gate()
    center.syncHook = async (method, path) => {
      if (method === 'PUT' && path === `/api/client/sync/sessions/${old}`) {
        reached.open()
        await hold.opened
      }
      return undefined
    }
    await startSync(booted)
    await signIn(booted)
    await reached.opened
    await ctx.sessionPersistence.delete(old)
    hold.open()
    await expect.poll(() => held(center, old)?.deleted).toBe(true)
    expect((await record(dshHome)).sessions[old]).toBeUndefined()
  })

  it('sends nothing for a deleted Session that never synced', async () => {
    const booted = await boot()
    const { ctx, center } = booted
    await startSync(booted)
    await signIn(booted)
    const never = await storeSession(ctx, 'never-1', text('没传过'))
    await ctx.sessionPersistence.delete(never)
    await sleep(300)
    expect(center.clientRequests.filter(path => path.startsWith('/api/client/sync/sessions/'))).toEqual([])
  })

  it('stops a held request when its plugin is disposed', async () => {
    const booted = await boot()
    const { ctx, center, dshHome } = booted
    await storeSession(ctx, 'old-1', text('复盘'))
    const hold = gate()
    const reached = gate()
    center.syncHook = async () => {
      reached.open()
      await hold.opened
      return undefined
    }
    const fiber = await ctx.plugin(SessionSync, { dshHome, deviceName: DEVICE, debounceMs: 20, retryMs: 100, scanIntervalMs: 3_600_000 })
    await signIn(booted)
    await reached.opened
    await fiber.dispose()
    const count = center.clientRequests.length
    hold.open()
    await sleep(300)
    expect(center.clientRequests.length).toBe(count)
  })

  it('keeps each Session with the employee it first synced as, within one tenant too', async () => {
    const booted = await boot()
    const { ctx, center } = booted
    const ofLi = await storeSession(ctx, 'of-li', text('李雷的'))
    await startSync(booted)
    await signIn(booted, { tenantId: 't-a', tenantName: '甲公司', phone: '13800000001' })
    await expect.poll(() => held(center, ofLi, 't-a/13800000001')?.meta.revision).toBe(1)
    const ofHan = await storeSession(ctx, 'of-han', text('韩梅梅的'))
    await signIn(booted, { tenantId: 't-a', tenantName: '甲公司', phone: '13800000002' })
    await expect.poll(() => held(center, ofHan, 't-a/13800000002')?.meta.revision).toBe(1)
    expect(held(center, ofLi, 't-a/13800000002')).toBeUndefined()
  })

  it('deletes a new Session deleted while its attachments were uploading', async () => {
    const booted = await boot()
    const { ctx, center, dshHome } = booted
    const file = await ctx.attachments.saveFile({ data: new TextEncoder().encode('表'), name: '表.csv' })
    const session = await storeSession(ctx, 'new-1', [{ type: 'file', attachment: file }, { type: 'text', text: '看' }])
    const hold = gate()
    const reached = gate()
    center.syncHook = async (_method, path) => {
      if (path === '/api/client/sync/blobs/check') {
        reached.open()
        await hold.opened
      }
      return undefined
    }
    await startSync(booted)
    await signIn(booted)
    await reached.opened
    await ctx.sessionPersistence.delete(session)
    hold.open()
    await expect.poll(() => held(center, session)?.deleted).toBe(true)
    expect((await record(dshHome)).sessions[session]).toBeUndefined()
  })

  it('syncs the other Sessions when one keeps failing, and tries that one again later', async () => {
    const booted = await boot()
    const { ctx, center } = booted
    const stuck = await storeSession(ctx, 'stuck-1', text('卡住的'), { createdAt: 5_000 })
    const fine = await storeSession(ctx, 'fine-1', text('正常的'), { createdAt: 1_000 })
    let conflicts = 3
    center.syncHook = (method, path) => (method === 'PUT' && path.endsWith(stuck) && conflicts-- > 0
      ? { status: 409, body: '{"code":"stale_revision","revision":0}' } : undefined)
    await startSync(booted)
    await signIn(booted)
    await expect.poll(() => [held(center, fine)?.meta.revision, held(center, stuck)?.meta.revision]).toEqual([1, 1])
  })

  it('leaves out an attachment the user center refuses, and uploads the conversation anyway', async () => {
    const booted = await boot()
    const { ctx, center } = booted
    const file = await ctx.attachments.saveFile({ data: new TextEncoder().encode('表'), name: '表.csv' })
    const digest = file.attachmentId.slice('sha256:'.length)
    const session = await storeSession(ctx, 'refused-file-1', [{ type: 'file', attachment: file }, { type: 'text', text: '看' }])
    center.syncHook = (method, path) => (method === 'PUT' && path.includes('/blobs/') ? { status: 400, body: '{}' } : undefined)
    await startSync(booted)
    await signIn(booted)
    await expect.poll(() => held(center, session)?.meta.attachments).toEqual([])
    expect(center.sync['t-a']?.blobs[digest]).toBeUndefined()
  })

  it('refuses to load with an empty device name', async () => {
    const booted = await boot()
    await expect(booted.ctx.plugin(SessionSync, { dshHome: booted.dshHome, deviceName: '  ' })).rejects.toThrow('device name is empty')
  })

  it('sends an acknowledged deletion again when its record cannot be cleared', async () => {
    const booted = await boot()
    const { ctx, center, dshHome } = booted
    const old = await storeSession(ctx, 'old-1', text('复盘'))
    await startSync(booted)
    await signIn(booted)
    await expect.poll(() => held(center, old)?.meta.revision).toBe(1)
    center.syncReply = { status: 503, body: '{}' }
    await ctx.sessionPersistence.delete(old)
    await expect.poll(async () => (await record(dshHome)).deletes).toEqual({ [old]: ACCOUNT })
    await chmod(dshHome, 0o500)
    cleanups.push(() => chmod(dshHome, 0o700))
    center.syncReply = undefined
    await expect.poll(() => held(center, old)?.deleted).toBe(true)
    await sleep(200)
    await chmod(dshHome, 0o700)
    await expect.poll(async () => (await record(dshHome)).deletes).toEqual({})
  })
})
