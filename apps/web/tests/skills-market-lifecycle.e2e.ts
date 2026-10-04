// Market Skill lifecycle over the real `skillMarket` Remote and a mock Skill Hub: an update offered
// after the Hub publishes a newer version, the confirmation before local edits are overwritten,
// a Skill the Hub withdrew staying usable and marked, and tenant switches hiding and restoring it.
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'
import { expect, it } from 'vitest'
import type {} from '@deepseek-ai/dsh-skill-market'
import { startMockUserCenter, type MockSkill, type MockTenant } from '../../../packages/credentials/hub-account/tests/mock-user-center.ts'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, openSettings, saveFailureShot } from './support.ts'

const OVERLAY = fileURLToPath(new URL('./skills-market.overlay.yml', import.meta.url))
const PDF: MockSkill = { id: 's-pdf', name: 'pdf-tools', description: 'Read PDF files', category: null, version: '1.0.0', files: { 'scripts/run.sh': 'echo v1\n' } }

async function finishSignIn(page: Page, trigger: () => Promise<void>): Promise<void> {
  const popup = page.waitForEvent('popup')
  await trigger()
  const opened = await popup
  await expect.poll(() => opened.textContent('body')).toContain('登录成功')
  await opened.close()
}

it('offers updates, protects local edits, keeps withdrawn Skills usable, and follows the tenant', async () => {
  const center = await startMockUserCenter()
  center.skills = [PDF]
  process.env.DSH_E2E_HUB_ORIGIN = center.origin
  const scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY })
  const marketDir = join(scaffold.harnessHome, 'skills-market', 't-a', 'pdf-tools')
  const browser = await chromium.launch()
  let failurePage: Page | undefined
  try {
    const page = await newEnglishPage(browser)
    failurePage = page
    await page.addInitScript(() => { Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 } }) })
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl)
    await finishSignIn(page, () => page.getByRole('button', { name: 'Sign in with the user center', exact: true }).click())
    await page.getByRole('dialog', { name: 'Sign in to Skill Hub' }).waitFor({ state: 'detached' })
    await connectFreshWorkspace(page, scaffold.workspaceCwd, 'skills-lifecycle')
    const openMarket = async () => {
      await page.getByRole('button', { name: 'Skills', exact: true }).click()
      await page.getByRole('heading', { name: 'Skills' }).waitFor()
    }
    await openMarket()
    await page.getByRole('button', { name: 'Install pdf-tools' }).click()
    await page.getByText('Installed v1.0.0').waitFor()

    // The Hub publishes 1.1.0: reopening the market offers the update.
    center.skills = [{ ...PDF, version: '1.1.0', files: { 'scripts/run.sh': 'echo v2\n' } }]
    await page.getByRole('button', { name: /^Installed \(\d+\)$/ }).click()
    await page.getByRole('region', { name: /From the market/ }).getByText('Update available: v1.1.0').waitFor()
    await page.getByRole('button', { name: 'Back to Skills' }).click()
    await page.getByRole('button', { name: 'Update pdf-tools' }).waitFor()
    expect(await page.getByRole('button', { name: 'Update pdf-tools' }).textContent()).toBe('Update to v1.1.0')

    // A local edit: the update asks first; Cancel keeps the file.
    await writeFile(join(marketDir, 'scripts', 'run.sh'), 'echo my edit\n')
    await page.getByRole('button', { name: 'Update pdf-tools' }).click()
    const confirm = page.getByRole('dialog', { name: 'Local edits will be overwritten' })
    await confirm.getByText('scripts/run.sh').waitFor()
    await confirm.getByRole('button', { name: 'Cancel' }).click()
    await confirm.waitFor({ state: 'detached' })
    expect(await readFile(join(marketDir, 'scripts', 'run.sh'), 'utf8')).toBe('echo my edit\n')
    await page.getByRole('button', { name: 'Update pdf-tools' }).click()
    await confirm.getByRole('button', { name: 'Overwrite and update' }).click()
    await page.getByText('Installed v1.1.0').waitFor()
    expect(await readFile(join(marketDir, 'scripts', 'run.sh'), 'utf8')).toBe('echo v2\n')
    expect(JSON.parse(await readFile(join(marketDir, '.hub-install.json'), 'utf8'))).toMatchObject({ version: '1.1.0' })

    // The Hub withdraws it: still installed and usable, marked as no longer in the market.
    center.skills = []
    await page.getByRole('button', { name: /^Installed \(\d+\)$/ }).click()
    const fromMarket = page.getByRole('region', { name: /From the market/ })
    await fromMarket.getByText('No longer in the market').waitFor()
    expect(await fromMarket.getByRole('button', { name: /^Update / }).count()).toBe(0)
    expect((await scaffold.ctx.skills.get('pdf-tools'))?.source).toBe('market')
    await page.getByRole('button', { name: 'Back to Skills' }).click()

    // Switching tenant hides tenant A's market Skills; switching back restores them.
    const switchTenant = async (tenant: MockTenant) => {
      center.tenant = tenant
      await openSettings(page, 'en')
      const settings = page.getByRole('dialog', { name: 'Settings' })
      await settings.getByRole('button', { name: 'Skill Hub account' }).click()
      await finishSignIn(page, () => settings.getByRole('region', { name: 'Skill Hub account' }).getByRole('button', { name: 'Switch tenant' }).click())
      await expect.poll(async () => (await scaffold.ctx.hubAccount.getState()).profile?.tenantId).toBe(tenant.tenantId)
      await settings.getByRole('button', { name: 'Close' }).last().click()
    }
    await switchTenant({ tenantId: 't-b', tenantName: '乙公司' })
    await expect.poll(async () => (await scaffold.ctx.skills.list()).some(skill => skill.name === 'pdf-tools')).toBe(false)
    await openMarket()
    await page.getByRole('button', { name: /^Installed \(\d+\)$/ }).click()
    await page.getByRole('region', { name: /From the market/ }).getByText('No Skills installed from the market yet').waitFor()
    await page.getByRole('button', { name: 'Back to Skills' }).click()
    await switchTenant({ tenantId: 't-a', tenantName: '甲公司' })
    await expect.poll(async () => (await scaffold.ctx.skills.list()).some(skill => skill.name === 'pdf-tools')).toBe(true)
    await openMarket()
    await page.getByRole('button', { name: /^Installed \(\d+\)$/ }).click()
    await page.getByRole('region', { name: /From the market/ }).getByText('pdf-tools').waitFor()
    expect(tripwire.pageErrors).toEqual([])
  } catch (error) {
    if (failurePage !== undefined) await saveFailureShot(failurePage, 'web-e2e-skills-market-lifecycle')
    throw error
  } finally {
    await browser.close()
    await scaffold.close()
    await center.close()
    Reflect.deleteProperty(process.env, 'DSH_E2E_HUB_ORIGIN')
  }
})
