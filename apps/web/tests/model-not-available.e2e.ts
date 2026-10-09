// A model the signed-in account may not use: ChatGPT (Codex) refuses a model its plan lacks with a stream error, and
// Anthropic refuses a model that needs bought credits with HTTP 429 `credits_required`. Both endpoints are loopback
// stand-ins answering in the providers' wire formats; the refusal must end the turn at once with a localized row,
// not retry as a rate limit or show the raw JSON.
import { createServer, type IncomingMessage } from 'node:http'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'
import { describe, expect, it } from 'vitest'
import type {} from '@deepseek-ai/dsh-hub-account'
import { browse, startMockUserCenter } from '../../../packages/credentials/hub-account/tests/mock-user-center.ts'
import { launchWebScaffold, watchConsole, webSnapshotMode } from './scaffold.ts'
import { connectFreshWorkspaceZh, saveFailureShot, writeComposerDraft, ZH_BROWSER_LOCALE } from './support.ts'

const OVERLAY = fileURLToPath(new URL('./hub-account.overlay.yml', import.meta.url))
const ROW = '当前账号不能使用这个模型（套餐不包含，或需要另购额度）。请换一个模型，或到服务商处开通后重试。'
const ANTHROPIC_KEY = 'E2E_ANTHROPIC_KEY'

/** An access token shaped like ChatGPT's: the Codex transport reads the account id from its claims. */
function chatgptToken(): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-e2e' } })}.sig`
}

/** One loopback server standing in for both providers; it counts the requests each receives. */
async function startRefusingProviders() {
  const counts = { codex: 0, anthropic: 0 }
  const server = createServer((req: IncomingMessage, res) => {
    req.resume()
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/codex/responses') {
        counts.codex += 1
        // Codex refuses inside the event stream, as the real service does for a model the plan lacks.
        const refusal = { type: 'error', message: "The 'gpt-5.3-codex-spark' model is not supported when using Codex with a ChatGPT account." }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(`event: error\ndata: ${JSON.stringify(refusal)}\n\n`)
        return
      }
      if (req.method === 'POST' && req.url?.split('?')[0] === '/v1/messages') {
        counts.anthropic += 1
        // The SDK's own retry is turned off by the header, so every count is a harness attempt.
        res.writeHead(429, { 'content-type': 'application/json', 'x-should-retry': 'false' })
        res.end(JSON.stringify({ type: 'error', error: {
          type: 'rate_limit_error', message: 'Usage credits are required for this model.',
          details: { error_code: 'credits_required', can_user_purchase_credits: true, model: 'claude-fable-5' },
        } }))
        return
      }
      res.writeHead(404).end()
    })
  })
  server.on('upgrade', (_req, socket) => { socket.destroy() })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing provider server address')
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    counts,
    close: () => new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() }),
  }
}

/** Send one message with the named model and return the failure row it ends in. */
async function sendWith(page: Page, model: string, text: string) {
  await page.getByRole('button', { name: /^选择模型/ }).click()
  await page.getByRole('menuitem', { name: /^模型/ }).click()
  await page.getByRole('menuitemradio', { name: model, exact: true }).click()
  const rows = page.getByRole('status').filter({ hasText: 'MODEL_NOT_AVAILABLE' })
  const before = await rows.count()
  const chat = page.locator('[data-composer-input][contenteditable="true"]').first()
  await writeComposerDraft(page, chat, text)
  await page.keyboard.press('Enter')
  await expect.poll(() => rows.count(), { timeout: 30_000 }).toBe(before + 1)
  return rows.last()
}

// The keyless lane masks DEEPSEEK_API_KEY, which record mode needs; the scenario records no Session.
describe.skipIf(webSnapshotMode() === 'record')('web e2e: a model the account may not use', () => {
  it('ends the turn at once with a localized row for a ChatGPT plan refusal and an Anthropic credits refusal', async () => {
    const center = await startMockUserCenter()
    const providers = await startRefusingProviders()
    process.env.DSH_E2E_HUB_ORIGIN = center.origin
    process.env[ANTHROPIC_KEY] = 'sk-ant-e2e'
    const scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY, deepSeekMissingCredential: true })
    const browser = await chromium.launch()
    let failurePage: Page | undefined
    try {
      await scaffold.ctx.hubAccount.signIn()
      await expect.poll(async () => (await scaffold.ctx.hubAccount.getState()).attempt?.authorizeUrl).toBeDefined()
      await browse((await scaffold.ctx.hubAccount.getState()).attempt!.authorizeUrl!)
      await expect.poll(async () => (await scaffold.ctx.hubAccount.getState()).status).toBe('signed-in')
      await scaffold.ctx.credentials.modifyRecord('llm-pi-ai/openai-codex' as never, () => Promise.resolve({
        kind: 'grant', payload: { type: 'oauth', access: chatgptToken(), refresh: 'refresh-e2e', expires: Date.now() + 3_600_000 },
      }))
      await scaffold.ctx.settings.update('llm-pi-ai', { providers: {
        'openai-codex': { baseURL: providers.origin },
        anthropic: { baseURL: providers.origin, apiKeyEnv: ANTHROPIC_KEY },
      } })

      const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: ZH_BROWSER_LOCALE })
      failurePage = page
      await page.addInitScript(() => { Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 } }) })
      const tripwire = watchConsole(page)
      await page.goto(scaffold.authenticatedUrl)
      await connectFreshWorkspaceZh(page, scaffold.workspaceCwd, 'model-not-available')

      const codexRow = await sendWith(page, 'GPT-5.3 Codex Spark', '你好')
      expect(await codexRow.textContent()).toContain(ROW)
      expect(await codexRow.getByRole('button', { name: '去配置模型' }).isVisible()).toBe(true)
      expect(providers.counts.codex).toBe(1)

      const claudeRow = await sendWith(page, 'Claude Fable 5', '再试一次')
      expect(await claudeRow.textContent()).toContain(ROW)
      expect(await claudeRow.textContent()).not.toContain('credits_required')
      // Refused once and not retried as a rate limit.
      expect(providers.counts.anthropic).toBe(1)
      expect(tripwire.pageErrors).toEqual([])
    } catch (error) {
      if (failurePage !== undefined) await saveFailureShot(failurePage, 'web-e2e-model-not-available')
      throw error
    } finally {
      await browser.close()
      await scaffold.close()
      await providers.close()
      await center.close()
      Reflect.deleteProperty(process.env, 'DSH_E2E_HUB_ORIGIN')
      Reflect.deleteProperty(process.env, ANTHROPIC_KEY)
    }
  })
})
