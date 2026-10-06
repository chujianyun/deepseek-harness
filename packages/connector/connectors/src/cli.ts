/**
 * What every connector CLI run shares: one tenant's executable and directory, running a command
 * to completion, reading the JSON it prints, and writing the model shell's script for it.
 */
import { execFile } from 'node:child_process'
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** One tenant's CLI: the executable and the tenant's directory under the connector. */
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

/** A sign-in step: creating the tenant's app on the platform, then authorizing the user. */
export type LoginStep = 'create-app' | 'authorize'

/** Why a sign-in step stopped. */
export class LoginError extends Error {
  /**
   * @param step - the step that failed.
   * @param message - what the CLI reported, for the user.
   */
  constructor(readonly step: LoginStep, message: string) { super(message) }
}

/** What the CLI on the model shell's PATH does for one tenant. */
export type WrapperMode = 'run' | 'not-connected'

/** A finished command. */
export interface Run {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

/** Longest failure message kept for the user. */
const FAILURE_MAX_CHARS = 300

/**
 * Run to completion; a nonzero exit is a result, a process that cannot start rejects.
 * @param bin - the executable.
 * @param args - its arguments.
 * @param env - its environment.
 * @param signal - stops it.
 * @param cwd - its working directory.
 * @returns the exit code and output.
 */
export function run(bin: string, args: readonly string[], env: NodeJS.ProcessEnv, signal: AbortSignal, cwd?: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    execFile(bin, [...args], { env, encoding: 'utf8', signal, windowsHide: true, ...cwd === undefined ? {} : { cwd } },
      (error, stdout, stderr) => {
        if (error === null) { resolve({ code: 0, stdout, stderr }); return }
        if (typeof error.code === 'number') { resolve({ code: error.code, stdout, stderr }); return }
        reject(new Error(error.message, { cause: error }))
      })
  })
}

/**
 * Parse the JSON object a command printed, if it printed one.
 * @param text - the output.
 * @returns the object, or undefined for anything else.
 */
export function json(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text.trim())
    return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
  } catch {
    // Not JSON: an old CLI, a crash message, or nothing at all.
    return undefined
  }
}

/**
 * A field of a parsed JSON object, when it is an object.
 * @param value - the parsed object.
 * @param name - the field.
 * @returns the field's object, or undefined.
 */
export function field(value: Record<string, unknown> | undefined, name: string): Record<string, unknown> | undefined {
  const inner = value?.[name]
  return typeof inner === 'object' && inner !== null ? inner as Record<string, unknown> : undefined
}

/**
 * The readable part of what a failed command printed: a JSON error (`{ error: { message } }`, or `{ error: "…" }`
 * as `lark-cli auth login --json` reports a failed authorization), else its last text lines without QR art.
 * @param result - the finished command.
 * @returns a message for the user.
 */
export function failureMessage(result: Run): string {
  const lines = `${result.stderr}\n${result.stdout}`.split('\n').map(line => line.trim()).filter(line => line !== '')
  // A whole stream is one pretty-printed JSON error, or ends with one after text (`dws`); `auth login --json` prints one event per line.
  const trailing = [result.stdout, result.stderr].map(text => text.slice(Math.max(0, text.lastIndexOf('\n{') + 1)))
  for (const text of [result.stdout, result.stderr, ...trailing, ...[...lines].reverse()]) {
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
 * Quote a value for a POSIX shell.
 * @param value - the value.
 * @returns the quoted word.
 */
export function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/**
 * The script lines that add `--yes` to a command the user approved for this shell call:
 * `DSH_CONNECTOR_CONFIRMED` names them one per line, each as `<cli> <command words>`.
 * @param cli - the CLI's name, such as `lark-cli`.
 * @param yes - the flags that already confirm, the first of which is added.
 * @returns the lines.
 */
export function confirmLines(cli: string, yes: readonly [string, ...string[]]): string[] {
  const given = yes.map(flag => `*" ${flag} "*`).join('|')
  return [
    '# A command the user approved for this call runs confirmed.',
    `case " $* " in ${given}) ;; *)`,
    '  while IFS= read -r confirmed; do',
    `    if [ -n "$confirmed" ]; then case "${cli} $* " in "$confirmed "*) set -- "$@" ${yes[0]}; break ;; esac; fi`,
    '  done <<DSH_CONFIRMED',
    '$DSH_CONNECTOR_CONFIRMED',
    'DSH_CONFIRMED',
    ';; esac',
  ]
}

/**
 * Write a tenant's script into `dir`, replacing it in one rename.
 * @param dir - the directory put on the model shell's PATH.
 * @param name - the script's file name, the CLI's name.
 * @param script - the script.
 */
export async function writeWrapper(dir: string, name: string, script: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  const staging = join(dir, `.${name}.writing`)
  await writeFile(staging, script)
  await chmod(staging, 0o755)
  await rename(staging, join(dir, name))
}
