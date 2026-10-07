// The DingTalk connector over the real `connectors`, `hub-account`, `skill`, `shell-env`, bash, and
// `llm-pi-ai` rows, with a stand-in dws served by a loopback mirror beside its Skills archive: the
// employee installs DingTalk from the Connectors page, signs in in one step from the dialog's QR code
// and address, and sees the card turn green with the account and the release's Skills. In a
// conversation a scripted model reads today's schedule through `dws` unasked, while sending a message
// waits in the approval panel and, rejected, never runs. Disconnecting signs dws out and deletes the
// company's directory.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
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
import { FAKE_DWS } from '../../../packages/connector/connectors/tests/fake-dws-cli.ts'
import { DWS_SKILLS } from '../../../packages/connector/connectors/tests/support.ts'
import { browse, startMockUserCenter } from '../../../packages/credentials/hub-account/tests/mock-user-center.ts'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { connectFreshWorkspaceZh, saveFailureShot, writeComposerDraft, ZH_BROWSER_LOCALE } from './support.ts'

const OVERLAYS = ['./hub-account.overlay.yml', './connectors.overlay.yml', './connectors-chat.overlay.yml']
  .map(path => fileURLToPath(new URL(path, import.meta.url)))
const VERSION = '9.9.9'
const ANSWER = 'DINGTALK_ANSWER'

/** One chat completion request the mock received. */
interface ChatRequest {
  readonly messages: readonly { readonly role: string; readonly content?: unknown }[]
}

/** The text of the latest user message. */
function latestAsk(request: ChatRequest): string {
  return JSON.stringify(request.messages.filter(message => message.role === 'user').at(-1)?.content ?? '')
}

/** The model: it runs the dws command matching the employee's request, then answers with the result. */
function streamChat(res: ServerResponse, request: ChatRequest): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const chunk = (delta: Record<string, unknown>, finish: string | null) => `data: ${JSON.stringify({
    id: 'chatcmpl-dingtalk', object: 'chat.completion.chunk', created: 0, model: 'acme-chat', choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`
  const usage = `data: ${JSON.stringify({
    id: 'chatcmpl-dingtalk', object: 'chat.completion.chunk', created: 0, model: 'acme-chat', choices: [],
    usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
  })}\n\n`
  const last = request.messages.at(-1)
  if (last?.role === 'tool') {
    res.write(chunk({ role: 'assistant', content: `${ANSWER} ${JSON.stringify(last.content)}` }, null))
    res.end(`${chunk({}, 'stop')}${usage}data: [DONE]\n\n`)
    return
  }
  const command = /群里发消息/u.test(latestAsk(request)) ? 'dws chat message send --conversation-id cid1 --text 周会改到下午三点' : 'dws calendar event list'
  res.write(chunk({ role: 'assistant', tool_calls: [{
    index: 0, id: `call_bash_${String(request.messages.length)}`, type: 'function',
    function: { name: 'bash', arguments: JSON.stringify({ command, description: '使用钉钉' }) },
  }] }, null))
  res.end(`${chunk({}, 'tool_calls')}${usage}data: [DONE]\n\n`)
}

async function startChat() {
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => { raw += chunk.toString() })
    req.on('end', () => { streamChat(res, JSON.parse(raw) as ChatRequest) })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    baseURL: `http://127.0.0.1:${String((server.address() as { port: number }).port)}/v1`,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => { resolve() }) }),
  }
}

it.skipIf(process.platform === 'win32')('installs, signs in to, uses, and disconnects DingTalk', async () => {
  // The stand-in release: the executable's archive and the Skills archive with its per-Skill tree.
  const work = await mkdtemp(join(tmpdir(), 'dsh-dingtalk-cli-'))
  await writeFile(join(work, 'dws'), FAKE_DWS, { mode: 0o755 })
  execFileSync('tar', ['-czf', join(work, 'dws.tar.gz'), '-C', work, 'dws'])
  for (const [name, markdown] of Object.entries(DWS_SKILLS)) {
    await mkdir(join(work, 'skills', 'multi', name), { recursive: true })
    await writeFile(join(work, 'skills', 'multi', name, 'SKILL.md'), markdown)
  }
  execFileSync('zip', ['-qr', join(work, 'dws-skills.zip'), 'multi'], { cwd: join(work, 'skills') })
  const files = new Map([['dws.tar.gz', await readFile(join(work, 'dws.tar.gz'))], ['dws-skills.zip', await readFile(join(work, 'dws-skills.zip'))]])
  const mirror = createServer((req, res) => {
    const body = files.get(req.url?.split('/').at(-1) ?? '')
    if (body === undefined) res.writeHead(404).end()
    else res.writeHead(200).end(body)
  })
  mirror.listen(0, '127.0.0.1')
  await once(mirror, 'listening')
  const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
  const archive = files.get('dws.tar.gz')!
  const skills = files.get('dws-skills.zip')!
  const dingtalk = {
    binary: 'dws', version: VERSION, mirrors: [`http://127.0.0.1:${String((mirror.address() as { port: number }).port)}/v{version}/{file}`],
    archives: [{ platform: `${process.platform}-${process.arch}`, file: 'dws.tar.gz', size: archive.length, sha256: digest(archive) }],
    skills: { file: 'dws-skills.zip', size: skills.length, sha256: digest(skills) },
  }
  const chat = await startChat()
  const center = await startMockUserCenter()
  Object.assign(process.env, { DSH_E2E_HUB_ORIGIN: center.origin, DSH_E2E_CHAT_API: chat.baseURL })
  const harnessHome = await mkdtemp(join(tmpdir(), 'dsh-dingtalk-home-'))
  await mkdir(join(harnessHome, 'profiles', 'scaffold'), { recursive: true })
  await writeFile(join(harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), JSON.stringify([{ id: 'connectors', config: { dshHome: harnessHome, dingtalk } }]))
  const scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAYS, harnessHome })
  const browser = await chromium.launch()
  let failurePage: Page | undefined
  try {
    await scaffold.ctx.hubAccount.signIn()
    await expect.poll(async () => (await scaffold.ctx.hubAccount.getState()).attempt?.authorizeUrl).toBeDefined()
    await browse((await scaffold.ctx.hubAccount.getState()).attempt!.authorizeUrl!)
    await expect.poll(async () => (await scaffold.ctx.hubAccount.getState()).status).toBe('signed-in')
    await scaffold.ctx.credentials.set(credentialRef('DSH_E2E_ACME_KEY'), 'sk-acme-e2e')
    const tenantId = (await scaffold.ctx.hubAccount.getState()).profile!.tenantId!
    const root = join(harnessHome, 'connectors', 'dingtalk')
    const control = join(root, 'control')
    const tenantDir = join(root, 'tenants', tenantId)

    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: ZH_BROWSER_LOCALE })
    failurePage = page
    await page.addInitScript(() => {
      Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 } })
      const opened: string[] = []
      Object.defineProperty(globalThis, '__opened', { value: opened })
      globalThis.open = (url?: string | URL) => { opened.push(String(url)); return null }
    })
    const opened = () => page.evaluate(() => Reflect.get(globalThis, '__opened') as string[])
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl)

    // Install from +: the executable and the Skills arrive, and the card turns red.
    await page.getByRole('button', { name: '连接器', exact: true }).click()
    const card = page.getByRole('listitem').filter({ hasText: '钉钉' })
    await card.getByRole('button', { name: '安装钉钉' }).click()
    await card.getByText('未连接').waitFor({ timeout: 15_000 })
    expect(await stat(join(root, VERSION, 'skills', 'dingtalk-calendar', 'SKILL.md')).then(() => true)).toBe(true)

    // Connect in one step: no step list, the QR code and address, opened in the browser.
    await card.getByRole('button', { name: '连接', exact: true }).click()
    const login = page.getByRole('dialog', { name: '连接钉钉' })
    await login.getByText('https://login.dingtalk.com/oauth2/device/verify.htm?caller=dws&user_code=DING-1').waitFor()
    await login.getByRole('img', { name: '钉钉授权二维码' }).waitFor()
    await login.getByText('用钉钉扫码，或在浏览器中打开链接并登录钉钉，授权 DSH 以你的身份使用钉钉。').waitFor()
    expect(await login.locator('ol').count()).toBe(0)
    await expect.poll(opened).toEqual(['https://login.dingtalk.com/oauth2/device/verify.htm?caller=dws&user_code=DING-1'])
    await writeFile(join(control, 'user'), 'ok')
    await login.waitFor({ state: 'detached' })
    await card.getByText('已登录：韩梅梅（甲公司）').waitFor()
    await card.getByText('带来的 Skill（2）').waitFor()
    expect(await card.locator('[data-state="done"]').count()).toBe(1)
    const env = (await readFile(join(control, 'env'), 'utf8')).trim().split('\n')
    expect(env).toEqual([`DWS_CONFIG_DIR=${join(tenantDir, 'config')}`, 'DWS_DISABLE_KEYCHAIN=1', `DWS_KEYCHAIN_DIR=${join(tenantDir, 'keychain')}`])

    // In a conversation, a read runs unasked through the company's dws.
    await page.goto(scaffold.authenticatedUrl)
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd, 'connectors-dingtalk')
    await page.getByRole('button', { name: /^选择模型/ }).click()
    await page.getByRole('menuitem', { name: /^模型/ }).click()
    await page.getByRole('menuitemradio', { name: 'acme-chat' }).click()
    const input = page.locator('[data-composer-input][contenteditable="true"]').first()
    const send = async (text: string) => {
      await writeComposerDraft(page, input, text)
      await page.keyboard.press('Enter')
    }
    await send('我今天有什么日程？')
    await page.getByText(/钉钉周会/u).first().waitFor({ timeout: 30_000 })
    expect(await page.locator('[data-approval-key]').count()).toBe(0)
    expect((await readFile(join(control, 'run-env'), 'utf8'))).toContain(`DWS_CONFIG_DIR=${join(tenantDir, 'config')}`)

    // Sending a message waits for the user; rejected, it never runs.
    const answers = await page.getByText(ANSWER).count()
    await send('帮我在群里发消息：周会改到下午三点')
    const panel = page.locator('[data-approval-key]')
    await panel.getByText('钉钉连接器将以你的身份执行写操作：dws chat message send。允许执行一次吗？').waitFor({ timeout: 30_000 })
    await panel.getByRole('button', { name: '拒绝', exact: true }).click()
    await expect.poll(async () => page.getByText(ANSWER).count(), { timeout: 30_000 }).toBeGreaterThan(answers)
    expect(await page.getByText(ANSWER).last().textContent()).toContain('the user rejected tool')
    const calls = (await readFile(join(control, 'calls'), 'utf8')).split('\n')
    expect(calls.some(call => call.startsWith('chat message send --conversation-id'))).toBe(false)

    // Disconnect: dws signs out and the company's directory goes.
    await page.getByRole('button', { name: '连接器', exact: true }).click()
    await card.getByRole('button', { name: '钉钉的更多操作' }).click()
    await page.getByRole('menuitem', { name: '断开' }).click()
    await page.getByRole('dialog', { name: '断开钉钉' }).getByRole('button', { name: '断开' }).click()
    await card.getByText('未连接').waitFor()
    await expect.poll(() => stat(tenantDir).then(() => true, () => false)).toBe(false)
    expect((await readFile(join(control, 'calls'), 'utf8')).split('\n')).toContain('auth logout')
    expect(tripwire.pageErrors).toEqual([])
  } catch (error) {
    if (failurePage !== undefined) await saveFailureShot(failurePage, 'web-e2e-connectors-dingtalk')
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
