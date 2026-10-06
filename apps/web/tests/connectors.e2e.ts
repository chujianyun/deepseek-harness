// The Connectors page over the real `connectors` and `hub-account` rows: signed in to a mock user
// center, the employee opens 连接器 from the sidebar, sees Feishu offered with + and DingTalk as
// coming soon, retries an install after the download sources fail, watches the CLI download and
// get checked, sees the installed Feishu card turn red (not connected), and uninstalls it.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'
import { expect, it } from 'vitest'
import type {} from '@deepseek-ai/dsh-connectors'
import type {} from '@deepseek-ai/dsh-hub-account'
import { browse, startMockUserCenter } from '../../../packages/credentials/hub-account/tests/mock-user-center.ts'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const OVERLAYS = ['./hub-account.overlay.yml', './connectors.overlay.yml'].map(path => fileURLToPath(new URL(path, import.meta.url)))
const VERSION = '9.9.9'
const FILE = `lark-cli-${VERSION}.tar.gz`

/** A loopback download source that can refuse every request or hold them until released. */
async function startMirror(archive: Buffer) {
  const state: { refuse: boolean; hold: Promise<void> | undefined; requests: number } = { refuse: false, hold: undefined, requests: 0 }
  const server = createServer((req, res) => {
    void (async () => {
      state.requests += 1
      await state.hold
      if (state.refuse || req.url !== `/v${VERSION}/${FILE}`) { res.writeHead(404).end(); return }
      res.writeHead(200).end(archive)
    })()
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  const origin = `http://127.0.0.1:${String(typeof address === 'object' && address !== null ? address.port : 0)}`
  return { state, origin, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => { resolve() }) }) }
}

it.skipIf(process.platform === 'win32')('installs and uninstalls the Feishu CLI from the Connectors page, retrying after a failed download', async () => {
  // A stand-in lark-cli: a script reporting the pinned version.
  const work = await mkdtemp(join(tmpdir(), 'dsh-connectors-cli-'))
  await writeFile(join(work, 'lark-cli'), `#!/bin/sh\necho "lark-cli version ${VERSION}"\n`, { mode: 0o755 })
  execFileSync('tar', ['-czf', join(work, FILE), '-C', work, 'lark-cli'])
  const archive = await readFile(join(work, FILE))
  const mirror = await startMirror(archive)
  const center = await startMockUserCenter()
  Object.assign(process.env, { DSH_E2E_HUB_ORIGIN: center.origin })
  const harnessHome = await mkdtemp(join(tmpdir(), 'dsh-connectors-home-'))
  await mkdir(join(harnessHome, 'profiles', 'scaffold'), { recursive: true })
  const feishu = {
    binary: 'lark-cli', version: VERSION, mirrors: [`${mirror.origin}/v{version}/{file}`],
    archives: [{ platform: `${process.platform}-${process.arch}`, file: FILE, size: archive.length, sha256: createHash('sha256').update(archive).digest('hex') }],
  }
  await writeFile(join(harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), JSON.stringify([{ id: 'connectors', config: { dshHome: harnessHome, feishu } }]))
  const scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAYS, harnessHome })
  const browser = await chromium.launch()
  let failurePage: Page | undefined
  try {
    await scaffold.ctx.hubAccount.signIn()
    await expect.poll(async () => (await scaffold.ctx.hubAccount.getState()).attempt?.authorizeUrl).toBeDefined()
    await browse((await scaffold.ctx.hubAccount.getState()).attempt!.authorizeUrl!)
    await expect.poll(async () => (await scaffold.ctx.hubAccount.getState()).status).toBe('signed-in')
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: ZH_BROWSER_LOCALE })
    failurePage = page
    await page.addInitScript(() => { Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 } }) })
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl)

    // The sidebar entry sits beside Knowledge and opens the cards.
    await page.getByRole('button', { name: '连接器', exact: true }).click()
    await page.getByRole('heading', { name: '连接器' }).waitFor({ timeout: 15_000 })
    const feishuCard = page.getByRole('listitem').filter({ hasText: '飞书' })
    const dingtalkCard = page.getByRole('listitem').filter({ hasText: '钉钉' })
    await feishuCard.getByText('lark-cli 9.9.9').waitFor()
    await dingtalkCard.getByText('即将支持').waitFor()
    expect(await dingtalkCard.getByRole('button').count()).toBe(0)

    // No download source answers: the card explains and offers + again.
    mirror.state.refuse = true
    await feishuCard.getByRole('button', { name: '安装飞书' }).click()
    await feishuCard.getByRole('alert').getByText('lark-cli 下载失败：无法连接下载源，请检查网络后点 + 重试。').waitFor({ timeout: 15_000 })

    // Retry: the card shows the install in progress, then the red not-connected dot.
    mirror.state.refuse = false
    let release!: () => void
    mirror.state.hold = new Promise((resolve) => { release = resolve })
    await feishuCard.getByRole('button', { name: '安装飞书' }).click()
    await feishuCard.getByRole('status', { name: '正在安装飞书' }).waitFor()
    await feishuCard.getByRole('progressbar').waitFor()
    release()
    await feishuCard.getByText('未连接').waitFor({ timeout: 15_000 })
    expect(await feishuCard.locator('[data-state="error"]').count()).toBe(1)
    expect(await feishuCard.getByRole('alert').count()).toBe(0)
    const installed = join(harnessHome, 'connectors', 'feishu', VERSION, 'lark-cli')
    expect(execFileSync(installed, ['--version'], { encoding: 'utf8' }).trim()).toBe(`lark-cli version ${VERSION}`)

    // Uninstall after confirming: back to +, and the CLI is gone.
    await feishuCard.getByRole('button', { name: '飞书的更多操作' }).click()
    await page.getByRole('menuitem', { name: '卸载' }).click()
    const dialog = page.getByRole('dialog', { name: '卸载飞书连接器' })
    await dialog.getByText('将删除 DSH 为它安装的 lark-cli，之后可以重新安装。你自己在电脑上安装的 lark-cli 不受影响。').waitFor()
    await dialog.getByRole('button', { name: '卸载' }).click()
    await feishuCard.getByRole('button', { name: '安装飞书' }).waitFor()
    await expect.poll(() => stat(join(harnessHome, 'connectors', 'feishu')).then(() => true, () => false)).toBe(false)
    expect(tripwire.pageErrors).toEqual([])
  } catch (error) {
    if (failurePage !== undefined) await saveFailureShot(failurePage, 'web-e2e-connectors')
    throw error
  } finally {
    await browser.close()
    await scaffold.close()
    await mirror.close()
    await center.close()
    await rm(harnessHome, { recursive: true, force: true })
    await rm(work, { recursive: true, force: true })
    Reflect.deleteProperty(process.env, 'DSH_E2E_HUB_ORIGIN')
  }
})
