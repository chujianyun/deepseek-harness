/**
 * Session sync through the shipped composition against a mock user center: backfill, a new turn,
 * attachments, deletion, and offline catch-up.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { chromium } from 'playwright'
import { expect, it, onTestFailed } from 'vitest'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-hub-account'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionSyncBundle } from '@deepseek-ai/dsh-session-sync'
import { browse, startMockUserCenter, type MockUserCenter } from '../../../packages/credentials/hub-account/tests/mock-user-center.ts'
import { fixtureUserPrompts, launchWebScaffold, seedSession, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))
// Borrowed settled turn of the feedback-command scenario; this lane only reads it.
const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/feedback-command/session.v3.jsonl', import.meta.url))
const PROMPT = 'Reply with the single word LIGHTHOUSE and stop.'
const OVERLAYS = ['./hub-account.overlay.yml', './session-sync.overlay.yml'].map(path => fileURLToPath(new URL(path, import.meta.url)))

const held = (center: MockUserCenter, sessionId: string) => center.sync['t-a']?.sessions[sessionId]
const bundleOf = (center: MockUserCenter, sessionId: string) =>
  JSON.parse(gunzipSync(held(center, sessionId)!.bundle!).toString('utf8')) as SessionSyncBundle
const syncRequests = (center: MockUserCenter) => center.clientRequests.filter(path => path.startsWith('/api/client/sync/'))

/** Store a closed one-turn Session directly, as an earlier run of the app left it. */
async function storeSession(scaffold: WebScaffold, id: string, content: ContentBlock[]): Promise<SessionId> {
  const sessionId = SessionId(id)
  const writer = await scaffold.ctx.sessionPersistence.create({
    version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: Date.now() - 60_000, cwd: scaffold.workspaceCwd, isSeeded: false,
  })
  await writer.append([
    { type: 'turn/start', seq: SessionSeq(0), time: Date.now() - 50_000, data: { turn: 1 } },
    { type: 'user/message', seq: SessionSeq(1), time: Date.now() - 50_000, data: createUserMessage({ content, source: { kind: 'user' } }), surfaceOp: 'append' },
    { type: 'turn/end', seq: SessionSeq(2), time: Date.now() - 40_000, data: { turn: 1, reason: { kind: 'completed' } } },
  ] as SessionEvent[])
  await writer.close()
  return sessionId
}

it('uploads old and new conversations with their attachments once, deletes, and catches up after going offline', async () => {
  expect(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))).toEqual([PROMPT])
  const center = await startMockUserCenter()
  process.env.DSH_E2E_HUB_ORIGIN = center.origin
  const scaffold = await launchWebScaffold({
    extraOverlayPath: OVERLAYS,
    replayProviders: [{ id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', contextWindow: 128_000 }] }],
    compareReplaySession: false,
    replayFixture: FIXTURE,
    paceMs: 5,
  })
  const browser = await chromium.launch()
  try {
    const { ctx } = scaffold
    // Conversations from before this version, and two sharing one attachment.
    const seeded = await seedSession(scaffold, await readFile(SEED, 'utf8'), 'session-sync-seeded')
    const file = await ctx.attachments.saveFile({ data: new TextEncoder().encode('订单号,金额\n1,99\n'), name: '订单.csv' })
    const digest = file.attachmentId.slice('sha256:'.length)
    const first = await storeSession(scaffold, 'session-sync-file-1', [{ type: 'text', text: '看看这个表' }, { type: 'file', attachment: file }])
    const second = await storeSession(scaffold, 'session-sync-file-2', [{ type: 'file', attachment: file }, { type: 'text', text: '再看一次' }])
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(syncRequests(center)).toEqual([])

    // Signing in uploads them.
    await ctx.hubAccount.signIn()
    await expect.poll(async () => (await ctx.hubAccount.getState()).attempt?.authorizeUrl).toBeDefined()
    await browse((await ctx.hubAccount.getState()).attempt!.authorizeUrl!)
    await expect.poll(() => [seeded, first, second].map(id => held(center, id)?.meta.revision), { timeout: 20_000 }).toEqual([1, 1, 1])
    expect(held(center, first)!.meta).toMatchObject({ device: '前台电脑', cwd: scaffold.workspaceCwd, attachments: [digest] })
    expect(held(center, second)!.meta.attachments).toEqual([digest])
    expect(syncRequests(center).filter(path => path === `/api/client/sync/blobs/${digest}`)).toHaveLength(1)
    expect(center.sync['t-a']!.blobs[digest]!.toString('utf8')).toBe('订单号,金额\n1,99\n')
    const seededBundle = bundleOf(center, seeded)
    expect(seededBundle.sessions[0].header.id).toBe(seeded)
    expect(seededBundle.sessions[0].events.length).toBeGreaterThan(3)

    // A new conversation uploads once its turn ends.
    const page = await newEnglishPage(browser)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-session-sync'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const input = page.locator('[data-composer-input]').first()
    const settled = scaffold.whenTurnSettled()
    await input.fill(PROMPT)
    await input.press('Enter')
    const live = await settled
    await expect.poll(() => held(center, live)?.meta.revision, { timeout: 20_000 }).toBe(1)
    const liveEvents = bundleOf(center, live).sessions[0].events
    expect(JSON.stringify(liveEvents.filter(event => event.type === 'user/message'))).toContain(PROMPT)
    expect(liveEvents.some(event => event.type === 'assistant/message')).toBe(true)

    // Deleting deletes it on the user center.
    expect(await ctx.sessionController.delete({ sessionId: first })).toEqual({ deletedSessionIds: [first] })
    await expect.poll(() => held(center, first)?.deleted).toBe(true)

    // Offline: the deletion waits, and so does the upload of a conversation found by the next scan.
    center.syncReply = 'drop'
    expect(await ctx.sessionController.delete({ sessionId: second })).toEqual({ deletedSessionIds: [second] })
    const later = await storeSession(scaffold, 'session-sync-offline', [{ type: 'text', text: '断网时的对话' }])
    await new Promise(resolve => setTimeout(resolve, 1_500))
    expect(held(center, second)?.deleted).toBe(false)
    expect(held(center, later)).toBeUndefined()
    center.syncReply = undefined
    await expect.poll(() => [held(center, second)?.deleted, held(center, later)?.meta.revision], { timeout: 20_000 }).toEqual([true, 1])
  } finally {
    await browser.close()
    await scaffold.close()
    await center.close()
    Reflect.deleteProperty(process.env, 'DSH_E2E_HUB_ORIGIN')
  }
}, 120_000)
