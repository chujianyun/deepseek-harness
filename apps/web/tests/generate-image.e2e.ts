// Desktop-composed image generation over the real composition: with a ChatGPT (Codex) sign-in stored, the model is
// offered `generate_image`; a GPT turn calls it, the tool generates through the Codex endpoint, and the image shows
// under the answer. The Models page switch withdraws the tool, and signing out does too. The OpenAI side is a loopback
// Codex server the openai-codex route's base URL points at; chat and image requests both follow it. The account
// sign-in UI itself is covered by models-account-sign-in.e2e.ts.
import { createServer, type IncomingMessage } from 'node:http'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { deflateSync, gunzipSync, zstdDecompressSync } from 'node:zlib'
import { chromium, type Page } from 'playwright'
import { describe, expect, it } from 'vitest'
import type {} from '@deepseek-ai/dsh-hub-account'
import { browse, startMockUserCenter } from '../../../packages/credentials/hub-account/tests/mock-user-center.ts'
import { launchWebScaffold, watchConsole, webSnapshotMode } from './scaffold.ts'
import { connectFreshWorkspaceZh, openSettings, saveFailureShot, writeComposerDraft, ZH_BROWSER_LOCALE } from './support.ts'

const OVERLAY = fileURLToPath(new URL('./hub-account.overlay.yml', import.meta.url))
const PROMPT = '一只橘猫在窗台上晒太阳'
const REPLY = 'GENERATE_IMAGE_REPLY_OK'

/** An access token shaped like ChatGPT's: the Codex transport reads the account id from its claims. */
function chatgptToken(): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-e2e' } })}.sig`
}

/** A 192x128 PNG with a warm gradient, so the gallery shows a visible picture. */
function gradientPng(): Buffer {
  const width = 192
  const height = 128
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (bytes: Buffer): number => {
    let c = 0xffffffff
    for (const byte of bytes) c = table[(c ^ byte) & 255]! ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data])
    const sum = Buffer.alloc(4)
    sum.writeUInt32BE(crc(body))
    return Buffer.concat([length, body, sum])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const rows: number[] = []
  for (let y = 0; y < height; y++) {
    rows.push(0)
    for (let x = 0; x < width; x++) rows.push(255, Math.round(120 + (x / width) * 100), Math.round(40 + (y / height) * 80))
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from(rows))), chunk('IEND', Buffer.alloc(0)),
  ])
}

const event = (value: Record<string, unknown>): string => `event: ${String(value['type'])}\ndata: ${JSON.stringify(value)}\n\n`
const completed = event({ type: 'response.completed', response: { id: 'resp', status: 'completed', usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } })

/**
 * A loopback Codex endpoint. A forced image generation call answers with the image; the chat turn first asks for
 * `generate_image`, and once a tool output comes back it answers in text. WebSocket upgrades are cut off so the
 * chat transport falls back to HTTP at once.
 */
async function startCodexServer(png: Buffer) {
  const requests: { kind: 'image' | 'call' | 'reply'; body: Record<string, unknown>; tools: string[] }[] = []
  const server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    req.on('end', () => {
      const raw = Buffer.concat(chunks)
      const encoding = req.headers['content-encoding']
      const body = JSON.parse((encoding === 'zstd' ? zstdDecompressSync(raw) : encoding === 'gzip' ? gunzipSync(raw) : raw).toString('utf8')) as Record<string, unknown>
      const tools = ((body['tools'] ?? []) as { name?: string; type?: string }[]).map(tool => tool.name ?? tool.type ?? '')
      const input = JSON.stringify(body['input'] ?? [])
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      if ((body['tool_choice'] as { type?: string } | undefined)?.type === 'image_generation') {
        requests.push({ kind: 'image', body, tools })
        res.end(event({ type: 'response.created', response: { id: 'img' } })
          + event({ type: 'response.output_item.done', output_index: 0, item: {
            type: 'image_generation_call', id: 'ig_e2e', status: 'completed', output_format: 'png',
            result: png.toString('base64'), revised_prompt: 'An orange cat basking on a sunny windowsill.',
          } })
          + completed)
        return
      }
      if (input.includes('function_call_output')) {
        requests.push({ kind: 'reply', body, tools })
        const text = `${REPLY} 图片已生成。`
        const message = { type: 'message', id: 'msg_e2e', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }
        res.end(event({ type: 'response.created', response: { id: 'r2' } })
          + event({ type: 'response.output_item.added', output_index: 0, item: { ...message, status: 'in_progress', content: [] } })
          + event({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text })
          + event({ type: 'response.output_item.done', output_index: 0, item: message })
          + completed)
        return
      }
      requests.push({ kind: 'call', body, tools })
      const args = JSON.stringify({ prompt: PROMPT, size: '1536x1024' })
      const call = { type: 'function_call', id: 'fc_e2e', call_id: 'call_e2e', name: 'generate_image' }
      res.end(event({ type: 'response.created', response: { id: 'r1' } })
        + event({ type: 'response.output_item.added', output_index: 0, item: { ...call, arguments: '', status: 'in_progress' } })
        + event({ type: 'response.function_call_arguments.done', output_index: 0, arguments: args })
        + event({ type: 'response.output_item.done', output_index: 0, item: { ...call, arguments: args, status: 'completed' } })
        + completed)
    })
  })
  server.on('upgrade', (_req, socket) => { socket.destroy() })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing Codex server address')
  const origin = `http://127.0.0.1:${String(address.port)}`
  return {
    origin,
    requests,
    close: () => new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() }),
  }
}

// The keyless lane masks DEEPSEEK_API_KEY, which record mode needs; the scenario records no Session.
describe.skipIf(webSnapshotMode() === 'record')('web e2e: generate_image through the ChatGPT (Codex) sign-in', () => {
  it('offers generate_image while signed in, shows the generated image in the conversation, and withdraws it on sign-out', async () => {
    const center = await startMockUserCenter()
    const png = gradientPng()
    const codex = await startCodexServer(png)
    process.env.DSH_E2E_HUB_ORIGIN = center.origin
    const scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY, deepSeekMissingCredential: true })
    const browser = await chromium.launch()
    let failurePage: Page | undefined
    try {
      await scaffold.ctx.hubAccount.signIn()
      await expect.poll(async () => (await scaffold.ctx.hubAccount.getState()).attempt?.authorizeUrl).toBeDefined()
      await browse((await scaffold.ctx.hubAccount.getState()).attempt!.authorizeUrl!)
      await expect.poll(async () => (await scaffold.ctx.hubAccount.getState()).status).toBe('signed-in')

      // Not signed in to ChatGPT: the model is offered no image tool.
      expect(scaffold.ctx.tools.get('generate_image')).toBeUndefined()
      await scaffold.ctx.credentials.modifyRecord('llm-pi-ai/openai-codex' as never, () => Promise.resolve({
        kind: 'grant', payload: { type: 'oauth', access: chatgptToken(), refresh: 'refresh-e2e', expires: Date.now() + 3_600_000 },
      }))
      await expect.poll(() => scaffold.ctx.tools.get('generate_image') !== undefined, { timeout: 10_000 }).toBe(true)
      await scaffold.ctx.settings.update('llm-pi-ai', { providers: { 'openai-codex': { baseURL: codex.origin } } })

      const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: ZH_BROWSER_LOCALE })
      failurePage = page
      await page.addInitScript(() => { Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 } }) })
      const tripwire = watchConsole(page)
      await page.goto(scaffold.authenticatedUrl)
      // A signed-in ChatGPT counts as a usable model, so no first-run step appears.
      await connectFreshWorkspaceZh(page, scaffold.workspaceCwd, 'generate-image')
      await page.getByRole('button', { name: /^选择模型/ }).click()
      await page.getByRole('menuitem', { name: /^模型/ }).click()
      await page.getByRole('menuitemradio', { name: 'GPT-5.5', exact: true }).click()
      const chat = page.locator('[data-composer-input][contenteditable="true"]').first()
      await writeComposerDraft(page, chat, '画一只在窗台上晒太阳的橘猫')
      await page.keyboard.press('Enter')

      // The generated picture shows under the answer without expanding anything.
      await page.getByText(REPLY).first().waitFor({ timeout: 30_000 })
      const gallery = page.locator('[data-generated-images]')
      await gallery.waitFor({ timeout: 20_000 })
      await page.waitForFunction(() => [...document.querySelectorAll('[data-generated-images] img')]
        .some(img => img instanceof HTMLImageElement && img.complete && img.naturalWidth === 192), undefined, { timeout: 20_000 })
      // The tool row sits in the Turn's process, titled by the tool with the prompt as its summary.
      await page.locator('[data-turn-process]').first().click()
      await page.locator('[data-process-activity]:visible').first().click()
      const row = page.locator('[data-tool="generate_image"]').first()
      await row.waitFor({ timeout: 10_000 })
      expect(await row.textContent()).toContain('生成图片')
      expect(await row.textContent()).toContain(PROMPT)

      // The chat turn offered the tool; the tool forced GPT Image with the model's arguments.
      expect(codex.requests.find(request => request.kind === 'call')?.tools).toContain('generate_image')
      const generation = codex.requests.find(request => request.kind === 'image')!
      expect(generation.body).toMatchObject({
        model: 'gpt-5.6-sol',
        tools: [{ type: 'image_generation', size: '1536x1024', quality: 'medium', background: 'auto' }],
        input: [{ role: 'user', content: [{ type: 'input_text', text: PROMPT }] }],
      })

      // The Models page switch withdraws the tool, and turning it back on offers it again.
      await openSettings(page, 'zh')
      const settings = page.getByRole('dialog', { name: '设置' })
      await settings.getByRole('button', { name: '模型', exact: true }).click()
      await settings.getByRole('button', { name: '编辑 openai-codex' }).click()
      const imageSwitch = settings.getByRole('switch', { name: '允许模型用此账号生成图片' })
      expect(await imageSwitch.getAttribute('aria-checked')).toBe('true')
      await imageSwitch.click()
      await expect.poll(() => scaffold.ctx.tools.get('generate_image'), { timeout: 10_000 }).toBeUndefined()
      await expect.poll(() => imageSwitch.getAttribute('aria-checked')).toBe('false')
      await imageSwitch.click()
      await expect.poll(() => scaffold.ctx.tools.get('generate_image') !== undefined, { timeout: 10_000 }).toBe(true)

      // Signing out withdraws the tool.
      await scaffold.ctx.credentials.deleteRecord('llm-pi-ai/openai-codex' as never)
      await expect.poll(() => scaffold.ctx.tools.get('generate_image'), { timeout: 10_000 }).toBeUndefined()
      expect(tripwire.warnings).toEqual([])
      expect(tripwire.pageErrors).toEqual([])
    } catch (error) {
      if (failurePage !== undefined) await saveFailureShot(failurePage, 'web-e2e-generate-image')
      throw error
    } finally {
      await browser.close()
      await scaffold.close()
      await codex.close()
      await center.close()
      Reflect.deleteProperty(process.env, 'DSH_E2E_HUB_ORIGIN')
    }
  })
})
