/** The MO brand's sidebar settings (default grouping, rows per group) through the shipped Web composition. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, seedSession, watchConsole } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))
const OVERLAY = fileURLToPath(new URL('./session-group-limit.overlay.yml', import.meta.url))

it('starts grouped by the configured default and lists the configured number of Sessions per group', async () => {
  const scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY })
  const browser = await chromium.launch()
  try {
    const fixture = await readFile(SEED, 'utf8')
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const noon = new Date()
    noon.setHours(12, 0, 0, 0)
    // Five Sessions earlier today, newest first by title.
    for (let index = 0; index < 5; index += 1) {
      const id = await seedSession(scaffold, fixture, `session-group-limit-${String(index)}`, undefined, { createdAt: noon.getTime() - (index + 1) * 600_000 })
      await workspace.attachSession(id)
      await scaffold.ctx.sessionController.rename({ sessionId: id, title: `Conversation ${String(index + 1)}` })
    }
    const page = await newEnglishPage(browser)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-session-group-limit'))
    await page.clock.setFixedTime(noon)
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    const tree = page.getByRole('tree', { name: 'Sessions' })
    const titles = () => tree.locator('[role="treeitem"]:not([aria-expanded]) [class*="title"]').allTextContents()

    // No menu click: the configured default grouping applies, with three idle rows beside the blank New Session.
    await tree.getByRole('treeitem', { name: 'Today' }).waitFor({ timeout: 15_000 })
    await expect.poll(titles).toEqual(['New Session', 'Conversation 1', 'Conversation 2', 'Conversation 3'])
    await tree.getByRole('button', { name: 'Show 2 more sessions' }).click()
    await expect.poll(titles).toEqual(['New Session', ...[1, 2, 3, 4, 5].map(n => `Conversation ${String(n)}`)])
    await tree.getByRole('button', { name: 'Show less' }).click()
    await expect.poll(titles).toHaveLength(4)
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser.close()
    await scaffold.close()
  }
}, 90_000)
