// Assistants over the real `assistants`, `hub-account`, and `llm-pi-ai` rows: the first sign-in to a
// mock user center creates the Daily Assistant as the company default. The employee opens 智能体 from
// the sidebar, finds the cards, and starts a chat with the default; the scripted model's request carries
// the assistant's core files after the deployment persona, and an edit to a core file on disk reaches
// the next request. A new session picks another assistant in the hero picker, and its first request
// carries that assistant's identity instead.
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'
import { expect, it } from 'vitest'
import type {} from '@deepseek-ai/dsh-assistants'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-hub-account'
import { browse, startMockUserCenter } from '../../../packages/credentials/hub-account/tests/mock-user-center.ts'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { connectFreshWorkspaceZh, saveFailureShot, writeComposerDraft, ZH_BROWSER_LOCALE } from './support.ts'

const OVERLAYS = ['./hub-account.overlay.yml', './assistants.overlay.yml'].map(path => fileURLToPath(new URL(path, import.meta.url)))
const ANSWER = 'ASSISTANT_ANSWER'
const SHOP_ID = 'shop-keeper'

/** One chat completion request the mock received. */
interface ChatRequest {
  readonly messages: readonly { readonly role: string; readonly content?: unknown }[]
}

/** The system prompt of a request. */
function systemPrompt(request: ChatRequest): string {
  return request.messages.filter(message => message.role === 'system').map(message => JSON.stringify(message.content ?? '')).join('\n')
}

function streamChat(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const chunk = (delta: Record<string, unknown>, finish: string | null) => `data: ${JSON.stringify({
    id: 'chatcmpl-assistants', object: 'chat.completion.chunk', created: 0, model: 'acme-chat', choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`
  const usage = `data: ${JSON.stringify({
    id: 'chatcmpl-assistants', object: 'chat.completion.chunk', created: 0, model: 'acme-chat', choices: [],
    usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
  })}\n\n`
  res.write(chunk({ role: 'assistant', content: ANSWER }, null))
  res.end(`${chunk({}, 'stop')}${usage}data: [DONE]\n\n`)
}

async function startChat() {
  const chats: ChatRequest[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => { raw += chunk.toString() })
    req.on('end', () => {
      chats.push(JSON.parse(raw) as ChatRequest)
      streamChat(res)
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

/** A second assistant the employee keeps in the company's folder before signing in. */
async function writeShopKeeper(tenantDir: string): Promise<void> {
  const dir = join(tenantDir, SHOP_ID)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'assistant.json'), JSON.stringify({
    version: 1, id: SHOP_ID, name: '店铺测试助手', description: '帮店铺做运营复盘', avatar: { kind: 'preset', key: 'sun' }, createdAt: '2030-01-01T00:00:00.000Z',
  }))
  await writeFile(join(dir, 'IDENTITY.md'), '# 身份\n\n- **名称**：店铺测试助手 SHOP_IDENTITY\n')
}

it('creates the default assistant, carries its core files into the chat, and lets a new session pick another', async () => {
  const chat = await startChat()
  const center = await startMockUserCenter()
  Object.assign(process.env, { DSH_E2E_HUB_ORIGIN: center.origin, DSH_E2E_CHAT_API: chat.baseURL })
  const harnessHome = await mkdtemp(join(tmpdir(), 'dsh-assistants-home-'))
  await mkdir(join(harnessHome, 'profiles', 'scaffold'), { recursive: true })
  await writeFile(join(harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), JSON.stringify([{ id: 'assistants', config: { dshHome: harnessHome } }]))
  const tenantDir = join(harnessHome, 'assistants', 't-a')
  await writeShopKeeper(tenantDir)
  const scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAYS, harnessHome })
  const browser = await chromium.launch()
  let failurePage: Page | undefined
  try {
    await scaffold.ctx.hubAccount.signIn()
    await expect.poll(async () => (await scaffold.ctx.hubAccount.getState()).attempt?.authorizeUrl).toBeDefined()
    await browse((await scaffold.ctx.hubAccount.getState()).attempt!.authorizeUrl!)
    await expect.poll(async () => (await scaffold.ctx.hubAccount.getState()).status).toBe('signed-in')
    await scaffold.ctx.credentials.set(credentialRef('DSH_E2E_ACME_KEY'), 'sk-acme-e2e')
    await expect.poll(async () => (await scaffold.ctx.assistants.getState()).assistants.length).toBe(2)
    const { defaultId } = await scaffold.ctx.assistants.getState()
    expect(defaultId).not.toBe(SHOP_ID)
    expect(JSON.parse(await readFile(join(tenantDir, 'tenant.json'), 'utf8'))).toEqual({ version: 1, defaultId, seeded: true })

    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: ZH_BROWSER_LOCALE })
    failurePage = page
    await page.addInitScript(() => { Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 } }) })
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl)
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd, 'assistants')

    // The sidebar entry opens the cards: the Daily Assistant is the default, and search narrows the list.
    await page.getByRole('button', { name: '智能体', exact: true }).click()
    await page.getByRole('heading', { name: '智能体' }).waitFor()
    const daily = page.locator(`[data-assistant-id="${defaultId!}"]`)
    await expect.poll(() => daily.textContent()).toContain('默认')
    await expect.poll(() => page.locator(`li[data-assistant-id="${SHOP_ID}"]`).textContent()).toContain('帮店铺做运营复盘')
    await page.getByRole('textbox', { name: '搜索智能体' }).fill('运营')
    await expect.poll(() => page.locator('li[data-assistant-id]').count()).toBe(1)
    await page.getByRole('textbox', { name: '搜索智能体' }).fill('')

    // Chat opens a new session bound to the Daily Assistant; its request carries the core files.
    await daily.getByRole('button', { name: '对话' }).click()
    const picker = page.getByRole('button', { name: '选择这个会话的智能体' })
    await expect.poll(() => picker.textContent()).toContain('日常助手')
    await page.getByRole('button', { name: /^选择模型/ }).click()
    await page.getByRole('menuitem', { name: /^模型/ }).click()
    await page.getByRole('menuitemradio', { name: 'acme-chat' }).click()
    const input = page.locator('[data-composer-input][contenteditable="true"]').first()
    const send = async (text: string) => {
      await writeComposerDraft(page, input, text)
      await page.keyboard.press('Enter')
    }
    await send('你好，你是谁？')
    await page.getByText(ANSWER).first().waitFor({ timeout: 30_000 })
    const first = systemPrompt(chat.chats.at(-1)!)
    expect(first).toContain('You are the assistant \\"日常助手\\"')
    expect(first).toContain('<core_file name=\\"IDENTITY.md\\">')
    expect(first).not.toContain('SHOP_IDENTITY')
    // The picker is gone once the session started.
    expect(await picker.count()).toBe(0)

    // An edit to a core file on disk reaches the next request of the same session.
    await writeFile(join(tenantDir, defaultId!, 'SOUL.md'), '# 人格\n\n回答结尾加上 SOUL_EDITED。\n')
    await send('再说一次')
    await expect.poll(() => page.getByText(ANSWER).count(), { timeout: 30_000 }).toBe(2)
    expect(systemPrompt(chat.chats.at(-1)!)).toContain('SOUL_EDITED')

    // A new session picks another assistant in the hero picker; its first request carries that identity.
    await page.getByRole('button', { name: '新建会话' }).first().click()
    await expect.poll(() => picker.textContent()).toContain('日常助手')
    await picker.click()
    await page.getByRole('menuitem', { name: /店铺测试助手/ }).click()
    await expect.poll(() => picker.textContent()).toContain('店铺测试助手')
    await send('今天的运营怎么样？')
    await expect.poll(() => chat.chats.filter(request => systemPrompt(request).includes('SHOP_IDENTITY')).length, { timeout: 30_000 }).toBe(1)
    expect(systemPrompt(chat.chats.at(-1)!)).toContain('You are the assistant \\"店铺测试助手\\"')
    expect(tripwire.pageErrors).toEqual([])
  } catch (error) {
    if (failurePage !== undefined) await saveFailureShot(failurePage, 'assistants')
    throw error
  } finally {
    await browser.close()
    await scaffold.close()
    await center.close()
    await chat.close()
  }
}, 180_000)
