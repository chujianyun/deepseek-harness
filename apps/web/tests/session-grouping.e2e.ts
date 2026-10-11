/** Registered Session groupings (the built-in Date grouping) through the shipped Web composition. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { acknowledgeReloadConnectionLoss, launchWebScaffold, seedSession, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))
const HOUR = 3_600_000
const DAY = 24 * HOUR
/** Seeded Sessions by how long before today's noon they were last active. */
const SESSIONS = [
  ['Today conversation', HOUR],
  ['Yesterday conversation', DAY],
  ['Three days conversation', 3 * DAY],
  ['Old conversation', 10 * DAY],
  // Six more old ones, so Earlier holds more than a group shows.
  ...Array.from({ length: 6 }, (_unused, index) => [`Older conversation ${String(index + 2)}`, (11 + index) * DAY] as const),
] as const
/** The five Earlier rows a group shows before its overflow control, newest first. */
const EARLIER_SHOWN = ['Old conversation', ...[2, 3, 4, 5].map(n => `Older conversation ${String(n)}`)]
const EARLIER_ALL = [...EARLIER_SHOWN, 'Older conversation 6', 'Older conversation 7']

describe('web e2e: session grouping', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const noon = new Date()
  noon.setHours(12, 0, 0, 0)
  const threeDaysLabel = new Date(noon.getTime() - 3 * DAY).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    const fixture = await readFile(SEED, 'utf8')
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    for (const [index, [title, age]] of SESSIONS.entries()) {
      const id = await seedSession(scaffold, fixture, `session-grouping-${index}`, undefined, { createdAt: noon.getTime() - age })
      await workspace.attachSession(id)
      await scaffold.ctx.sessionController.rename({ sessionId: id, title })
    }
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await page.clock.setFixedTime(noon)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  })

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  /** Each section's heading with its Session titles, top to bottom. */
  const sections = () => page.locator('[role="tree"][aria-label="Sessions"] [class*="groupSection"]').evaluateAll(nodes => nodes.map(node => [
    node.querySelector('[role="treeitem"][aria-expanded]')?.textContent ?? '',
    [...node.querySelectorAll('[role="treeitem"]:not([aria-expanded]) [class*="title"]')].map(title => title.textContent),
  ]))
  const pick = async (parent: RegExp, name: string): Promise<void> => {
    await page.getByRole('button', { name: 'View options' }).click()
    await page.getByRole('menuitem', { name: parent }).hover()
    await page.getByRole('menuitem', { name, exact: true }).click()
  }

  it('sections Sessions by day under Date, shows five per section with the rest behind show more, keeps a folded section across reload, and switches back', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-session-grouping'))
    await page.getByRole('button', { name: 'View options' }).click()
    await page.getByRole('menuitem', { name: /^Group by/u }).hover()
    expect(await page.getByRole('menu').last().getByRole('menuitem').allTextContents())
      .toEqual(['WorkSpace', 'Workspace Tree', 'Date', 'No grouping'])
    await page.getByRole('menuitem', { name: 'Date', exact: true }).click()
    // The current blank New Session leads the section of its own activity.
    await expect.poll(sections, { timeout: 10_000 }).toEqual([
      ['Today', ['New Session', 'Today conversation']],
      ['Yesterday', ['Yesterday conversation']],
      [threeDaysLabel, ['Three days conversation']],
      ['Earlier', EARLIER_SHOWN],
    ])
    expect(await page.getByText('Sessions', { exact: true }).count()).toBeGreaterThanOrEqual(1)
    // Rows follow activity under a registered grouping, so Order by is not offered.
    await page.getByRole('button', { name: 'View options' }).click()
    expect(await page.getByRole('menuitem').allTextContents()).toEqual(['StatusActive', 'Group byDate'])
    await page.keyboard.press('Escape')

    // A group lists its five most recent Sessions; the rest sit behind "show more", and the expansion survives a reload.
    const tree = page.getByRole('tree', { name: 'Sessions' })
    await tree.getByRole('button', { name: 'Show 2 more sessions' }).click()
    await expect.poll(async () => (await sections()).at(-1)).toEqual(['Earlier', EARLIER_ALL])
    const expandedStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    acknowledgeReloadConnectionLoss(tripwire, expandedStart)
    await expect.poll(async () => (await sections()).at(-1), { timeout: 15_000 }).toEqual(['Earlier', EARLIER_ALL])
    await tree.getByRole('button', { name: 'Show less' }).click()
    await expect.poll(async () => (await sections()).at(-1)).toEqual(['Earlier', EARLIER_SHOWN])

    await page.getByRole('treeitem', { name: 'Earlier' }).click()
    await expect.poll(sections).toEqual([
      ['Today', ['New Session', 'Today conversation']],
      ['Yesterday', ['Yesterday conversation']],
      [threeDaysLabel, ['Three days conversation']],
      ['Earlier', []],
    ])
    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await expect.poll(sections, { timeout: 15_000 }).toEqual([
      ['Today', ['New Session', 'Today conversation']],
      ['Yesterday', ['Yesterday conversation']],
      [threeDaysLabel, ['Three days conversation']],
      ['Earlier', []],
    ])

    await pick(/^Group by/u, 'No grouping')
    await expect.poll(() => page.locator('[role="treeitem"][aria-expanded]').count()).toBe(0)
    await pick(/^Group by/u, 'WorkSpace')
    await expect.poll(() => page.getByText('Workspaces', { exact: true }).count()).toBe(1)
    expect(tripwire.pageErrors).toEqual([])
  }, 120_000)
})
