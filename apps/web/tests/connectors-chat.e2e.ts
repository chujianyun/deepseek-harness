// A connected Feishu connector in conversations, over the real `connectors`, `hub-account`, `skill`,
// `shell-env`, bash, and `llm-pi-ai` rows: signed in to a mock user center and connected through a
// stand-in lark-cli, the employee asks about today's schedule; a scripted model sees the connector's
// Skills in the catalog, runs `lark-cli calendar +agenda` through bash — which reaches the installed
// CLI with the company's own directories — and answers from its output. Asked to send a message, the
// model's write waits in the approval panel and the rejection reaches it as a denial; asked to delete a
// file, the high-risk command shows a warning and, once allowed, runs with `--yes`. Switched off on the
// Connectors page, the session's next request carries a catalog without the Skills.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
import { FAKE_LARK_CLI } from '../../../packages/connector/connectors/tests/fake-lark-cli.ts'
import { browse, startMockUserCenter } from '../../../packages/credentials/hub-account/tests/mock-user-center.ts'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { connectFreshWorkspaceZh, saveFailureShot, writeComposerDraft, ZH_BROWSER_LOCALE } from './support.ts'

const OVERLAYS = ['./hub-account.overlay.yml', './connectors.overlay.yml', './connectors-chat.overlay.yml']
  .map(path => fileURLToPath(new URL(path, import.meta.url)))
const VERSION = '9.9.9'
const FILE = `lark-cli-${VERSION}.tar.gz`
const ANSWER = 'CONNECTOR_ANSWER'
const NO_SKILL = 'CONNECTOR_NO_SKILL'

/** One chat completion request the mock received. */
interface ChatRequest {
  readonly messages: readonly { readonly role: string; readonly content?: unknown }[]
}

/** The latest Skill catalog a request carries. */
function latestCatalog(request: ChatRequest): string {
  return request.messages.map(message => JSON.stringify(message.content ?? '')).filter(text => text.includes('available_skills')).at(-1) ?? ''
}

/** The lark-cli command the model runs for each request of the employee. */
const COMMANDS: readonly (readonly [RegExp, string])[] = [
  [/群里发消息/u, 'lark-cli im +messages-send --chat-id oc_team --text 周会改到下午三点'],
  [/周报文件/u, 'lark-cli drive +delete --file-token box_old'],
  [/日程/u, 'lark-cli calendar +agenda'],
]

/** The text of the latest user message. */
function latestAsk(request: ChatRequest): string {
  return JSON.stringify(request.messages.filter(message => message.role === 'user').at(-1)?.content ?? '')
}

/**
 * The model: with `lark-calendar` in the latest catalog and no tool result yet it runs the command
 * matching the employee's request through bash; after a tool result it answers with that result;
 * without the Skill it says so.
 */
function streamChat(res: ServerResponse, request: ChatRequest): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const chunk = (delta: Record<string, unknown>, finish: string | null) => `data: ${JSON.stringify({
    id: 'chatcmpl-connectors', object: 'chat.completion.chunk', created: 0, model: 'acme-chat', choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`
  const usage = `data: ${JSON.stringify({
    id: 'chatcmpl-connectors', object: 'chat.completion.chunk', created: 0, model: 'acme-chat', choices: [],
    usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
  })}\n\n`
  const last = request.messages.at(-1)
  if (last?.role === 'tool') {
    res.write(chunk({ role: 'assistant', content: `${ANSWER} ${JSON.stringify(last.content)}` }, null))
  } else if (latestCatalog(request).includes('`lark-calendar`')) {
    const command = COMMANDS.find(([pattern]) => pattern.test(latestAsk(request)))?.[1] ?? 'lark-cli calendar +agenda'
    res.write(chunk({ role: 'assistant', tool_calls: [{
      index: 0, id: `call_bash_${String(request.messages.length)}`, type: 'function',
      function: { name: 'bash', arguments: JSON.stringify({ command, description: '使用飞书' }) },
    }] }, null))
    res.end(`${chunk({}, 'tool_calls')}${usage}data: [DONE]\n\n`)
    return
  } else {
    res.write(chunk({ role: 'assistant', content: NO_SKILL }, null))
  }
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

it.skipIf(process.platform === 'win32')('gives the model the connected connector\'s Skills and CLI, and takes them away when switched off', async () => {
  const work = await mkdtemp(join(tmpdir(), 'dsh-connectors-chat-cli-'))
  await writeFile(join(work, 'lark-cli'), FAKE_LARK_CLI, { mode: 0o755 })
  execFileSync('tar', ['-czf', join(work, FILE), '-C', work, 'lark-cli'])
  const archive = await readFile(join(work, FILE))
  const mirror = createServer((_req, res) => { res.writeHead(200).end(archive) })
  mirror.listen(0, '127.0.0.1')
  await once(mirror, 'listening')
  const chat = await startChat()
  const center = await startMockUserCenter()
  Object.assign(process.env, { DSH_E2E_HUB_ORIGIN: center.origin, DSH_E2E_CHAT_API: chat.baseURL })
  const harnessHome = await mkdtemp(join(tmpdir(), 'dsh-connectors-chat-home-'))
  await mkdir(join(harnessHome, 'profiles', 'scaffold'), { recursive: true })
  const feishu = {
    binary: 'lark-cli', version: VERSION, mirrors: [`http://127.0.0.1:${String((mirror.address() as { port: number }).port)}/{file}`],
    archives: [{ platform: `${process.platform}-${process.arch}`, file: FILE, size: archive.length, sha256: createHash('sha256').update(archive).digest('hex') }],
  }
  await writeFile(join(harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), JSON.stringify([{ id: 'connectors', config: { dshHome: harnessHome, feishu } }]))
  const scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAYS, harnessHome })
  const browser = await chromium.launch()
  let failurePage: Page | undefined
  try {
    await scaffold.ctx.hubAccount.signIn()
    await expect.poll(async () => (await scaffold.ctx.hubAccount.getState()).attempt?.authorizeUrl).toBeDefined()
    await browse((await scaffold.ctx.hubAccount.getState()).attempt!.authorizeUrl!)
    await expect.poll(async () => (await scaffold.ctx.hubAccount.getState()).status).toBe('signed-in')
    await scaffold.ctx.credentials.set(credentialRef('DSH_E2E_ACME_KEY'), 'sk-acme-e2e')

    // Install and connect Feishu through the stand-in CLI.
    const connectors = scaffold.ctx.connectors
    const feishuView = async () => (await connectors.getState()).connectors[0]!
    await connectors.installConnector('feishu')
    await expect.poll(async () => (await feishuView()).status, { timeout: 15_000 }).toBe('disconnected')
    const control = join(harnessHome, 'connectors', 'feishu', 'control')
    await connectors.connect('feishu')
    await expect.poll(async () => (await feishuView()).login?.url).toContain('open.feishu.cn')
    await writeFile(join(control, 'app'), 'ok')
    await expect.poll(async () => (await feishuView()).login?.url).toContain('accounts.feishu.cn')
    await writeFile(join(control, 'user'), 'ok')
    await expect.poll(async () => (await feishuView()).status).toBe('connected')

    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: ZH_BROWSER_LOCALE })
    failurePage = page
    await page.addInitScript(() => { Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 } }) })
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl)
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd, 'connectors-chat')
    await page.getByRole('button', { name: /^选择模型/ }).click()
    await page.getByRole('menuitem', { name: /^模型/ }).click()
    await page.getByRole('menuitemradio', { name: 'acme-chat' }).click()
    const input = page.locator('[data-composer-input][contenteditable="true"]').first()
    const send = async (text: string) => {
      await writeComposerDraft(page, input, text)
      await page.keyboard.press('Enter')
    }

    // Connected: the catalog lists the connector's Skills, and bash reaches the installed CLI.
    await send('我今天有什么日程？')
    await page.getByText(ANSWER).first().waitFor({ timeout: 30_000 })
    await page.getByText(/产品周会/).first().waitFor()
    const asked = chat.chats.find(request => latestCatalog(request).includes('`lark-calendar`'))
    expect(latestCatalog(asked!)).toContain('`lark-im`')
    const tenantId = (await scaffold.ctx.hubAccount.getState()).profile!.tenantId!
    const runEnv = await readFile(join(control, 'run-env'), 'utf8')
    expect(runEnv).toContain(`LARKSUITE_CLI_CONFIG_DIR=${join(harnessHome, 'connectors', 'feishu', 'tenants', tenantId, 'config')}`)
    const calls = async () => (await readFile(join(control, 'calls'), 'utf8')).split('\n').filter(call => !call.includes('--help'))
    // The agenda only reads, so it ran without an approval.
    expect(await page.locator('[data-approval-key]').count()).toBe(0)

    // A write waits for the user; rejected, it never runs and the model learns the user said no.
    const answers = await page.getByText(ANSWER).count()
    await send('帮我在群里发消息：周会改到下午三点')
    const panel = page.locator('[data-approval-key]')
    await panel.getByText('飞书连接器将以你的身份执行写操作：lark-cli im +messages-send。允许执行一次吗？').waitFor({ timeout: 30_000 })
    await panel.getByRole('button', { name: '拒绝', exact: true }).click()
    await expect.poll(async () => page.getByText(ANSWER).count(), { timeout: 30_000 }).toBeGreaterThan(answers)
    expect(JSON.stringify(chat.chats.at(-1)!.messages.at(-1)!.content)).toContain('the user rejected tool \\"bash\\"')
    expect((await calls()).some(call => call.startsWith('im +messages-send'))).toBe(false)

    // A high-risk write shows the warning; allowed once, it runs with --yes and the model gets its result.
    await send('删除旧的周报文件')
    await panel.getByText(/^⚠️ 高风险操作：飞书连接器将以你的身份执行 lark-cli drive \+delete/u).waitFor({ timeout: 30_000 })
    await panel.getByRole('button', { name: '允许一次', exact: true }).click()
    await page.getByText(/deleted/u).first().waitFor({ timeout: 30_000 })
    expect(await calls()).toContain('drive +delete --file-token box_old --yes')

    // Switched off on the Connectors page: the next request's catalog no longer lists them.
    await page.getByRole('button', { name: '连接器', exact: true }).click()
    const card = page.getByRole('listitem').filter({ hasText: '飞书' })
    await card.getByText('带来的 Skill（2）').waitFor()
    await card.getByRole('switch', { name: '在对话中使用飞书' }).click()
    await card.getByText('已停用：对话中的模型不会使用飞书，登录信息保留。').waitFor()
    const asks = chat.chats.length
    // The same session: the request after the switch carries a replacement catalog without them.
    await page.getByText('今天有什么日程？').first().click()
    await send('我今天有什么日程？')
    await page.getByText(NO_SKILL).first().waitFor({ timeout: 30_000 })
    expect(chat.chats.length).toBeGreaterThan(asks)
    expect(latestCatalog(chat.chats.at(-1)!)).not.toContain('`lark-calendar`')
    expect(tripwire.pageErrors).toEqual([])
  } catch (error) {
    if (failurePage !== undefined) await saveFailureShot(failurePage, 'web-e2e-connectors-chat')
    throw error
  } finally {
    await browser.close()
    await scaffold.close()
    await chat.close()
    await center.close()
    mirror.closeAllConnections()
    mirror.close()
    await rm(harnessHome, { recursive: true, force: true })
    await rm(work, { recursive: true, force: true })
    Reflect.deleteProperty(process.env, 'DSH_E2E_HUB_ORIGIN')
    Reflect.deleteProperty(process.env, 'DSH_E2E_CHAT_API')
  }
})
