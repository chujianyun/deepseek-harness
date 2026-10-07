// E-commerce accounts in conversations, over the real `ecommerce-accounts`, `hub-account`, `skill`,
// `shell-env`, bash, and `llm-pi-ai` rows with a stand-in Google Chrome: signed in to a mock user
// center with a signed-in Tmall merchant account, the employee asks for store data; a scripted model
// sees the `ecommerce-accounts` Skill in the catalog, lists the accounts through `dsh-ecommerce`
// in bash, takes over the account's browser, and answers with its DevTools address, which reaches
// the account's own Chrome. Once the account is signed out, the same request stops with the way to
// Settings → E-commerce accounts.
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
import { browse, startMockUserCenter } from '../../../packages/credentials/hub-account/tests/mock-user-center.ts'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { connectFreshWorkspaceZh, saveFailureShot, writeComposerDraft, ZH_BROWSER_LOCALE } from './support.ts'

const OVERLAYS = ['./hub-account.overlay.yml', './ecommerce-accounts.overlay.yml', './connectors-chat.overlay.yml']
  .map(path => fileURLToPath(new URL(path, import.meta.url)))
const FAKE_CHROME = fileURLToPath(new URL('../../../packages/ecommerce/ecommerce-accounts/tests/fake-chrome.mjs', import.meta.url))
const ANSWER = 'ECOMMERCE_ANSWER'

/** One chat completion request the mock received. */
interface ChatRequest {
  readonly messages: readonly { readonly role: string; readonly content?: unknown }[]
}

/**
 * The model: with the Skill in the catalog it lists the accounts, then takes over the first one's
 * browser, then answers with what the last command printed.
 */
function streamChat(res: ServerResponse, request: ChatRequest): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const chunk = (delta: Record<string, unknown>, finish: string | null) => `data: ${JSON.stringify({
    id: 'chatcmpl-ecommerce', object: 'chat.completion.chunk', created: 0, model: 'acme-chat', choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`
  const usage = `data: ${JSON.stringify({
    id: 'chatcmpl-ecommerce', object: 'chat.completion.chunk', created: 0, model: 'acme-chat', choices: [],
    usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
  })}\n\n`
  const lastUser = request.messages.findLastIndex(message => message.role === 'user')
  const results = request.messages.slice(lastUser + 1).filter(message => message.role === 'tool').map(message => JSON.stringify(message.content))
  const catalog = request.messages.some(message => JSON.stringify(message.content ?? '').includes('`ecommerce-accounts`'))
  const bash = (command: string) => {
    res.write(chunk({ role: 'assistant', tool_calls: [{
      index: 0, id: `call_bash_${String(request.messages.length)}`, type: 'function',
      function: { name: 'bash', arguments: JSON.stringify({ command, description: '使用电商账号' }) },
    }] }, null))
    res.end(`${chunk({}, 'tool_calls')}${usage}data: [DONE]\n\n`)
  }
  if (catalog && results.length === 0) { bash('dsh-ecommerce accounts'); return }
  const id = /\\"id\\": \\"([0-9a-f-]{36})\\"/u.exec(results[0] ?? '')?.[1]
  if (catalog && results.length === 1 && id !== undefined) { bash(`dsh-ecommerce browser ${id}`); return }
  res.write(chunk({ role: 'assistant', content: `${ANSWER} ${results.at(-1) ?? 'no skill'}` }, null))
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

it.skipIf(process.platform === 'win32')('lets the model list the accounts, take over a signed-in browser, and stop at a signed-out account', async () => {
  const chat = await startChat()
  const center = await startMockUserCenter()
  Object.assign(process.env, { DSH_E2E_HUB_ORIGIN: center.origin, DSH_E2E_CHAT_API: chat.baseURL })
  const harnessHome = await mkdtemp(join(tmpdir(), 'dsh-ecommerce-chat-home-'))
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

    // A signed-in Tmall merchant account, signed in through the stand-in Chrome.
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
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd, 'ecommerce-chat')
    await page.getByRole('button', { name: /^选择模型/ }).click()
    await page.getByRole('menuitem', { name: /^模型/ }).click()
    await page.getByRole('menuitemradio', { name: 'acme-chat' }).click()
    const input = page.locator('[data-composer-input][contenteditable="true"]').first()
    const send = async (text: string) => {
      await writeComposerDraft(page, input, text)
      await page.keyboard.press('Enter')
    }

    // The catalog offers the Skill; the model lists the accounts and takes over the browser.
    await send('看一下天猫店铺的数据')
    await page.getByText(ANSWER).first().waitFor({ timeout: 30_000 })
    const browserCall = chat.chats.at(-1)!.messages.at(-1)!
    expect(browserCall.role).toBe('tool')
    const port = (JSON.parse(await readFile(join(accountDir, 'chrome.json'), 'utf8')) as { port: number }).port
    expect(JSON.stringify(browserCall.content)).toContain(`http://127.0.0.1:${String(port)}`)
    const listed = JSON.stringify(chat.chats.find(request => request.messages.filter(message => message.role === 'tool').length === 1)!.messages.at(-1)!.content)
    expect(listed).toContain('名流旗舰店')
    expect(listed).not.toMatch(/cookie|user-data/iu)
    // The reservation ended with the bash call.
    await expect.poll(async () => (await accounts.getState()).accounts[0]!.inUse).toBe(false)

    // Signed out, the same request stops with the way to Settings.
    await rm(join(accountDir, 'user-data', 'fake-signed-in'))
    await send('再看一下天猫店铺的数据')
    await expect.poll(() => page.getByText(ANSWER).count(), { timeout: 30_000 }).toBe(2)
    expect(JSON.stringify(chat.chats.at(-1)!.messages.at(-1)!.content)).toContain('is signed out. Stop, and ask the user to sign in again in DSH Settings')
    expect(tripwire.pageErrors).toEqual([])
  } catch (error) {
    if (failurePage !== undefined) await saveFailureShot(failurePage, 'web-e2e-ecommerce-chat')
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
}, 120_000)
