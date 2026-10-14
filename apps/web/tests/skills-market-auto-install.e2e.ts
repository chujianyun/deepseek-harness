// Automatic install of Skill Hub Skills (Spec #221) over the real `skillMarket` Remote and a mock
// Skill Hub: the Skill the Hub marks for automatic install appears under "Installed" right after
// sign-in, an unmarked one does not, an uninstalled one stays out across later sign-ins, and
// installing it again by hand brings it back.
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'
import { expect, it } from 'vitest'
import type {} from '@deepseek-ai/dsh-skill-market'
import { startMockUserCenter, type MockSkill, type MockTenant } from '../../../packages/credentials/hub-account/tests/mock-user-center.ts'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, openSettings, saveFailureShot, signInToSkillHub } from './support.ts'

const OVERLAY = fileURLToPath(new URL('./skills-market.overlay.yml', import.meta.url))
const MARKED: MockSkill = { id: 's-pdf', name: 'pdf-tools', description: 'Read PDF files', category: null, version: '1.0.0', autoInstall: true }
const PLAIN: MockSkill = { id: 's-sql', name: 'sql-helper', description: 'Write SQL', category: null, version: '1.0.0', autoInstall: false }

async function finishSignIn(page: Page, trigger: () => Promise<void>): Promise<void> {
  const popup = page.waitForEvent('popup')
  await trigger()
  const opened = await popup
  await expect.poll(() => opened.textContent('body')).toContain('登录成功')
  await opened.close()
}

it('installs the marked Skill after sign-in and keeps an uninstalled one out until installed by hand', async () => {
  const center = await startMockUserCenter()
  center.skills = [MARKED, PLAIN]
  process.env.DSH_E2E_HUB_ORIGIN = center.origin
  const scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY })
  const browser = await chromium.launch()
  let failurePage: Page | undefined
  try {
    const page = await newEnglishPage(browser)
    failurePage = page
    await page.addInitScript(() => { Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 } }) })
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl)
    await signInToSkillHub(page)
    await connectFreshWorkspace(page, scaffold.workspaceCwd, 'skills-auto-install')
    const installed = async () => {
      await page.getByRole('button', { name: 'Skills', exact: true }).click()
      await page.getByRole('heading', { name: 'Skills' }).waitFor()
      await page.getByRole('button', { name: /^Installed \(\d+\)$/ }).click()
      return page.getByRole('region', { name: /From the market/ })
    }

    // Right after sign-in, without opening the market: the marked Skill is installed, the other is not.
    await expect.poll(async () => (await scaffold.ctx.skills.list()).some(skill => skill.name === 'pdf-tools')).toBe(true)
    const fromMarket = await installed()
    await fromMarket.getByText('pdf-tools').waitFor()
    expect(await fromMarket.getByText('sql-helper').count()).toBe(0)
    await page.getByRole('button', { name: 'Back to Skills' }).click()

    // The user uninstalls it (the installed-skills Remote records it the same way); later sign-ins leave it out.
    const market = scaffold.ctx.get('skillMarket')!
    await rm(join(scaffold.harnessHome, 'skills-market', 't-a', 'pdf-tools'), { recursive: true })
    await market.markUninstalled('pdf-tools')
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
    await switchTenant({ tenantId: 't-a', tenantName: '甲公司' })
    await expect.poll(() => center.clientRequests.filter(path => path.startsWith('/api/client/skills?page=1')).length).toBeGreaterThanOrEqual(3)
    expect((await scaffold.ctx.skills.list()).some(skill => skill.name === 'pdf-tools')).toBe(false)
    expect([...(await market.records()).keys()]).toEqual([])

    // Installing it by hand from the market brings it back (reload: the market page keeps the cards it loaded before).
    await page.reload()
    await page.getByRole('button', { name: 'Skills', exact: true }).click()
    await page.getByRole('button', { name: 'Install pdf-tools' }).click()
    await page.getByText('Installed v1.0.0').waitFor()
    expect((await installed().then(region => region.getByText('pdf-tools').count()))).toBe(1)
    expect(tripwire.pageErrors).toEqual([])
  } catch (error) {
    if (failurePage !== undefined) await saveFailureShot(failurePage, 'web-e2e-skills-market-auto-install')
    throw error
  } finally {
    await browser.close()
    await scaffold.close()
    await center.close()
    Reflect.deleteProperty(process.env, 'DSH_E2E_HUB_ORIGIN')
  }
})
