// Settings → E-commerce accounts over the real `ecommerce-accounts` and `hub-account` rows, with a
// stand-in Google Chrome: the section appears once the Desktop signs in to a mock user center; the
// employee adds a Tmall merchant account, which opens the sign-in page in that account's own
// Chrome, and the dialog turns to success once the platform answers with the account's nick. A
// second add of the same account is refused, and the account name is corrected to the one Tmall
// reports. A Pinduoduo shop signs in the same way; when its sign-in ends, an app-wide notice leads
// back to Settings. Deleting an account closes its Chrome and removes its browser data.
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'
import { expect, it } from 'vitest'
import type {} from '@deepseek-ai/dsh-ecommerce-accounts'
import type {} from '@deepseek-ai/dsh-hub-account'
import { browse, startMockUserCenter } from '../../../packages/credentials/hub-account/tests/mock-user-center.ts'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { openSettings, saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const OVERLAYS = ['./hub-account.overlay.yml', './ecommerce-accounts.overlay.yml'].map(path => fileURLToPath(new URL(path, import.meta.url)))
const FAKE_CHROME = fileURLToPath(new URL('../../../packages/ecommerce/ecommerce-accounts/tests/fake-chrome.mjs', import.meta.url))

it.skipIf(process.platform === 'win32')('adds a Tmall merchant account, signs it in through its own Chrome, and deletes it', async () => {
  const center = await startMockUserCenter()
  Object.assign(process.env, { DSH_E2E_HUB_ORIGIN: center.origin })
  const harnessHome = await mkdtemp(join(tmpdir(), 'dsh-ecommerce-home-'))
  await mkdir(join(harnessHome, 'profiles', 'scaffold'), { recursive: true })
  await writeFile(join(harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), JSON.stringify([{
    id: 'ecommerce-accounts', config: { dshHome: harnessHome, chromePath: FAKE_CHROME, signInPollMs: 200, chromeTimeoutMs: 5000, checkTimeoutMs: 3000 },
  }]))
  const scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAYS, harnessHome })
  const browser = await chromium.launch()
  let failurePage: Page | undefined
  let accountDir: string | undefined
  let pddDir: string | undefined
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: ZH_BROWSER_LOCALE })
    failurePage = page
    await page.addInitScript(() => { Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 } }) })
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl)
    await openSettings(page, 'zh')
    const settings = page.getByRole('dialog', { name: '设置' })
    // Signed out of the user center there are no accounts, so there is no section.
    await settings.getByRole('button', { name: '通用设置', exact: true }).waitFor()
    expect(await settings.getByRole('button', { name: '电商账号', exact: true }).count()).toBe(0)

    await scaffold.ctx.hubAccount.signIn()
    await expect.poll(async () => (await scaffold.ctx.hubAccount.getState()).attempt?.authorizeUrl).toBeDefined()
    await browse((await scaffold.ctx.hubAccount.getState()).attempt!.authorizeUrl!)
    await expect.poll(async () => (await scaffold.ctx.hubAccount.getState()).status).toBe('signed-in')
    await settings.getByRole('button', { name: '电商账号', exact: true }).click()
    const section = settings.getByRole('region', { name: '电商账号' })
    await section.getByText('还没有电商账号。').waitFor({ timeout: 10_000 })

    // Add the account: the form says Chrome is needed, and signing in opens Tmall's sign-in page in its Chrome.
    await section.getByRole('button', { name: '添加第一个账号' }).click()
    const add = page.getByRole('dialog', { name: '新增账号' })
    await add.getByText('本功能需要搭配Google浏览器使用。').waitFor()
    await add.getByPlaceholder('例如：名流旗舰店', { exact: true }).fill('名流旗舰店')
    await add.getByPlaceholder('例如：名流旗舰店:运营').fill('mingliu:运营')
    await add.getByRole('button', { name: '去登录' }).click()
    const signIn = page.getByRole('dialog', { name: '登录天猫' })
    await signIn.getByText('已在 Google Chrome 中打开天猫登录页', { exact: false }).waitFor({ timeout: 10_000 })
    const { accounts } = await scaffold.ctx.ecommerceAccounts.getState()
    const tenantId = (await scaffold.ctx.hubAccount.getState()).profile!.tenantId!
    accountDir = join(harnessHome, 'ecommerce', tenantId, 'browsers', accounts[0]!.id)
    const argsFile = join(accountDir, 'user-data', 'fake-args.json')
    await expect.poll(() => access(argsFile).then(() => true, () => false), { timeout: 10_000 }).toBe(true)
    const args = JSON.parse(await readFile(argsFile, 'utf8')) as string[]
    expect(args).toContain(`--user-data-dir=${join(accountDir, 'user-data')}`)
    expect(args).toContain('--restore-last-session')

    // The user scans the QR code in Chrome: the tab moves on, the platform answers, and the dialog turns to success.
    await writeFile(join(accountDir, 'user-data', 'fake-signed-in'), '名流旗舰店:运营')
    await signIn.getByText('登录成功，平台显示的账号是「名流旗舰店:运营」', { exact: false }).waitFor({ timeout: 15_000 })
    await signIn.getByRole('note').getByText('实际登录的是「名流旗舰店:运营」，与填写的账号不一致。').waitFor()
    await signIn.getByRole('button', { name: '完成' }).click()
    const row = section.getByRole('button', { name: '查看 名流旗舰店 的详情' })
    await expect.poll(() => row.textContent()).toContain('已登录')
    const ledger = await readFile(join(harnessHome, 'ecommerce', tenantId, 'accounts.json'), 'utf8')
    expect(ledger).not.toMatch(/cookie|password/iu)

    // The same account cannot be added twice.
    await section.getByRole('button', { name: '新增账号' }).click()
    await add.getByPlaceholder('例如：名流旗舰店', { exact: true }).fill('名流旗舰店')
    await add.getByPlaceholder('例如：名流旗舰店:运营').fill('mingliu:运营')
    await add.getByRole('button', { name: '去登录' }).click()
    await add.getByRole('alert').getByText('当前账号已添加').waitFor()
    await add.getByRole('button', { name: '取消' }).click()

    // The details offer the account name Tmall reports instead of the one entered.
    await row.click()
    await section.getByRole('note').getByRole('button', { name: '改为实际账号名' }).click()
    await expect.poll(async () => (await scaffold.ctx.ecommerceAccounts.getState()).accounts[0]!.account).toBe('名流旗舰店:运营')
    await section.getByRole('note').waitFor({ state: 'detached' })
    await section.getByRole('button', { name: '返回账号列表', exact: false }).click()

    // A Pinduoduo shop signs in the same way; Pinduoduo reports no account name.
    await section.getByRole('button', { name: '新增账号' }).click()
    await add.getByRole('combobox', { name: '平台' }).selectOption('pinduoduo')
    await add.getByPlaceholder('例如：名流旗舰店', { exact: true }).fill('拼多多小店')
    await add.getByPlaceholder('例如：名流旗舰店:运营').fill('pdd:运营')
    await add.getByRole('button', { name: '去登录' }).click()
    const pddSignIn = page.getByRole('dialog', { name: '登录拼多多' })
    await pddSignIn.waitFor()
    pddDir = join(harnessHome, 'ecommerce', tenantId, 'browsers', (await scaffold.ctx.ecommerceAccounts.getState()).accounts[1]!.id)
    await expect.poll(() => access(join(pddDir!, 'user-data', 'fake-args.json')).then(() => true, () => false), { timeout: 10_000 }).toBe(true)
    await writeFile(join(pddDir, 'user-data', 'fake-signed-in'), 'pdd')
    await pddSignIn.getByText('登录成功。这个 Chrome 会在后台保持登录。').waitFor({ timeout: 15_000 })
    await pddSignIn.getByRole('button', { name: '完成' }).click()
    const pddRow = section.getByRole('button', { name: '查看 拼多多小店 的详情' })
    await expect.poll(() => pddRow.textContent()).toContain('已登录')

    // Its sign-in ends: the next check finds it signed out, and a notice leads back to Settings.
    await rm(join(pddDir, 'user-data', 'fake-signed-in'))
    await scaffold.ctx.ecommerceAccounts.refresh()
    const notice = page.getByRole('alert').filter({ hasText: '电商账号「拼多多小店」的登录已失效' })
    await notice.waitFor({ timeout: 10_000 })
    await page.keyboard.press('Escape')
    await settings.waitFor({ state: 'detached' })
    await notice.getByText('去重新登录').click()
    await settings.getByRole('region', { name: '电商账号' }).getByText('未登录或登录过期').waitFor({ timeout: 10_000 })

    // Delete both: each account's Chrome closes and its browser data goes.
    for (const name of ['名流旗舰店', '拼多多小店']) {
      await section.getByRole('button', { name: `查看 ${name} 的详情` }).click()
      await section.getByRole('button', { name: '删除账号' }).click()
      await page.getByRole('dialog', { name: '删除电商账号' }).getByRole('button', { name: '删除', exact: true }).click()
      await section.getByRole('button', { name: `查看 ${name} 的详情` }).waitFor({ state: 'detached', timeout: 15_000 })
    }
    await section.getByText('还没有电商账号。').waitFor({ timeout: 15_000 })
    await expect(access(accountDir)).rejects.toThrow()
    await expect(access(pddDir)).rejects.toThrow()
    expect(tripwire.pageErrors).toEqual([])
  } catch (error) {
    if (failurePage !== undefined) await saveFailureShot(failurePage, 'web-e2e-ecommerce-accounts')
    throw error
  } finally {
    await browser.close()
    // A failed run may leave the stand-in Chrome running; deleting the account would have closed it.
    for (const dir of [accountDir, pddDir]) {
      if (dir === undefined) continue
      const record = await readFile(join(dir, 'chrome.json'), 'utf8').catch(() => undefined)
      if (record !== undefined) process.kill((JSON.parse(record) as { pid: number }).pid, 'SIGKILL')
    }
    await scaffold.close()
    await center.close()
    await rm(harnessHome, { recursive: true, force: true })
    Reflect.deleteProperty(process.env, 'DSH_E2E_HUB_ORIGIN')
  }
}, 120_000)
