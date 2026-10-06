/**
 * The DingTalk driver: running an installed `dws` for one tenant. Every run gets the tenant's own
 * configuration directory and encrypted credential store (`DWS_CONFIG_DIR`, `DWS_KEYCHAIN_DIR`)
 * and none of the caller's `DWS_*` variables. `DWS_DISABLE_KEYCHAIN` keeps the store's key in that
 * directory rather than in the system keychain, where `dws` keeps one key for every directory and
 * sweeps it when signing out — so DSH never reads or changes the user's own `~/.dws` sign-in.
 *
 * Signing in uses DingTalk's own app through the device flow, whose address works from a browser
 * on this machine and from a phone scanning its QR code. The Skills ship as files in the release's
 * `dws-skills.zip`, installed beside the executable.
 */
import { readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { renderSVG } from 'uqr'
import { parse as parseYaml } from 'yaml'
import { DWS_CLI } from './catalog.ts'
import { confirmLines, failureMessage, json, quote, run, type Health, type LoginStep, type Run, type TenantCli, type WrapperMode } from './cli.ts'
import type { ConnectorDriver, DriverSkill, SkillLocation } from './driver.ts'
import { SKILLS_DIR } from './install.ts'
import { SKILL_NAME, watchLogin } from './lark.ts'
import type { Assessment } from './risk.ts'

/** Longest wait for `auth status` and `auth logout`. */
const CHECK_TIMEOUT_MS = 30_000

/** Variables `dws` reads that would point a run at another configuration, store, or app. */
const FOREIGN = /^DWS_/u

/** The `dws` variables of one tenant's runs. */
function tenantVariables(cli: TenantCli): Record<string, string> {
  return {
    DWS_CONFIG_DIR: join(cli.dir, 'config'),
    DWS_KEYCHAIN_DIR: join(cli.dir, 'keychain'),
    DWS_DISABLE_KEYCHAIN: '1',
  }
}

/**
 * The environment of a run for one tenant.
 * @param cli - the tenant's `dws`.
 * @returns the process environment without the caller's `DWS_*` variables, plus the tenant's directories.
 */
export function cliEnv(cli: TenantCli): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !FOREIGN.test(name)))
  return { ...env, ...tenantVariables(cli) }
}

/** Run `dws` for a tenant to completion. */
function dws(cli: TenantCli, args: readonly string[], signal: AbortSignal): Promise<Run> {
  return run(cli.bin, args, cliEnv(cli), signal)
}

/** A string field of a parsed object, when it is a non-empty string. */
function text(value: Record<string, unknown> | undefined, name: string): string | undefined {
  const inner = value?.[name]
  return typeof inner === 'string' && inner.trim() !== '' ? inner.trim() : undefined
}

/**
 * Check the tenant's sign-in with `auth status --readonly --format json`, which reads the local
 * sign-in without refreshing it. Signed in, the account is the user and company; not signed in
 * with a reason, such as a credential store that cannot be read, is degraded rather than signed out.
 * @param cli - the tenant's `dws`.
 * @param signal - stops the check.
 * @returns what the check found; anything it cannot read is a degraded connection.
 */
export async function checkHealth(cli: TenantCli, signal: AbortSignal): Promise<Health> {
  let result: Run
  try {
    result = await dws(cli, ['auth', 'status', '--readonly', '--format', 'json'], AbortSignal.any([signal, AbortSignal.timeout(CHECK_TIMEOUT_MS)]))
  } catch (error) {
    signal.throwIfAborted()
    return { kind: 'degraded', problem: String(error) }
  }
  const status = json(result.stdout)
  if (result.code !== 0 || status?.success !== true) return { kind: 'degraded', problem: failureMessage(result) }
  if (status.authenticated === true) {
    const user = text(status, 'user_name')
    const corp = text(status, 'corp_name')
    return { kind: 'connected', account: user !== undefined && corp !== undefined ? `${user}（${corp}）` : user ?? corp ?? null }
  }
  const reason = text(status, 'reason')
  if (reason === undefined) return { kind: 'signed-out' }
  return { kind: 'degraded', problem: text(status, 'message') ?? reason }
}

/** The device-flow address `auth login --device` prints, with the user code included. */
function addressIn(stderr: string): string | undefined {
  return /https:\/\/\S*[?&]user_code=\S+/u.exec(stderr)?.[0]
}

/**
 * Sign the user in with DingTalk's own app: `auth login --device --no-browser --format json`
 * prints a verification address with the user code and waits until the user authorizes it.
 * @param cli - the tenant's `dws`.
 * @param step - the step, always `authorize`.
 * @param onAddress - called once with the address the user opens.
 * @param signal - stops the sign-in, ending the process.
 * @throws LoginError when it fails; the abort reason, as an Error, when aborted.
 */
export function runLoginStep(cli: TenantCli, step: LoginStep, onAddress: (url: string) => void, signal: AbortSignal): Promise<void> {
  return watchLogin(cli.bin, ['auth', 'login', '--device', '--no-browser', '--format', 'json'], cliEnv(cli), step, {
    address: ({ stderr }) => addressIn(stderr),
    succeeded: ({ code }) => code === 0,
  }, onAddress, signal)
}

/**
 * Draw a QR code of an address.
 * @param _cli - unused: DSH draws it.
 * @param url - the address.
 * @returns a `data:` URL of the SVG.
 */
export function qrCode(_cli: TenantCli, url: string): Promise<string | null> {
  return Promise.resolve(`data:image/svg+xml;base64,${Buffer.from(renderSVG(url, { border: 2 })).toString('base64')}`)
}

/**
 * Sign the tenant out — `auth logout` revokes its tokens — then delete its directory, credential store included.
 * @param cli - the tenant's `dws`.
 */
export async function removeTenant(cli: TenantCli): Promise<void> {
  // A tenant that never signed in has nothing to revoke.
  await dws(cli, ['auth', 'logout'], AbortSignal.timeout(CHECK_TIMEOUT_MS)).catch(() => undefined)
  await rm(cli.dir, { recursive: true, force: true })
}

/** The frontmatter and body of a `SKILL.md`. */
function splitSkill(markdown: string): { meta: Record<string, unknown> | undefined; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n?/u.exec(markdown)
  if (match === null) return { meta: undefined, body: markdown }
  let meta: unknown
  try {
    // The pattern's one group always matches.
    meta = parseYaml(match[1] as string)
  } catch {
    // A frontmatter that is not YAML names no Skill.
    meta = undefined
  }
  return { meta: typeof meta === 'object' && meta !== null ? meta as Record<string, unknown> : undefined, body: markdown.slice(match[0].length) }
}

/**
 * List the Skills of an installed release from their `SKILL.md` frontmatter.
 * @param location - the installed version.
 * @returns each Skill whose directory, name, and description agree; none when the release has no Skills.
 */
export async function listSkills(location: SkillLocation): Promise<DriverSkill[]> {
  const root = join(location.versionDir, SKILLS_DIR)
  const names = await readdir(root).catch(() => [])
  const skills: DriverSkill[] = []
  for (const dir of names.sort()) {
    const markdown = await readFile(join(root, dir, 'SKILL.md'), 'utf8').catch(() => undefined)
    if (markdown === undefined) continue
    const { meta } = splitSkill(markdown)
    const name = text(meta, 'name')
    const description = text(meta, 'description')
    if (name === dir && SKILL_NAME.test(name) && description !== undefined) skills.push({ name, description })
  }
  return skills
}

/**
 * Read one Skill's instructions without its frontmatter.
 * @param location - the installed version.
 * @param name - the Skill.
 * @returns the Markdown, or undefined when the release has no such Skill.
 */
export async function readSkill(location: SkillLocation, name: string): Promise<string | undefined> {
  if (!SKILL_NAME.test(name)) return undefined
  const markdown = await readFile(join(location.versionDir, SKILLS_DIR, name, 'SKILL.md'), 'utf8').catch(() => undefined)
  return markdown === undefined ? undefined : splitSkill(markdown).body
}

/**
 * The `dws` script a tenant's model shell calls. `run` runs the installed CLI with the tenant's
 * directories and none of the caller's `DWS_*` variables; after a failed command it points the
 * model to the Connectors page. `not-connected` refuses, pointing the model to the Connectors page.
 * `dws` keeps its logs in the configuration directory and carries on when it cannot write them.
 * @param cli - the tenant's `dws`.
 * @param mode - what the script does.
 * @returns the script.
 */
export function wrapperScript(cli: TenantCli, mode: WrapperMode): string {
  const lines = ['#!/bin/sh', '# Written by DSH for one company\'s DingTalk connector; DSH rewrites it when the connection changes.']
  if (mode === 'not-connected') {
    lines.push(
      'echo "DSH: the DingTalk connector is not connected for this company. Ask the user to connect DingTalk on the DSH Connectors page (连接器), then try again." >&2',
      'exit 1',
    )
    return `${lines.join('\n')}\n`
  }
  lines.push(
    'for name in $(env | sed -n \'s/^\\(DWS_[A-Za-z0-9_]*\\)=.*/\\1/p\'); do unset "$name"; done',
    ...Object.entries(tenantVariables(cli)).map(([name, value]) => `export ${name}=${quote(value)}`),
    ...confirmLines('dws', ['--yes', '-y']),
    `${quote(cli.bin)} "$@"`,
    'status=$?',
    'if [ "$status" -ne 0 ]; then',
    '  echo "DSH: dws exited with status $status. If signing in to DingTalk or a missing permission is the cause, ask the user to check the DingTalk connector on the DSH Connectors page (连接器)." >&2',
    'fi',
    'exit $status',
  )
  return `${lines.join('\n')}\n`
}

/**
 * Read the safety `dws` states in a command's help: `Safety: effect=read|write|destructive
 * risk=low|medium|high confirmation=not_required|user_required`. A read runs unasked; a destructive
 * or high-risk command is a high-risk write; a command whose confirmation the user must give runs
 * only with `--yes`.
 * @param help - the help text.
 * @returns the stated risk, or unknown without one.
 */
export function assess(help: string): Assessment {
  const line = /^Safety:\s*(.*)$/mu.exec(help)?.[1]
  if (line === undefined) return { risk: 'unknown', confirm: false }
  const stated = Object.fromEntries(line.split(/\s+/u).map(pair => pair.split('=') as [string, string | undefined]))
  const confirm = stated.confirmation === 'user_required'
  switch (stated.effect) {
    case 'read':
      return { risk: 'read', confirm: false }
    case 'destructive':
      return { risk: 'high-risk-write', confirm }
    case 'write':
      return { risk: stated.risk === 'high' ? 'high-risk-write' : 'write', confirm }
    default:
      return { risk: 'unknown', confirm: false }
  }
}

/** DingTalk through `dws`. */
export const dingtalk: ConnectorDriver = {
  id: 'dingtalk',
  name: { en: 'DingTalk', zh: '钉钉' },
  spec: DWS_CLI,
  steps: ['authorize'],
  env: cliEnv,
  checkHealth,
  loginSteps: () => ['authorize'],
  runLoginStep,
  qrCode,
  removeTenant,
  wrapperScript,
  listSkills: location => listSkills(location),
  readSkill: (location, name) => readSkill(location, name),
  skillResources: (location, name) => ({ kind: 'directory', path: join(location.versionDir, SKILLS_DIR, name) }),
  assess,
  // Commands that only read and whose help states no safety.
  readOnly: ['auth status', 'version', 'schema', 'profile list', 'shortcut list', 'config list'],
}
