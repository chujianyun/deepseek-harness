/**
 * Keyless request-isolation evidence for the shipped personal composition.
 *
 * The dsh-base + dsh-web-app tree boots with the DeepSeek Platform origin and
 * the model endpoint pinned to controlled loopback services, while a recording
 * loopback proxy stands in for every other destination. Account sign-in,
 * account state reads, and a model chat request must reach their configured
 * services; nothing else — no enterprise OAuth, Skill Hub, branding,
 * telemetry collector, or update-policy request — may leave the process. The
 * loopback services are controlled stand-ins, not evidence of real DeepSeek
 * Platform authorization; real-account verification is a separate recorded
 * activity. A composed probe plugin proves the fence itself records the
 * forbidden request classes it exists to catch.
 */

import { createRequire } from 'node:module'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import {
  bundlePatchPaths,
  createRuntimeResolution,
  initProfile,
  loadOverlayPatches,
  PluginPackages,
  type Profile,
} from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { installProxyFromEnvironment } from '@deepseek-ai/dsh-http-proxy'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { AccountClientMetadata } from '@deepseek-ai/dsh-deepseek-account/types'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const { boot } = createRequire(import.meta.url)(join(REPO_ROOT, 'packages/boot/app-boot/lib/index.js')) as typeof import('@deepseek-ai/dsh-app-boot')
/** The shipped personal surface: the dsh-base and dsh-web-app bundle patches over an empty profile. */
const BASE_PATCH = join(REPO_ROOT, 'packages/bundle/base/cordis.patch.yml')
const WEB_BUNDLE = join(REPO_ROOT, 'packages/bundle/web-app')
const WEB_PATCHES = bundlePatchPaths(WEB_BUNDLE, (JSON.parse(readFileSync(join(WEB_BUNDLE, 'package.json'), 'utf8')) as { dsh: { bundle: { patch: string[] } } }).dsh.bundle)
const INSTALL_ANCHOR = join(REPO_ROOT, 'apps/cli/package.json')
const PROBE_MODULE = pathToFileURL(join(REPO_ROOT, 'apps/cli/tests/fixtures/egress-probe.mjs')).href

/** One request a controlled service observed. */
interface ObservedRequest {
  method: string
  path: string
  grant: string | undefined
  apiKey: string | undefined
  body: string
}

interface ControlledService {
  url: string
  requests: ObservedRequest[]
  close(): Promise<void>
}

async function listen(server: Server): Promise<string> {
  const address = await new Promise<AddressInfo>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve(server.address() as AddressInfo) }) })
  return `http://127.0.0.1:${String(address.port)}`
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request as AsyncIterable<Buffer>) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

function observe(handler: (request: ObservedRequest, response: ServerResponse) => void): Promise<ControlledService> {
  const requests: ObservedRequest[] = []
  const server = createServer((request, response) => {
    void readBody(request).then((body) => {
      requests.push({ method: request.method ?? '', path: request.url ?? '',
        grant: request.headers['x-dsh-auth-token'] as string | undefined, apiKey: request.headers['x-api-key'] as string | undefined, body })
      handler(requests.at(-1)!, response)
    }).catch(() => response.destroy(new Error('controlled service read failure')))
  })
  return listen(server).then(url => ({
    url, requests,
    close: () => new Promise<void>((resolve) => { server.close(() => { resolve() }) }),
  }))
}

/** The Platform stand-in: sign-in initialization and cancellation, and the account profile read. */
function platformService(): Promise<ControlledService> {
  return observe((request, response) => {
    const origin = platform.url
    const reply = (value: unknown): void => {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ code: 0, data: { biz_code: 0, biz_data: value } }))
    }
    if (request.path === '/auth-api/v0/dsh/auth_init') {
      reply({ authorize_url: `${origin}/dsh/authorize?authorize_id=isolation`, authorize_id: 'isolation', expires_in: 600 })
      return
    }
    if (request.path === '/auth-api/v0/dsh/auth_cancel') { reply(null); return }
    if (request.path === '/auth-api/v0/users/current') {
      reply({ id: 'isolation-user', email: 't***@example.invalid', mobile: '138****5678', id_profile: { name: 'Isolation', picture: null } })
      return
    }
    response.writeHead(404).end()
  })
}

/** The Messages stand-in: one complete text generation per request. */
function modelService(): Promise<ControlledService> {
  const events = [
    { type: 'message_start', message: { id: 'msg_1', model: 'deepseek-flash', usage: { input_tokens: 3, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ]
  const sse = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
  return observe((request, response) => {
    if (request.path === '/v1/messages') {
      response.writeHead(200, { 'content-type': 'text/event-stream' }).end(sse)
      return
    }
    response.writeHead(404).end()
  })
}

/** The egress fence: records every proxied destination and answers 502, so no external service is ever reached. */
async function recordingProxy(log: string[]): Promise<ControlledService> {
  const server = createServer((request, response) => {
    log.push(`REQ ${request.url ?? ''}`)
    response.writeHead(502).end('request-isolation proxy')
  })
  server.on('connect', (request, socket) => {
    log.push(`CONNECT ${request.url ?? ''}`)
    socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
    socket.end()
  })
  const url = await listen(server)
  return { url, requests: [], close: () => new Promise<void>((resolve) => { server.close(() => { resolve() }) }) }
}

let platform: ControlledService
let model: ControlledService
let proxy: ControlledService
let home: string
let ctx: Context
let disposeProxy: () => Promise<void>
const proxyLog: string[] = []
const environmentBackup: Record<string, string | undefined> = {}
const CLIENT: AccountClientMetadata = { version: '0.0.0-isolation', locale: 'en', timezoneOffsetSeconds: 0 }

/**
 * Boot the shipped composition with only the transport-free rows substituted;
 * the request-making plugins — platform account, model adapter, credentials —
 * are the real thing, pointed at the controlled services.
 */
async function bootComposition(): Promise<Context> {
  const overrides: PatchOptions[] = [
    { id: 'storage-json', config: { root: join(home, 'storages') } },
    // Fixed Session data must stay inside this boot's temporary profile root.
    { id: 'session-persistence-jsonl', config: { root: join(home, 'sessions') } },
    // The account sign-in callback registers on the bound webserver; it stays
    // ENABLED on an OS-assigned loopback port while the rows that would serve
    // the browser surface or watch files are disabled.
    { id: 'webserver', config: { host: '127.0.0.1', port: 0 } },
    { id: 'hmr', disabled: true },
    { id: 'web-runtime', disabled: true },
    { id: 'modules', disabled: true },
    { id: 'connection', disabled: true },
    { id: 'session-log-download', disabled: true },
    { id: 'open-in-app', disabled: true },
    { id: 'client-hmr', disabled: true },
    { id: 'directory-picker', disabled: true },
    { insert: [
      { id: 'directory-picker-browse', name: '@deepseek-ai/dsh-host-directory-picker-browse' },
      { id: 'ui-directory-picker-browse', name: '@deepseek-ai/dsh-client-ui-directory-picker-browse' },
    ] },
    // The controlled Platform stand-in, with loopback HTTP explicitly enabled.
    { id: 'deepseek-account', config: { platformOrigin: platform.url, allowLoopbackHttp: true, desktopPlatform: null } },
    // The on-demand egress probe, fired only by the fence control case.
    { insert: [{ id: 'egress-probe', name: PROBE_MODULE }] },
  ]
  const profileDir = join(home, 'profiles', 'spec')
  await mkdir(profileDir, { recursive: true })
  initProfile(profileDir, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  const profile: Profile = { skippedBundles: [], name: 'spec', dir: profileDir,
    layers: [], patchPath: join(profileDir, 'cordis.patch.yml'), patches: [] }
  const resolution = await createRuntimeResolution({ installAnchor: INSTALL_ANCHOR, home, profile })
  const rootConfig = join(profileDir, 'cordis.yml')
  await writeFile(rootConfig, '[]\n')
  const patches = [
    ...loadOverlayPatches('dsh-test', BASE_PATCH),
    ...WEB_PATCHES.flatMap(file => loadOverlayPatches('dsh-test', file)),
    ...overrides,
  ]
  return await boot('dsh-test', rootConfig, patches, async (bootCtx) => {
    bootCtx.provide('profileContext', { name: 'spec', dir: profileDir, patchPath: profile.patchPath,
      installAnchor: INSTALL_ANCHOR, home, cwd: home,
      startedBundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
      overlays: [], telemetryDisabledEnv: undefined })
    await bootCtx.plugin(PluginPackages, { resolution })
    bootCtx.provide('connection', {
      fetch: { register: () => () => {} },
      rpc: { intercept: () => () => {} },
    } as never)
    provideCmdline(bootCtx, { args: [], exit: () => {} })
  })
}

beforeAll(async () => {
  platform = await platformService()
  model = await modelService()
  proxy = await recordingProxy(proxyLog)
  home = await mkdtemp(join(tmpdir(), 'dsh-request-isolation-'))
  for (const name of ['DSH_HOME', 'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL']) environmentBackup[name] = process.env[name]
  process.env.DSH_HOME = home
  // The user-configured credential and model endpoint, resolved per request by
  // the real adapter; both point at the controlled service.
  process.env.DEEPSEEK_API_KEY = 'request-isolation-probe-key'
  process.env.DEEPSEEK_BASE_URL = model.url
  // The enterprise posture: every non-loopback destination fails. Loopback is
  // always bypassed by the proxy install, so the controlled services receive
  // their traffic directly.
  disposeProxy = await installProxyFromEnvironment(
    { get: name => (name === 'HTTP_PROXY' || name === 'HTTPS_PROXY' ? { value: proxy.url } : undefined) },
    () => undefined,
  )
  ctx = await bootComposition()
}, 120_000)

afterAll(async () => {
  await ctx?.fiber.dispose()
  await disposeProxy()
  for (const [name, value] of Object.entries(environmentBackup)) {
    if (value === undefined) Reflect.deleteProperty(process.env, name)
    else process.env[name] = value
  }
  await Promise.all([platform.close(), model.close(), proxy.close()])
  await rm(home, { recursive: true, force: true })
})

function callbackOrigin(): string {
  const webServer = ctx.get('webServer') as { port: number } | undefined
  if (webServer === undefined) throw new Error('the composition must bind its webserver for the sign-in callback')
  return `http://127.0.0.1:${String(webServer.port)}`
}

describe('personal composition request isolation', () => {
  it('boots the shipped composition with no requests to non-loopback destinations', () => {
    // Boot alone must be quiet: no telemetry flush, no policy check, no
    // branding or Skill Hub discovery against any external service.
    expect(proxyLog).toEqual([])
  })

  it('starts platform sign-in against the configured origin and settles cancellation there', async () => {
    const baseline = platform.requests.length
    const started = await ctx.deepseekAccount.startSignIn(CLIENT, callbackOrigin(), 'desktop')
    await vi.waitFor(() => {
      expect(platform.requests.slice(baseline).filter(request => request.path === '/auth-api/v0/dsh/auth_init')).toHaveLength(1)
    })
    const attempt = (await ctx.deepseekAccount.getState()).attempt
    expect(attempt?.phase).toBe('waiting-browser')
    expect(attempt?.authorizeUrl).toBe(`${platform.url}/dsh/authorize?authorize_id=isolation`)
    expect(started.attempt?.id).toBe(attempt?.id)
    await ctx.deepseekAccount.cancelSignIn(attempt!.id)
    await vi.waitFor(() => {
      expect(platform.requests.slice(baseline).filter(request => request.path === '/auth-api/v0/dsh/auth_cancel')).toHaveLength(1)
    })
    const settled = await ctx.deepseekAccount.getState()
    expect(settled.attempt?.phase).toBe('cancelled')
    expect(settled.status).toBe('signed-out')
    expect(proxyLog).toEqual([])
  })

  it('reads the account profile against the configured origin with the stored grant', async () => {
    const baseline = platform.requests.length
    await ctx.credentials.modifyRecord(credentialKey('deepseek-account-platform', 'default'), () => Promise.resolve({
      kind: 'grant', payload: { version: 1, issuer: platform.url, token: 'isolation-grant' },
    }))
    const profile = await ctx.deepseekAccount.getProfile(CLIENT)
    expect(profile).toMatchObject({ status: 'ready' })
    const reads = platform.requests.slice(baseline).filter(request => request.path === '/auth-api/v0/users/current')
    expect(reads).toHaveLength(1)
    expect(reads[0]!.method).toBe('GET')
    expect(reads[0]!.grant).toBe('isolation-grant')
    expect(proxyLog).toEqual([])
  })

  it('sends a model chat request to the user-configured endpoint with the configured credential', async () => {
    const baseline = model.requests.length
    let text = ''
    for await (const chunk of ctx.llm.stream({
      provider: 'deepseek-official', model: 'deepseek-flash',
      messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] })],
    })) {
      if (chunk.type === 'text-delta') text += chunk.text
    }
    expect(text).toBe('hello')
    const calls = model.requests.slice(baseline).filter(request => request.path === '/v1/messages')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.apiKey).toBe('request-isolation-probe-key')
    expect(JSON.parse(calls[0]!.body) as { model: string }).toMatchObject({ model: 'deepseek-flash' })
    expect(proxyLog).toEqual([])
  })

  it('records a composed plugin that dials a forbidden service class', async () => {
    // Negative control: the fence is only worth its assertions when it proves
    // it catches the request classes it exists to reject. The probe dials a
    // Skill-Hub-class destination the personal composition must never call.
    const probe = ctx.get('egressProbe') as { ping(url: string): Promise<number> } | undefined
    expect(probe).toBeDefined()
    await probe!.ping('https://skill-hub.enterprise.example/v1/skills')
    expect(proxyLog.some(line => line.includes('skill-hub.enterprise.example'))).toBe(true)
  })
})
