// An automation task's scheduled run with nobody watching, over the real `automation-tasks`,
// `schedule`, `connectors`, `hub-account`, `shell-env`, bash, and `llm-pi-ai` rows with a stand-in
// lark-cli and a scripted model: the task declares `lark-cli sheets +write` among the operations its
// unattended runs may run. When the schedule fires, the model writes a test sheet — a command of
// unknown risk that would ask for approval — runs a Skill script, and then tries a high-risk delete it
// did not declare. The sheet write runs without asking, the script runs as usual, the delete is
// refused without waiting, and the run ends on its own with each answer recorded in the Session log;
// opened in the browser, the run's turn ends with the record of what ran and what was refused.
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
import type {} from '@deepseek-ai/dsh-automation-tasks'
import type {} from '@deepseek-ai/dsh-connectors'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-hub-account'
import type {} from '@deepseek-ai/dsh-workspace'
import { FAKE_LARK_CLI } from '../../../packages/connector/connectors/tests/fake-lark-cli.ts'
import { browse, startMockUserCenter } from '../../../packages/credentials/hub-account/tests/mock-user-center.ts'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const OVERLAYS = ['./hub-account.overlay.yml', './connectors.overlay.yml', './connectors-chat.overlay.yml', './automation-tasks.overlay.yml']
  .map(path => fileURLToPath(new URL(path, import.meta.url)))
const VERSION = '9.9.9'
const FILE = `lark-cli-${VERSION}.tar.gz`
const DONE = 'UNATTENDED_RUN_DONE'

/** One chat completion request the mock received. */
interface ChatRequest {
  readonly messages: readonly { readonly role: string; readonly content?: unknown }[]
}

/**
 * The model of the scheduled run: after the run's instruction it writes the sheet, then runs the Skill
 * script, then tries the delete, one bash call per request, and finally reports the last result.
 */
function streamChat(res: ServerResponse, request: ChatRequest, script: string): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const chunk = (delta: Record<string, unknown>, finish: string | null) => `data: ${JSON.stringify({
    id: 'chatcmpl-unattended', object: 'chat.completion.chunk', created: 0, model: 'acme-chat', choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`
  const usage = `data: ${JSON.stringify({
    id: 'chatcmpl-unattended', object: 'chat.completion.chunk', created: 0, model: 'acme-chat', choices: [],
    usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
  })}\n\n`
  const lastUser = request.messages.findLastIndex(message => message.role === 'user')
  const steps = request.messages.slice(lastUser).filter(message => message.role === 'tool').length
  const commands = [
    'lark-cli sheets +write --sheet sht_test --range A1:B1 --values "[[\\"日期\\",\\"访客\\"]]"',
    `node ${JSON.stringify(script)}`,
    'lark-cli drive +delete --file-token box_old',
  ]
  const command = commands[steps]
  if (command !== undefined) {
    res.write(chunk({ role: 'assistant', tool_calls: [{
      index: 0, id: `call_bash_${String(request.messages.length)}`, type: 'function',
      function: { name: 'bash', arguments: JSON.stringify({ command, description: '运营日报' }) },
    }] }, null))
    res.end(`${chunk({}, 'tool_calls')}${usage}data: [DONE]\n\n`)
    return
  }
  res.write(chunk({ role: 'assistant', content: `${DONE} ${JSON.stringify(request.messages.at(-1)?.content ?? '')}` }, null))
  res.end(`${chunk({}, 'stop')}${usage}data: [DONE]\n\n`)
}

it.skipIf(process.platform === 'win32')('runs declared operations unattended, refuses the rest without waiting, and records both', async () => {
  const work = await mkdtemp(join(tmpdir(), 'dsh-unattended-cli-'))
  await writeFile(join(work, 'lark-cli'), FAKE_LARK_CLI, { mode: 0o755 })
  execFileSync('tar', ['-czf', join(work, FILE), '-C', work, 'lark-cli'])
  const archive = await readFile(join(work, FILE))
  const mirror = createServer((_req, res) => { res.writeHead(200).end(archive) })
  mirror.listen(0, '127.0.0.1')
  await once(mirror, 'listening')
  // A Skill script outside the workspace that writes its report into the working directory.
  const script = join(work, 'skills', 'ops-report', 'scripts', 'collect.mjs')
  await mkdir(join(script, '..'), { recursive: true })
  await writeFile(script, "import { writeFileSync } from 'node:fs'\nwriteFileSync('日报.json', JSON.stringify({ visitors: 1024 }))\nconsole.log('collected')\n")
  const chats: ChatRequest[] = []
  const chat = createServer((req, res) => {
    let raw = ''
    req.on('data', (data: Buffer) => { raw += data.toString() })
    req.on('end', () => {
      const request = JSON.parse(raw) as ChatRequest
      chats.push(request)
      streamChat(res, request, script)
    })
  })
  chat.listen(0, '127.0.0.1')
  await once(chat, 'listening')
  const center = await startMockUserCenter()
  Object.assign(process.env, {
    DSH_E2E_HUB_ORIGIN: center.origin, DSH_E2E_CHAT_API: `http://127.0.0.1:${String((chat.address() as { port: number }).port)}/v1`,
  })
  const harnessHome = await mkdtemp(join(tmpdir(), 'dsh-unattended-home-'))
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
    const { ctx } = scaffold
    await ctx.hubAccount.signIn()
    await expect.poll(async () => (await ctx.hubAccount.getState()).attempt?.authorizeUrl).toBeDefined()
    await browse((await ctx.hubAccount.getState()).attempt!.authorizeUrl!)
    await expect.poll(async () => (await ctx.hubAccount.getState()).status).toBe('signed-in')
    await ctx.credentials.set(credentialRef('DSH_E2E_ACME_KEY'), 'sk-acme-e2e')
    await ctx.connectors.installConnector('feishu')
    const feishuView = async () => (await ctx.connectors.getState()).connectors[0]!
    await expect.poll(async () => (await feishuView()).status, { timeout: 15_000 }).toBe('disconnected')
    const control = join(harnessHome, 'connectors', 'feishu', 'control')
    // The stand-in CLI records its calls beside its version directory, which the sandbox must let it write.
    ctx.sandboxPolicy.registerWritableRoot({ name: 'e2e-stand-in-cli-control', resolve: () => control })
    await ctx.connectors.connect('feishu')
    await expect.poll(async () => (await feishuView()).login?.url).toContain('open.feishu.cn')
    await writeFile(join(control, 'app'), 'ok')
    await expect.poll(async () => (await feishuView()).login?.url).toContain('accounts.feishu.cn')
    await writeFile(join(control, 'user'), 'ok')
    await expect.poll(async () => (await feishuView()).status).toBe('connected')

    // The task runs once, a few seconds from now, with nobody to answer an approval.
    const workspace = await ctx.workspaceRegistry.create(scaffold.workspaceCwd, '默认工作区')
    const { sessionId } = await ctx.automationTasks.create({
      title: '运营日报', prompt: '跑运营日报', workspaceId: workspace.id, model: { provider: 'acme-gateway', model: 'acme-chat' },
      permission: 'workspace-write', connectors: ['feishu'], operations: ['lark-cli sheets +write'],
      timing: { kind: 'at', at: new Date(Date.now() + 20_000).toISOString() },
    })
    const resolved = await ctx.sessionController.resolveAgent(sessionId)
    if ('error' in resolved) throw resolved.error
    const events = () => resolved.agent.session.ownEvents()
    await expect.poll(() => events().some(event => event.type === 'turn/end'), { timeout: 60_000, interval: 250 }).toBe(true)

    // The run ended on its own: the sheet write and the script ran, the undeclared delete never did.
    expect(chats.at(-1)?.messages.at(-1)?.role).toBe('tool')
    const calls = (await readFile(join(control, 'calls'), 'utf8')).split('\n').filter(call => call !== '' && !call.includes('--help'))
    expect(calls.filter(call => call.startsWith('sheets ') || call.startsWith('drive '))).toEqual(['sheets +write --sheet sht_test --range A1:B1 --values [["日期","访客"]]'])
    expect(JSON.parse(await readFile(join(scaffold.workspaceCwd, '日报.json'), 'utf8'))).toEqual({ visitors: 1024 })
    const answered = events().filter(event => event.type === 'automation-tasks/unattended').map(event => event.data)
    expect(answered).toMatchObject([
      { command: expect.stringContaining('lark-cli sheets +write') as string, allowed: true, operations: ['lark-cli sheets +write'] },
      { command: 'lark-cli drive +delete --file-token box_old', allowed: false, operations: [] },
    ])
    // Nothing waited for a person, and the model learned why the delete did not run.
    expect(events().filter(event => event.type === 'approval/asked')).toEqual([])
    expect(JSON.stringify(chats.at(-1)?.messages.at(-1)?.content)).toContain('unattended')
    const ended = events().find(event => event.type === 'turn/end')
    expect(ended?.data).toMatchObject({ reason: { kind: 'completed' } })

    // The task's Session shows the run's record beneath its closing reply.
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: ZH_BROWSER_LOCALE })
    failurePage = page
    await page.addInitScript(() => { Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 } }) })
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl)
    await page.getByText('运营日报', { exact: true }).first().click()
    const record = page.getByRole('region', { name: '无人值守运行记录' })
    await record.waitFor({ timeout: 30_000 })
    expect(await record.textContent()).toContain('已拒绝，未等待确认（1 条）')
    expect(await record.textContent()).toContain('对应声明：lark-cli sheets +write')
    expect(tripwire.pageErrors).toEqual([])
    // For review: the record in each language and colour scheme, when a directory is given.
    const shots = process.env.DSH_E2E_SHOTS
    if (shots !== undefined) {
      for (const [lang, locale, title] of [['zh', ZH_BROWSER_LOCALE, '无人值守运行记录'], ['en', 'en-US', 'Unattended run']] as const) {
        for (const theme of ['light', 'dark'] as const) {
          const shot = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale, colorScheme: theme })
          await shot.addInitScript(() => { Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 } }) })
          await shot.goto(scaffold.authenticatedUrl)
          await shot.getByText('运营日报', { exact: true }).first().click()
          const shown = shot.getByRole('region', { name: title })
          await shown.waitFor({ timeout: 30_000 })
          await shown.scrollIntoViewIfNeeded()
          await shot.screenshot({ path: join(shots, `${lang}-${theme}-record.png`) })
          await shot.close()
        }
      }
    }
  } catch (error) {
    if (failurePage !== undefined) await saveFailureShot(failurePage, 'automation-unattended')
    throw error
  } finally {
    await browser.close()
    await scaffold.close()
    await center.close()
    chat.closeAllConnections()
    chat.close()
    mirror.close()
    await rm(harnessHome, { recursive: true, force: true })
    await rm(work, { recursive: true, force: true })
    Reflect.deleteProperty(process.env, 'DSH_E2E_HUB_ORIGIN')
    Reflect.deleteProperty(process.env, 'DSH_E2E_CHAT_API')
  }
}, 120_000)
