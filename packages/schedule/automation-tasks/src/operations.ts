/**
 * The operations an automation task declares for its unattended runs, as both the form and the Host
 * check them: each is a command's first words, such as `lark-cli im +messages-send`, that may run
 * without asking while the task runs on its schedule. Browser-safe: no Host imports.
 *
 * @module @deepseek-ai/dsh-automation-tasks/operations
 */

/** Most operations one task declares. */
export const OPERATIONS_MAX = 50

/** Longest operation, in characters. */
export const OPERATION_MAX_CHARS = 200

/** A word of an operation: no whitespace and none of the characters a shell gives a meaning. */
const WORD = /^[^\s;&|<>()`$'"\\{}*?[\]!#~=]+$/u

/**
 * Programs that run other commands, such as a shell, `env`, an interpreter, or `find`: declaring one
 * would let any command through.
 */
export const RUNNERS: ReadonlySet<string> = new Set([
  'bash', 'sh', 'zsh', 'dash', 'fish', 'env', 'sudo', 'doas', 'su', 'exec', 'eval', 'source', 'command', 'builtin', 'time', 'nice',
  'nohup', 'timeout', 'xargs', 'find', 'node', 'deno', 'bun', 'npx', 'npm', 'pnpm', 'yarn', 'python', 'python3', 'perl', 'ruby',
  'php', 'osascript', 'open', 'powershell', 'pwsh', 'cmd', 'start', 'invoke-expression', 'iex', 'invoke-command', 'start-process',
])

/**
 * Whether an operation may be declared: a program and at least one more word, the program not one
 * of {@link RUNNERS}.
 * @param operation - a read operation, its words joined by one space.
 * @returns whether it may be declared.
 */
export function declarable(operation: string): boolean {
  const [program, ...rest] = operation.split(' ')
  return rest.length > 0 && !RUNNERS.has((program as string).toLowerCase())
}

/** Why a declared operation is refused, with the entry it is about. */
export type OperationProblem =
  | { readonly code: 'too_many'; readonly max: number }
  | { readonly code: 'too_long'; readonly operation: string; readonly max: number }
  | { readonly code: 'shell_character'; readonly operation: string }
  | { readonly code: 'not_declarable'; readonly operation: string }

/**
 * Read declared operations: each is trimmed and its words joined by one space; blank entries and
 * repeats are dropped, keeping the first.
 * @param operations - the operations as entered.
 * @returns the operations, or the first problem: more than {@link OPERATIONS_MAX}, one longer than
 *   {@link OPERATION_MAX_CHARS}, a word holding a character a shell gives a meaning, or one that may
 *   not be declared (see {@link declarable}).
 */
export function readOperations(operations: readonly string[]): { readonly operations: string[] } | { readonly problem: OperationProblem } {
  const read: string[] = []
  for (const entry of operations) {
    const words = entry.trim().split(/\s+/u).filter(word => word !== '')
    const operation = words.join(' ')
    if (operation === '' || read.includes(operation)) continue
    if (operation.length > OPERATION_MAX_CHARS) return { problem: { code: 'too_long', operation, max: OPERATION_MAX_CHARS } }
    if (!words.every(word => WORD.test(word))) return { problem: { code: 'shell_character', operation } }
    if (!declarable(operation)) return { problem: { code: 'not_declarable', operation } }
    read.push(operation)
  }
  return read.length > OPERATIONS_MAX ? { problem: { code: 'too_many', max: OPERATIONS_MAX } } : { operations: read }
}
