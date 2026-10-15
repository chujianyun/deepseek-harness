/**
 * Session sync through the shipped composition against a mock user center: backfill, a new turn,
 * attachments, deletion, and offline catch-up.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { gunzipSync, gzipSync } from 'node:zlib'
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
import { connectFreshWorkspace, newEnglishPage, saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))
// Borrowed settled turn of the feedback-command scenario; this lane only reads it.
const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/feedback-command/session.v3.jsonl', import.meta.url))
const PROMPT = 'Reply with the single word LIGHTHOUSE and stop.'
const SHOTS = process.env.DSH_E2E_SHOT_DIR
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

/** A conversation as another computer uploaded it: a stored log under a new id, gzip-compressed. */
async function otherComputerBundle(scaffold: WebScaffold, sourceId: SessionId, id: string): Promise<Buffer> {
  const { session, inheritedEventCount, events } = await scaffold.ctx.sessionQuery.readSession(sourceId)
  return gzipSync(JSON.stringify({ format: 1, sessions: [{ header: { ...session, id }, inheritedEventCount, events }] }))
}

/** Put a conversation on the mock user center as if another computer had uploaded it. */
function uploadedElsewhere(center: MockUserCenter, id: string, bundle: Buffer, revision = 1): void {
  const store = center.sync['t-a'] ??= { sessions: {}, blobs: {} }
  store.seq = (store.seq ?? 0) + 1
  store.sessions = { ...store.sessions, [id]: { meta: { revision, device: '前台电脑', attachments: [] }, bundle, deleted: false, seq: store.seq } }
}

it('shows another computer\'s conversation marked and view-only, and deletes it both ways', async () => {
  const center = await startMockUserCenter()
  process.env.DSH_E2E_HUB_ORIGIN = center.origin
  const scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAYS })
  const browser = await chromium.launch()
  try {
    const { ctx } = scaffold
    const workspace = await ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    // A conversation recorded here, turned into another computer's upload, then removed here.
    const source = await seedSession(scaffold, await readFile(SEED, 'utf8'), 'session-sync-source')
    const bundle = await otherComputerBundle(scaffold, source, 'from-pc')
    const second = await otherComputerBundle(scaffold, source, 'from-pc-2')
    await ctx.sessionPersistence.delete(source)
    uploadedElsewhere(center, 'from-pc', bundle)
    uploadedElsewhere(center, 'from-pc-2', second)
    await ctx.hubAccount.signIn()
    await expect.poll(async () => (await ctx.hubAccount.getState()).attempt?.authorizeUrl).toBeDefined()
    await browse((await ctx.hubAccount.getState()).attempt!.authorizeUrl!)
    await expect.poll(async () => (await ctx.sessionSync.getState()).pulled.map(item => item.sessionId).sort(), { timeout: 20_000 })
      .toEqual(['from-pc', 'from-pc-2'])
    for (const id of ['from-pc', 'from-pc-2']) await workspace.attachSession(SessionId(id))
    // Never uploaded back, and refused as a prompt target or a rename.
    expect(Object.keys(center.sync['t-a']!.sessions).sort()).toEqual(['from-pc', 'from-pc-2'])
    await expect(ctx.sessionController.rename({ sessionId: SessionId('from-pc'), title: '改名' })).rejects.toMatchObject({ code: 'session/view-only' })

    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: ZH_BROWSER_LOCALE })
    onTestFailed(() => saveFailureShot(page, 'web-e2e-session-sync-pull'))
    await page.addInitScript(() => { Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 } }) })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    const mark = page.getByRole('img', { name: '来自其他电脑：前台电脑' })
    await expect.poll(() => mark.count(), { timeout: 15_000 }).toBe(2)
    // Their titles come from the pulled logs, without opening them.
    expect(await page.getByRole('treeitem').filter({ has: mark }).allTextContents()).toEqual([
      expect.stringContaining('Use the read tool twice'), expect.stringContaining('Use the read tool twice'),
    ])
    if (SHOTS !== undefined) await page.screenshot({ path: `${SHOTS}/e2e-pulled-rows.png` })

    // Opening it shows the history with the view-only notice in place of the composer, and starts no Agent.
    const row = page.getByRole('treeitem').filter({ has: mark }).first()
    await row.click()
    const notice = page.locator('[data-session-sync-readonly]')
    await notice.waitFor({ timeout: 15_000 })
    expect(await notice.textContent()).toBe('来自「前台电脑」的对话在这台电脑上只能查看，不能继续对话。接着聊')
    expect(await page.locator('[data-composer-input]:visible').count()).toBe(0)
    expect(ctx.agents.get(SessionId('from-pc'))).toBeUndefined()
    expect(ctx.agents.get(SessionId('from-pc-2'))).toBeUndefined()
    if (SHOTS !== undefined) await page.screenshot({ path: `${SHOTS}/e2e-pulled-open.png` })

    if (SHOTS !== undefined) {
      // The row mark, its hover line, and the view-only composer in both languages and themes.
      for (const [lang, locale] of [['zh', ZH_BROWSER_LOCALE], ['en', 'en-US']] as const) {
        for (const theme of ['light', 'dark'] as const) {
          const shot = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale, colorScheme: theme })
          await shot.addInitScript(() => { Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 } }) })
          await shot.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
          const marked = shot.locator('[data-session-sync-badge]')
          await expect.poll(() => marked.count(), { timeout: 15_000 }).toBe(2)
          const first = shot.getByRole('treeitem').filter({ has: marked }).first()
          await first.click()
          await shot.locator('[data-session-sync-readonly]').waitFor({ timeout: 15_000 })
          await first.hover()
          await shot.waitForTimeout(1_200)
          await shot.screenshot({ path: `${SHOTS}/${lang}-${theme}-pulled.png` })
          await shot.close()
        }
      }
    }

    // Deleting a pulled conversation here deletes it on the user center (and so on its computer).
    await expect(ctx.sessionController.delete({ sessionId: SessionId('from-pc-2') })).resolves.toEqual({ deletedSessionIds: ['from-pc-2'] })
    await expect.poll(() => center.sync['t-a']!.sessions['from-pc-2']?.deleted, { timeout: 15_000 }).toBe(true)
    // Deleted on its computer: the copy here goes on the next pull, and its row with it.
    const store = center.sync['t-a']!
    store.seq = (store.seq ?? 0) + 1
    store.sessions = { ...store.sessions, 'from-pc': { meta: { revision: 1 }, bundle: null, deleted: true, seq: store.seq } }
    await page.evaluate(() => { window.dispatchEvent(new Event('focus')) })
    await expect.poll(async () => ctx.sessionPersistence.stat(SessionId('from-pc')), { timeout: 15_000 }).toBeUndefined()
    await expect.poll(() => mark.count(), { timeout: 15_000 }).toBe(0)
    expect((await ctx.sessionSync.getState()).pulled).toEqual([])
  } finally {
    await browser.close()
    await scaffold.close()
    await center.close()
    Reflect.deleteProperty(process.env, 'DSH_E2E_HUB_ORIGIN')
  }
}, 120_000)

it('continues another computer\'s conversation here in a chosen folder, with its whole history', async () => {
  const center = await startMockUserCenter()
  process.env.DSH_E2E_HUB_ORIGIN = center.origin
  const scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAYS })
  const browser = await chromium.launch()
  try {
    const { ctx } = scaffold
    const workspace = await ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const fixture = await readFile(SEED, 'utf8')
    const [firstPrompt] = fixtureUserPrompts(fixture)
    const source = await seedSession(scaffold, fixture, 'session-sync-continue-source')
    uploadedElsewhere(center, 'from-pc', await otherComputerBundle(scaffold, source, 'from-pc'))
    // The same conversation, recorded in a folder that does not exist on this computer.
    const { session, inheritedEventCount, events } = await ctx.sessionQuery.readSession(source)
    const away = gzipSync(JSON.stringify({ format: 1, sessions: [{ header: { ...session, id: 'from-pc-away', cwd: '/not/on/this/computer' }, inheritedEventCount, events }] }))
    uploadedElsewhere(center, 'from-pc-away', away)
    await ctx.sessionPersistence.delete(source)
    await ctx.hubAccount.signIn()
    await expect.poll(async () => (await ctx.hubAccount.getState()).attempt?.authorizeUrl).toBeDefined()
    await browse((await ctx.hubAccount.getState()).attempt!.authorizeUrl!)
    await expect.poll(async () => (await ctx.sessionSync.getState()).pulled.length, { timeout: 20_000 }).toBe(2)
    await workspace.attachSession(SessionId('from-pc'))
    const before = (await ctx.sessionQuery.readSession(SessionId('from-pc'))).events.length

    const continueIn = async (locale: string, theme: 'light' | 'dark') => {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale, colorScheme: theme })
      // Desktop exposes its folder chooser; here it answers with this test's workspace.
      await page.addInitScript((picked: string) => {
        Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 } })
        Object.defineProperty(globalThis, '__DSH_DIRECTORY_PICKER__', { value: { pick: () => Promise.resolve(picked) } })
      }, scaffold.workspaceCwd)
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      return page
    }

    // The original folder exists here: it is offered, and continuing opens the new conversation.
    const page = await continueIn(ZH_BROWSER_LOCALE, 'light')
    onTestFailed(() => saveFailureShot(page, 'web-e2e-session-sync-continue'))
    const pulledRow = page.getByRole('treeitem').filter({ has: page.locator('[data-session-sync-badge]') }).first()
    await pulledRow.waitFor({ timeout: 15_000 })
    await pulledRow.click()
    await page.locator('[data-session-sync-readonly]').waitFor({ timeout: 15_000 })
    const opened = await page.locator('[data-session-sync-readonly]').textContent()
    expect(opened).toContain('接着聊')
    await page.getByRole('button', { name: '接着聊' }).click()
    const dialog = page.getByRole('dialog', { name: '接着聊' })
    await expect.poll(() => dialog.locator('[data-session-sync-folder]').textContent(), { timeout: 15_000 }).not.toBe('还没有选择')
    expect(await dialog.getByRole('note').count()).toBe(0)
    await dialog.getByRole('button', { name: '接着聊' }).click()
    await expect.poll(async () => (await ctx.sessionSync.getState()).continuations.length, { timeout: 15_000 }).toBe(1)
    const continued = (await ctx.sessionSync.getState()).continuations[0]!
    expect(continued).toMatchObject({ sourceId: 'from-pc', device: '前台电脑' })
    // The new conversation is this computer's: its composer is back, and it says what it continues.
    await page.locator('[data-composer-input]:visible').first().waitFor({ timeout: 15_000 })
    await page.locator('[data-session-sync-continued]').waitFor({ timeout: 15_000 })
    // What the model sees next turn starts with the whole earlier conversation.
    const header = (await ctx.sessionPersistence.stat(continued.sessionId))?.header
    expect(header).toMatchObject({ parentSession: 'from-pc', isSeeded: true })
    const live = ctx.sessions.get(continued.sessionId)
    const derived = JSON.stringify(live?.deriveMessages() ?? (await ctx.sessionQuery.readSession(continued.sessionId)).events)
    expect(derived).toContain(firstPrompt!)
    // The pulled conversation stays as it was, and the continuation uploads like any conversation here.
    expect((await ctx.sessionQuery.readSession(SessionId('from-pc'))).events.length).toBe(before)
    await ctx.sessionSync.refresh()
    await expect.poll(() => held(center, continued.sessionId)?.meta.revision, { timeout: 15_000 }).toBe(1)
    await page.close()

    // The original folder is not here: the dialog is told so (its warning and chooser are covered by the
    // client tests and the Desktop smoke, whose sidebar lists conversations outside any Workspace).
    expect(await ctx.sessionSync.continueInfo({ sessionId: SessionId('from-pc-away') })).toEqual({ folder: '/not/on/this/computer', folderHere: false })

    if (SHOTS !== undefined) {
      // The dialog in both languages and themes.
      for (const [lang, locale] of [['zh', ZH_BROWSER_LOCALE], ['en', 'en-US']] as const) {
        for (const theme of ['light', 'dark'] as const) {
          const shot = await continueIn(locale, theme)
          const row = shot.getByRole('treeitem').filter({ has: shot.locator('[data-session-sync-badge]') }).first()
          await row.waitFor({ timeout: 15_000 })
          await row.click()
          await shot.locator('[data-session-sync-readonly] button').click()
          const dialog = shot.getByRole('dialog')
          await expect.poll(() => dialog.locator('[data-session-sync-folder]').textContent(), { timeout: 15_000 }).toBe(scaffold.workspaceCwd)
          await shot.waitForTimeout(400)
          await shot.screenshot({ path: `${SHOTS}/${lang}-${theme}-continue.png` })
          await shot.close()
        }
      }
    }
  } finally {
    await browser.close()
    await scaffold.close()
    await center.close()
    Reflect.deleteProperty(process.env, 'DSH_E2E_HUB_ORIGIN')
  }
}, 180_000)
