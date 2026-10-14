// The assembled Skills page over the real `installedSkills` Remote: listing, switching, reload persistence, pins,
// bulk switching, and "chat with it".
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'
import { expect, it } from 'vitest'
import type {} from '@deepseek-ai/dsh-skill-controller'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const OVERLAY = fileURLToPath(new URL('./skills-page.overlay.yml', import.meta.url))

async function writeSkill(root: string, name: string): Promise<void> {
  await mkdir(join(root, name), { recursive: true })
  await writeFile(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} description for the Skills page e2e.\n---\n\nBody.\n`)
}

it('lists installed skills, keeps a switched-off skill disabled across reloads, and seeds a chat draft', async () => {
  const scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY })
  try {
    await writeSkill(join(scaffold.harnessHome, 'skills'), 'alpha-skill')
    await writeSkill(join(scaffold.workspaceCwd, '.agents-home', 'skills'), 'beta-skill')
    const controller = scaffold.ctx.get('skillController')
    expect(controller).toBeDefined()
    const browser = await chromium.launch()
    let failurePage: Page | undefined
    try {
      const page = await newEnglishPage(browser)
      failurePage = page
      const tripwire = watchConsole(page)
      await page.goto(scaffold.authenticatedUrl)
      await connectFreshWorkspace(page, scaffold.workspaceCwd, 'skills-page')

      // The Skills entry opens the market; "Installed (N)" opens this machine's skills.
      await page.getByRole('button', { name: 'Skills', exact: true }).click()
      await page.getByRole('button', { name: /^Installed \(\d+\)$/ }).click()
      await expect.poll(() => page.getByRole('heading', { name: 'Installed' }).isVisible()).toBe(true)
      await expect.poll(() => page.getByRole('switch', { name: 'Enable alpha-skill' }).isVisible()).toBe(true)
      expect(await page.getByRole('switch', { name: 'Enable beta-skill' }).getAttribute('aria-checked')).toBe('true')

      await page.getByRole('switch', { name: 'Enable alpha-skill' }).click()
      await expect.poll(async () => (await controller!.list()).skills.find(skill => skill.name === 'alpha-skill')?.enabled).toBe(false)

      await page.reload()
      await page.getByRole('button', { name: 'Skills', exact: true }).click()
      await page.getByRole('button', { name: /^Installed \(\d+\)$/ }).click()
      await expect.poll(() => page.getByRole('switch', { name: 'Enable alpha-skill' }).getAttribute('aria-checked')).toBe('false')

      // Pins (Spec #221 T176) go first and survive a reload on this machine.
      await writeSkill(join(scaffold.harnessHome, 'skills'), 'gamma-skill')
      await page.reload()
      await page.getByRole('button', { name: 'Skills', exact: true }).click()
      await page.getByRole('button', { name: /^Installed \(\d+\)$/ }).click()
      const custom = page.getByRole('region', { name: /Custom/ })
      await custom.getByRole('button', { name: 'Pin gamma-skill' }).click()
      const order = async () => (await custom.getByRole('listitem').allTextContents()).map(text => /alpha-skill|beta-skill|gamma-skill/.exec(text)?.[0]).filter(Boolean)
      expect(await order()).toEqual(['gamma-skill', 'alpha-skill', 'beta-skill'])
      await page.reload()
      await page.getByRole('button', { name: 'Skills', exact: true }).click()
      await page.getByRole('button', { name: /^Installed \(\d+\)$/ }).click()
      await expect.poll(() => custom.getByRole('button', { name: 'Pin gamma-skill' }).getAttribute('aria-pressed')).toBe('true')
      expect(await order()).toEqual(['gamma-skill', 'alpha-skill', 'beta-skill'])

      // Bulk management: select two skills and switch both off, then both on, through the real Remote.
      await page.getByRole('button', { name: 'Manage in bulk' }).click()
      const bar = page.getByRole('toolbar', { name: 'Manage in bulk' })
      await page.getByRole('checkbox', { name: 'Select beta-skill' }).check()
      await page.getByRole('checkbox', { name: 'Select gamma-skill' }).check()
      await bar.getByText('2 selected').waitFor()
      await bar.getByRole('button', { name: 'Disable' }).click()
      const enabled = async (name: string) => (await controller!.list()).skills.find(skill => skill.name === name)?.enabled
      await expect.poll(async () => [await enabled('beta-skill'), await enabled('gamma-skill')]).toEqual([false, false])
      await bar.getByRole('button', { name: 'Enable' }).click()
      await expect.poll(async () => [await enabled('beta-skill'), await enabled('gamma-skill')]).toEqual([true, true])
      await bar.getByRole('button', { name: 'Done' }).click()
      await expect.poll(() => bar.count()).toBe(0)

      await page.getByRole('button', { name: 'More actions for beta-skill' }).click()
      await page.getByRole('menuitem', { name: 'Chat with it' }).click()
      const input = page.locator('[data-composer-input][contenteditable="true"]').first()
      await expect.poll(async () => (await input.textContent())?.trim()).toBe('/beta-skill')

      expect(tripwire.pageErrors).toEqual([])
    } catch (error) {
      if (failurePage !== undefined) await saveFailureShot(failurePage, 'web-e2e-skills-page')
      throw error
    } finally {
      await browser.close()
    }
  } finally {
    await scaffold.close()
  }
})
