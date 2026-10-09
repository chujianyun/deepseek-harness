// Desktop-composed account sign-in over the real Models page, the real authorization namespace, and pi-ai's real
// ChatGPT (Codex) login: an employee adds ChatGPT Codex from Settings → Models, signs in by pasting the redirect URL,
// and talks to a GPT model. Only the two OpenAI endpoints are stand-ins: the token exchange is answered in-process and
// the model endpoint is a loopback Codex server the card's base URL points at.
import { createServer, type IncomingMessage } from 'node:http'
import { once } from 'node:events'
import { gunzipSync, zstdDecompressSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'
import { describe, expect, it } from 'vitest'
import type {} from '@deepseek-ai/dsh-hub-account'
import { browse, startMockUserCenter } from '../../../packages/credentials/hub-account/tests/mock-user-center.ts'
import { launchWebScaffold, watchConsole, webSnapshotMode } from './scaffold.ts'
import { connectFreshWorkspaceZh, openSettings, saveFailureShot, writeComposerDraft, ZH_BROWSER_LOCALE } from './support.ts'

const OVERLAY = fileURLToPath(new URL('./hub-account.overlay.yml', import.meta.url))
const TOKEN_URL = 'https://auth.openai.com/oauth/token'
const REPLY = 'CODEX_SIGN_IN_REPLY_OK'
const ACCOUNT = 'acct-e2e'

/** An access token shaped like ChatGPT's: the Codex transport reads the account id from its claims. */
function chatgptToken(): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode({ 'https://api.openai.com/auth': { chatgpt_account_id: ACCOUNT } })}.sig`
}

/**
 * A loopback Codex endpoint answering every Responses request with one streamed reply. The transport tries a
 * WebSocket upgrade first; cutting it off makes it fall back to HTTP at once.
 */
async function startCodexServer() {
  const requests: { authorization: string | undefined; account: string | undefined; model: string | undefined }[] = []
  const server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/codex/responses') { res.writeHead(404).end(); return }
      // The Codex transport compresses its request body.
      const raw = Buffer.concat(chunks)
      const encoding = req.headers['content-encoding']
      const text = encoding === 'zstd' ? zstdDecompressSync(raw) : encoding === 'gzip' ? gunzipSync(raw) : raw
      const body = JSON.parse(text.toString('utf8')) as { model?: string }
      requests.push({
        authorization: req.headers.authorization,
        account: req.headers['chatgpt-account-id'] as string | undefined,
        model: body.model,
      })
      const event = (value: Record<string, unknown>) => `event: ${String(value['type'])}\ndata: ${JSON.stringify(value)}\n\n`
      const reply = `${REPLY} 来自 ChatGPT。`
      const message = {
        type: 'message', id: 'msg_e2e', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: reply, annotations: [] }],
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write(event({ type: 'response.created', response: { id: 'resp_e2e', status: 'in_progress' } }))
      res.write(event({ type: 'response.output_item.added', output_index: 0, item: { ...message, status: 'in_progress', content: [] } }))
      res.write(event({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: reply }))
      res.write(event({ type: 'response.output_item.done', output_index: 0, item: message }))
      res.end(event({
        type: 'response.completed',
        response: { id: 'resp_e2e', status: 'completed', usage: { input_tokens: 12, output_tokens: 6, total_tokens: 18 } },
      }))
    })
  })
  server.on('upgrade', (_req, socket) => { socket.destroy() })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing Codex server address')
  return {
    baseURL: `http://127.0.0.1:${String(address.port)}`,
    requests,
    close: () => new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() }),
  }
}

/**
 * Answer pi-ai's token exchange in-process, recording what it sent; every other request goes out unchanged.
 * The Host runs in this process, so its `fetch` is this one.
 */
function interceptTokenExchange(access: string) {
  const original = globalThis.fetch
  const exchanges: URLSearchParams[] = []
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url !== TOKEN_URL) return original(input, init)
    exchanges.push(new URLSearchParams(String(init?.body)))
    return new Response(JSON.stringify({ access_token: access, refresh_token: 'refresh-e2e', expires_in: 3600 }), {
      headers: { 'content-type': 'application/json' },
    })
  }
  return { exchanges, restore: () => { globalThis.fetch = original } }
}

// The keyless lane masks DEEPSEEK_API_KEY, which record mode needs; the scenario records no Session.
describe.skipIf(webSnapshotMode() === 'record')('web e2e: account sign-in on the Models page', () => {
  it('adds ChatGPT Codex, signs in by pasting the redirect URL, and chats with a GPT model', async () => {
    const center = await startMockUserCenter()
    const codex = await startCodexServer()
    const access = chatgptToken()
    const tokens = interceptTokenExchange(access)
    process.env.DSH_E2E_HUB_ORIGIN = center.origin
    const scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY, deepSeekMissingCredential: true })
    const browser = await chromium.launch()
    let failurePage: Page | undefined
    try {
      // Signed in to the user center, as the Desktop welcome window guarantees before the workspace opens.
      await scaffold.ctx.hubAccount.signIn()
      await expect.poll(async () => (await scaffold.ctx.hubAccount.getState()).attempt?.authorizeUrl).toBeDefined()
      await browse((await scaffold.ctx.hubAccount.getState()).attempt!.authorizeUrl!)
      await expect.poll(async () => (await scaffold.ctx.hubAccount.getState()).status).toBe('signed-in')

      const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: ZH_BROWSER_LOCALE })
      // The sign-in page opens on its own; it must not reach the real OpenAI.
      const opened: string[] = []
      await context.route('https://auth.openai.com/**', async (route) => { opened.push(route.request().url()); await route.abort() })
      const page = await context.newPage()
      failurePage = page
      await page.addInitScript(() => { Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 } }) })
      const tripwire = watchConsole(page)
      await page.goto(scaffold.authenticatedUrl)

      const step = page.getByRole('dialog', { name: '添加一个 API Key 开始使用' })
      await step.waitFor({ timeout: 20_000 })
      await step.getByRole('button', { name: '使用其他模型提供商' }).click()
      const settings = page.getByRole('dialog', { name: '设置' })
      await settings.waitFor({ timeout: 10_000 })
      const add = settings.getByRole('button', { name: '添加模型提供商' })
      await expect.poll(() => add.isEnabled(), { timeout: 10_000 }).toBe(true)
      await add.click()
      const catalog = settings.getByRole('tabpanel', { name: '第三方模型提供商' })
      await catalog.getByLabel('提供商', { exact: true }).selectOption('openai-codex')

      // A sign-in-only provider: the card offers account sign-in instead of an API key field.
      const signIn = catalog.getByRole('group', { name: '账号登录' })
      await signIn.waitFor()
      expect(await catalog.getByRole('textbox', { name: 'API 密钥', exact: true }).count()).toBe(0)
      await signIn.getByText('该服务商通过登录账号使用，不需要 API 密钥。').waitFor()
      expect(await signIn.getByRole('status').textContent()).toBe('未登录')
      await signIn.getByRole('button', { name: '登录', exact: true }).click()

      // pi-ai asks for the method, then reports the authorization page and waits for the redirect URL.
      await signIn.getByRole('button', { name: 'Browser login (default)' }).click()
      const link = signIn.getByRole('link', { name: '打开登录页' })
      await link.waitFor({ timeout: 10_000 })
      const authorize = new URL((await link.getAttribute('href'))!)
      expect(authorize.origin + authorize.pathname).toBe('https://auth.openai.com/oauth/authorize')
      const state = authorize.searchParams.get('state')!
      await expect.poll(() => opened.length, { timeout: 10_000 }).toBeGreaterThan(0)
      expect(new URL(opened[0]!).searchParams.get('state')).toBe(state)
      const paste = signIn.getByRole('textbox')
      await paste.fill(`http://localhost:1455/auth/callback?code=code-e2e&state=${state}`)
      await signIn.getByRole('button', { name: '提交' }).click()
      await expect.poll(() => signIn.getByRole('status').textContent(), { timeout: 15_000 }).toBe('已登录')
      expect(tokens.exchanges[0]?.get('code')).toBe('code-e2e')
      expect(tokens.exchanges[0]?.get('redirect_uri')).toBe('http://localhost:1455/auth/callback')
      expect(await signIn.getByRole('button', { name: '退出登录' }).isVisible()).toBe(true)

      // Point the route at the loopback Codex server and save it.
      await catalog.getByText('自定义设置').click()
      await catalog.getByLabel('API 地址').fill(codex.baseURL)
      await catalog.getByRole('button', { name: '保存', exact: true }).click()
      const row = settings.getByRole('listitem').filter({ hasText: 'openai-codex' })
      await row.waitFor({ timeout: 10_000 })
      await row.getByRole('img', { name: '已登录' }).waitFor()
      await settings.getByRole('button', { name: '关闭' }).last().click()

      // Pick a GPT model and talk to it: the request carries the signed-in token and account.
      await connectFreshWorkspaceZh(page, scaffold.workspaceCwd, 'codex-sign-in')
      await page.getByRole('button', { name: /^选择模型/ }).click()
      await page.getByRole('menuitem', { name: /^模型/ }).click()
      await page.getByRole('menuitemradio', { name: 'GPT-5.5', exact: true }).click()
      await expect.poll(() => page.getByRole('button', { name: /^选择模型/ }).textContent()).toContain('GPT-5.5')
      const chat = page.locator('[data-composer-input][contenteditable="true"]').first()
      await writeComposerDraft(page, chat, '用一句话介绍你自己')
      await page.keyboard.press('Enter')
      await page.getByText(REPLY).first().waitFor({ timeout: 30_000 })
      expect(codex.requests.at(-1)).toEqual({ authorization: `Bearer ${access}`, account: ACCOUNT, model: 'gpt-5.5' })

      // Signing out forgets the credential; the row reports it missing again.
      await openSettings(page, 'zh')
      await settings.waitFor({ timeout: 10_000 })
      await settings.getByRole('button', { name: '模型', exact: true }).click()
      await settings.getByRole('button', { name: '编辑 openai-codex' }).click()
      await settings.getByRole('group', { name: '账号登录' }).getByRole('button', { name: '退出登录' }).click()
      await expect.poll(() => settings.getByRole('group', { name: '账号登录' }).getByRole('status').textContent()).toBe('未登录')
      await settings.getByRole('listitem').filter({ hasText: 'openai-codex' }).getByRole('img', { name: '未登录' }).waitFor({ timeout: 10_000 })
      expect(await scaffold.ctx.credentials.readRecord('llm-pi-ai/openai-codex' as never)).toBeUndefined()
      expect(tripwire.warnings).toEqual([])
      expect(tripwire.pageErrors).toEqual([])
    } catch (error) {
      if (failurePage !== undefined) await saveFailureShot(failurePage, 'web-e2e-models-account-sign-in')
      throw error
    } finally {
      await browser.close()
      await scaffold.close()
      tokens.restore()
      await codex.close()
      await center.close()
      Reflect.deleteProperty(process.env, 'DSH_E2E_HUB_ORIGIN')
    }
  })
})
