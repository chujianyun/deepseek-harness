// A third-party plugin written for an older release, installed the way an external memory service installs
// itself: a `DSH_HOME/cordis.patch.yml` insert naming a bare package under `DSH_HOME/profiles/node_modules`.
// Its manifest declares no version, and its `agent/pre-step` listener adds recalled context under the
// released V3 `{ kind: 'plugin', plugin }` source. A real `dsh --profile web` process talks to a local
// DeepSeek Messages stand-in; the turn completes, the model sees the recalled context, the package is left out
// of `dsh_plugin_packages`, and the Session log records the producer-owned kind.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import { REPO_ROOT, newEnglishPage, saveFailureShot, writeComposerDraft } from './support.ts'

const ANSWER = 'LEGACY_PLUGIN_ANSWER'
const RECALL = 'LEGACY_PLUGIN_RECALL'

const PLUGIN = `import { createUserMessage } from '@deepseek-ai/dsh-llm'
export const name = 'legacy-memory'
export function apply(ctx) {
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (!decision || decision.kind === 'reject' || payload.messages.length === 0) return decision
    const memory = createUserMessage({
      source: { kind: 'plugin', plugin: name, form: 'recall' },
      content: [{ type: 'text', text: '${RECALL}' }],
    })
    return { ...decision, messages: [...decision.messages, memory] }
  })
}
`

/** One Messages request the stand-in received. */
interface MessagesRequest {
  readonly messages: readonly unknown[]
  readonly dsh_plugin_packages?: { readonly packages: readonly { readonly name: string }[] }
  readonly dsh_session_log?: { readonly events: readonly unknown[] }
}

async function startModel() {
  const requests: MessagesRequest[] = []
  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk: Buffer) => { raw += chunk.toString() })
    request.once('end', () => {
      requests.push(JSON.parse(raw) as MessagesRequest)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const events = [
        { type: 'message_start', message: { id: 'legacy-plugin', model: 'mock-model', usage: { input_tokens: 3, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: ANSWER } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ]
      response.end(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  onTestFinished(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => { resolve() }) }))
  return { url: `http://127.0.0.1:${String((server.address() as { port: number }).port)}`, requests }
}

/** Install the legacy plugin the way the external service does. */
async function installLegacyPlugin(home: string): Promise<void> {
  const modules = join(home, 'profiles', 'node_modules')
  await mkdir(join(modules, 'legacy-memory'), { recursive: true })
  await mkdir(join(modules, '@deepseek-ai'), { recursive: true })
  await symlink(join(REPO_ROOT, 'packages/llm/llm'), join(modules, '@deepseek-ai', 'dsh-llm'))
  await writeFile(join(modules, 'legacy-memory', 'package.json'), `${JSON.stringify({ name: 'legacy-memory', type: 'module', exports: { '.': './index.mjs' } })}\n`)
  await writeFile(join(modules, 'legacy-memory', 'index.mjs'), PLUGIN)
  await writeFile(join(home, 'cordis.patch.yml'), '- insert:\n    - id: legacy-memory\n      name: legacy-memory\n')
}

it.skipIf(process.platform === 'win32')('completes a turn with a third-party plugin that uses the released V3 source and declares no version', async () => {
  const world = await mkdtemp(join(tmpdir(), 'dsh-legacy-plugin-'))
  onTestFinished(() => rm(world, { recursive: true, force: true }))
  const home = join(world, 'home')
  const workspacePath = join(world, 'workspace')
  await mkdir(workspacePath, { recursive: true })
  await installLegacyPlugin(home)
  const model = await startModel()

  let output = ''
  const child = spawn(process.execPath, [
    join(REPO_ROOT, 'apps/cli/lib/bin.js'), '--profile', 'web',
    '--patch', fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
    '--no-open', '--port', '0',
  ], {
    cwd: world,
    env: {
      ...process.env, NODE_OPTIONS: '',
      DSH_HOME: home, DSH_AGENTS_HOME: join(world, 'agents'),
      DSH_TELEMETRY_DISABLED: '1', DEEPSEEK_API_KEY: 'keyless-legacy-plugin-fixture',
      DEEPSEEK_BASE_URL: model.url,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const closed = once(child, 'close')
  onTestFinished(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    await closed
  })
  const ready = Promise.withResolvers<string>()
  const receive = (data: Buffer): void => {
    output += data.toString()
    const url = /dsh web: (http:\/\/[^\s]+)/u.exec(output)?.[1]
    if (url !== undefined) ready.resolve(url)
  }
  child.stdout.on('data', receive)
  child.stderr.on('data', receive)
  void closed.then(() => { ready.reject(new Error('Server exited before readiness\n' + output)) })
  const url = await ready.promise

  const authenticated = await fetch(url, { redirect: 'manual' })
  const cookie = authenticated.headers.get('set-cookie')?.split(';', 1)[0]
  if (cookie === undefined) throw new Error('Server did not issue an authentication cookie')
  const response = await fetch(new URL('/api/workspace/create', url), {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'workspace/create', payload: { args: { request: { path: workspacePath } } } }),
  })
  expect(((await response.json()) as { result: { ok: boolean } }).result.ok).toBe(true)

  const browser = await chromium.launch({ headless: true })
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  const errors: string[] = []
  page.on('pageerror', (error) => { errors.push(String(error)) })
  onTestFailed(async () => {
    await saveFailureShot(page, 'web-legacy-plugin-compat')
    console.error(output.replace(/([?&]token=)[A-Za-z0-9_-]+/gu, '$1<redacted>'))
  })
  await page.goto(url, { waitUntil: 'load' })
  await page.locator('[data-slot="root"]').waitFor({ state: 'attached', timeout: 20_000 })
  await page.getByRole('button', { name: 'Continue', exact: true }).click({ timeout: 15_000 })
  const composer = page.locator('[data-composer-input][contenteditable="true"]')
  await writeComposerDraft(page, composer, 'Summarize yesterday for the shop.')
  await composer.press('Enter')
  await page.getByRole('paragraph').filter({ hasText: new RegExp(`^${ANSWER}$`, 'u') }).last().waitFor({ timeout: 20_000 })

  expect(await page.locator('body').innerText()).not.toMatch(/producer-owned source kind|request extension preparation failed/u)
  // The title request follows the turn; the conversation request is the one carrying the recalled context.
  const request = model.requests.find(entry => JSON.stringify(entry.messages).includes(RECALL))
  expect(request?.dsh_plugin_packages?.packages.length).toBeGreaterThan(0)
  expect(request?.dsh_plugin_packages?.packages.map(entry => entry.name)).not.toContain('legacy-memory')
  // Session admission refused the released wrapper before the fix; the uploaded Session log carries the admitted events.
  const logged = JSON.stringify(model.requests.map(entry => entry.dsh_session_log?.events ?? []))
  expect(logged).toContain('"kind":"plugin:legacy-memory"')
  expect(logged).not.toContain('"kind":"plugin","plugin"')
  expect(errors).toEqual([])
}, 90_000)
