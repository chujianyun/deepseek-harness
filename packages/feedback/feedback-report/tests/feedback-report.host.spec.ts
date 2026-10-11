/** The `feedbackReport` Remote over a mock user center and a real Hub sign-in, with Session reads stubbed. */
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { arch, platform, release, tmpdir } from 'node:os'
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
import FeedbackReport from '../src/index.ts'
import { browse, startMockUserCenter } from '../../../credentials/hub-account/tests/mock-user-center.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

let seq = 0
const event = (type: string, time: number, data: unknown) => ({ type, seq: SessionSeq(seq++), time, data }) as never as SessionEvent
const user = (time: number, text: string) =>
  event('user/message', time, createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } as never }))
const assistant = (time: number, text: string) => event('assistant/message', time, {
  turn: 1, step: 1, stream: [],
  message: { id: MessageId(`m${String(time)}`), role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'p', model: 'm' } },
})
const S1 = SessionId('s-1')
const TALK = [
  event('model/selection', 100, { provider: 'deepseek', model: 'v4-flash', reasoningEffort: 'high' }),
  event('assistant/selected', 200, { assistantId: 'a-shop' }),
  user(1_000, '发到三个店铺'),
  assistant(2_000, '拼多多登录过期'),
]
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString('base64')
const REPORT = { category: 'error' as const, description: '  发布一直转圈  ', sessionId: S1, attachSession: true, images: [], uiLanguage: 'zh-CN' }

interface BootOptions {
  signedIn?: boolean
  assistants?: boolean
  /** Mount without a client version. */
  unversioned?: boolean
  config?: { requestTimeoutMs?: number }
}

async function boot({ signedIn = true, assistants = true, unversioned = false, config = {} }: BootOptions = {}) {
  const center = await startMockUserCenter({ tenantId: 't-a', tenantName: '名流' })
  cleanups.push(() => center.close())
  const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-feedback-report-')))
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
  const titles: Record<string, string> = { [S1]: '多店铺新品草稿发布' }
  ctx.provide('sessionQuery', {
    readSession: async (id: SessionId) => ({ events: logs[id] ?? [] }),
    readTitle: async (id: SessionId) => titles[id] === undefined ? undefined : { title: titles[id] },
  } as never)
  if (assistants) ctx.provide('assistants', { getState: async () => ({ assistants: [{ id: 'a-shop', name: '电商管家' }] }) } as never)
  await ctx.plugin(FeedbackReport, { ...unversioned ? {} : { appVersion: '1.0.1' }, ...config })
  return { ctx, center, hub, report: ctx.get('feedbackReport')!, logs, titles }
}

describe('feedbackReport', () => {
  it('publishes the namespace and its method', async () => {
    const { report } = await boot()
    expect(report.typertRemote.namespace).toBe('feedbackReport')
    expect(remoteMethods(report).map(method => method.method)).toEqual(['submit'])
  })

  it('reports the problem with the environment, the Session snapshot, and the images', async () => {
    const { report, center } = await boot()
    const receipt = await report.submit({ ...REPORT, images: [{ name: '截图.png', contentType: 'image/png', data: PNG }] })
    expect(receipt.id).toBe('fb-1')
    expect(Date.parse(receipt.createdAt)).not.toBeNaN()
    expect(center.feedback).toEqual([{
      payload: {
        source: 'report', category: 'error', description: '发布一直转圈',
        environment: {
          appVersion: '1.0.1', os: `${platform()} ${release()}`, arch: arch(), locale: 'zh-CN',
          model: 'deepseek/v4-flash (high)', assistant: '电商管家', tenant: '名流',
        },
        session: {
          sessionId: S1, title: '多店铺新品草稿发布',
          messages: [
            { role: 'user', text: '发到三个店铺', at: new Date(1_000).toISOString() },
            { role: 'assistant', text: '拼多多登录过期', at: new Date(2_000).toISOString() },
          ],
        },
      },
      images: [{ name: '截图.png', type: 'image/png', size: 11 }],
    }])
  })

  it('leaves the conversation out when asked, and reads only what the log holds', async () => {
    const { report, center, logs, titles } = await boot({ assistants: false, unversioned: true })
    const { uiLanguage: _dropped, ...withoutLanguage } = REPORT
    await report.submit({ ...withoutLanguage, attachSession: false })
    expect(center.feedback[0]!.payload).toMatchObject({ session: null, environment: { model: 'deepseek/v4-flash (high)' } })
    expect(center.feedback[0]!.payload).not.toHaveProperty('environment.assistant')
    expect(center.feedback[0]!.payload).not.toHaveProperty('environment.appVersion')
    expect(center.feedback[0]!.payload).not.toHaveProperty('environment.locale')
    // A Session without conversation, model, or title attaches nothing.
    logs[S1] = [event('model/selection', 1, { provider: 'deepseek', model: 'v4' }), event('assistant/selected', 2, { assistantId: '' })]
    Reflect.deleteProperty(titles, S1)
    await report.submit(REPORT)
    expect(center.feedback[1]!.payload).toMatchObject({ session: null, environment: { model: 'deepseek/v4' } })
    // No Session at all.
    await report.submit({ ...REPORT, sessionId: null })
    expect(center.feedback[2]!.payload).not.toHaveProperty('environment.model')
  })

  it('names no tenant for a sign-in without one', async () => {
    const { report, center, hub } = await boot()
    const state = await hub.getState()
    vi.spyOn(hub, 'getState').mockResolvedValue({ ...state, profile: null })
    await report.submit(REPORT)
    expect(center.feedback[0]!.payload).not.toHaveProperty('environment.tenant')
  })

  it('names an assistant only when the tenant still has it', async () => {
    const { report, center, logs, titles } = await boot()
    logs[S1] = [event('assistant/selected', 1, { assistantId: 'a-gone' }), user(2, 'hi')]
    Reflect.deleteProperty(titles, S1)
    await report.submit(REPORT)
    expect(center.feedback[0]!.payload).not.toHaveProperty('environment.assistant')
    // An untitled Session is attached with an empty title.
    expect(center.feedback[0]!.payload).toMatchObject({ session: { title: '' } })
  })

  it('reports thumbs-down feedback the user explained, with the Session, and nothing else', async () => {
    const { ctx, center } = await boot()
    const item = (patch: object) => ({ messageId: 'm1', rating: 'negative', version: 'v', createdAt: 1, updatedAt: 1, ...patch }) as never
    ctx.emit('feedback/message-recorded', S1, item({ category: 'task-result', note: '少了一个店铺' }))
    await expect.poll(() => center.feedback.length).toBe(1)
    ctx.emit('feedback/message-recorded', S1, item({ category: 'other' }))
    await expect.poll(() => center.feedback.length).toBe(2)
    ctx.emit('feedback/message-recorded', S1, item({ note: 'x'.repeat(2_500) }))
    await expect.poll(() => center.feedback.length).toBe(3)
    // A plain rating, or any thumbs-up, is not a report.
    ctx.emit('feedback/message-recorded', S1, item({}))
    ctx.emit('feedback/message-recorded', S1, item({ rating: 'positive', note: '很好' }))
    await new Promise((resolve) => { setTimeout(resolve, 30) })
    expect(center.feedback.map(entry => entry.payload)).toMatchObject([
      { source: 'message', category: 'task-result', description: '少了一个店铺', session: { sessionId: S1 } },
      { source: 'message', category: 'other', description: '（未填写说明）' },
      { source: 'message', category: 'other', description: 'x'.repeat(2_000) },
    ])
  })

  it('logs thumbs-down feedback it could not report', async () => {
    const { ctx, center } = await boot()
    center.feedbackReply = { status: 500, body: '{}' }
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    ctx.emit('feedback/message-recorded', S1, { messageId: 'm1', rating: 'negative', note: '不对', version: 'v', createdAt: 1, updatedAt: 1 } as never)
    await expect.poll(() => info.mock.calls.some(call => call[0] === '[feedback-report] thumbs-down feedback not reported')).toBe(true)
  })

  it('refuses what breaks a limit before sending anything', async () => {
    const { report, center } = await boot()
    const refused = async (patch: object) => remoteErrorOf(await report.submit({ ...REPORT, ...patch }).catch((error: unknown) => error))
    expect(await refused({ description: '   ' })).toMatchObject({ code: 'feedback-report/invalid', details: { reason: 'description' } })
    expect(await refused({ description: 'x'.repeat(2_001) })).toMatchObject({ details: { reason: 'description' } })
    const image = { name: 'a.png', contentType: 'image/png', data: PNG }
    expect(await refused({ images: [image, image, image, image] })).toMatchObject({ details: { reason: 'images' } })
    expect(await refused({ images: [{ ...image, contentType: 'image/svg+xml' }] })).toMatchObject({ details: { reason: 'image-type' } })
    expect(await refused({ images: [{ ...image, data: '' }] })).toMatchObject({ details: { reason: 'image-size' } })
    expect(await refused({ images: [{ ...image, data: Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64') }] })).toMatchObject({ details: { reason: 'image-size' } })
    expect(center.feedback).toEqual([])
  })

  it('needs a sign-in, including one lost during the call', async () => {
    const signedOut = await boot({ signedIn: false })
    expect(remoteErrorOf(await signedOut.report.submit(REPORT).catch((error: unknown) => error))).toMatchObject({ code: 'feedback-report/signed-out' })
    const { report, hub } = await boot()
    vi.spyOn(hub, 'accessToken').mockResolvedValue(undefined)
    expect(remoteErrorOf(await report.submit(REPORT).catch((error: unknown) => error))).toMatchObject({ code: 'feedback-report/signed-out' })
  })

  it("carries the user center's reason for a refusal, joined, or names its status", async () => {
    const { report, center } = await boot()
    const refused = async () => remoteErrorOf(await report.submit(REPORT).catch((error: unknown) => error))
    center.feedbackReply = { status: 400, body: JSON.stringify({ message: '请描述遇到的问题' }) }
    expect(await refused()).toMatchObject({ code: 'feedback-report/refused', message: '请描述遇到的问题', details: { status: 400 } })
    center.feedbackReply = { status: 400, body: JSON.stringify({ message: ['a', 'b'] }) }
    expect(await refused()).toMatchObject({ message: 'a；b' })
    center.feedbackReply = { status: 500, body: 'oops' }
    expect(await refused()).toMatchObject({ message: 'the user center answered 500', details: { status: 500 } })
    center.feedbackReply = { status: 403, body: JSON.stringify({ reason: 'x' }) }
    expect(await refused()).toMatchObject({ message: 'the user center answered 403' })
    center.feedbackReply = { status: 201, body: JSON.stringify({ id: 'x', createdAt: 'yesterday' }) }
    expect(await refused()).toMatchObject({ message: 'the user center answered an unreadable receipt' })
    center.feedbackReply = { status: 201, body: 'not json' }
    expect(await refused()).toMatchObject({ code: 'feedback-report/refused' })
  })

  it('reads a dropped connection and a missed deadline as unreachable', async () => {
    const { report, center } = await boot()
    center.feedbackReply = 'drop'
    expect(remoteErrorOf(await report.submit(REPORT).catch((error: unknown) => error))).toMatchObject({ code: 'feedback-report/unreachable' })
    const slow = await boot({ config: { requestTimeoutMs: 1 } })
    vi.spyOn(slow.hub, 'request').mockImplementation((_path, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(init.signal?.reason as Error) })
    }))
    expect(remoteErrorOf(await slow.report.submit(REPORT).catch((error: unknown) => error))).toMatchObject({ code: 'feedback-report/unreachable' })
  })
})
