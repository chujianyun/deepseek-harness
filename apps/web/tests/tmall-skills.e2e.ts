// The Tmall data skills in a conversation, over the real `ecommerce-accounts`, `hub-account`, `skill`,
// `shell-env`, bash, and `llm-pi-ai` rows with a stand-in Google Chrome: the two skills are packed as
// for the Skill Hub and installed as user skills; signed in to a mock user center with a signed-in
// Tmall merchant account, the employee asks for each report, and a scripted model finds the skill in
// the catalog, lists the accounts, and runs the skill's script with the account in bash. The script
// takes over the account's browser through `dsh-ecommerce`, reads the stand-in's Alimama and
// Business Advisor figures, writes the reports into the workspace, and its summary reaches the chat.
// The publish-category skill then finds a new item's category by product name and saves that
// category's field rules, with the declarations the store must confirm, and the product-draft skill
// sorts a material folder without detail images into a draft checked against those rules.
// With a signed-in buyer account instead, the item skill's script lets DSH pick the buyer account,
// opens each item page once (counted toward the account's pages today), reads the stand-in's item,
// 问大家, and reviews, stops at risk control keeping what it read and has DSH rest the account, and is
// refused while the account rests.
import { once } from 'node:events'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'
import { expect, it } from 'vitest'
import type {} from '@deepseek-ai/dsh-agent'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-ecommerce-accounts'
import type {} from '@deepseek-ai/dsh-hub-account'
import { packSkills } from '@deepseek-ai/dsh-tmall-skills'
import { png } from '../../../packages/ecommerce/tmall-skills/tests/images.ts'
import { browse, startMockUserCenter } from '../../../packages/credentials/hub-account/tests/mock-user-center.ts'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { connectFreshWorkspaceZh, saveFailureShot, writeComposerDraft, ZH_BROWSER_LOCALE } from './support.ts'

const OVERLAYS = ['./hub-account.overlay.yml', './ecommerce-accounts.overlay.yml', './connectors-chat.overlay.yml']
  .map(path => fileURLToPath(new URL(path, import.meta.url)))
const FAKE_CHROME = fileURLToPath(new URL('../../../packages/ecommerce/ecommerce-accounts/tests/fake-chrome.mjs', import.meta.url))
const ANSWER = 'TMALL_SKILL_ANSWER'
/** What the scripted model answers about the material folder: titles it wrote and the store's brand. */
const DRAFT_ANSWERS = { values: {
  商品标题: { value: '名流水多多三合一玻尿酸避孕套', source: '模型生成' }, 商品卖点: { value: '玻尿酸润滑', source: '模型生成' },
  导购标题: { value: '名流水多多', source: '模型生成' }, 品牌: { value: '名流', source: '店铺资料' },
} }
/** The skill each request asks for, and its script. */
const SCRIPTS: Record<string, string> = {
  'tmall-alimama-scene-report': 'alimama-scene-report.mjs',
  'tmall-sycm-core-daily': 'sycm-core-daily.mjs',
}

/** One chat completion request the mock received. */
interface ChatRequest {
  readonly messages: readonly { readonly role: string; readonly content?: unknown }[]
}

/**
 * The model: for a request naming a skill that the catalog lists, it lists the accounts, runs that
 * skill's script with the first account, then answers with what the script printed.
 */
function streamChat(res: ServerResponse, request: ChatRequest, skillsDir: string): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const chunk = (delta: Record<string, unknown>, finish: string | null) => `data: ${JSON.stringify({
    id: 'chatcmpl-tmall', object: 'chat.completion.chunk', created: 0, model: 'acme-chat', choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`
  const usage = `data: ${JSON.stringify({
    id: 'chatcmpl-tmall', object: 'chat.completion.chunk', created: 0, model: 'acme-chat', choices: [],
    usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
  })}\n\n`
  const lastAsk = request.messages.findLastIndex(message => message.role === 'user' && /2026-10-06 的|采集商品|定天猫类目|整理素材/u.test(JSON.stringify(message.content ?? '')))
  const asked = JSON.stringify(request.messages[lastAsk]?.content ?? '')
  const results = request.messages.slice(lastAsk + 1).filter(message => message.role === 'tool').map(message => JSON.stringify(message.content))
  const catalog = JSON.stringify(request.messages.map(message => message.content ?? ''))
  const skill = Object.keys(SCRIPTS).find(name => asked.includes(name.endsWith('core-daily') ? '生意参谋' : '万相台') && catalog.includes(`\`${name}\``))
  const bash = (command: string) => {
    res.write(chunk({ role: 'assistant', tool_calls: [{
      index: 0, id: `call_bash_${String(request.messages.length)}`, type: 'function',
      function: { name: 'bash', arguments: JSON.stringify({ command, description: '天猫取数' }) },
    }] }, null))
    res.end(`${chunk({}, 'tool_calls')}${usage}data: [DONE]\n\n`)
  }
  if (asked.includes('采集商品') && catalog.includes('`tmall-item-report`') && results.length === 0) {
    const items = asked.match(/\d{12}/gu) ?? []
    bash(`"${process.execPath}" "${join(skillsDir, 'tmall-item-report', 'scripts', 'item-report.mjs')}" ${items.join(' ')}`)
    return
  }
  const publishing = asked.includes('定天猫类目') && catalog.includes('`tmall-publish-category`')
  if ((skill !== undefined || publishing) && results.length === 0) { bash('dsh-ecommerce accounts'); return }
  const id = /\\"id\\": \\"([0-9a-f-]{36})\\"/u.exec(results[0] ?? '')?.[1]
  const publish = `"${process.execPath}" "${join(skillsDir, 'tmall-publish-category', 'scripts', 'publish-category.mjs')}"`
  if (publishing && results.length === 1 && id !== undefined) { bash(`${publish} resolve --account ${id} --keyword 避孕套`); return }
  if (publishing && results.length === 2) { bash(`${publish} rules --account ${id as string} --cat 50024154`); return }
  const organizing = asked.includes('整理素材') && catalog.includes('`ecommerce-product-draft`')
  const draft = `"${process.execPath}" "${join(skillsDir, 'ecommerce-product-draft', 'scripts', 'product-draft.mjs')}"`
  if (organizing && results.length === 0) { bash(`${draft} inventory --folder 素材`); return }
  if (organizing && results.length === 1) {
    bash(`printf '%s' '${JSON.stringify(DRAFT_ANSWERS)}' > 发品草稿/答案.json && ${draft} draft --folder 素材 --answers 发品草稿/答案.json --rules 天猫发品/字段规则_50024154.json`)
    return
  }
  if (skill !== undefined && results.length === 1 && id !== undefined) {
    bash(`"${process.execPath}" "${join(skillsDir, skill, 'scripts', SCRIPTS[skill] as string)}" --account ${id} --date 2026-10-06`)
    return
  }
  res.write(chunk({ role: 'assistant', content: `${ANSWER} ${results.at(-1) ?? 'no skill'}` }, null))
  res.end(`${chunk({}, 'stop')}${usage}data: [DONE]\n\n`)
}

async function startChat(skillsDir: string) {
  const chats: ChatRequest[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => { raw += chunk.toString() })
    req.on('end', () => {
      const request = JSON.parse(raw) as ChatRequest
      chats.push(request)
      streamChat(res, request, skillsDir)
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    baseURL: `http://127.0.0.1:${String((server.address() as { port: number }).port)}/v1`,
    chats,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => { resolve() }) }),
  }
}

it.skipIf(process.platform === 'win32')('runs the packed Tmall data skills with a signed-in merchant account and saves their reports in the workspace', async () => {
  const harnessHome = await mkdtemp(join(tmpdir(), 'dsh-tmall-skills-home-'))
  const skillsDir = join(harnessHome, 'skills')
  await packSkills(skillsDir)
  const chat = await startChat(skillsDir)
  const center = await startMockUserCenter()
  Object.assign(process.env, { DSH_E2E_HUB_ORIGIN: center.origin, DSH_E2E_CHAT_API: chat.baseURL })
  await mkdir(join(harnessHome, 'profiles', 'scaffold'), { recursive: true })
  await writeFile(join(harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), JSON.stringify([{
    id: 'ecommerce-accounts', config: { dshHome: harnessHome, chromePath: FAKE_CHROME, signInPollMs: 200, chromeTimeoutMs: 5000, checkTimeoutMs: 3000 },
  }]))
  const scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAYS, harnessHome })
  const browser = await chromium.launch()
  let failurePage: Page | undefined
  let accountDir: string | undefined
  try {
    await scaffold.ctx.hubAccount.signIn()
    await expect.poll(async () => (await scaffold.ctx.hubAccount.getState()).attempt?.authorizeUrl).toBeDefined()
    await browse((await scaffold.ctx.hubAccount.getState()).attempt!.authorizeUrl!)
    await expect.poll(async () => (await scaffold.ctx.hubAccount.getState()).status).toBe('signed-in')
    await scaffold.ctx.credentials.set(credentialRef('DSH_E2E_ACME_KEY'), 'sk-acme-e2e')

    const accounts = scaffold.ctx.ecommerceAccounts
    const { accountId } = await accounts.addAccount({ platform: 'tmall', kind: 'merchant', storeName: '名流旗舰店', account: 'mingliu:运营' })
    await accounts.startSignIn(accountId)
    const tenantId = (await scaffold.ctx.hubAccount.getState()).profile!.tenantId!
    accountDir = join(harnessHome, 'ecommerce', tenantId, 'browsers', accountId)
    await expect.poll(() => readFile(join(accountDir!, 'chrome.json'), 'utf8').then(() => true, () => false), { timeout: 10_000 }).toBe(true)
    await writeFile(join(accountDir, 'user-data', 'fake-signed-in'), '名流旗舰店:运营')
    await expect.poll(async () => (await accounts.getState()).accounts[0]!.status, { timeout: 15_000 }).toBe('signed-in')

    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: ZH_BROWSER_LOCALE })
    failurePage = page
    await page.addInitScript(() => { Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 } }) })
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl)
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd, 'tmall-skills')
    await page.getByRole('button', { name: /^选择模型/ }).click()
    await page.getByRole('menuitem', { name: /^模型/ }).click()
    await page.getByRole('menuitemradio', { name: 'acme-chat' }).click()
    const input = page.locator('[data-composer-input][contenteditable="true"]').first()
    const send = async (text: string) => {
      await writeComposerDraft(page, input, text)
      await page.keyboard.press('Enter')
    }
    const reports = join(scaffold.workspaceCwd, 'tmall-skills', '天猫报表')

    // Alimama: one row per scene, with rates recomputed from the stand-in's raw figures.
    await send('请拉一下 2026-10-06 的万相台营销场景报表')
    await page.getByText(ANSWER).first().waitFor({ timeout: 60_000 })
    const lastResult = () => JSON.stringify(chat.chats.at(-1)!.messages.findLast(message => message.role === 'tool')!.content)
    const alimama = lastResult()
    expect(alimama).toContain('万相台营销场景报表 · 名流旗舰店 · 2026-10-06')
    expect(alimama).toContain('| 合计 | 10801.40 | | 26520.55 | | 2.46 |')
    const csv = await readFile(join(reports, '万相台营销场景报表_名流旗舰店_2026-10-06.csv'), 'utf8')
    expect(csv.split('\r\n')[2]).toBe('2026-10-06,436,货品全站推广,10151.40,93003,6214,6.68%,1.63,25904.68,638,596,2.55,15.91,10.27%,427,6.87%,23.77,82.74%,43.46,90350,607.35')
    // The reservation ended with the bash call, and the skill's tab is closed.
    await expect.poll(async () => (await accounts.getState()).accounts[0]!.inUse).toBe(false)
    expect(JSON.parse(await readFile(join(accountDir, 'user-data', 'fake-tabs.json'), 'utf8'))).not.toContainEqual(expect.stringContaining('alimama'))

    // Business Advisor: the day's row from the export, with its spend checked against Alimama.
    await send('请拉一下 2026-10-06 的生意参谋店铺经营核心日报')
    await expect.poll(() => page.getByText(ANSWER).count(), { timeout: 60_000 }).toBe(2)
    const sycm = lastResult()
    expect(sycm).toContain('✅ 推广花费与万相台一致（关键词推广 650.00，人群推广 0.00，货品全站推广 10151.40）。')
    expect(sycm).toContain('| 支付买家数 | 681 |')
    const day = await readFile(join(reports, '生意参谋店铺经营核心日报_名流旗舰店_2026-10-06.csv'), 'utf8')
    expect(day).toContain('支付金额,"34,000.20"')
    expect((await readFile(join(reports, '生意参谋店铺经营核心日报_名流旗舰店_2026-10-06.xlsx')).then(bytes => bytes.subarray(0, 2).toString('latin1')))).toBe('PK')

    // Publishing: the category found by product name, then its field rules with the two declarations.
    await send('新品是避孕套，请帮我定天猫类目并读取字段规则')
    await expect.poll(() => page.getByText(ANSWER).count(), { timeout: 60_000 }).toBe(3)
    const tools = chat.chats.at(-1)!.messages.filter(message => message.role === 'tool').slice(-2).map(message => JSON.stringify(message.content))
    expect(tools[0]).toContain('1. 计生用品 > 避孕套（类目 id 50024154）—— 天猫类目搜索「避孕套」')
    expect(tools[0]).toContain('另有 1 个类目这家店未授权，不能用：医疗器械 > 安全套')
    const rules = lastResult()
    expect(rules).toContain('类目：计生用品 > 避孕套（50024154），共 5 个字段。')
    expect(rules).toContain('- 品牌（p-20000，select，只读），可选 1 项：名流')
    expect(rules).toContain('- 请检查产品标签和说明书，确认发布的医疗器械可以由消费者个人自行使用。（personalUseConfirm）')
    const publishing = join(scaffold.workspaceCwd, 'tmall-skills', '天猫发品')
    expect(JSON.parse(await readFile(join(publishing, '字段规则_50024154.json'), 'utf8'))).toMatchObject({ store: '名流旗舰店', catId: '50024154' })
    expect((await readdir(publishing)).sort()).toEqual(['字段规则_50024154.json', '类目缓存_名流旗舰店.json'])

    // A material folder without detail images becomes a draft checked against those rules; nothing fills the detail.
    const materials = join(scaffold.workspaceCwd, 'tmall-skills', '素材')
    for (const [file, bytes] of [
      ['方图/主图-1.png', png(120, 120)], ['长图/主图-1.png', png(90, 120)], ['素材图/白底.png', png(100, 100, 'white')],
      ['素材图/透明图.png', png(80, 80, 'clear')], ['sku图/sku1.png', png(100, 100)], ['sku图/sku2.png', png(100, 100)],
      ['sku.csv', '序号,上架名称,商家编码,到手价\nSKU1,尝鲜装 18只,ml-a,42.9\nSKU2,超值装 40只,ml-b,69.9\n'],
    ] as const) {
      await mkdir(join(materials, file, '..'), { recursive: true })
      await writeFile(join(materials, file), bytes)
    }
    await send('请帮我整理素材文件夹，生成商品草稿')
    await expect.poll(() => page.getByText(ANSWER).count(), { timeout: 60_000 }).toBe(4)
    const sorted = chat.chats.at(-1)!.messages.filter(message => message.role === 'tool').at(-2)
    expect(JSON.stringify(sorted?.content)).toContain('- 1:1 主图（1）：')
    const drafted = lastResult()
    expect(drafted).toContain('图片：1:1 主图 1、3:4 主图 1、白底图 1、透明素材图 1、详情图 0、SKU 图 2')
    expect(drafted).toContain('| SKU1 | 尝鲜装 18只 | ml-a |  | 42.9 |  | sku图/sku1.png |')
    expect(drafted).toContain('按类目 计生用品 > 避孕套（50024154）的字段规则检查：缺失 0、不符合 0、待店铺确认 2、待确认 1、已填 2')
    const draftDir = join(scaffold.workspaceCwd, 'tmall-skills', '发品草稿')
    expect((await readdir(draftDir)).sort()).toEqual(['商品草稿.json', '待确认清单.md', '答案.json', '素材清点.json'])
    expect(JSON.parse(await readFile(join(draftDir, '商品草稿.json'), 'utf8'))).toMatchObject({ catId: '50024154', images: { detail: [] } })
    expect(tripwire.pageErrors).toEqual([])
  } catch (error) {
    if (failurePage !== undefined) await saveFailureShot(failurePage, 'web-e2e-tmall-skills')
    throw error
  } finally {
    await browser.close()
    if (accountDir !== undefined) {
      const record = await readFile(join(accountDir, 'chrome.json'), 'utf8').catch(() => undefined)
      if (record !== undefined) process.kill((JSON.parse(record) as { pid: number }).pid, 'SIGKILL')
    }
    await scaffold.close()
    await chat.close()
    await center.close()
    await rm(harnessHome, { recursive: true, force: true })
    Reflect.deleteProperty(process.env, 'DSH_E2E_HUB_ORIGIN')
    Reflect.deleteProperty(process.env, 'DSH_E2E_CHAT_API')
  }
}, 180_000)

it.skipIf(process.platform === 'win32')('runs the packed item skill with a buyer account DSH picks, stops at risk control, rests the account, and is refused while it rests', async () => {
  const harnessHome = await mkdtemp(join(tmpdir(), 'dsh-tmall-item-home-'))
  const skillsDir = join(harnessHome, 'skills')
  await packSkills(skillsDir)
  const chat = await startChat(skillsDir)
  const center = await startMockUserCenter()
  Object.assign(process.env, { DSH_E2E_HUB_ORIGIN: center.origin, DSH_E2E_CHAT_API: chat.baseURL })
  await mkdir(join(harnessHome, 'profiles', 'scaffold'), { recursive: true })
  await writeFile(join(harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), JSON.stringify([{
    id: 'ecommerce-accounts', config: { dshHome: harnessHome, chromePath: FAKE_CHROME, signInPollMs: 200, chromeTimeoutMs: 5000, checkTimeoutMs: 3000 },
  }]))
  const scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAYS, harnessHome })
  const browser = await chromium.launch()
  let failurePage: Page | undefined
  let accountDir: string | undefined
  try {
    await scaffold.ctx.hubAccount.signIn()
    await expect.poll(async () => (await scaffold.ctx.hubAccount.getState()).attempt?.authorizeUrl).toBeDefined()
    await browse((await scaffold.ctx.hubAccount.getState()).attempt!.authorizeUrl!)
    await expect.poll(async () => (await scaffold.ctx.hubAccount.getState()).status).toBe('signed-in')
    await scaffold.ctx.credentials.set(credentialRef('DSH_E2E_ACME_KEY'), 'sk-acme-e2e')

    // A signed-in Tmall buyer account; the day's limit is two pages.
    const accounts = scaffold.ctx.ecommerceAccounts
    await accounts.setBuyerDailyPages(2)
    const { accountId } = await accounts.addAccount({ platform: 'tmall', kind: 'buyer', storeName: '', account: 'tb_buyer_1' })
    await accounts.startSignIn(accountId)
    const tenantId = (await scaffold.ctx.hubAccount.getState()).profile!.tenantId!
    accountDir = join(harnessHome, 'ecommerce', tenantId, 'browsers', accountId)
    await expect.poll(() => readFile(join(accountDir!, 'chrome.json'), 'utf8').then(() => true, () => false), { timeout: 10_000 }).toBe(true)
    await writeFile(join(accountDir, 'user-data', 'fake-signed-in'), 'tb_buyer_1')
    await expect.poll(async () => (await accounts.getState()).accounts[0]!.status, { timeout: 15_000 }).toBe('signed-in')

    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: ZH_BROWSER_LOCALE })
    failurePage = page
    await page.addInitScript(() => { Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 } }) })
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl)
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd, 'tmall-item')
    await page.getByRole('button', { name: /^选择模型/ }).click()
    await page.getByRole('menuitem', { name: /^模型/ }).click()
    await page.getByRole('menuitemradio', { name: 'acme-chat' }).click()
    const input = page.locator('[data-composer-input][contenteditable="true"]').first()
    const send = async (text: string) => {
      await writeComposerDraft(page, input, text)
      await page.keyboard.press('Enter')
    }
    const lastResult = () => JSON.stringify(chat.chats.at(-1)!.messages.findLast(message => message.role === 'tool')!.content)
    const reports = join(scaffold.workspaceCwd, 'tmall-item', '天猫报表')

    // The first item is read in full; the second hits risk control, and what it read is kept.
    await send('请采集商品 794818635459 和 600000000004 做单品报告')
    await page.getByText(ANSWER).first().waitFor({ timeout: 90_000 })
    const first = lastResult()
    expect(first).toContain('买家号 tb_buyer_1（DSH 自动挑选，今天开始时剩 2 页）')
    expect(first).toContain('- 794818635459 名流 超薄避孕套 【10只】：主图 2、详情图 1（保存图片 4 张），SKU 2，问大家 2，评价 4（主列表 2，负面标签 1，追评 1；中差评视图 2），接口调用 4 次。')
    expect(first).toContain('读取问大家时平台出现风控（滑块或身份验证），已立即停止，没有尝试验证、重试或换号')
    const item = join(reports, '单品_794818635459')
    const report = await readFile(join(item, '报告.md'), 'utf8')
    expect(report).toContain('| 【10只】超薄 | 10 | 29.9 | 19.9 | 1.99 | 有货 |')
    expect(report).toContain('「用了一次就破了，质量太差」')
    expect((await readdir(join(item, 'images'))).sort()).toEqual(['desc_01.jpg', 'main_01.jpg', 'main_02.jpg', 'sku_01_【10只】超薄.jpg'])
    expect(await readFile(join(reports, '单品_600000000004', '报告.md'), 'utf8')).toContain('⚠️ 采集中途停止')
    // Each item page counted once toward the buyer account's pages today; the script told DSH about the
    // risk control the APIs met, so the account rests, and it is free of the call again.
    await expect.poll(async () => (await accounts.getState()).accounts[0]!.pagesToday).toBe(2)
    const rested = (await accounts.getState()).accounts[0]!
    expect([rested.inUse, typeof rested.cooldownUntil]).toEqual([false, 'string'])
    expect(first).toContain(`DSH 已让买家号 tb_buyer_1 冷却到 ${rested.cooldownUntil as string}，期间不会再被挑选。`)

    // The resting account is not handed out: the next request stops before any page opens.
    await send('请采集商品 524565741530 做单品报告')
    await expect.poll(() => page.getByText(ANSWER).count(), { timeout: 60_000 }).toBe(2)
    expect(lastResult()).toContain('is resting after the platform')
    expect((await accounts.getState()).accounts[0]!.pagesToday).toBe(2)
    expect(tripwire.pageErrors).toEqual([])
  } catch (error) {
    if (failurePage !== undefined) await saveFailureShot(failurePage, 'web-e2e-tmall-item')
    throw error
  } finally {
    await browser.close()
    if (accountDir !== undefined) {
      const record = await readFile(join(accountDir, 'chrome.json'), 'utf8').catch(() => undefined)
      if (record !== undefined) process.kill((JSON.parse(record) as { pid: number }).pid, 'SIGKILL')
    }
    await scaffold.close()
    await chat.close()
    await center.close()
    await rm(harnessHome, { recursive: true, force: true })
    Reflect.deleteProperty(process.env, 'DSH_E2E_HUB_ORIGIN')
    Reflect.deleteProperty(process.env, 'DSH_E2E_CHAT_API')
  }
}, 240_000)
