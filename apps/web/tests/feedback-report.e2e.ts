/**
 * Problem reports through the enterprise composition against a mock user center: the header button
 * (the only header entry, with no More actions menu) and an explained thumbs-down.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'
import { expect, it, onTestFailed } from 'vitest'
import type {} from '@deepseek-ai/dsh-hub-account'
import { browse, startMockUserCenter } from '../../../packages/credentials/hub-account/tests/mock-user-center.ts'
import { launchWebScaffold, seedSession, watchConsole } from './scaffold.ts'
import { newEnglishPage, saveFailureShot, scrollIntoView } from './support.ts'

const SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))
const OVERLAYS = ['./hub-account.overlay.yml', './feedback-report.overlay.yml'].map(path => fileURLToPath(new URL(path, import.meta.url)))
const SHOTS = process.env.DSH_E2E_SHOT_DIR
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

const shot = async (page: Page, name: string) => {
  if (SHOTS === undefined) return
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${SHOTS}/${name}.png` })
}

it('reports a problem from the header, with no More actions menu, and an explained thumbs-down, to the user center', async () => {
  const center = await startMockUserCenter({ tenantId: 't-a', tenantName: '名流' })
  process.env.DSH_E2E_HUB_ORIGIN = center.origin
  const scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAYS })
  const browser = await chromium.launch()
  try {
    const { ctx } = scaffold
    await ctx.hubAccount.signIn()
    await expect.poll(async () => (await ctx.hubAccount.getState()).attempt?.authorizeUrl).toBeDefined()
    await browse((await ctx.hubAccount.getState()).attempt!.authorizeUrl!)
    await expect.poll(async () => (await ctx.hubAccount.getState()).status).toBe('signed-in')
    const workspace = await ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SEED, 'utf8'), 'feedback-report-e2e')
    await workspace.attachSession(sessionId)
    await ctx.sessionController.rename({ sessionId, title: 'Multi-shop draft' })

    const page = await newEnglishPage(browser)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-feedback-report'))
    await page.addInitScript(() => { Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 } }) })
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await page.getByRole('treeitem').filter({ has: page.getByText('Multi-shop draft', { exact: true }) }).click()
    await page.getByText('DONE', { exact: true }).waitFor({ timeout: 30_000 })

    // The header button opens the dialog about the open Session.
    await page.getByRole('button', { name: 'Report a problem', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Report a problem' })
    await dialog.waitFor()
    const submit = dialog.getByRole('button', { name: 'Submit', exact: true })
    expect(await submit.isDisabled()).toBe(true)
    await dialog.getByRole('radio', { name: 'Slow' }).click()
    await dialog.getByRole('textbox', { name: 'Description' }).fill('Publishing spins forever, then fails')
    await dialog.getByLabel('Add screenshot', { exact: true }).setInputFiles({ name: 'spinner.png', mimeType: 'image/png', buffer: PNG })
    await dialog.getByRole('img', { name: 'spinner.png' }).waitFor()
    // Attaching the conversation is the user's explicit choice: unticked until they tick it.
    expect(await dialog.getByRole('checkbox').isChecked()).toBe(false)
    await dialog.getByRole('checkbox').check()
    await shot(page, 'e2e-report-dialog')
    await submit.click()
    await page.getByRole('alert').filter({ hasText: 'Sent. Thanks for the report' }).waitFor({ timeout: 15_000 })
    await expect.poll(() => dialog.count()).toBe(0)
    expect(center.feedback).toHaveLength(1)
    expect(center.feedback[0]).toMatchObject({
      payload: {
        source: 'report', category: 'lag', description: 'Publishing spins forever, then fails',
        environment: { appVersion: '9.9.9-e2e', tenant: '名流', locale: 'en' },
        session: { sessionId, title: 'Multi-shop draft', messages: expect.arrayContaining([expect.objectContaining({ role: 'user' })]) as never },
      },
      images: [{ name: 'spinner.png', type: 'image/png', size: PNG.length }],
    })

    // The enterprise header has no More actions menu: Report a problem is its feedback entry.
    expect(await page.getByRole('button', { name: 'More actions', exact: true }).count()).toBe(0)

    // A thumbs-down with a category is reported as well.
    const dislike = page.getByRole('button', { name: 'Bad response' }).first()
    await scrollIntoView(dislike)
    await dislike.hover()
    await dislike.click()
    const rating = page.getByRole('dialog', { name: 'Submit feedback' })
    await rating.getByRole('button', { name: 'Task result', exact: true }).click()
    await rating.getByRole('textbox', { name: 'Feedback details' }).fill('One shop is missing')
    await rating.getByRole('button', { name: 'Submit', exact: true }).click()
    await expect.poll(() => center.feedback.length, { timeout: 15_000 }).toBe(2)
    expect(center.feedback[1]!.payload).toMatchObject({
      source: 'message', category: 'task-result', description: 'One shop is missing', session: { sessionId },
    })
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser.close()
    await scaffold.close()
    await center.close()
    Reflect.deleteProperty(process.env, 'DSH_E2E_HUB_ORIGIN')
  }
}, 150_000)
