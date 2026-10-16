/** Shared fixtures of the session-sync specs: real Session storage, a mock-model loop, real attachments, and the mock user center. */
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateSync, gunzipSync } from 'node:zlib'
import { expect } from 'vitest'
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
import SessionProjectionCache from '@deepseek-ai/dsh-session-projection-cache'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SessionSync, { type SessionSyncBundle } from '../src/index.ts'
import { browse, startMockUserCenter, type MockTenant, type MockUserCenter } from '../../../credentials/hub-account/tests/mock-user-center.ts'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

/** Teardown steps of the running test; each spec drains them after every test. */
export const cleanups: (() => Promise<void>)[] = []

export const DEVICE = '前台电脑'
/** The account the mock employee of tenant t-a syncs as. */
export const ACCOUNT = 't-a/138****0001'

export interface Booted {
  ctx: Context
  center: MockUserCenter
  home: string
  dshHome: string
}

/** Mount real Session storage and a mock-model loop; Session sync mounts later with `startSync`. */
/** What `boot` mounts beyond the defaults. */
export interface BootOptions {
  replies?: number
  home?: string
  center?: MockUserCenter
  attachments?: boolean
  compression?: 'none'
  projectionCache?: boolean
  /** Stand-in for the Session controller's fork. */
  fork?: (request: { sessionId: SessionId; cwd?: string }) => Promise<{ sessionId: SessionId }>
}

export async function boot(options: BootOptions = {}): Promise<Booted> {
  const center = options.center ?? await startMockUserCenter()
  if (options.center === undefined) cleanups.push(() => center.close())
  const home = options.home ?? await realpath(await mkdtemp(join(tmpdir(), 'dsh-session-sync-')))
  if (options.home === undefined) cleanups.push(() => rm(home, { recursive: true, force: true }))
  const dshHome = join(home, '.dsh')
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose().then(() => undefined))
  await ctx.plugin(LlmRuntime)
  if (options.projectionCache === true) {
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root: join(home, 'storages') })
    await ctx.plugin(StorageDomain, { backend: 'json' })
  }
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  if (options.projectionCache === true) await ctx.plugin(SessionProjectionCache, { writeEveryEvents: 100, writeIntervalMs: 60_000 })
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
  // The real controller is composed in the Web e2e; here its fork only names the new conversation.
  ctx.provide('sessionController', { fork: options.fork ?? (async () => ({ sessionId: SessionId('continued') })) } as never)
  ctx.llm.registerAdapter(['mock'], new MockAdapter(Array.from({ length: options.replies ?? 4 }, (_, index) => textResponse(`答复 ${String(index + 1)}`))))
  return { ctx, center, home, dshHome }
}

export async function signIn({ ctx, center }: Booted, tenant?: MockTenant): Promise<void> {
  if (tenant !== undefined) center.tenant = tenant
  const hub = ctx.get('hubAccount')!
  await hub.signIn()
  await expect.poll(async () => (await hub.getState()).attempt?.authorizeUrl).toBeDefined()
  await browse((await hub.getState()).attempt!.authorizeUrl!)
  await expect.poll(async () => (await hub.getState()).profile?.tenantId).toBe(center.tenant.tenantId)
}

export async function startSync({ ctx, dshHome }: Booted, config: { scanIntervalMs?: number; deviceName?: string } = {}): Promise<void> {
  const scanIntervalMs = config.scanIntervalMs ?? 3_600_000
  await ctx.plugin(SessionSync, { dshHome, deviceName: config.deviceName ?? DEVICE, debounceMs: 20, retryMs: 150, scanIntervalMs })
}

/** Store a closed one-turn Session directly, as an earlier run of the app left it. */
export async function storeSession(
  ctx: Context, id: string, content: ContentBlock[], header: Partial<SessionHeader> = {},
): Promise<SessionId> {
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

export const text = (value: string): ContentBlock[] => [{ type: 'text', text: value }]

/** A promise the test resolves, to hold a request of the mock user center. */
export function gate(): { opened: Promise<void>; open: () => void } {
  let open!: () => void
  const opened = new Promise<void>((resolve) => { open = resolve })
  return { opened, open }
}

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
/** The sync record of a machine, as written. */
export interface SyncRecord {
  sessions: Record<string, object>
  deletes: Record<string, string>
  pulled: Record<string, { revision: number; behind?: number; gone?: true } | undefined>
  cursors: Record<string, number>
}

export const record = async (dshHome: string): Promise<SyncRecord> =>
  JSON.parse(await readFile(join(dshHome, 'session-sync.json'), 'utf8')) as never
/** A 2×2 RGB PNG. */
export function png(): Buffer {
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

export function idle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
}

/** Run one real turn of a live Session with the mock model. */
export async function turn(ctx: Context, agent: Agent, prompt: string): Promise<void> {
  const done = idle(ctx, agent)
  agent.followup(createUserMessage({ content: text(prompt), source: { kind: 'user' } }))
  await done
}

export const held = (center: MockUserCenter, sessionId: string, tenantId = 't-a') => center.sync[tenantId]?.sessions[sessionId]
export const bundleOf = (center: MockUserCenter, sessionId: string, tenantId = 't-a'): SessionSyncBundle =>
  JSON.parse(gunzipSync(held(center, sessionId, tenantId)!.bundle!).toString('utf8')) as SessionSyncBundle
/** Sync requests other than pulls, which every scan makes. */
export const uploads = (center: MockUserCenter) => center.clientRequests.filter(path => path.startsWith('/api/client/sync/') && !path.includes('?since='))
export const puts = (center: MockUserCenter, path: string) => center.clientRequests.filter(request => request === path).length
export const userTexts = (bundle: SessionSyncBundle) => bundle.sessions[0].events
  .flatMap(event => (event.type === 'user/message' ? event.data.content : []))
  .flatMap(block => (block.type === 'text' ? [block.text] : []))
