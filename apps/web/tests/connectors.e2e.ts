// The Connectors page over the real `connectors` and `hub-account` rows: signed in to a mock user
// center, the employee opens 连接器 from the sidebar, sees Feishu and DingTalk offered with +,
// retries an install after the download sources fail, watches the CLI download and
// get checked, and sees the installed Feishu card turn red. A stand-in lark-cli then walks the
// sign-in: the dialog shows each step's QR code and address and opens it in the browser, and the
// card turns green with the account; a failing health check turns it yellow; disconnecting deletes
// the tenant's sign-in, a cancelled sign-in leaves nothing behind, and uninstalling removes the CLI.
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
import { FAKE_LARK_CLI } from '../../../packages/connector/connectors/tests/fake-lark-cli.ts'
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

it.skipIf(process.platform === 'win32')('installs, connects, checks, disconnects, and uninstalls Feishu from the Connectors page', async () => {
  const work = await mkdtemp(join(tmpdir(), 'dsh-connectors-cli-'))
  await writeFile(join(work, 'lark-cli'), FAKE_LARK_CLI, { mode: 0o755 })
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
    await page.addInitScript(() => {
      Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 } })
      const opened: string[] = []
      Object.defineProperty(globalThis, '__opened', { value: opened })
      globalThis.open = (url?: string | URL) => { opened.push(String(url)); return null }
    })
    const opened = () => page.evaluate(() => Reflect.get(globalThis, '__opened') as string[])
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl)

    // The sidebar entry sits beside Knowledge and opens the cards.
    await page.getByRole('button', { name: '连接器', exact: true }).click()
    await page.getByRole('heading', { name: '连接器' }).waitFor({ timeout: 15_000 })
    const feishuCard = page.getByRole('listitem').filter({ hasText: '飞书' })
    const dingtalkCard = page.getByRole('listitem').filter({ hasText: '钉钉' })
    await feishuCard.getByText('lark-cli 9.9.9').waitFor()
    // DingTalk is offered with its pinned dws; installing it is connectors-dingtalk.e2e.ts's.
    await dingtalkCard.getByText('dws 1.0.63').waitFor()
    expect(await dingtalkCard.getByRole('button', { name: '安装钉钉' }).count()).toBe(1)

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
    expect(await feishuCard.getByRole('button', { name: '连接', exact: true }).count()).toBe(1)

    // Connect: the dialog walks both steps, each opened in the browser, and the card turns green.
    const tenantId = (await scaffold.ctx.hubAccount.getState()).profile!.tenantId!
    const root = join(harnessHome, 'connectors', 'feishu')
    const control = join(root, 'control')
    const tenantDir = join(root, 'tenants', tenantId)
    await feishuCard.getByRole('button', { name: '连接', exact: true }).click()
    const login = page.getByRole('dialog', { name: '连接飞书' })
    await login.getByRole('img', { name: '飞书授权二维码' }).waitFor()
    await login.getByText('https://open.feishu.cn/page/cli?user_code=APP-1').waitFor()
    expect(await login.locator('[aria-current="step"]').textContent()).toBe('1. 创建飞书应用')
    await expect.poll(opened).toEqual(['https://open.feishu.cn/page/cli?user_code=APP-1'])
    await writeFile(join(control, 'app'), 'ok')
    await login.getByText('https://accounts.feishu.cn/verify?user_code=USER-1').waitFor()
    expect(await login.locator('[aria-current="step"]').textContent()).toBe('2. 授权飞书账号')
    await expect.poll(opened).toHaveLength(2)
    await writeFile(join(control, 'user'), 'ok')
    await login.waitFor({ state: 'detached' })
    await feishuCard.getByText('已连接').waitFor()
    await feishuCard.getByText('已登录：韩梅梅').waitFor()
    expect(await feishuCard.locator('[data-state="done"]').count()).toBe(1)
    expect(await stat(join(tenantDir, 'config', 'config.json')).then(() => true)).toBe(true)

    // A failing health check turns the card yellow; checking again after it recovers turns it green.
    await writeFile(join(control, 'status.json'), JSON.stringify({ identities: { user: { status: 'verify_failed', message: 'token unusable: refresh failed' } } }))
    await feishuCard.getByRole('button', { name: '飞书的更多操作' }).click()
    await page.getByRole('menuitem', { name: '重新检查' }).click()
    await feishuCard.getByText('连接异常：token unusable: refresh failed。可以点「⋯」重新检查或重新连接。').waitFor()
    expect(await feishuCard.locator('[data-state="warning"]').count()).toBe(1)
    await rm(join(control, 'status.json'))
    await feishuCard.getByRole('button', { name: '飞书的更多操作' }).click()
    await page.getByRole('menuitem', { name: '重新检查' }).click()
    await feishuCard.getByText('已连接').waitFor()

    // Disconnect after confirming: red again, the tenant's sign-in is deleted, and the CLI stays.
    await feishuCard.getByRole('button', { name: '飞书的更多操作' }).click()
    await page.getByRole('menuitem', { name: '断开' }).click()
    await page.getByRole('dialog', { name: '断开飞书' }).getByRole('button', { name: '断开' }).click()
    await feishuCard.getByText('未连接').waitFor()
    await expect.poll(() => stat(tenantDir).then(() => true, () => false)).toBe(false)
    expect(await stat(join(root, VERSION, 'lark-cli')).then(() => true)).toBe(true)

    // A refused app and a cancelled sign-in leave nothing behind.
    await feishuCard.getByRole('button', { name: '连接', exact: true }).click()
    await login.getByText('https://open.feishu.cn/page/cli?user_code=APP-1').waitFor()
    await writeFile(join(control, 'app'), 'fail:the tenant does not allow employees to create apps')
    await feishuCard.getByText('无法创建飞书应用：the tenant does not allow employees to create apps。如果公司不允许员工自建应用，请联系管理员。').waitFor()
    await feishuCard.getByRole('button', { name: '连接', exact: true }).click()
    await login.getByText('https://open.feishu.cn/page/cli?user_code=APP-1').waitFor()
    await login.getByRole('button', { name: '取消连接' }).last().click()
    await login.waitFor({ state: 'detached' })
    await feishuCard.getByText('未连接').waitFor()
    await expect.poll(() => stat(tenantDir).then(() => true, () => false)).toBe(false)

    // Uninstall after confirming: back to +, and the CLI is gone.
    await feishuCard.getByRole('button', { name: '飞书的更多操作' }).click()
    await page.getByRole('menuitem', { name: '卸载' }).click()
    const dialog = page.getByRole('dialog', { name: '卸载飞书连接器' })
    await dialog.getByText('将删除 DSH 为它安装的 lark-cli，以及本机所有公司的飞书登录凭据，之后可以重新安装。你自己在电脑上安装的 lark-cli 不受影响。').waitFor()
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
