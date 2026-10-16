// A collection script as a skill carries it, over the real `ecommerce-accounts`, `hub-account`, and
// `shell-env` rows with a stand-in Google Chrome: the example script is bundled like a skill's, and
// with a signed-in Tmall merchant account it runs in one bash call with that call's environment. It
// reserves the account's browser through `dsh-ecommerce browser`, reads the home page and its report
// table in a background tab, and prints one JSON object; its tab is closed, and the reservation ends
// with the bash call while Chrome keeps running.
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-ecommerce-accounts'
import type {} from '@deepseek-ai/dsh-hub-account'
import type {} from '@deepseek-ai/dsh-shell-env'
import { bundleScript } from '@deepseek-ai/dsh-tmall-skills'
import { Cdp } from '../../../packages/ecommerce/ecommerce-accounts/src/cdp.ts'
import { browse, startMockUserCenter } from '../../../packages/credentials/hub-account/tests/mock-user-center.ts'
import { launchWebScaffold } from './scaffold.ts'
import { killRecordedChrome } from './support.ts'

const OVERLAYS = ['./hub-account.overlay.yml', './ecommerce-accounts.overlay.yml'].map(path => fileURLToPath(new URL(path, import.meta.url)))
const FAKE_CHROME = fileURLToPath(new URL('../../../packages/ecommerce/ecommerce-accounts/tests/fake-chrome.mjs', import.meta.url))
const EXAMPLE = fileURLToPath(new URL('../../../packages/ecommerce/tmall-skills/tests/collect-example.ts', import.meta.url))

it.skipIf(process.platform === 'win32')('runs a bundled collection script in one bash call, closing its tab and ending the reservation', async () => {
  const center = await startMockUserCenter()
  const harnessHome = await mkdtemp(join(tmpdir(), 'dsh-collect-home-'))
  const build = await mkdtemp(join(tmpdir(), 'dsh-collect-build-'))
  await mkdir(join(harnessHome, 'profiles', 'scaffold'), { recursive: true })
  await writeFile(join(harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), JSON.stringify([{
    id: 'ecommerce-accounts', config: { dshHome: harnessHome, chromePath: FAKE_CHROME, signInPollMs: 200, chromeTimeoutMs: 5000, checkTimeoutMs: 3000 },
  }]))
  Object.assign(process.env, { DSH_E2E_HUB_ORIGIN: center.origin })
  const scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAYS, harnessHome }).catch(async (error: unknown) => {
    Reflect.deleteProperty(process.env, 'DSH_E2E_HUB_ORIGIN')
    await center.close()
    throw error
  })
  let accountDir: string | undefined
  try {
    await bundleScript(EXAMPLE, join(build, 'scripts'), 'collect-example.mjs', build)
    const { ctx } = scaffold
    await ctx.hubAccount.signIn()
    await expect.poll(async () => (await ctx.hubAccount.getState()).attempt?.authorizeUrl).toBeDefined()
    await browse((await ctx.hubAccount.getState()).attempt!.authorizeUrl!)
    await expect.poll(async () => (await ctx.hubAccount.getState()).status).toBe('signed-in')
    const { accountId } = await ctx.ecommerceAccounts.addAccount({ platform: 'tmall', kind: 'merchant', storeName: '名流旗舰店', account: 'mingliu:运营' })
    const tenantId = (await ctx.hubAccount.getState()).profile!.tenantId!
    accountDir = join(harnessHome, 'ecommerce', tenantId, 'browsers', accountId)
    await ctx.ecommerceAccounts.startSignIn(accountId)
    await writeFile(join(accountDir, 'user-data', 'fake-signed-in'), 'mingliu:运营')
    await expect.poll(async () => (await ctx.ecommerceAccounts.getState()).accounts[0]!.status, { timeout: 15_000 }).toBe('signed-in')

    // The model's bash call runs the script with the environment and PATH DSH gives that call.
    const call = bashCall('collect-1')
    const dshEnv = ctx.shellEnv.collect(call)
    const env = { ...process.env, ...dshEnv, PATH: [...ctx.shellEnv.collectPath(call), process.env.PATH].join(delimiter) }
    const { cdpUrl } = JSON.parse(await (await fetch(`${dshEnv.DSH_ECOMMERCE_URL!}/browser?id=${accountId}`)).text()) as { cdpUrl: string }
    const before = await pageTabs(cdpUrl)
    const run = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      execFile(process.execPath, [join(build, 'scripts', 'collect-example.mjs'), '--account', accountId], { env, encoding: 'utf8' }, (error, stdout, stderr) => {
        resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : -1, stdout, stderr })
      })
    })
    expect(run).toMatchObject({ code: 0, stderr: '' })
    expect(JSON.parse(run.stdout)).toEqual({
      platform: 'tmall', accountId, store: '名流旗舰店', account: 'mingliu:运营',
      data: { href: 'https://www.tmall.com/', table: { headers: ['日期', '访客数'], rows: [['2026-10-12', '1024']], footer: [] } },
    })
    // The browser is in this call's use until the call ends; the script's tab is already closed.
    expect((await ctx.ecommerceAccounts.getState()).accounts[0]!.inUse).toBe(true)
    expect(await pageTabs(cdpUrl)).toEqual(before)
    ctx.emit('tools/result', call, { isError: false, value: { exitCode: 0 } } as object as ToolExecutionResult)
    await expect.poll(async () => (await ctx.ecommerceAccounts.getState()).accounts[0]!.inUse).toBe(false)
  } finally {
    if (accountDir !== undefined) await killRecordedChrome(accountDir)
    await scaffold.close()
    await center.close()
    await rm(harnessHome, { recursive: true, force: true })
    await rm(build, { recursive: true, force: true })
    Reflect.deleteProperty(process.env, 'DSH_E2E_HUB_ORIGIN')
  }
}, 120_000)

/** A bash call of the model, as the shell hands it to DSH's tools. */
const bashCall = (id: string): ToolExecution => ({
  signal: new AbortController().signal, token: Symbol('collect-e2e') as ToolExecution['token'],
  callId: ToolCallId(id), rootCallId: ToolCallId(id), name: 'bash', arguments: { command: 'node collect-example.mjs' },
})

/** The ids of a Chrome's open page tabs. */
async function pageTabs(cdpUrl: string): Promise<string[]> {
  const cdp = await Cdp.connect(Number(new URL(cdpUrl).port), 5000)
  const list = async () => (await cdp.send<{ targetInfos: { type: string; targetId: string }[] }>('Target.getTargets'))
    .targetInfos.filter(info => info.type === 'page').map(info => info.targetId).sort()
  try {
    // As in Chrome, a tab closed a moment ago may be listed once more.
    await list()
    return await list()
  } finally {
    cdp.close()
  }
}
