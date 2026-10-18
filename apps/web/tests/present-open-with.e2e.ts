/** MO's "打开方式" on a recorded delivery: open with the default application or show in the folder, as the enterprise Desktop composes it. */
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { release, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tool-present/types'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, ZH_BROWSER_LOCALE } from './support.ts'

const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/present/session.v3.jsonl', import.meta.url))
const PROMPT = 'Use one run_code program to do the following in order. Call present for missing.txt and catch its error without creating that file. '
  + 'Use bash to run exactly `printf "DELIVERED_REPORT\\n" > report.txt; printf "DELIVERED_NOTE\\n" > 说明.txt`. '
  + 'Call present for report.txt and 说明.txt. After present succeeds, deliberately throw the string "AFTER_PRESENT" (not an Error object) from that same run_code program. '
  + 'Do not retry the program or create any other files. Finish by mentioning `report.txt` and `说明.txt` in inline code, and put PRESENT_DONE in a separate paragraph.'
const SHOTS = process.env.DSH_E2E_SHOTS

// The recorded Bash scenario and executable opener fixture require a POSIX host outside WSL.
describe.skipIf(process.platform === 'win32' || release().toLowerCase().includes('microsoft'))('web e2e: MO open-with menu on delivered files', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let nativeRoot: string
  let openLog: string
  let disposeApproval: (() => void) | undefined
  const opened = async () => (await readFile(openLog, 'utf8')).split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as { path: string; action: 'open' | 'reveal' })

  beforeAll(async () => {
    nativeRoot = await mkdtemp(join(tmpdir(), 'dsh-open-with-native-'))
    openLog = join(nativeRoot, 'opened.jsonl')
    await writeFile(openLog, '')
    // The built Host's own OS command, with only the desktop application replaced.
    const command = process.platform === 'darwin' ? 'open' : 'xdg-open'
    await writeFile(join(nativeRoot, command), `#!${process.execPath}
const fs = require('node:fs');
const path = process.argv[2] === '-R' ? process.argv[3] : process.argv[2];
const action = process.argv[2] === '-R' || fs.statSync(path).isDirectory() ? 'reveal' : 'open';
fs.appendFileSync(${JSON.stringify(openLog)}, JSON.stringify({ path, action }) + '\\n');
`, { mode: 0o700 })
    vi.stubEnv('PATH', `${nativeRoot}${delimiter}${process.env.PATH ?? ''}`)
    scaffold = await launchWebScaffold({
      extraOverlayPath: [
        fileURLToPath(new URL('./present.overlay.yml', import.meta.url)),
        fileURLToPath(new URL('./brand-mo.overlay.yml', import.meta.url)),
        fileURLToPath(new URL('./present-open-with.overlay.yml', import.meta.url)),
      ],
      agentPresets: { default: 'ptc' }, replayFixture: FIXTURE,
    })
    disposeApproval = scaffold.ctx.on('approval/request', () => Promise.resolve('allowed-once'), { prepend: true })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    try {
      await browser?.close()
    } finally {
      disposeApproval?.()
      try {
        await scaffold?.close()
      } finally {
        vi.unstubAllEnvs()
        await rm(nativeRoot, { recursive: true, force: true })
      }
    }
  })

  it('offers only 打开方式 with two choices, opens the file with its default application, and shows it in its folder', async () => {
    const settled = scaffold.whenTurnSettled()
    const input = page.locator('[data-composer-input]').first()
    await input.fill(PROMPT)
    await input.press('Enter')
    const sessionId = await settled
    const cwd = scaffold.ctx.agents.get(sessionId)?.session.header.cwd
    if (cwd === undefined) throw new Error('open-with Session has no workspace')
    const card = page.locator('[data-presented-file]').filter({ hasText: 'report.txt' })
    await page.getByText(/^PRESENT_DONE\.?$/).waitFor({ timeout: 30_000 })
    await card.waitFor({ timeout: 30_000 })
    // No Open In split button: the enterprise composition leaves it out.
    expect(await page.getByRole('button', { name: 'More ways to open' }).count()).toBe(0)
    await expect.poll(() => page.locator('[data-presented-files-row] [data-open-with]').count()).toBe(2)

    await card.getByRole('button', { name: 'Open with', exact: true }).click()
    expect(await page.getByRole('menuitem').allInnerTexts()).toEqual(['Open with default app', 'Show in folder'])
    const openResponse = page.waitForResponse(response => response.url().includes('/api/present.open?') && response.request().method() === 'POST')
    await page.getByRole('menuitem', { name: 'Open with default app' }).click()
    expect((await openResponse).status()).toBe(204)
    await expect.poll(opened).toEqual([{ action: 'open', path: await realpath(join(cwd, 'report.txt')) }])

    await page.waitForFunction(() => document.querySelector('[data-open-with]:disabled') === null)
    await card.getByRole('button', { name: 'Open with', exact: true }).click()
    const revealResponse = page.waitForResponse(response => response.url().includes('action=reveal') && response.request().method() === 'POST')
    await page.getByRole('menuitem', { name: 'Show in folder' }).click()
    expect((await revealResponse).status()).toBe(204)
    await expect.poll(async () => (await opened()).at(-1))
      .toEqual({ action: 'reveal', path: await realpath(process.platform === 'darwin' ? join(cwd, 'report.txt') : cwd) })

    if (SHOTS !== undefined) {
      for (const [locale, name] of [[ZH_BROWSER_LOCALE, 'zh'], ['en-US', 'en']] as const) {
        for (const colorScheme of ['light', 'dark'] as const) {
          const shot = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale, colorScheme })
          await shot.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
          // A fresh window opens the blank new-session page: open the delivering Session from the sidebar.
          await shot.locator(`[data-row-key*="${sessionId}"]`).first().click()
          const shotCard = shot.locator('[data-presented-file]').filter({ hasText: 'report.txt' })
          await shotCard.waitFor({ timeout: 30_000 })
          await shotCard.scrollIntoViewIfNeeded()
          await shotCard.locator('[data-open-with]').click()
          await shot.getByRole('menuitem').first().waitFor()
          await shot.screenshot({ path: join(SHOTS, `${name}-${colorScheme}-open-with.png`) })
          await shot.close()
        }
      }
    }
  }, 200_000)
})
