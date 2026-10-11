/** The `sessionShare` Remote over a mock user center and a real Hub sign-in, with Session reads stubbed. */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import HubAccount from '@deepseek-ai/dsh-hub-account'
import { createUserMessage, MessageId } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { remoteErrorOf, remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import SessionShare from '../src/index.ts'
import { browse, startMockUserCenter } from '../../../credentials/hub-account/tests/mock-user-center.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

let seq = 0
const event = (type: string, time: number, data: unknown) => ({ type, seq: SessionSeq(seq++), time, data }) as never as SessionEvent
const user = (time: number, text: string) => event('user/message', time, createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } as never }))
const assistant = (time: number, text: string) => event('assistant/message', time, {
  turn: 1, step: 1, stream: [],
  message: { id: MessageId(`m${String(time)}`), role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'p', model: 'm' } },
})
const selected = (assistantId: string) => event('assistant/selected', 500, { assistantId })

const S1 = SessionId('s-1')
const TALK = [user(1_000, '帮我复盘双十一'), assistant(2_000, '成交额增长 12%。')]

interface BootOptions {
  signedIn?: boolean
  assistants?: boolean
  config?: { requestTimeoutMs?: number; dshHome?: string }
}

async function boot({ signedIn = true, assistants = true, config = {} }: BootOptions = {}) {
  const center = await startMockUserCenter()
  cleanups.push(() => center.close())
  const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-session-share-')))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose().then(() => undefined))
  await ctx.plugin(LocalCredentialProvider, { path: join(home, 'credentials.yaml'), watch: false })
  await ctx.plugin(AuthorizationService)
  await ctx.plugin(HubAccount, { origin: center.origin, clientId: center.clientId, allowLoopbackHttp: true, dshHome: join(home, '.dsh') })
  const hub = ctx.get('hubAccount')!
  if (signedIn) {
    await hub.signIn()
    await expect.poll(async () => (await hub.getState()).attempt?.authorizeUrl).toBeDefined()
    await browse((await hub.getState()).attempt!.authorizeUrl!)
    await expect.poll(async () => (await hub.getState()).status).toBe('signed-in')
  }
  const logs: Record<string, SessionEvent[]> = { [S1]: TALK }
  ctx.provide('sessionQuery', { readSession: async (id: SessionId) => ({ events: logs[id] ?? [] }) } as never)
  if (assistants) {
    ctx.provide('assistants', { getState: async () => ({ assistants: [{ id: 'a-shop', name: '电商管家' }] }) } as never)
  }
  const dshHome = join(home, '.dsh')
  await ctx.plugin(SessionShare, { dshHome, ...config })
  const share = ctx.get('sessionShare')!
  const shareRequests = () => center.clientRequests.filter(path => path.startsWith('/api/client/session-shares/'))
  const recordFile = join(dshHome, 'session-shares.json')
  const recorded = async (): Promise<unknown> => JSON.parse(await readFile(recordFile, 'utf8')) as object
  return { ctx, center, hub, share, logs, shareRequests, home, dshHome, recordFile, recorded }
}

describe('sessionShare', () => {
  it('publishes the namespace and its methods', async () => {
    const { share } = await boot()
    expect(share.typertRemote.namespace).toBe('sessionShare')
    expect(remoteMethods(share).map(method => method.method)).toEqual(['status', 'share', 'revoke'])
  })

  it('uploads the conversation snapshot with the title and no assistant for a general Session, and reports the link', async () => {
    const { share, center } = await boot()
    expect(await share.status({ sessionId: S1 })).toEqual({ signedIn: true, link: null })
    const link = await share.share({ sessionId: S1, title: '双十一复盘' })
    expect(link.url).toBe(`${center.origin}/share/${link.shareId}`)
    expect(center.shares[S1]?.body).toEqual({
      title: '双十一复盘', assistantName: null,
      messages: [
        { role: 'user', text: '帮我复盘双十一', at: new Date(1_000).toISOString() },
        { role: 'assistant', text: '成交额增长 12%。', at: new Date(2_000).toISOString() },
      ],
    })
    expect(await share.status({ sessionId: S1 })).toEqual({ signedIn: true, link })
  })

  it('sharing again replaces the snapshot and keeps the link', async () => {
    const { share, center, logs } = await boot()
    const first = await share.share({ sessionId: S1, title: '复盘' })
    logs[S1] = [...TALK, user(3_000, '再看退款率')]
    const second = await share.share({ sessionId: S1, title: '复盘（更新）' })
    expect(second.shareId).toBe(first.shareId)
    expect(center.shares[S1]?.body).toMatchObject({ title: '复盘（更新）', messages: [{}, {}, { text: '再看退款率' }] })
  })

  it('names the assistant the Session is bound to, and none after going back to general or once the assistant is gone', async () => {
    const { share, center, logs } = await boot()
    logs[S1] = [selected('a-shop'), ...TALK]
    await share.share({ sessionId: S1, title: 't' })
    expect(center.shares[S1]?.body).toMatchObject({ assistantName: '电商管家' })
    logs[S1] = [selected('a-shop'), selected(''), ...TALK]
    await share.share({ sessionId: S1, title: 't' })
    expect(center.shares[S1]?.body).toMatchObject({ assistantName: null })
    logs[S1] = [selected('a-deleted'), ...TALK]
    await share.share({ sessionId: S1, title: 't' })
    expect(center.shares[S1]?.body).toMatchObject({ assistantName: null })
  })

  it('shares without an assistant name where assistants are not composed', async () => {
    const { share, center, logs } = await boot({ assistants: false })
    logs[S1] = [selected('a-shop'), ...TALK]
    await share.share({ sessionId: S1, title: 't' })
    expect(center.shares[S1]?.body).toMatchObject({ assistantName: null })
  })

  it('refuses a Session with no conversation without calling the user center', async () => {
    const { share, shareRequests, logs } = await boot()
    logs[S1] = [selected('a-shop')]
    expect(remoteErrorOf(await share.share({ sessionId: S1, title: 't' }).catch((error: unknown) => error)))
      .toMatchObject({ code: 'session-share/empty', details: { sessionId: S1 } })
    expect(shareRequests()).toEqual([])
  })

  it('withdraws the share, and leaves a Session that is not shared as is', async () => {
    const { share, center } = await boot()
    await share.share({ sessionId: S1, title: 't' })
    await share.revoke({ sessionId: S1 })
    expect(center.shares).toEqual({})
    expect(await share.status({ sessionId: S1 })).toEqual({ signedIn: true, link: null })
    await expect(share.revoke({ sessionId: S1 })).resolves.toBeUndefined()
  })

  it('withdraws the share of a deleted Session and forgets it', async () => {
    const { ctx, share, center, recorded } = await boot()
    const link = await share.share({ sessionId: S1, title: 't' })
    expect(await recorded()).toEqual({ version: 1, shares: { [S1]: { tenantId: 't-a', shareId: link.shareId } } })
    ctx.emit('session/deleted', S1)
    await expect.poll(() => center.shares).toEqual({})
    await expect.poll(recorded).toEqual({ version: 1, shares: {} })
  })

  it('makes no request for a deleted Session this machine never shared', async () => {
    const { ctx, shareRequests } = await boot()
    ctx.emit('session/deleted', SessionId('never-shared'))
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect(shareRequests()).toEqual([])
  })

  it('leaves the share of a deleted Session shared under another tenant, and says so', async () => {
    const { ctx, share, center, hub, shareRequests, recorded } = await boot()
    await share.share({ sessionId: S1, title: 't' })
    center.tenant = { tenantId: 't-b', tenantName: '乙公司' }
    await hub.switchTenant()
    await expect.poll(async () => (await hub.getState()).attempt?.authorizeUrl).toBeDefined()
    await browse((await hub.getState()).attempt!.authorizeUrl!)
    await expect.poll(async () => (await hub.getState()).profile?.tenantId).toBe('t-b')
    // Tenant A's record stays after the switch.
    expect(await recorded()).toMatchObject({ shares: { [S1]: { tenantId: 't-a' } } })
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const before = shareRequests().length
    ctx.emit('session/deleted', S1)
    await expect.poll(() => info.mock.calls.some(call => call[0] === '[session-share] share of a deleted Session not withdrawn: shared under another sign-in')).toBe(true)
    expect(shareRequests()).toHaveLength(before)
    expect(Object.keys(center.shares)).toEqual([S1])
    await expect.poll(recorded).toEqual({ version: 1, shares: {} })
  })

  it('records a sign-in without a tenant under an empty tenant', async () => {
    const { share, hub, recorded } = await boot()
    const state = await hub.getState()
    vi.spyOn(hub, 'getState').mockResolvedValue({ ...state, profile: null })
    const link = await share.share({ sessionId: S1, title: 't' })
    expect(await recorded()).toEqual({ version: 1, shares: { [S1]: { tenantId: '', shareId: link.shareId } } })
  })

  it('records a share the user center reports, and forgets one it no longer has', async () => {
    const { share, center, recorded } = await boot()
    await share.share({ sessionId: S1, title: 't' })
    const shareId = center.shares[S1]!.shareId
    center.shares = {}
    expect(await share.status({ sessionId: S1 })).toEqual({ signedIn: true, link: null })
    expect(await recorded()).toEqual({ version: 1, shares: {} })
    center.shares = { [S1]: { shareId, body: {}, createdAt: '2026-10-11T00:00:00.000Z', updatedAt: '2026-10-11T00:00:00.000Z' } }
    expect((await share.status({ sessionId: S1 })).link?.shareId).toBe(shareId)
    expect(await recorded()).toEqual({ version: 1, shares: { [S1]: { tenantId: 't-a', shareId } } })
  })

  it('reads a damaged record file as empty and replaces it on the next write', async () => {
    const { share, recordFile, dshHome, recorded } = await boot()
    await mkdir(dshHome, { recursive: true })
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    for (const damaged of ['{not json', JSON.stringify({ version: 2 })]) {
      await writeFile(recordFile, damaged)
      const link = await share.share({ sessionId: S1, title: 't' })
      expect(await recorded()).toEqual({ version: 1, shares: { [S1]: { tenantId: 't-a', shareId: link.shareId } } })
    }
    expect(info).toHaveBeenCalledWith('[session-share] unreadable share record file ignored', { path: recordFile })
  })

  it('logs a deleted Session whose record cannot be read', async () => {
    const { ctx, recordFile } = await boot()
    // A directory where the file belongs: the read fails with something other than a missing file.
    await mkdir(recordFile, { recursive: true })
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    ctx.emit('session/deleted', S1)
    await expect.poll(() => info.mock.calls.some(call => call[0] === '[session-share] share of a deleted Session not withdrawn')).toBe(true)
  })

  it('logs and keeps running when the share of a deleted Session cannot be withdrawn', async () => {
    const { ctx, share, center } = await boot()
    await share.share({ sessionId: S1, title: 't' })
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    center.shareReply = { status: 500, body: '{}' }
    ctx.emit('session/deleted', S1)
    await expect.poll(() => info.mock.calls.some(call => call[0] === '[session-share] share of a deleted Session not withdrawn')).toBe(true)
    center.shareReply = undefined
    expect(await share.status({ sessionId: S1 })).toMatchObject({ signedIn: true, link: { url: expect.stringContaining('/share/') as string } })
  })

  it('reports signed out, refuses to share or withdraw, and ignores deleted Sessions while signed out', async () => {
    const { ctx, share, shareRequests } = await boot({ signedIn: false })
    expect(await share.status({ sessionId: S1 })).toEqual({ signedIn: false, link: null })
    expect(remoteErrorOf(await share.share({ sessionId: S1, title: 't' }).catch((error: unknown) => error))).toMatchObject({ code: 'session-share/signed-out' })
    expect(remoteErrorOf(await share.revoke({ sessionId: S1 }).catch((error: unknown) => error))).toMatchObject({ code: 'session-share/signed-out' })
    ctx.emit('session/deleted', S1)
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect(shareRequests()).toEqual([])
  })

  it('reads a sign-in lost during the call as signed out', async () => {
    const { share, hub } = await boot()
    vi.spyOn(hub, 'accessToken').mockResolvedValue(undefined)
    expect(remoteErrorOf(await share.share({ sessionId: S1, title: 't' }).catch((error: unknown) => error))).toMatchObject({ code: 'session-share/signed-out' })
  })

  it("carries the user center's own reason for a refusal, joined when it lists several", async () => {
    const { share, center } = await boot()
    center.shareReply = { status: 413, body: JSON.stringify({ message: '对话内容超过 2MB，无法分享' }) }
    expect(remoteErrorOf(await share.share({ sessionId: S1, title: 't' }).catch((error: unknown) => error)))
      .toMatchObject({ code: 'session-share/refused', message: '对话内容超过 2MB，无法分享', details: { status: 413 } })
    center.shareReply = { status: 400, body: JSON.stringify({ message: ['标题不能为空', '标题过长'] }) }
    expect(remoteErrorOf(await share.share({ sessionId: S1, title: '' }).catch((error: unknown) => error)))
      .toMatchObject({ code: 'session-share/refused', message: '标题不能为空；标题过长', details: { status: 400 } })
  })

  it('names the status when a refusal carries no reason, for every method', async () => {
    const { share, center } = await boot()
    center.shareReply = { status: 500, body: 'oops' }
    expect(remoteErrorOf(await share.status({ sessionId: S1 }).catch((error: unknown) => error)))
      .toMatchObject({ code: 'session-share/refused', message: 'the user center answered 500', details: { status: 500 } })
    center.shareReply = { status: 403, body: JSON.stringify({ reason: 'no' }) }
    expect(remoteErrorOf(await share.revoke({ sessionId: S1 }).catch((error: unknown) => error)))
      .toMatchObject({ code: 'session-share/refused', message: 'the user center answered 403', details: { status: 403 } })
  })

  it('refuses an answer that is not a share link', async () => {
    const { share, center } = await boot()
    center.shareReply = { status: 200, body: JSON.stringify({ shareId: '' }) }
    expect(remoteErrorOf(await share.share({ sessionId: S1, title: 't' }).catch((error: unknown) => error)))
      .toMatchObject({ code: 'session-share/refused', message: 'the user center answered an unreadable share' })
    center.shareReply = { status: 200, body: JSON.stringify({ shareId: 's', url: 'u', createdAt: '1760000000', updatedAt: '1760000000' }) }
    expect(remoteErrorOf(await share.share({ sessionId: S1, title: 't' }).catch((error: unknown) => error)))
      .toMatchObject({ code: 'session-share/refused', message: 'the user center answered an unreadable share' })
    center.shareReply = { status: 200, body: 'not json' }
    expect(remoteErrorOf(await share.status({ sessionId: S1 }).catch((error: unknown) => error))).toMatchObject({ code: 'session-share/refused' })
  })

  it('reads a dropped connection and a missed deadline as unreachable', async () => {
    const { share, center } = await boot()
    center.shareReply = 'drop'
    expect(remoteErrorOf(await share.share({ sessionId: S1, title: 't' }).catch((error: unknown) => error))).toMatchObject({ code: 'session-share/unreachable' })
    const slow = await boot({ config: { requestTimeoutMs: 1 } })
    slow.center.clientStatus = undefined
    vi.spyOn(slow.hub, 'request').mockImplementation((_path, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(init.signal?.reason as Error) })
    }))
    expect(remoteErrorOf(await slow.share.status({ sessionId: S1 }).catch((error: unknown) => error))).toMatchObject({ code: 'session-share/unreachable' })
  })

  it('escapes the Session id in the path', async () => {
    const { share, logs, shareRequests } = await boot()
    const odd = SessionId('a/b c')
    logs[odd] = TALK
    await share.share({ sessionId: odd, title: 't' })
    expect(shareRequests()).toEqual(['/api/client/session-shares/a%2Fb%20c'])
  })
})
