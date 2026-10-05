// Desktop-composed first-run model setup over the real Models page and the real pi-ai adapter,
// with no DeepSeek account and no DeepSeek key: the first-run step offers the official key or
// another provider; a send without a key explains where to configure one; an employee adds an
// OpenAI-compatible gateway (a loopback mock) from Settings → Models and talks to it.
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
const REPLY = 'ACME_GATEWAY_REPLY_OK'
const KEY = 'sk-acme-e2e'

/** A loopback OpenAI-compatible gateway answering every chat completion with one streamed reply. */
async function startOpenAiGateway() {
  const requests: { authorization: string | undefined; body: { model?: string; stream?: boolean } }[] = []
  const server = createServer((req: IncomingMessage, res) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => { raw += chunk })
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return }
      const body = JSON.parse(raw) as { model?: string; stream?: boolean }
      requests.push({ authorization: req.headers.authorization, body })
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const chunk = (delta: Record<string, unknown>, finish: string | null, usage?: Record<string, number>) => `data: ${JSON.stringify({
        id: 'chatcmpl-e2e', object: 'chat.completion.chunk', created: 0, model: body.model,
        choices: [{ index: 0, delta, finish_reason: finish }], ...usage === undefined ? {} : { usage },
      })}\n\n`
      res.write(chunk({ role: 'assistant', content: `${REPLY} ` }, null))
      res.write(chunk({ content: '来自 Acme 网关。' }, null))
      res.end(`${chunk({}, 'stop', { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 })}data: [DONE]\n\n`)
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing gateway address')
  return {
    baseURL: `http://127.0.0.1:${String(address.port)}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() }),
  }
}

// The keyless lane masks DEEPSEEK_API_KEY, which record mode needs; the scenario records no Session.
describe.skipIf(webSnapshotMode() === 'record')('web e2e: Desktop model setup', () => {
  it('guides a keyless Desktop to configure a model and chats through an OpenAI-compatible gateway', async () => {
    const center = await startMockUserCenter()
    const gateway = await startOpenAiGateway()
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

      const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: ZH_BROWSER_LOCALE })
      failurePage = page
      await page.addInitScript(() => { Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 } }) })
      const tripwire = watchConsole(page)
      await page.goto(scaffold.authenticatedUrl)

      // First run without any usable model: the step offers the official key or another provider,
      // and "another provider" opens Settings on Models.
      const step = page.getByRole('dialog', { name: '添加一个 API Key 开始使用' })
      await step.waitFor({ timeout: 20_000 })
      await step.getByRole('button', { name: '稍后配置' }).waitFor()
      await step.getByRole('button', { name: '使用其他模型提供商' }).click()
      await step.waitFor({ state: 'detached' })
      const settings = page.getByRole('dialog', { name: '设置' })
      await settings.waitFor({ timeout: 10_000 })
      expect(await settings.getByRole('button', { name: '模型', exact: true }).getAttribute('aria-current')).toBeTruthy()
      const add = settings.getByRole('button', { name: '添加模型提供商' })
      await expect.poll(() => add.isEnabled(), { timeout: 10_000 }).toBe(true)
      await add.click()
      await settings.getByRole('tab', { name: '自定义模型 API' }).click()
      const custom = settings.getByRole('tabpanel', { name: '自定义模型 API' })
      await custom.getByLabel('Provider ID').fill('acme-gateway')
      await custom.getByLabel('显示名称').fill('Acme 网关')
      await custom.getByLabel('API 地址').fill(gateway.baseURL)
      await custom.getByRole('textbox', { name: 'API 密钥', exact: true }).fill(KEY)
      await custom.getByRole('button', { name: '添加模型', exact: true }).click()
      await custom.getByLabel('模型 ID 1').fill('acme-chat')
      await custom.getByRole('button', { name: '创建提供商', exact: true }).click()
      await settings.getByText('Acme 网关', { exact: true }).first().waitFor({ timeout: 10_000 })
      await settings.getByRole('button', { name: '关闭' }).last().click()

      // The default model is still the keyless official route: a send names the fix instead of an adapter diagnostic.
      await connectFreshWorkspaceZh(page, scaffold.workspaceCwd, 'custom-model')
      const input = page.locator('[data-composer-input][contenteditable="true"]').first()
      await writeComposerDraft(page, input, '你好')
      await page.keyboard.press('Enter')
      await page.getByText('当前模型还没有配置 API Key。请打开「设置 → 模型」填写 Key，或添加其他模型提供商后重试。').waitFor({ timeout: 20_000 })
      // Its Configure models action opens Settings on Models.
      await page.getByRole('button', { name: '去配置模型' }).click()
      await settings.waitFor({ timeout: 10_000 })
      expect(await settings.getByRole('button', { name: '模型', exact: true }).getAttribute('aria-current')).toBeTruthy()
      await settings.getByText('Acme 网关', { exact: true }).first().waitFor()
      await settings.getByRole('button', { name: '关闭' }).last().click()

      // Pick the gateway's model and talk to it.
      await page.getByRole('button', { name: /^选择模型/ }).click()
      await page.getByRole('menuitem', { name: /^模型/ }).click()
      await page.getByRole('menuitemradio', { name: 'acme-chat' }).click()
      await expect.poll(() => page.getByRole('button', { name: /^选择模型/ }).textContent()).toContain('acme-chat')
      const chat = page.locator('[data-composer-input][contenteditable="true"]').first()
      await writeComposerDraft(page, chat, '用一句话介绍你自己')
      await page.keyboard.press('Enter')
      await page.getByText(REPLY).first().waitFor({ timeout: 30_000 })
      expect(gateway.requests.at(-1)).toMatchObject({ authorization: `Bearer ${KEY}`, body: { model: 'acme-chat', stream: true } })
      expect(tripwire.warnings).toEqual([])
      expect(tripwire.pageErrors).toEqual([])
    } catch (error) {
      if (failurePage !== undefined) await saveFailureShot(failurePage, 'web-e2e-models-custom-provider')
      throw error
    } finally {
      await browser.close()
      await scaffold.close()
      await gateway.close()
      await center.close()
      Reflect.deleteProperty(process.env, 'DSH_E2E_HUB_ORIGIN')
    }
  })
})
