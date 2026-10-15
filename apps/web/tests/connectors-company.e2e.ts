// Company tools in conversations, over the real `connectors`, `hub-account`, `shell-env`, bash, and
// `llm-pi-ai` rows: signed in to a mock user center that gives the company 吉客云 (Jackyun), the
// Connectors page shows it under Company tools beside the office platforms. Asked about goods, a
// scripted model runs `jackyun api call` through bash, which reaches the user center through the Host,
// and answers from the platform's result. Asked to create a combo that already exists, the call stops
// without changing anything; the model reruns it with `--confirm-overwrite`, the approval panel warns
// before overwriting, and once allowed the user center gets the confirmation. Switched off on the
// Connectors page, the model shell has no `jackyun` command.
import { once } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'
import { expect, it } from 'vitest'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-connectors'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-hub-account'
import { browse, startMockUserCenter } from '../../../packages/credentials/hub-account/tests/mock-user-center.ts'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { connectFreshWorkspaceZh, saveFailureShot, writeComposerDraft, ZH_BROWSER_LOCALE } from './support.ts'

const SHOTS = process.env.DSH_E2E_SHOTS
// Screenshots for a review show the MO WorkAI look the enterprise build ships.
const OVERLAYS = ['./hub-account.overlay.yml', './connectors.overlay.yml', './connectors-chat.overlay.yml', ...SHOTS === undefined ? [] : ['./brand-mo.overlay.yml']]
  .map(path => fileURLToPath(new URL(path, import.meta.url)))
const ANSWER = 'COMPANY_ANSWER'

/** One chat completion request the mock received. */
interface ChatRequest {
  readonly messages: readonly { readonly role: string; readonly content?: unknown }[]
}

const READ = 'jackyun api call --method erp.storage.goodslist --json \'{"pageSize":1,"goodsNo":"A1"}\''
const IMPORT = 'jackyun api call --method erp.packagegoods.import --json \'{"goodsNo":"ZH-001","goodsName":"名流组合装"}\''

function latestAsk(request: ChatRequest): string {
  return JSON.stringify(request.messages.filter(message => message.role === 'user').at(-1)?.content ?? '')
}

/**
 * The model: runs the command matching the employee's request through bash; after a result that says
 * to rerun with `--confirm-overwrite`, reruns it so; otherwise answers with the last result.
 */
function streamChat(res: ServerResponse, request: ChatRequest): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const chunk = (delta: Record<string, unknown>, finish: string | null) => `data: ${JSON.stringify({
    id: 'chatcmpl-company', object: 'chat.completion.chunk', created: 0, model: 'acme-chat', choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`
  const usage = `data: ${JSON.stringify({
    id: 'chatcmpl-company', object: 'chat.completion.chunk', created: 0, model: 'acme-chat', choices: [],
    usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
  })}\n\n`
  const bash = (command: string) => {
    res.write(chunk({ role: 'assistant', tool_calls: [{
      index: 0, id: `call_bash_${String(request.messages.length)}`, type: 'function',
      function: { name: 'bash', arguments: JSON.stringify({ command, description: '使用吉客云' }) },
    }] }, null))
    res.end(`${chunk({}, 'tool_calls')}${usage}data: [DONE]\n\n`)
  }
  const last = request.messages.at(-1)
  const result = JSON.stringify(last?.content ?? '')
  if (last?.role === 'tool' && result.includes('--confirm-overwrite;')) { bash(`${IMPORT} --confirm-overwrite`); return }
  if (last?.role !== 'tool') { bash(/组合装/u.test(latestAsk(request)) ? IMPORT : READ); return }
  res.write(chunk({ role: 'assistant', content: `${ANSWER} ${result}` }, null))
  res.end(`${chunk({}, 'stop')}${usage}data: [DONE]\n\n`)
}

async function startChat() {
  const chats: ChatRequest[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => { raw += chunk.toString() })
    req.on('end', () => {
      const request = JSON.parse(raw) as ChatRequest
      chats.push(request)
      streamChat(res, request)
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

it.skipIf(process.platform === 'win32')('gives the model the company\'s Jackyun command, confirms an overwrite, and takes it away when switched off', async () => {
  const chat = await startChat()
  const center = await startMockUserCenter()
  center.companyTools = [{
    id: 'c-1', kind: 'jackyun', name: 'jackyun', displayName: '吉客云', description: '查货品、按货品创建组合装。', autoInstall: true,
    allowedMethods: ['erp.storage.goodslist', 'erp-goods.goods.listgoodspackage', 'erp.packagegoods.import'],
  }]
  center.companyReply = ({ body }) => body.method === 'erp.packagegoods.import' && !body.confirmOverwrite
    ? { status: 409, body: { code: 'would_overwrite', message: '会覆盖吉客云里已有的货品：名流组合装（ZH-001），需要确认后再执行', existing: [{ goodsNo: 'ZH-001', goodsName: '名流组合装' }] } }
    : { status: 200, body: { code: 200, msg: '', subCode: '', result: { data: body.method === 'erp.packagegoods.import' ? { skuIds: '901' } : [{ goodsNo: 'A1', goodsName: '名流 500mg' }] } } }
  Object.assign(process.env, { DSH_E2E_HUB_ORIGIN: center.origin, DSH_E2E_CHAT_API: chat.baseURL })
  const harnessHome = await mkdtemp(join(tmpdir(), 'dsh-connectors-company-home-'))
  await mkdir(join(harnessHome, 'profiles', 'scaffold'), { recursive: true })
  const scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAYS, harnessHome })
  const browser = await chromium.launch()
  let failurePage: Page | undefined
  try {
    await scaffold.ctx.hubAccount.signIn()
    await expect.poll(async () => (await scaffold.ctx.hubAccount.getState()).attempt?.authorizeUrl).toBeDefined()
    await browse((await scaffold.ctx.hubAccount.getState()).attempt!.authorizeUrl!)
    await expect.poll(async () => (await scaffold.ctx.hubAccount.getState()).status).toBe('signed-in')
    expect(center.authorizeRequests[0]!.get('scope')).toContain('connectors:use')
    await scaffold.ctx.credentials.set(credentialRef('DSH_E2E_ACME_KEY'), 'sk-acme-e2e')
    await expect.poll(async () => (await scaffold.ctx.connectors.getState()).company.tools.map(tool => tool.name)).toEqual(['jackyun'])

    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: ZH_BROWSER_LOCALE })
    failurePage = page
    await page.addInitScript(() => { Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 } }) })
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl)
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd, 'connectors-company')

    await page.getByRole('button', { name: /^选择模型/ }).click()
    await page.getByRole('menuitem', { name: /^模型/ }).click()
    await page.getByRole('menuitemradio', { name: 'acme-chat' }).click()
    const input = page.locator('[data-composer-input][contenteditable="true"]').first()
    const send = async (text: string) => {
      await writeComposerDraft(page, input, text)
      await page.keyboard.press('Enter')
    }
    const panel = page.locator('[data-approval-key]')

    // A read runs without an approval and the model answers from the platform's result.
    await send('帮我查一下货品 A1')
    await page.getByText(ANSWER).first().waitFor({ timeout: 30_000 })
    await page.getByText(/名流 500mg/u).first().waitFor()
    expect(await panel.count()).toBe(0)
    expect(center.companyCalls).toEqual([{ name: 'jackyun', body: { method: 'erp.storage.goodslist', params: { pageSize: 1, goodsNo: 'A1' }, confirmOverwrite: false } }])

    // The Connectors page shows the company's tools under their own heading.
    await page.getByRole('button', { name: '连接器', exact: true }).click()
    const office = page.getByRole('region', { name: '办公平台' })
    await office.getByText('飞书', { exact: true }).waitFor()
    const listed = page.getByRole('region', { name: '公司提供的工具' }).getByRole('listitem').filter({ hasText: '吉客云' })
    await listed.getByText('查货品、按货品创建组合装。').waitFor()
    await listed.getByText('可调用 3 个接口').waitFor()
    expect(await listed.getByRole('switch', { name: '在对话中使用吉客云' }).getAttribute('aria-checked')).toBe('true')
    if (SHOTS !== undefined) {
      for (const [locale, name] of [[ZH_BROWSER_LOCALE, 'zh'], ['en-US', 'en']] as const) {
        for (const colorScheme of ['light', 'dark'] as const) {
          const shot = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale, colorScheme })
          await shot.addInitScript(() => { Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 } }) })
          await shot.goto(scaffold.authenticatedUrl)
          await shot.getByRole('button', { name: name === 'zh' ? '连接器' : 'Connectors', exact: true }).click()
          await shot.getByRole('region', { name: name === 'zh' ? '公司提供的工具' : 'Company tools' }).getByRole('listitem').first().waitFor()
          await shot.screenshot({ path: join(SHOTS, `${name}-${colorScheme}-connectors.png`) })
          await shot.close()
        }
      }
    }
    await page.getByText(/查一下货品 A1/u).first().click()

    // A combo that exists stops; rerun with the flag, it waits for the user and then overwrites.
    const answers = await page.getByText(ANSWER).count()
    await send('按货品创建组合装 ZH-001')
    await panel.getByText(/^⚠️ 覆盖已有数据：吉客云将以你的身份修改已存在的货品或组合装/u).waitFor({ timeout: 30_000 })
    expect(center.companyCalls.map(call => call.body.confirmOverwrite)).toEqual([false, false])
    if (SHOTS !== undefined) await page.screenshot({ path: join(SHOTS, 'connectors-company-overwrite.png') })
    await panel.getByRole('button', { name: '允许一次', exact: true }).click()
    await expect.poll(async () => page.getByText(ANSWER).count(), { timeout: 30_000 }).toBeGreaterThan(answers)
    expect(center.companyCalls.at(-1)!.body).toEqual({
      method: 'erp.packagegoods.import', params: { goodsNo: 'ZH-001', goodsName: '名流组合装' }, confirmOverwrite: true,
    })
    await page.getByText(/skuIds/u).first().waitFor()

    // Switched off, the model shell has no jackyun command.
    await page.getByRole('button', { name: '连接器', exact: true }).click()
    const card = page.getByRole('region', { name: '公司提供的工具' }).getByRole('listitem').filter({ hasText: '吉客云' })
    await card.getByRole('switch', { name: '在对话中使用吉客云' }).click()
    await card.getByText('已停用：对话中的模型不会使用吉客云。').waitFor()
    const calls = center.companyCalls.length
    await page.getByText(/查一下货品 A1/u).first().click()
    await page.getByText(/skuIds/u).first().waitFor()
    const asks = chat.chats.length
    await send('帮我查一下货品 A1')
    // The bash result, then the answer from it.
    await expect.poll(() => chat.chats.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(asks + 2)
    expect(center.companyCalls.length).toBe(calls)
    expect(JSON.stringify(chat.chats.at(-1)!.messages.at(-1)!.content)).toMatch(/jackyun: (command )?not found|command not found/u)
    expect(tripwire.pageErrors).toEqual([])
  } catch (error) {
    if (failurePage !== undefined) await saveFailureShot(failurePage, 'web-e2e-connectors-company')
    throw error
  } finally {
    await browser.close()
    await scaffold.close()
    await chat.close()
    await center.close()
    await rm(harnessHome, { recursive: true, force: true })
    Reflect.deleteProperty(process.env, 'DSH_E2E_HUB_ORIGIN')
    Reflect.deleteProperty(process.env, 'DSH_E2E_CHAT_API')
  }
})
