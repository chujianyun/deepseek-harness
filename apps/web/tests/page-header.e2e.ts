// Page headers across the sidebar panels of the enterprise composition: Skills, Connectors, and
// Assistants put their title where the Plugins and Automation tasks pages do (same left edge, same
// top inset, 20px medium), in a centred column at most 960px wide.
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'
import { expect, it } from 'vitest'
import { startMockUserCenter } from '../../../packages/credentials/hub-account/tests/mock-user-center.ts'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const OVERLAYS = ['./hub-account.overlay.yml', './brand-mo.overlay.yml', './skills-page.overlay.yml', './connectors.overlay.yml', './assistants.overlay.yml']
  .map(path => fileURLToPath(new URL(path, import.meta.url)))

interface TitleBox {
  x: number
  y: number
  fontSize: string
  fontWeight: string
}

/** Open one sidebar panel and measure its page title. */
async function title(page: Page, panel: string): Promise<TitleBox> {
  await page.getByRole('navigation', { name: 'Global panels' }).getByRole('button', { name: panel, exact: true }).click()
  const heading = page.getByRole('heading', { level: 1 }).first()
  await heading.waitFor()
  const box = await heading.boundingBox()
  if (box === null) throw new Error(`${panel}: title has no box`)
  const style = await heading.evaluate((element) => {
    const computed = getComputedStyle(element)
    return { fontSize: computed.fontSize, fontWeight: computed.fontWeight }
  })
  return { x: Math.round(box.x), y: Math.round(box.y), ...style }
}

it('places every panel title like the Plugins page in a centred 960px column', async () => {
  const center = await startMockUserCenter()
  process.env.DSH_E2E_HUB_ORIGIN = center.origin
  const scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAYS })
  const browser = await chromium.launch()
  let failurePage: Page | undefined
  try {
    const page = await newEnglishPage(browser)
    failurePage = page
    const tripwire = watchConsole(page)
    // The Desktop renderer's marker; the Hub account rows contribute only there.
    await page.addInitScript(() => { Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 } }) })
    await page.setViewportSize({ width: 1600, height: 1000 })
    await page.goto(scaffold.authenticatedUrl)
    await connectFreshWorkspace(page, scaffold.workspaceCwd, 'page-header')
    const plugins = await title(page, 'Plugins')
    expect(plugins).toMatchObject({ fontSize: '20px', fontWeight: '500' })
    // Within 4px of the Plugins title: the upstream Automation tasks page itself differs by its
    // scrollbar gutter and a row centred on its buttons.
    for (const panel of ['Automation tasks', 'Skills', 'Connectors', 'Assistants']) {
      const box = await title(page, panel)
      expect({ panel, fontSize: box.fontSize, fontWeight: box.fontWeight }).toEqual({ panel, fontSize: '20px', fontWeight: '500' })
      expect({ panel, dx: Math.abs(box.x - plugins.x) <= 4, dy: Math.abs(box.y - plugins.y) <= 4 }).toEqual({ panel, dx: true, dy: true })
    }
    expect(tripwire.pageErrors).toEqual([])
  } catch (error) {
    if (failurePage !== undefined) await saveFailureShot(failurePage, 'web-e2e-page-header')
    throw error
  } finally {
    await browser.close()
    await scaffold.close()
    await center.close()
    Reflect.deleteProperty(process.env, 'DSH_E2E_HUB_ORIGIN')
  }
})
