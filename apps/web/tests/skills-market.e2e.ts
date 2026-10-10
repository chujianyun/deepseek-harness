// The assembled Skills market over the real `skillMarket` and `installedSkills` Remotes and a mock
// Skill Hub: sign in, browse, search, filter by category, open a detail, install, find the Skill
// under "From the market", and invoke it with `/name` in a new conversation. Cards, the detail, and the
// installed card show the Hub's display name; the slug stays the name the model and `/name` use.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'
import { expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ReplayOverrideDoc } from '@deepseek-ai/dsh-llm-replay'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-skill-market'
import { startMockUserCenter } from '../../../packages/credentials/hub-account/tests/mock-user-center.ts'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot, signInToSkillHub } from './support.ts'

const OVERLAY = fileURLToPath(new URL('./skills-market.overlay.yml', import.meta.url))

function replay(): ReplayOverrideDoc {
  const text = 'MARKET_SKILL_DONE'
  const chunks: StreamChunk[] = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 16, outputTokens: 4 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  return [{ kind: 'chunks', chunks }]
}

it('browses the market, installs a Skill, lists it from the market, and invokes it with /name', async () => {
  const center = await startMockUserCenter()
  center.skills = [
    { id: 's-pdf', name: 'pdf-tools', displayName: 'PDF 工具', description: 'Read PDF files', category: { id: 'c-doc', name: 'Docs' }, version: '1.0.0', files: { 'scripts/run.sh': 'echo pdf\n' } },
    { id: 's-sql', name: 'sql-helper', description: 'Write SQL', category: { id: 'c-dev', name: 'Dev' }, version: '2.1.0' },
  ]
  const replayDir = await mkdtemp(join(tmpdir(), 'dsh-skills-market-replay-'))
  await writeFile(join(replayDir, 'replay.override.json'), JSON.stringify(replay()))
  process.env.DSH_E2E_HUB_ORIGIN = center.origin
  const scaffold = await launchWebScaffold({
    extraOverlayPath: OVERLAY, replayFixture: join(replayDir, 'override-only.jsonl'), replayOverride: join(replayDir, 'replay.override.json'),
  })
  const events: SessionEvent[] = []
  scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { events.push(event) })
  // A Skill the user placed on this machine blocks the market Skill of the same name.
  await mkdir(join(scaffold.harnessHome, 'skills', 'sql-helper'), { recursive: true })
  await writeFile(join(scaffold.harnessHome, 'skills', 'sql-helper', 'SKILL.md'), '---\nname: sql-helper\ndescription: My SQL\n---\n\nMine.\n')
  const browser = await chromium.launch()
  let failurePage: Page | undefined
  try {
    const page = await newEnglishPage(browser)
    failurePage = page
    await page.addInitScript(() => { Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 } }) })
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl)
    await signInToSkillHub(page)
    await connectFreshWorkspace(page, scaffold.workspaceCwd, 'skills-market')

    // Browse: cards, search, category.
    await page.getByRole('button', { name: 'Skills', exact: true }).click()
    await page.getByRole('heading', { name: 'Skills' }).waitFor()
    await page.getByRole('button', { name: 'PDF 工具', exact: true }).waitFor()
    expect(await page.getByRole('button', { name: 'A local Skill has the same name' }).isDisabled()).toBe(true)
    await page.getByRole('searchbox', { name: 'Search Skills' }).fill('sql')
    await page.getByRole('button', { name: 'Search', exact: true }).click()
    await expect.poll(() => page.getByRole('button', { name: 'PDF 工具', exact: true }).count()).toBe(0)
    await page.getByRole('searchbox', { name: 'Search Skills' }).fill('')
    await page.getByRole('button', { name: 'Search', exact: true }).click()
    await page.getByRole('tab', { name: 'Docs' }).click()
    await expect.poll(() => page.getByRole('button', { name: 'sql-helper', exact: true }).count()).toBe(0)
    expect(center.clientRequests.some(path => path.includes('categoryId=c-doc'))).toBe(true)

    // Detail and install.
    await page.getByRole('button', { name: 'PDF 工具', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'PDF 工具' })
    await dialog.getByRole('heading', { name: 'pdf-tools' }).waitFor()
    await dialog.getByText('scripts/run.sh').waitFor()
    await dialog.locator('code', { hasText: 'pdf-tools' }).first().waitFor()
    await dialog.getByRole('button', { name: 'Install PDF 工具' }).click()
    await dialog.getByText('Installed v1.0.0').waitFor()
    await dialog.getByRole('button', { name: 'Close' }).last().click()
    const installedDir = join(scaffold.harnessHome, 'skills-market', 't-a', 'pdf-tools')
    expect(await readFile(join(installedDir, 'scripts', 'run.sh'), 'utf8')).toBe('echo pdf\n')
    expect(JSON.parse(await readFile(join(installedDir, '.hub-install.json'), 'utf8'))).toMatchObject({ hubSkillId: 's-pdf', displayName: 'PDF 工具', version: '1.0.0' })

    // Installed: the market group, then chat with it.
    await page.getByRole('button', { name: /^Installed \(\d+\)$/ }).click()
    const marketGroup = page.getByRole('region', { name: /From the market/ })
    await marketGroup.getByText('PDF 工具').waitFor()
    await marketGroup.getByText('pdf-tools', { exact: true }).waitFor()
    expect(await marketGroup.getByRole('switch', { name: 'Enable PDF 工具' }).getAttribute('aria-checked')).toBe('true')
    await marketGroup.getByRole('button', { name: 'More actions for PDF 工具' }).click()
    await page.getByRole('menuitem', { name: 'Chat with it' }).click()
    const input = page.locator('[data-composer-input][contenteditable="true"]').first()
    await expect.poll(async () => (await input.textContent())?.trim()).toBe('/pdf-tools')
    await input.click()
    await page.keyboard.press('End')
    await page.keyboard.type('summarize the report')
    await page.keyboard.press('Enter')
    await expect.poll(() => events.some(event => event.type === 'user/message'
      && (event.data.source as { kind?: string; name?: string } | undefined)?.kind === 'skill-invocation'
      && (event.data.source as { name?: string }).name === 'pdf-tools'
      && event.data.content.some(block => block.type === 'text' && block.text.includes('Use pdf-tools.'))), { timeout: 20_000 }).toBe(true)
    await page.getByText('MARKET_SKILL_DONE').first().waitFor({ timeout: 20_000 })
    expect(tripwire.pageErrors).toEqual([])
  } catch (error) {
    if (failurePage !== undefined) await saveFailureShot(failurePage, 'web-e2e-skills-market')
    throw error
  } finally {
    await browser.close()
    await scaffold.close()
    await center.close()
    Reflect.deleteProperty(process.env, 'DSH_E2E_HUB_ORIGIN')
    await rm(replayDir, { recursive: true, force: true })
  }
})
