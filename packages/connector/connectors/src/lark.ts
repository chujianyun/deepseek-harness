/**
 * Running an installed lark-cli for one tenant. Every run gets that tenant's own configuration,
 * data, and log directories and none of the caller's `LARKSUITE_CLI_*` variables, so DSH never
 * reads or changes the user's own `~/.lark-cli`. Each tenant creates its own app, so the tokens
 * and app secret lark-cli keeps in the system keychain, keyed by app, never mix either.
 */
import { execFile, spawn } from 'node:child_process'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** One tenant's lark-cli: the executable and the tenant's directory under the connector. */
export interface TenantCli {
  readonly bin: string
  readonly dir: string
}

/** What a health check found. */
export type Health =
  | { readonly kind: 'unconfigured' }
  | { readonly kind: 'signed-out' }
  | { readonly kind: 'connected'; readonly account: string | null }
  | { readonly kind: 'degraded'; readonly problem: string }

/** The step a sign-in is on: creating the tenant's app, then authorizing the user. */
export type LoginStep = 'create-app' | 'authorize'

/** Why a sign-in step stopped. */
export class LoginError extends Error {
  /**
   * @param step - the step that failed.
   * @param message - what lark-cli reported, for the user.
   */
  constructor(readonly step: LoginStep, message: string) { super(message) }
}

/** Longest wait for `auth status`, which reaches the server to verify the token. */
const CHECK_TIMEOUT_MS = 30_000

/** Longest failure message kept for the user. */
const FAILURE_MAX_CHARS = 300

/** Longest wait for a QR code to be drawn. */
const QR_TIMEOUT_MS = 10_000

/** Variables lark-cli reads that would point an Agent run elsewhere (`config init` refuses inside one). */
const FOREIGN = /^(?:LARKSUITE_CLI_|OPENCLAW_HOME$|HERMES_HOME$)/u

/**
 * The environment of a run for one tenant.
 * @param cli - the tenant's lark-cli.
 * @returns the process environment without the caller's lark-cli variables, plus the tenant's directories.
 */
export function cliEnv(cli: TenantCli): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !FOREIGN.test(name)))
  return { ...env, ...tenantVariables(cli, join(cli.dir, 'logs')) }
}

/** The lark-cli variables of one tenant's runs. */
function tenantVariables(cli: TenantCli, logs: string): Record<string, string> {
  return {
    LARKSUITE_CLI_CONFIG_DIR: join(cli.dir, 'config'),
    LARKSUITE_CLI_DATA_DIR: join(cli.dir, 'data'),
    LARKSUITE_CLI_LOG_DIR: logs,
    LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
    LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
  }
}

interface Run {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

/** Run to completion; a nonzero exit is a result, a process that cannot start rejects. */
function run(cli: TenantCli, args: readonly string[], signal: AbortSignal, cwd?: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    execFile(cli.bin, [...args], { env: cliEnv(cli), encoding: 'utf8', signal, windowsHide: true, ...cwd === undefined ? {} : { cwd } },
      (error, stdout, stderr) => {
        if (error === null) { resolve({ code: 0, stdout, stderr }); return }
        if (typeof error.code === 'number') { resolve({ code: error.code, stdout, stderr }); return }
        reject(new Error(error.message, { cause: error }))
      })
  })
}

/** Parse the JSON object a command printed, if it printed one. */
function json(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text.trim())
    return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
  } catch {
    // Not JSON: an old CLI, a crash message, or nothing at all.
    return undefined
  }
}

/** A field of a parsed JSON object, when it is an object. */
function field(value: Record<string, unknown> | undefined, name: string): Record<string, unknown> | undefined {
  const inner = value?.[name]
  return typeof inner === 'object' && inner !== null ? inner as Record<string, unknown> : undefined
}

/**
 * The readable part of what a failed command printed: a JSON error (`{ error: { message } }`, or `{ error: "…" }`
 * as `auth login --json` reports a failed authorization), else its last text lines without the QR art.
 * @param result - the finished command.
 * @returns a message for the user.
 */
export function failureMessage(result: Run): string {
  const lines = `${result.stderr}\n${result.stdout}`.split('\n').map(line => line.trim()).filter(line => line !== '')
  // A whole stream is one pretty-printed JSON error; `auth login --json` prints one event per line.
  for (const text of [result.stdout, result.stderr, ...[...lines].reverse()]) {
    const error = json(text)?.error
    if (typeof error === 'string') return error
    if (typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string') {
      return (error as { message: string }).message
    }
  }
  const text = lines.filter(line => !/[█▀▄]/u.test(line) && json(line) === undefined).slice(-2).join(' ')
  if (text === '') return `exit code ${String(result.code)}`
  return text.length > FAILURE_MAX_CHARS ? `${text.slice(0, FAILURE_MAX_CHARS)}…` : text
}

/**
 * Check the tenant's sign-in with `auth status --json --verify`, which asks the server whether the token still works.
 * @param cli - the tenant's lark-cli.
 * @param signal - stops the check.
 * @returns what the check found; anything it cannot read is a degraded connection.
 */
export async function checkHealth(cli: TenantCli, signal: AbortSignal): Promise<Health> {
  let result: Run
  try {
    result = await run(cli, ['auth', 'status', '--json', '--verify'], AbortSignal.any([signal, AbortSignal.timeout(CHECK_TIMEOUT_MS)]))
  } catch (error) {
    signal.throwIfAborted()
    return { kind: 'degraded', problem: String(error) }
  }
  // lark-cli reports an error as JSON on stderr.
  const status = json(result.stdout) ?? json(result.stderr)
  const error = field(status, 'error')
  if (status?.ok === false && error?.type === 'config' && error.subtype === 'not_configured') return { kind: 'unconfigured' }
  const user = field(field(status, 'identities'), 'user')
  switch (user?.status) {
    case 'ready':
    case 'needs_refresh':
      return { kind: 'connected', account: typeof user.userName === 'string' ? user.userName : null }
    case 'missing':
    case 'not_configured':
      return { kind: 'signed-out' }
    default:
      return { kind: 'degraded', problem: typeof user?.message === 'string' ? user.message : failureMessage(result) }
  }
}

/**
 * Draw a QR code of an address with `auth qrcode`.
 * @param cli - the tenant's lark-cli.
 * @param url - the address.
 * @param signal - stops it.
 * @returns a `data:` URL of the PNG, or null when it could not be drawn.
 */
export async function qrCode(cli: TenantCli, url: string, signal: AbortSignal): Promise<string | null> {
  // lark-cli writes images only inside its working directory.
  const dir = join(cli.dir, 'qr')
  try {
    await mkdir(dir, { recursive: true })
    const result = await run(cli, ['auth', 'qrcode', url, '-o', 'login.png', '--size', '240'], AbortSignal.any([signal, AbortSignal.timeout(QR_TIMEOUT_MS)]), dir)
    if (result.code !== 0) return null
    return `data:image/png;base64,${(await readFile(join(dir, 'login.png'))).toString('base64')}`
  } catch {
    // The address and link still work without a picture.
    return null
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** The verification address a sign-in step printed, if this output contains it. */
function addressIn(step: LoginStep, output: string): string | undefined {
  if (step === 'create-app') return /https:\/\/\S+/u.exec(output)?.[0]
  for (const line of output.split('\n')) {
    const event = json(line)
    if (event?.event === 'device_authorization' && typeof event.verification_uri_complete === 'string') return event.verification_uri_complete
  }
  return undefined
}

/**
 * Whether `auth login --json` completed the authorization. It exits nonzero when the tenant's
 * administrator withheld some of the requested permissions, yet the user is signed in with the
 * rest; the missing ones are logged.
 */
function authorized(stdout: string): boolean {
  for (const line of stdout.split('\n')) {
    const event = json(line)
    if (event?.event !== 'authorization_complete' || typeof event.user_open_id !== 'string') continue
    // Only a sign-in that missed some permissions exits nonzero with this event.
    console.info('[connectors] signed in without some permissions', { missing: event.missing })
    return true
  }
  return false
}

/**
 * Run one sign-in step to completion. `create-app` is `config init --new`, which creates the tenant's
 * app in the browser; `authorize` is `auth login --recommend --json`, which authorizes the user.
 * Both block until the user finishes in the browser or the authorization expires. An authorization
 * that completed without some permissions the administrator withholds still succeeds.
 * @param cli - the tenant's lark-cli.
 * @param step - which step.
 * @param onAddress - called once with the address the user opens.
 * @param signal - stops the step, ending the process.
 * @throws LoginError when the step fails; the abort reason, as an Error, when aborted.
 */
export function runLoginStep(cli: TenantCli, step: LoginStep, onAddress: (url: string) => void, signal: AbortSignal): Promise<void> {
  const args = step === 'create-app' ? ['config', 'init', '--new', '--brand', 'feishu'] : ['auth', 'login', '--recommend', '--json']
  return new Promise((resolve, reject) => {
    const child = spawn(cli.bin, args, { env: cliEnv(cli), signal, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let announced = false
    const scan = (): void => {
      if (announced) return
      const url = addressIn(step, step === 'create-app' ? stderr : stdout)
      if (url !== undefined) { announced = true; onAddress(url) }
    }
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; scan() })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; scan() })
    // An abort rejects with its reason, as an Error.
    const stopped = (): Error => signal.reason instanceof Error
      ? signal.reason
      : new Error('sign-in step stopped', { cause: signal.reason })
    child.once('error', (error) => {
      if (signal.aborted) { reject(stopped()); return }
      reject(new LoginError(step, error.message))
    })
    child.once('close', (code) => {
      if (signal.aborted) { reject(stopped()); return }
      if (code === 0 || (step === 'authorize' && authorized(stdout))) { resolve(); return }
      reject(new LoginError(step, failureMessage({ code, stdout, stderr })))
    })
  })
}

/**
 * Delete the tenant's sign-in: `config remove` clears its app and tokens, keychain entries included, then its directory goes.
 * @param cli - the tenant's lark-cli.
 */
export async function removeTenant(cli: TenantCli): Promise<void> {
  // A tenant that never finished creating its app has nothing for config remove to clear.
  await run(cli, ['config', 'remove'], AbortSignal.timeout(CHECK_TIMEOUT_MS)).catch(() => undefined)
  await rm(cli.dir, { recursive: true, force: true })
}

/** Longest wait for `skills list` or `skills read`, which read the binary's embedded files. */
const SKILL_TIMEOUT_MS = 15_000

/** Kebab-case Skill name, as the skill registry requires. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

/**
 * List the Skills the CLI embeds with `skills list`.
 * @param cli - the tenant's lark-cli.
 * @param signal - stops it.
 * @returns each Skill's name and description; none when the CLI cannot list them.
 */
export async function listSkills(cli: TenantCli, signal: AbortSignal): Promise<{ name: string; description: string }[]> {
  try {
    const result = await run(cli, ['skills', 'list'], AbortSignal.any([signal, AbortSignal.timeout(SKILL_TIMEOUT_MS)]))
    const skills = json(result.stdout)?.skills
    if (!Array.isArray(skills)) return []
    return skills.flatMap((skill: unknown) => {
      const { name, description } = skill as { name?: unknown; description?: unknown }
      return typeof name === 'string' && SKILL_NAME.test(name) && typeof description === 'string' && description.trim() !== ''
        ? [{ name, description: description.trim() }] : []
    })
  } catch {
    // A CLI that cannot run lists nothing; the next lookup asks again.
    return []
  }
}

/**
 * Read one Skill's instructions with `skills read`, without its frontmatter.
 * @param cli - the tenant's lark-cli.
 * @param name - the Skill.
 * @param signal - stops it.
 * @returns the Markdown, or undefined when the CLI cannot read it.
 */
export async function readSkill(cli: TenantCli, name: string, signal: AbortSignal): Promise<string | undefined> {
  try {
    const result = await run(cli, ['skills', 'read', name], AbortSignal.any([signal, AbortSignal.timeout(SKILL_TIMEOUT_MS)]))
    if (result.code !== 0 || result.stdout.trim() === '') return undefined
    // The CLI prints a tip line, then the SKILL.md frontmatter, then the body.
    return result.stdout.replace(/^((?:>[^\n]*\n)?)---\n[\s\S]*?\n---\n/u, '$1')
  } catch {
    // As above.
    return undefined
  }
}

/** What the `lark-cli` on the model shell's PATH does for one tenant. */
export type WrapperMode = 'run' | 'not-connected'

/** Quote a value for a POSIX shell. */
function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/**
 * The `lark-cli` script a tenant's model shell calls. `run` runs the installed CLI with the tenant's
 * configuration and data directories and none of the caller's lark-cli variables, writing its logs
 * under the system temporary directory, which a sandboxed model shell may write; after a failed
 * command it points the model to the Connectors page. `not-connected` refuses, pointing the model
 * to the Connectors page.
 * @param cli - the tenant's lark-cli.
 * @param mode - what the script does.
 * @param logs - the log directory of runs through the script.
 * @returns the script.
 */
export function wrapperScript(cli: TenantCli, mode: WrapperMode, logs: string): string {
  const lines = ['#!/bin/sh', '# Written by DSH for one company\'s Feishu connector; DSH rewrites it when the connection changes.']
  if (mode === 'not-connected') {
    lines.push(
      'echo "DSH: the Feishu connector is not connected for this company. Ask the user to connect Feishu on the DSH Connectors page (连接器), then try again." >&2',
      'exit 1',
    )
    return `${lines.join('\n')}\n`
  }
  lines.push(
    'for name in $(env | sed -n \'s/^\\(LARKSUITE_CLI_[A-Za-z0-9_]*\\)=.*/\\1/p\'); do unset "$name"; done',
    'unset OPENCLAW_HOME HERMES_HOME',
    ...Object.entries(tenantVariables(cli, logs)).map(([name, value]) => `export ${name}=${quote(value)}`),
    `${quote(cli.bin)} "$@"`,
    'status=$?',
    'if [ "$status" -ne 0 ]; then',
    '  echo "DSH: lark-cli exited with status $status. If signing in to Feishu or a missing permission is the cause, ask the user to check the Feishu connector on the DSH Connectors page (连接器)." >&2',
    'fi',
    'exit $status',
  )
  return `${lines.join('\n')}\n`
}

/**
 * Write the tenant's `lark-cli` script into `dir`, replacing it in one rename.
 * @param dir - the directory put on the model shell's PATH.
 * @param script - the script.
 */
export async function writeWrapper(dir: string, script: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  const staging = join(dir, '.lark-cli.writing')
  await writeFile(staging, script)
  await chmod(staging, 0o755)
  await rename(staging, join(dir, 'lark-cli'))
}
