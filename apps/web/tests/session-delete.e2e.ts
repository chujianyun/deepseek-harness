/** Permanent Session deletion through the shipped Web composition: storage, registry, list, and search. */
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium, type Locator } from 'playwright'
import { expect, it, onTestFailed } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { acknowledgeReloadConnectionLoss, launchWebScaffold, seedSession, watchConsole } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))

/** Every path under `root` whose final segment names the Session. */
async function pathsNaming(root: string, sessionId: SessionId): Promise<string[]> {
  const entries = await readdir(root, { recursive: true })
  return entries.filter(entry => entry.split(/[\\/]/u).some(segment => segment.includes(sessionId)))
}

it('deletes a loaded Session from storage, the Workspace registry, the list, and search, and leaves the others', async () => {
  const scaffold = await launchWebScaffold({})
  try {
    const { ctx } = scaffold
    const fixture = await readFile(SEED, 'utf8')
    const workspace = await ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const gone = await seedSession(scaffold, fixture, 'session-delete-gone')
    const kept = await seedSession(scaffold, fixture, 'session-delete-kept')
    for (const id of [gone, kept]) await workspace.attachSession(id)
    await ctx.workspaceRegistry.pinSession(gone)
    await ctx.schedule.create(gone, { prompt: 'check later', after_seconds: 3_600, title: 'Check later' })
    const spilled = await ctx.spillStore.saveText({
      owner: { sessionId: gone }, source: { kind: 'tool', toolName: 'shell', callId: ToolCallId('call-1'), label: 'result' },
      suggestedName: 'shell.txt', content: 'a long tool result',
    })
    expect(existsSync(spilled.locator)).toBe(true)
    // Load the Session, as an open conversation would: its Agent holds the log's writer.
    const resolved = await ctx.sessionController.resolveAgent(gone)
    expect('agent' in resolved).toBe(true)
    expect((await pathsNaming(scaffold.persistenceRoot, gone)).length).toBeGreaterThan(0)
    const listed = async () => (await ctx.sessionController.list({}, new AbortController().signal)).items.map(item => item.sessionId)
    expect(await listed()).toEqual(expect.arrayContaining([gone, kept]))

    expect(await ctx.sessionController.delete({ sessionId: gone })).toEqual({ deletedSessionIds: [gone] })

    // Nothing on disk names the Session any more: its log directory and its projection checkpoint are gone.
    expect(await pathsNaming(scaffold.persistenceRoot, gone)).toEqual([])
    await expect.poll(() => pathsNaming(scaffold.harnessHome, gone)).toEqual([])
    expect(await ctx.sessionPersistence.stat(gone)).toBeUndefined()
    expect(ctx.sessions.get(gone)).toBeUndefined()
    expect(ctx.agents.get(gone)).toBeUndefined()
    const afterwards = await listed()
    expect(afterwards).toContain(kept)
    expect(afterwards).not.toContain(gone)
    // The owners of data keyed by the Session clean up on its deletion.
    await expect.poll(() => workspace.sessionIds).toEqual([kept])
    await expect.poll(() => ctx.workspaceRegistry.pinnedSessionIds).toEqual([])
    expect(ctx.workspaceRegistry.archivedSessionIds).toEqual([])
    await expect.poll(async () => (await ctx.schedule.catalog()).map(entry => entry.sessionId)).toEqual([])
    await expect.poll(() => existsSync(spilled.locator)).toBe(false)
    // The other Session is untouched and still opens.
    expect((await pathsNaming(scaffold.persistenceRoot, kept)).length).toBeGreaterThan(0)
    expect('agent' in await ctx.sessionController.resolveAgent(kept)).toBe(true)
    // A second delete finds nothing.
    await expect(ctx.sessionController.delete({ sessionId: gone })).rejects.toMatchObject({ code: 'session/not-found' })

    // A fork is loaded the moment it is created: it deletes at once, and its source stays.
    const fork = await ctx.sessionController.fork({ sessionId: kept })
    expect(await ctx.sessionController.delete({ sessionId: fork.sessionId })).toEqual({ deletedSessionIds: [fork.sessionId] })
    expect(await pathsNaming(scaffold.persistenceRoot, fork.sessionId)).toEqual([])
    expect((await listed())).toContain(kept)
    // A new Session deleted before its first prompt never reached storage, and is gone all the same.
    const blank = await ctx.sessionController.create({ workspaceId: workspace.id })
    expect(await ctx.sessionController.delete({ sessionId: blank.sessionId })).toEqual({ deletedSessionIds: [blank.sessionId] })
    expect(ctx.sessions.get(blank.sessionId)).toBeUndefined()
    await expect.poll(() => workspace.sessionIds).toEqual([kept])
  } finally {
    await scaffold.close()
  }
}, 90_000)

it('deletes the open Session from its row menu after confirmation: the row leaves, a notice shows, and it stays gone after reload', async () => {
  const scaffold = await launchWebScaffold({})
  const browser = await chromium.launch()
  try {
    const { ctx } = scaffold
    const fixture = await readFile(SEED, 'utf8')
    const workspace = await ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    for (const [id, title] of [['session-delete-ui-gone', 'Delete me'], ['session-delete-ui-kept', 'Keep me']] as const) {
      const sessionId = await seedSession(scaffold, fixture, id)
      await workspace.attachSession(sessionId)
      await ctx.sessionController.rename({ sessionId, title })
    }
    const page = await newEnglishPage(browser)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-session-delete'))
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    const row = (title: string) => page.getByRole('treeitem').filter({ has: page.getByText(title, { exact: true }) })
    /** The row's hover actions appear on hover; open one by its accessible name. */
    const clickHoverAction = async (target: Locator, name: string): Promise<void> => {
      await target.hover()
      await target.getByRole('button', { name, exact: true }).click()
    }
    // Open it first: the Session being deleted is the one on screen, loaded on the Host.
    await row('Delete me').click()
    await expect.poll(() => row('Delete me').getAttribute('aria-selected'), { timeout: 10_000 }).toBe('true')

    await clickHoverAction(row('Delete me'), 'Session actions for Delete me')
    // Delete is the last row of the menu.
    expect((await page.getByRole('menuitem').allTextContents()).at(-1)).toBe('Delete')
    await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Delete this session?' })
    await expect.poll(() => dialog.textContent()).toContain('“Delete me” will be deleted permanently and cannot be restored')
    // Cancelling keeps it.
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect.poll(() => dialog.count()).toBe(0)
    expect(await row('Delete me').count()).toBe(1)

    await clickHoverAction(row('Delete me'), 'Session actions for Delete me')
    await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect.poll(() => row('Delete me').count(), { timeout: 15_000 }).toBe(0)
    await page.getByText('Session deleted', { exact: true }).waitFor({ timeout: 10_000 })
    expect(await row('Keep me').count()).toBe(1)
    expect((await ctx.sessionPersistence.list()).map(snapshot => String(snapshot.header.id))).not.toContain('session-delete-ui-gone')

    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await expect.poll(() => row('Keep me').count(), { timeout: 15_000 }).toBe(1)
    expect(await row('Delete me').count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser.close()
    await scaffold.close()
  }
}, 120_000)
