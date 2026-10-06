/** Connector CLIs installed from a loopback mirror serving stand-in archives. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { create } from 'tar'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { remoteErrorOf, remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'
import { hubStub } from './support.ts'
import ConnectorsService, { type CliSpec, type ConnectorsState } from '../src/index.ts'

/** A rename into this path fails, as a full or read-only disk would refuse it. */
const refusedRename = vi.hoisted(() => ({ target: undefined as string | undefined }))
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return {
    ...fs,
    rename: (from: string, to: string) => to === refusedRename.target ? Promise.reject(new Error('EROFS')) : fs.rename(from, to),
  }
})

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const VERSION = '9.9.9'
const PLATFORM = `${process.platform}-${process.arch}`

async function scratch(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** A stand-in CLI: a shell script that prints `lark-cli version <reported>`. */
async function archive(kind: 'tar.gz' | 'zip', options: { reported?: string; entry?: string } = {}): Promise<Buffer> {
  const script = `#!/bin/sh\necho "lark-cli version ${options.reported ?? VERSION}"\n`
  const entry = options.entry ?? 'lark-cli'
  if (kind === 'zip') return Buffer.from(zipSync({ [entry]: Buffer.from(script), 'README.md': Buffer.from('readme') }))
  const dir = await scratch('dsh-connectors-archive-')
  await writeFile(join(dir, entry), script, { mode: 0o755 })
  await writeFile(join(dir, 'README.md'), 'readme')
  const out = join(dir, 'out.tar.gz')
  await create({ gzip: true, file: out, cwd: dir }, [entry, 'README.md'])
  return readFile(out)
}

interface Mirror {
  readonly origin: string
  readonly requests: string[]
  files: Map<string, Buffer>
  fail?: (path: string) => boolean
  /** Hold every response until released. */
  hold?: Promise<void>
  /** Send the first half, then the rest this many milliseconds later. */
  pauseMs?: number
}

async function startMirror(): Promise<Mirror> {
  const mirror: Mirror = { origin: '', requests: [], files: new Map() }
  const server = createServer((req, res) => {
    void (async () => {
      mirror.requests.push(req.url!)
      await mirror.hold
      const body = mirror.files.get(req.url!)
      if (mirror.fail?.(req.url!) === true || body === undefined) { res.writeHead(404).end(); return }
      if (mirror.pauseMs === undefined) { res.writeHead(200).end(body); return }
      res.writeHead(200).write(body.subarray(0, body.length / 2))
      await new Promise(resolve => setTimeout(resolve, mirror.pauseMs))
      res.end(body.subarray(body.length / 2))
    })()
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  cleanups.push(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) }))
  return Object.assign(mirror, { origin: `http://127.0.0.1:${String(typeof address === 'object' && address !== null ? address.port : 0)}` })
}

/** A spec whose only archive for this platform is `body`, served by the mirror under `/second`. */
function spec(mirror: Mirror, body: Buffer, file = `lark-cli-${VERSION}.tar.gz`, platform = PLATFORM): CliSpec {
  mirror.files.set(`/second/v${VERSION}/${file}`, body)
  return {
    binary: 'lark-cli', version: VERSION,
    mirrors: [`${mirror.origin}/first/v{version}/{file}`, `${mirror.origin}/second/v{version}/{file}`],
    archives: [{ platform, file, size: body.length, sha256: createHash('sha256').update(body).digest('hex') }],
  }
}

type BootOptions = { tenant?: string | null; checkIntervalMs?: number; dingtalk?: CliSpec }

async function boot(home: string, feishu?: CliSpec, options: BootOptions = {}) {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  const hub = hubStub(options.tenant ?? null)
  ctx.provide('hubAccount', hub.service as never)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(ShellEnv, { dshHome: home })
  const live = await liveConfig(ctx, ConnectorsService, {
    dshHome: home, ...feishu === undefined ? {} : { feishu }, ...options.dingtalk === undefined ? {} : { dingtalk: options.dingtalk },
    ...options.checkIntervalMs === undefined ? {} : { checkIntervalMs: options.checkIntervalMs },
  })
  ctx.provide('settings', { update: async (_entry: string, patch: Record<string, unknown>) => { await live.update(patch) } } as never)
  const service = ctx.get('connectors')!
  const stream = new AbortController()
  cleanups.push(async () => { stream.abort() })
  const iterator = service.watch(stream.signal)[Symbol.asyncIterator]()
  const until = async (predicate: (state: ConnectorsState) => boolean): Promise<ConnectorsState> => {
    for (;;) {
      const next = await iterator.next()
      if (next.done === true) throw new Error('state stream ended')
      if (predicate(next.value)) return next.value
    }
  }
  return { ctx, service, until, hub }
}

const feishu = (state: ConnectorsState) => state.connectors.find(connector => connector.id === 'feishu')!
const dingtalkView = (state: ConnectorsState) => state.connectors.find(connector => connector.id === 'dingtalk')!
const runs = it.skipIf(process.platform === 'win32')

describe('connectors', () => {
  it('publishes the namespace, and Feishu and DingTalk with their pinned CLIs', async () => {
    const { service } = await boot(await scratch('dsh-connectors-home-'))
    expect(service.typertRemote.namespace).toBe('connectors')
    expect(remoteMethods(service).map(method => method.method)).toEqual([
      'getState', 'watch', 'installConnector', 'uninstallConnector', 'connect', 'cancelConnect', 'disconnect', 'check', 'setEnabled',
    ])
    const state = await service.getState()
    // dws has no Windows build DSH can isolate, and neither CLI builds for every architecture.
    const dwsPlatforms = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64']
    expect(state.connectors.map(connector => [connector.id, connector.status])).toEqual([
      ['feishu', PLATFORM === 'linux-riscv64' ? 'unsupported' : 'not-installed'],
      ['dingtalk', dwsPlatforms.includes(PLATFORM) ? 'not-installed' : 'unsupported'],
    ])
    expect(feishu(state)).toMatchObject({ cli: 'lark-cli', version: '1.0.97', receivedBytes: 0, error: null, login: null, loginError: null })
    expect(state.connectors[1]).toMatchObject({
      id: 'dingtalk', cli: 'dws', version: '1.0.63', receivedBytes: 0, error: null,
      login: null, loginError: null, account: null, problem: null, enabled: true, skills: [],
    })
    // The DingTalk download is the executable's archive plus the release's Skills archive.
    if (dwsPlatforms.includes(PLATFORM)) expect(state.connectors[1]?.totalBytes).toBeGreaterThan(3_251_120)
  })

  runs('installs the CLI from the next mirror, keeps only the executable, and finds it installed after a restart', async () => {
    const home = await scratch('dsh-connectors-home-')
    const mirror = await startMirror()
    const body = await archive('tar.gz')
    const cli = spec(mirror, body)
    const { service, until } = await boot(home, cli)
    expect(feishu(await service.getState())).toMatchObject({ status: 'not-installed', totalBytes: body.length })
    await service.installConnector('feishu')
    expect(feishu(await service.getState()).status).toBe('installing')
    const done = feishu(await until(state => feishu(state).status !== 'installing'))
    expect(done).toMatchObject({ status: 'disconnected', receivedBytes: body.length, error: null })
    expect(mirror.requests).toEqual([`/first/v${VERSION}/lark-cli-${VERSION}.tar.gz`, `/second/v${VERSION}/lark-cli-${VERSION}.tar.gz`])
    const root = join(home, 'connectors', 'feishu')
    expect(await readdir(join(root, VERSION))).toEqual(['lark-cli'])
    expect(await readdir(join(root, 'downloads'))).toEqual([])
    // Installing again changes nothing.
    await service.installConnector('feishu')
    expect(mirror.requests).toHaveLength(2)
    const restarted = await boot(home, cli)
    expect(feishu(await restarted.service.getState()).status).toBe('disconnected')
  })

  runs('counts the bytes of a download an earlier install left unfinished', async () => {
    const home = await scratch('dsh-connectors-home-')
    const mirror = await startMirror()
    const body = await archive('tar.gz')
    const downloads = join(home, 'connectors', 'feishu', 'downloads')
    await mkdir(downloads, { recursive: true })
    await writeFile(join(downloads, `lark-cli-${VERSION}.tar.gz.part`), body.subarray(0, 100))
    // The stand-in mirror ignores Range, so the partial bytes are counted, then uncounted, then the whole file.
    const { service, until } = await boot(home, spec(mirror, body))
    await service.installConnector('feishu')
    await until(state => feishu(state).receivedBytes === 100)
    expect(feishu(await until(state => feishu(state).status !== 'installing'))).toMatchObject({ status: 'disconnected', receivedBytes: body.length })
  })

  runs('publishes download progress while the bytes stream in', async () => {
    const mirror = await startMirror()
    const body = await archive('tar.gz')
    mirror.pauseMs = 600
    const { service, until } = await boot(await scratch('dsh-connectors-home-'), spec(mirror, body))
    await service.installConnector('feishu')
    const partial = feishu(await until(state => feishu(state).receivedBytes > 0 && feishu(state).receivedBytes < body.length))
    expect(partial.status).toBe('installing')
    await until(state => feishu(state).status === 'disconnected')
  })

  runs('unpacks a zip archive', async () => {
    const mirror = await startMirror()
    const { service, until } = await boot(await scratch('dsh-connectors-home-'), spec(mirror, await archive('zip'), `lark-cli-${VERSION}.zip`))
    await service.installConnector('feishu')
    expect(feishu(await until(state => feishu(state).status !== 'installing')).status).toBe('disconnected')
  })

  it('reports verification when the archive is not the pinned one, then installs once it is', async () => {
    const mirror = await startMirror()
    const body = await archive('tar.gz')
    const cli = spec(mirror, body)
    mirror.files.set(`/second/v${VERSION}/lark-cli-${VERSION}.tar.gz`, Buffer.alloc(body.length, 1))
    const { service, until } = await boot(await scratch('dsh-connectors-home-'), cli)
    await service.installConnector('feishu')
    expect(feishu(await until(state => feishu(state).status === 'not-installed'))).toMatchObject({ error: 'verification', receivedBytes: 0 })
    if (process.platform === 'win32') return
    mirror.files.set(`/second/v${VERSION}/lark-cli-${VERSION}.tar.gz`, body)
    await service.installConnector('feishu')
    expect(feishu(await service.getState()).error).toBeNull()
    expect(feishu(await until(state => feishu(state).status !== 'installing')).status).toBe('disconnected')
  })

  it('reports network when no mirror serves the archive', async () => {
    const mirror = await startMirror()
    const cli = spec(mirror, await archive('tar.gz'))
    mirror.fail = () => true
    const { service, until } = await boot(await scratch('dsh-connectors-home-'), cli)
    await service.installConnector('feishu')
    expect(feishu(await until(state => feishu(state).status === 'not-installed')).error).toBe('network')
  })

  it('reports storage when the archive has no executable', async () => {
    const home = await scratch('dsh-connectors-home-')
    const mirror = await startMirror()
    const { service, until } = await boot(home, spec(mirror, await archive('tar.gz', { entry: 'other' })))
    await service.installConnector('feishu')
    expect(feishu(await until(state => feishu(state).status === 'not-installed')).error).toBe('storage')
    expect(await readdir(join(home, 'connectors', 'feishu'))).toEqual(['downloads'])
    const zipped = await boot(await scratch('dsh-connectors-home-'), spec(mirror, await archive('zip', { entry: 'other' }), `lark-cli-${VERSION}.zip`))
    await zipped.service.installConnector('feishu')
    expect(feishu(await zipped.until(state => feishu(state).status === 'not-installed')).error).toBe('storage')
  })

  runs('reports launch when the CLI does not report the pinned version, leaving nothing installed', async () => {
    const home = await scratch('dsh-connectors-home-')
    const mirror = await startMirror()
    const { service, until } = await boot(home, spec(mirror, await archive('tar.gz', { reported: '1.0.0' })))
    await service.installConnector('feishu')
    expect(feishu(await until(state => feishu(state).status === 'not-installed')).error).toBe('launch')
    expect(await readdir(join(home, 'connectors', 'feishu'))).toEqual(['downloads'])
  })

  runs('reports storage when the checked CLI cannot be moved into place', async () => {
    const home = await scratch('dsh-connectors-home-')
    const mirror = await startMirror()
    refusedRename.target = join(home, 'connectors', 'feishu', VERSION)
    cleanups.push(async () => { refusedRename.target = undefined })
    const { service, until } = await boot(home, spec(mirror, await archive('tar.gz')))
    await service.installConnector('feishu')
    expect(feishu(await until(state => feishu(state).status === 'not-installed')).error).toBe('storage')
    expect(await readdir(join(home, 'connectors', 'feishu'))).toEqual(['downloads'])
  })

  runs('uninstalls an installed CLI, and stops and removes a running install', async () => {
    const home = await scratch('dsh-connectors-home-')
    const mirror = await startMirror()
    const { service, until } = await boot(home, spec(mirror, await archive('tar.gz')))
    await service.installConnector('feishu')
    await until(state => feishu(state).status === 'disconnected')
    expect(feishu(await service.uninstallConnector('feishu'))).toMatchObject({ status: 'not-installed', receivedBytes: 0, error: null })
    expect(await stat(join(home, 'connectors', 'feishu')).catch(() => undefined)).toBeUndefined()
    let release!: () => void
    mirror.hold = new Promise((resolve) => { release = resolve })
    await service.installConnector('feishu')
    const uninstalled = service.uninstallConnector('feishu')
    release()
    expect(feishu(await uninstalled)).toMatchObject({ status: 'not-installed', error: null })
    expect(await stat(join(home, 'connectors', 'feishu')).catch(() => undefined)).toBeUndefined()
  })

  it('stops a running install quietly when the plugin is disposed', async () => {
    const home = await scratch('dsh-connectors-home-')
    const mirror = await startMirror()
    mirror.hold = new Promise(() => {})
    const { ctx, service } = await boot(home, spec(mirror, await archive('tar.gz')))
    await service.installConnector('feishu')
    await ctx.fiber.dispose()
    expect(feishu(await service.getState()).status).toBe('installing')
  })

  /** A dws spec whose executable and Skills archives the mirror serves under `/second`. */
  async function dwsSpec(mirror: Mirror, skills: Record<string, Uint8Array>): Promise<CliSpec> {
    const body = await archive('tar.gz', { entry: 'dws' })
    const zip = Buffer.from(zipSync(skills))
    mirror.files.set(`/second/v${VERSION}/dws.tar.gz`, body)
    mirror.files.set(`/second/v${VERSION}/dws-skills.zip`, zip)
    const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
    return {
      binary: 'dws', version: VERSION, mirrors: [`${mirror.origin}/second/v{version}/{file}`],
      archives: [{ platform: PLATFORM, file: 'dws.tar.gz', size: body.length, sha256: digest(body) }],
      skills: { file: 'dws-skills.zip', size: zip.length, sha256: digest(zip) },
    }
  }

  runs('installs dws with the per-Skill tree of its release\'s Skills archive', async () => {
    const home = await scratch('dsh-connectors-home-')
    const mirror = await startMirror()
    const skill = Buffer.from('---\nname: dingtalk-calendar\ndescription: 钉钉日历\n---\nbody\n')
    const dingtalk = await dwsSpec(mirror, {
      'SKILL.md': Buffer.from('mono copy'), 'mono/SKILL.md': Buffer.from('mono'),
      'multi/dingtalk-calendar/SKILL.md': skill, 'multi/dingtalk-calendar/references/guide.md': Buffer.from('guide'),
    })
    const { service, until } = await boot(home, undefined, { dingtalk })
    expect(dingtalkView(await service.getState()).totalBytes).toBe(dingtalk.archives[0]!.size + dingtalk.skills!.size)
    await service.installConnector('dingtalk')
    const installed = await until(state => dingtalkView(state).skills.length > 0)
    expect(dingtalkView(installed).skills).toEqual([{ name: 'dingtalk-calendar', description: '钉钉日历' }])
    const version = join(home, 'connectors', 'dingtalk', VERSION)
    expect((await readdir(version)).sort()).toEqual(['dws', 'skills'])
    expect(await readdir(join(version, 'skills'))).toEqual(['dingtalk-calendar'])
    expect(await readFile(join(version, 'skills', 'dingtalk-calendar', 'references', 'guide.md'), 'utf8')).toBe('guide')
    expect(await readdir(join(home, 'connectors', 'dingtalk', 'downloads'))).toEqual([])
  })

  runs('refuses a Skills archive whose entry would leave the Skills directory, installing nothing', async () => {
    const home = await scratch('dsh-connectors-home-')
    const mirror = await startMirror()
    const dingtalk = await dwsSpec(mirror, { 'multi/../../escaped.md': Buffer.from('x') })
    const { service, until } = await boot(home, undefined, { dingtalk })
    await service.installConnector('dingtalk')
    expect(dingtalkView(await until(state => dingtalkView(state).error !== null))).toMatchObject({ status: 'not-installed', error: 'storage' })
    expect(await stat(join(home, 'connectors', 'escaped.md')).catch(() => undefined)).toBeUndefined()
    expect(await stat(join(home, 'connectors', 'dingtalk', VERSION)).catch(() => undefined)).toBeUndefined()
  })

  it('refuses unknown connectors and CLIs without a build for this platform', async () => {
    const mirror = await startMirror()
    const { service } = await boot(await scratch('dsh-connectors-home-'), spec(mirror, await archive('tar.gz'), `lark-cli-${VERSION}.tar.gz`, 'plan9-mips'), {
      dingtalk: { binary: 'dws', version: VERSION, mirrors: [], archives: [] },
    })
    expect(feishu(await service.getState()).status).toBe('unsupported')
    for (const [id, code] of [['feishu', 'connectors/unavailable'], ['dingtalk', 'connectors/unavailable'], ['wecom', 'connectors/not-found']] as const) {
      const install = await service.installConnector(id).catch((error: unknown) => error)
      expect(remoteErrorOf(install)?.code).toBe(code)
      const uninstall = await service.uninstallConnector(id).catch((error: unknown) => error)
      expect(remoteErrorOf(uninstall)?.code).toBe(code)
    }
  })

  it('ends the state stream when the plugin is disposed', async () => {
    const { ctx, service } = await boot(await scratch('dsh-connectors-home-'))
    const stream = service.watch(new AbortController().signal)[Symbol.asyncIterator]()
    await stream.next()
    const pending = stream.next()
    await ctx.fiber.dispose()
    expect((await pending).done).toBe(true)
  })

  it('ends the state stream when its signal aborts', async () => {
    const { service } = await boot(await scratch('dsh-connectors-home-'))
    const controller = new AbortController()
    const stream = service.watch(controller.signal)[Symbol.asyncIterator]()
    await stream.next()
    const pending = stream.next()
    controller.abort()
    expect((await pending).done).toBe(true)
  })

  it('creates nothing until a connector is installed', async () => {
    const home = await scratch('dsh-connectors-home-')
    await mkdir(join(home, 'unrelated'))
    await boot(home)
    expect(await readdir(home)).toEqual(['unrelated'])
  })
})
