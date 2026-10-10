// "Add skill" over the real `skillMarket` Remote and a mock Skill Hub: a new Skill needs a display
// name, and the dialog names the Skill by it; an employee's upload waits
// for review with its link, the Hub's refusal shows verbatim, a broken folder lists its problems,
// and an administrator's upload is published into the market, while the local Skills stay as they were.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'
import { expect, it } from 'vitest'
import type {} from '@deepseek-ai/dsh-skill-market'
import { startMockUserCenter } from '../../../packages/credentials/hub-account/tests/mock-user-center.ts'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot, signInToSkillHub } from './support.ts'

const OVERLAY = fileURLToPath(new URL('./skills-market.overlay.yml', import.meta.url))

async function writeSkill(dir: string, skillMd: string): Promise<void> {
  await mkdir(join(dir, 'scripts'), { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), skillMd)
  await writeFile(join(dir, 'scripts', 'run.sh'), 'echo hi\n')
  await writeFile(join(dir, '.DS_Store'), 'junk')
}

it('uploads a custom Skill for review, shows refusals verbatim, and publishes an administrator\'s upload', async () => {
  const center = await startMockUserCenter()
  process.env.DSH_E2E_HUB_ORIGIN = center.origin
  const scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY })
  const reportDir = join(scaffold.harnessHome, 'skills', 'report-writer')
  const reportMd = '---\nname: report-writer\ndescription: Writes weekly reports\n---\n\nBody.\n'
  await writeSkill(reportDir, reportMd)
  await writeSkill(join(scaffold.harnessHome, 'skills', 'weekly-notes'), '---\nname: weekly-notes\ndescription: Keeps weekly notes\n---\n')
  const brokenDir = join(scaffold.workspaceCwd, 'broken-skill')
  await writeSkill(brokenDir, '---\nname: Broken Skill\n---\n')
  const browser = await chromium.launch()
  let failurePage: Page | undefined
  try {
    const page = await newEnglishPage(browser)
    failurePage = page
    await page.addInitScript(() => { Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 } }) })
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl)
    await signInToSkillHub(page)
    await connectFreshWorkspace(page, scaffold.workspaceCwd, 'skills-upload')
    await page.getByRole('button', { name: 'Skills', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Add a skill to the Skill Hub' })
    const openUpload = async () => {
      await page.getByRole('button', { name: 'Add skill', exact: true }).click()
      await dialog.getByRole('button', { name: /report-writer/ }).waitFor()
    }

    // An employee uploads a new Skill visible to one department: it waits for review.
    await openUpload()
    await dialog.getByRole('button', { name: /report-writer/ }).click()
    await dialog.getByText('2 files').waitFor()
    expect(await dialog.getByRole('textbox', { name: 'Version' }).inputValue()).toBe('1.0.0')
    await dialog.getByRole('tab', { name: 'Departments' }).click()
    await dialog.getByRole('checkbox', { name: '研发部' }).check()
    // A new Skill cannot be uploaded until it has a display name.
    expect(await dialog.getByRole('button', { name: 'Upload', exact: true }).isDisabled()).toBe(true)
    await dialog.getByRole('textbox', { name: 'Display name' }).fill(' 周报助手 ')
    await dialog.getByRole('button', { name: 'Upload', exact: true }).click()
    await dialog.getByRole('status').filter({ hasText: 'Submitted for review: 周报助手 1.0.0' }).waitFor()
    expect(await dialog.getByRole('textbox', { name: 'Review link' }).inputValue()).toMatch(/\/skills\/review\/s-up-1-v1$/)
    expect(center.uploads[0]).toMatchObject({
      path: '/api/client/skills', fields: { version: '1.0.0', displayName: '周报助手', visibility: 'departments', departmentIds: 'd-rd' },
    })
    expect([...center.uploads[0]?.entries ?? []].sort()).toEqual(['report-writer/SKILL.md', 'report-writer/scripts/run.sh'])
    expect(await readFile(join(reportDir, 'SKILL.md'), 'utf8')).toBe(reportMd)
    await dialog.getByRole('button', { name: 'Done' }).click()

    // Uploading it again is its next version, which the Hub refuses while 1.0.0 is in review.
    await openUpload()
    await dialog.getByRole('button', { name: /report-writer/ }).click()
    await dialog.getByText('You already own a skill with this name ("周报助手", highest version 1.0.0)').waitFor()
    expect(await dialog.getByRole('textbox', { name: 'Version' }).inputValue()).toBe('1.0.1')
    expect(await dialog.getByRole('textbox', { name: 'Display name' }).count()).toBe(0)
    expect(await dialog.getByRole('tablist').count()).toBe(0)
    await dialog.getByRole('button', { name: 'Upload', exact: true }).click()
    await dialog.getByRole('alert').filter({ hasText: 'Upload failed: 该 Skill 已有未成为正式的版本 1.0.0（审核中），请先处理后再上传新版本' }).waitFor()

    // A typed folder with a broken SKILL.md lists why it cannot be uploaded.
    await dialog.getByRole('button', { name: 'Choose again' }).click()
    await dialog.getByRole('textbox', { name: 'Folder path' }).fill(brokenDir)
    await dialog.getByRole('button', { name: 'Read', exact: true }).click()
    const problems = dialog.getByRole('alert')
    await problems.getByText('The SKILL.md name may contain only lowercase letters, digits, and hyphens').waitFor()
    await problems.getByText('SKILL.md has no description').waitFor()
    expect(await dialog.getByRole('button', { name: 'Upload', exact: true }).count()).toBe(0)
    await dialog.getByRole('button', { name: 'Close' }).click()

    // An administrator's upload is published at once and the market lists it.
    center.tenantAdmin = true
    await openUpload()
    await dialog.getByRole('button', { name: /weekly-notes/ }).click()
    await dialog.getByRole('textbox', { name: 'Display name' }).fill('每周笔记')
    await dialog.getByRole('button', { name: 'Upload', exact: true }).click()
    await dialog.getByRole('status').filter({ hasText: 'Published: 每周笔记 1.0.0' }).waitFor()
    expect(await dialog.getByRole('textbox', { name: 'Review link' }).count()).toBe(0)
    await dialog.getByRole('button', { name: 'Done' }).click()
    await page.getByRole('tabpanel').getByRole('button', { name: '每周笔记', exact: true }).waitFor()

    // Both local Skills remain custom Skills.
    await page.getByRole('button', { name: /^Installed \(\d+\)$/ }).click()
    const custom = page.getByRole('region', { name: /Custom/ })
    await custom.getByText('report-writer').waitFor()
    await custom.getByText('weekly-notes').waitFor()
    expect(tripwire.pageErrors).toEqual([])
  } catch (error) {
    if (failurePage !== undefined) await saveFailureShot(failurePage, 'web-e2e-skills-market-upload')
    throw error
  } finally {
    await browser.close()
    await scaffold.close()
    await center.close()
    Reflect.deleteProperty(process.env, 'DSH_E2E_HUB_ORIGIN')
  }
})
