// The assembled MO WorkAI brand theme over the real theme runtime: with the row mounted, the Plugins
// panel's primary button, the composer's send button, and the active sidebar panel take 名流蓝 in the
// light palette and the lifted blue in the dark palette; without it the platform palette stays (ink
// primary button, hover-grey active panel). The mounted row's index render carries the boot page brand
// and a stylesheet that paints the boot page navy and seeds the palette before the client loads. The
// sidebar brand row is the MO wordmark (inverted on the light theme); the collapsed rail shows the app icon.
import { fileURLToPath } from 'node:url'
import { chromium, type Locator, type Page } from 'playwright'
import { expect, it } from 'vitest'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const OVERLAY = fileURLToPath(new URL('./brand-mo.overlay.yml', import.meta.url))

/** Computed background color of the first element a locator matches. */
const fill = (target: Locator) => target.first().evaluate(element => getComputedStyle(element).backgroundColor)

/** Read a color once its transition has finished: two reads 300 ms apart agree within 3 s. */
async function settled(read: () => Promise<string>): Promise<string> {
  let previous = await read()
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 300))
    const next = await read()
    if (next === previous) return next
    previous = next
  }
  throw new Error(`color did not settle; last read ${previous}`)
}

interface PanelPaint {
  addPlugin: string
  activePanel: string
  activePanelLabel: string
}

/** Colors on the Plugins panel: its primary button and its active sidebar row. */
async function panelPaint(page: Page): Promise<PanelPaint> {
  const panel = page.getByRole('navigation', { name: 'Global panels' }).getByRole('button', { name: 'Plugins', exact: true })
  return {
    addPlugin: await fill(page.getByRole('button', { name: 'Add plugin', exact: true })),
    activePanel: await fill(panel),
    activePanelLabel: await panel.evaluate(element => getComputedStyle(element).color),
  }
}

/** The send button's fill in the light and the dark palette, then the Plugins panel's colors in both. */
async function paint(page: Page): Promise<{ light: { send: string } & PanelPaint; dark: { send: string } & PanelPaint }> {
  const send = page.getByRole('button', { name: 'Send message', exact: true })
  await page.emulateMedia({ colorScheme: 'light' })
  const lightSend = await settled(() => fill(send))
  // The theme preference follows the system, so each scheme change repaints the palette.
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect.poll(() => fill(send)).not.toBe(lightSend)
  const darkSend = await settled(() => fill(send))
  await page.getByRole('navigation', { name: 'Global panels' }).getByRole('button', { name: 'Plugins', exact: true }).click()
  await page.getByRole('button', { name: 'Add plugin', exact: true }).first().waitFor()
  await settled(async () => JSON.stringify(await panelPaint(page)))
  const dark = await panelPaint(page)
  await page.emulateMedia({ colorScheme: 'light' })
  await expect.poll(async () => (await panelPaint(page)).addPlugin).not.toBe(dark.addPlugin)
  await settled(async () => JSON.stringify(await panelPaint(page)))
  return { light: { send: lightSend, ...await panelPaint(page) }, dark: { send: darkSend, ...dark } }
}

/** What the index render injected for the boot page: the brand name and the navy boot stylesheet. */
function bootRows(page: Page): Promise<{ brand: string | null; navyBoot: boolean }> {
  return page.evaluate(() => {
    const brand: unknown = Reflect.get(globalThis, '__DSH_BOOT_BRAND__')
    const name = typeof brand === 'object' && brand !== null && 'name' in brand && typeof brand.name === 'string' ? brand.name : null
    const navyBoot = [...document.querySelectorAll('head style')].some(style => style.textContent.includes('[data-dsh-boot]{background:#0E1430'))
    return { brand: name, navyBoot }
  })
}

async function run(overlay: string | undefined, check: (page: Page) => Promise<void>, name: string): Promise<void> {
  const scaffold = await launchWebScaffold(overlay === undefined ? {} : { extraOverlayPath: overlay })
  const browser = await chromium.launch()
  let failurePage: Page | undefined
  try {
    const page = await newEnglishPage(browser)
    failurePage = page
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl)
    await connectFreshWorkspace(page, scaffold.workspaceCwd, name)
    await check(page)
    expect(tripwire.pageErrors).toEqual([])
  } catch (error) {
    if (failurePage !== undefined) await saveFailureShot(failurePage, `web-e2e-${name}`)
    throw error
  } finally {
    await browser.close()
    await scaffold.close()
  }
}

it('paints primary buttons, send, and the active panel 名流蓝 in both palettes when the brand row is mounted', async () => {
  await run(OVERLAY, async (page) => {
    expect(await paint(page)).toEqual({
      light: { send: 'rgb(42, 85, 249)', addPlugin: 'rgb(42, 85, 249)', activePanel: 'rgb(230, 236, 254)', activePanelLabel: 'rgb(42, 85, 249)' },
      dark: { send: 'rgb(92, 124, 255)', addPlugin: 'rgb(92, 124, 255)', activePanel: 'rgba(92, 124, 255, 0.18)', activePanelLabel: 'rgb(169, 186, 255)' },
    })
    expect(await bootRows(page)).toEqual({ brand: 'MO WorkAI', navyBoot: true })
    // The expanded brand row is the MO wordmark: inverted to dark on the light theme, as drawn on the dark one.
    const wordmark = page.locator('[data-slot="sidebar.brand.name"] img')
    expect(await wordmark.getAttribute('src')).toMatch(/^data:image\/png;base64,/u)
    const filter = () => wordmark.evaluate(element => getComputedStyle(element).filter)
    expect(await filter()).toBe('invert(1)')
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect.poll(filter).toBe('none')
    await page.emulateMedia({ colorScheme: 'light' })
    await expect.poll(filter).toBe('invert(1)')
    // The collapsed rail keeps the active panel's blue label.
    await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
    const railPanel = page.getByRole('navigation', { name: 'Global panels' }).getByRole('button', { name: 'Plugins', exact: true })
    expect(await settled(() => railPanel.evaluate(element => getComputedStyle(element).color))).toBe('rgb(42, 85, 249)')
    // ... and shows the app icon as its mark.
    expect(await page.locator('[data-slot="sidebar.brand.mark"] img').count()).toBe(1)
    // A blank new session offers the configured quick tasks; a card fills the draft without sending.
    await page.getByRole('button', { name: 'Open sidebar', exact: true }).click()
    await page.getByRole('button', { name: 'New session', exact: true }).first().click()
    const tasks = page.locator('[data-quick-tasks] button')
    await tasks.first().waitFor()
    expect(await tasks.evaluateAll(cards => cards.map(card => card.getAttribute('data-task'))))
      .toEqual(['multi-publish', 'business-report', 'product-research', 'asset-organize'])
    await page.getByRole('button', { name: /Publish to several stores/ }).click()
    const composer = page.locator('[data-composer-input][contenteditable="true"]').last()
    await expect.poll(() => composer.innerText()).toContain('Publish one new product to several stores')
  }, 'brand-mo')
})

it('keeps the platform palette when the brand row is not mounted', async () => {
  await run(undefined, async (page) => {
    const { light } = await paint(page)
    expect(light.addPlugin).toBe('rgb(15, 17, 21)')
    expect(light.activePanel).toBe('rgba(38, 49, 72, 0.06)')
    expect(light.activePanelLabel).toBe('rgb(15, 17, 21)')
    expect(light.send).not.toBe('rgb(42, 85, 249)')
    expect(await bootRows(page)).toEqual({ brand: null, navyBoot: false })
    expect(await page.locator('[data-quick-tasks]').count()).toBe(0)
  }, 'brand-mo-absent')
})
