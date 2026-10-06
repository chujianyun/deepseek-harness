/** Shared by the connector specs: a Hub sign-in stand-in and a service booted over a stand-in lark-cli or dws. */
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'
import ConnectorsService, { type CliSpec, type ConnectorsState } from '../src/index.ts'
import { FAKE_DWS } from './fake-dws-cli.ts'
import { FAKE_LARK_CLI as FAKE } from './fake-lark-cli.ts'

export const VERSION = '9.9.9'
const PLATFORM = `${process.platform}-${process.arch}`
const SPEC: CliSpec = {
  binary: 'lark-cli', version: VERSION, mirrors: ['http://127.0.0.1:9/{file}'],
  archives: [{ platform: PLATFORM, file: 'lark-cli.tar.gz', size: 1, sha256: '0'.repeat(64) }],
}
const DWS_SPEC: CliSpec = {
  binary: 'dws', version: VERSION, mirrors: ['http://127.0.0.1:9/{file}'],
  archives: [{ platform: PLATFORM, file: 'dws.tar.gz', size: 1, sha256: '0'.repeat(64) }],
  skills: { file: 'dws-skills.zip', size: 1, sha256: '0'.repeat(64) },
}
/** A connector with no build for any platform. */
const NOWHERE = (binary: string): CliSpec => ({ binary, version: VERSION, mirrors: [], archives: [] })

/** The Skills the stand-in dws release ships, as `<name>/SKILL.md`. */
export const DWS_SKILLS: Readonly<Record<string, string>> = {
  'dingtalk-calendar': '---\nname: dingtalk-calendar\ndescription: 钉钉日历与会议室\nmetadata:\n  category: product\n---\n\n# calendar\n\nRun dws calendar event list.\n',
  'dingtalk-chat': '---\nname: dingtalk-chat\ndescription: "钉钉群聊与消息"\n---\nRun dws chat message send.\n',
  // Skipped: a name that disagrees with its directory, no description, YAML that does not parse, and no frontmatter.
  'dingtalk-other': '---\nname: dingtalk-renamed\ndescription: x\n---\n',
  'dingtalk-empty': '---\nname: dingtalk-empty\n---\n',
  'dingtalk-broken': '---\nname: [unclosed\n---\n',
  'dingtalk-plain': '# no frontmatter\n',
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
export const dingtalk = (state: ConnectorsState) => state.connectors[1]!

export async function setup(options: {
  tenant?: string | null
  installed?: boolean
  checkIntervalMs?: number
  /** Control files written before the service starts, such as `noskills`. */
  files?: readonly string[]
  /** Leave out the Settings service. */
  settings?: false
  /** The directory the DSH home is made in; the system temporary directory by default. */
  homeParent?: string
  /** The connector the spec drives, with its stand-in CLI; the other has no build for any platform. */
  connector?: 'feishu' | 'dingtalk'
} = {}) {
  const id = options.connector ?? 'feishu'
  if (options.homeParent !== undefined) await mkdir(options.homeParent, { recursive: true })
  const home = await mkdtemp(join(options.homeParent ?? tmpdir(), 'dsh-connection-'))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  const root = join(home, 'connectors', id)
  const control = join(root, 'control')
  const binary = id === 'feishu' ? 'lark-cli' : 'dws'
  if (options.installed !== false) {
    await mkdir(join(root, VERSION), { recursive: true })
    await writeFile(join(root, VERSION, binary), id === 'feishu' ? FAKE : FAKE_DWS)
    await chmod(join(root, VERSION, binary), 0o755)
    if (id === 'dingtalk') {
      for (const [name, markdown] of Object.entries(DWS_SKILLS)) {
        await mkdir(join(root, VERSION, 'skills', name), { recursive: true })
        await writeFile(join(root, VERSION, 'skills', name, 'SKILL.md'), markdown)
      }
    }
    await mkdir(control, { recursive: true })
    for (const file of options.files ?? []) await writeFile(join(control, file), '')
  }
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  const hub = hubStub(options.tenant === undefined ? 't-a' : options.tenant)
  ctx.provide('hubAccount', hub.service as never)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(ShellEnv, { dshHome: home })
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: home })
  const interval = options.checkIntervalMs === undefined ? {} : { checkIntervalMs: options.checkIntervalMs }
  // The other connector stays uninstallable, so no test reaches its real mirrors.
  const specs = id === 'feishu' ? { feishu: SPEC, dingtalk: NOWHERE('dws') } : { feishu: NOWHERE('lark-cli'), dingtalk: DWS_SPEC }
  const live = await liveConfig(ctx, ConnectorsService, { dshHome: home, ...specs, ...interval })
  if (options.settings !== false) {
    ctx.provide('settings', { update: async (_entry: string, patch: Record<string, unknown>) => { await live.update(patch) } } as never)
  }
  const service = ctx.get('connectors')!
  const stream = new AbortController()
  cleanups.push(async () => { stream.abort() })
  const iterator = service.watch(stream.signal)[Symbol.asyncIterator]()
  const pick = id === 'feishu' ? feishu : dingtalk
  const until = async (predicate: (view: ReturnType<typeof feishu>) => boolean) => {
    for (;;) {
      const next = await iterator.next()
      if (next.done === true) throw new Error('state stream ended')
      if (predicate(pick(next.value))) return pick(next.value)
    }
  }
  const tenantDir = (tenant: string) => join(root, 'tenants', tenant)
  const exists = (path: string) => stat(path).then(() => true, () => false)
  const calls = async () => (await readFile(join(control, 'calls'), 'utf8').catch(() => '')).trim().split('\n').filter(line => line !== '')
  const answer = (step: 'app' | 'user', result: string) => writeFile(join(control, step), result)
  const status = (value: object | string) => writeFile(join(control, 'status.json'), typeof value === 'string' ? value : JSON.stringify(value))
  return { ctx, service, hub, until, root, control, tenantDir, exists, calls, answer, status }
}
