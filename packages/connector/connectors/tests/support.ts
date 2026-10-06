/** Shared by the connector specs: a Hub sign-in stand-in and a service booted over the stand-in lark-cli. */
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'
import ConnectorsService, { type CliSpec, type ConnectorsState } from '../src/index.ts'
import { FAKE_LARK_CLI as FAKE } from './fake-lark-cli.ts'

export const VERSION = '9.9.9'
const PLATFORM = `${process.platform}-${process.arch}`
const SPEC: CliSpec = {
  binary: 'lark-cli', version: VERSION, mirrors: ['http://127.0.0.1:9/{file}'],
  archives: [{ platform: PLATFORM, file: 'lark-cli.tar.gz', size: 1, sha256: '0'.repeat(64) }],
}

export const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.unstubAllEnvs()
})

/** A Hub sign-in stand-in whose tenant the spec switches. */
export function hubStub(tenantId: string | null) {
  let current = tenantId
  let version = 0
  const waiting = new Set<() => void>()
  const view = () => ({ profile: current === null ? null : { tenantId: current } })
  return {
    set: (next: string | null) => { current = next; version += 1; for (const wake of waiting) wake() },
    service: {
      getState: () => Promise.resolve(view()),
      async *watch(signal: AbortSignal) {
        // Every change after the watch starts is seen, even one made while the consumer was busy.
        let seen = version
        for (;;) {
          if (seen === version) {
            await new Promise<void>((resolve) => {
              const wake = (): void => { waiting.delete(wake); resolve() }
              waiting.add(wake)
              signal.addEventListener('abort', wake, { once: true })
            })
          }
          if (signal.aborted) return
          seen = version
          yield view()
        }
      },
    },
  }
}

export const feishu = (state: ConnectorsState) => state.connectors[0]!

export async function setup(options: {
  tenant?: string | null
  installed?: boolean
  checkIntervalMs?: number
  /** Control files written before the service starts, such as `noskills`. */
  files?: readonly string[]
  /** Leave out the Settings service. */
  settings?: false
} = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-connection-'))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  const root = join(home, 'connectors', 'feishu')
  const control = join(root, 'control')
  if (options.installed !== false) {
    await mkdir(join(root, VERSION), { recursive: true })
    await writeFile(join(root, VERSION, 'lark-cli'), FAKE)
    await chmod(join(root, VERSION, 'lark-cli'), 0o755)
    await mkdir(control, { recursive: true })
    for (const file of options.files ?? []) await writeFile(join(control, file), '')
  }
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  const hub = hubStub(options.tenant === undefined ? 't-a' : options.tenant)
  ctx.provide('hubAccount', hub.service as never)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(ShellEnv, { dshHome: home })
  const interval = options.checkIntervalMs === undefined ? {} : { checkIntervalMs: options.checkIntervalMs }
  const live = await liveConfig(ctx, ConnectorsService, { dshHome: home, feishu: SPEC, ...interval })
  if (options.settings !== false) {
    ctx.provide('settings', { update: async (_entry: string, patch: Record<string, unknown>) => { await live.update(patch) } } as never)
  }
  const service = ctx.get('connectors')!
  const stream = new AbortController()
  cleanups.push(async () => { stream.abort() })
  const iterator = service.watch(stream.signal)[Symbol.asyncIterator]()
  const until = async (predicate: (view: ReturnType<typeof feishu>) => boolean) => {
    for (;;) {
      const next = await iterator.next()
      if (next.done === true) throw new Error('state stream ended')
      if (predicate(feishu(next.value))) return feishu(next.value)
    }
  }
  const tenantDir = (tenant: string) => join(root, 'tenants', tenant)
  const exists = (path: string) => stat(path).then(() => true, () => false)
  const calls = async () => (await readFile(join(control, 'calls'), 'utf8').catch(() => '')).trim().split('\n').filter(line => line !== '')
  const answer = (step: 'app' | 'user', result: string) => writeFile(join(control, step), result)
  const status = (value: object | string) => writeFile(join(control, 'status.json'), typeof value === 'string' ? value : JSON.stringify(value))
  return { ctx, service, hub, until, root, control, tenantDir, exists, calls, answer, status }
}
