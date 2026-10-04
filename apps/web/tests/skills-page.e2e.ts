// The assembled Skills page over the real `installedSkills` Remote: listing, switching, reload persistence, and "chat with it".
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

      await page.getByRole('button', { name: 'Skills', exact: true }).click()
      await expect.poll(() => page.getByRole('heading', { name: 'Installed' }).isVisible()).toBe(true)
      await expect.poll(() => page.getByRole('switch', { name: 'Enable alpha-skill' }).isVisible()).toBe(true)
      expect(await page.getByRole('switch', { name: 'Enable beta-skill' }).getAttribute('aria-checked')).toBe('true')

      await page.getByRole('switch', { name: 'Enable alpha-skill' }).click()
      await expect.poll(async () => (await controller!.list()).skills.find(skill => skill.name === 'alpha-skill')?.enabled).toBe(false)

      await page.reload()
      await page.getByRole('button', { name: 'Skills', exact: true }).click()
      await expect.poll(() => page.getByRole('switch', { name: 'Enable alpha-skill' }).getAttribute('aria-checked')).toBe('false')

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
