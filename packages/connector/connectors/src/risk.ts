/**
 * The risk of one connector CLI's commands in a bash command. Each invocation of the CLI is found
 * by splitting the command into words and separators, and its risk is the one the CLI states in
 * `<command> --help`, as the connector's driver reads it. Anything this cannot read with
 * certainty — command substitution, `eval`, a nested shell, an argument built from a variable, a
 * command without a stated risk — counts as a write, so it is confirmed rather than run unasked.
 */
import { execFile } from 'node:child_process'

/** Risk of a connector command, from least to most; `unknown` is confirmed like a write. */
export type Risk = 'none' | 'read' | 'write' | 'unknown' | 'high-risk-write'

/** What a command's help states: its risk, and whether the CLI asks to confirm it. */
export interface Assessment {
  readonly risk: Risk
  /** Whether the CLI runs it only with its confirm flag, which DSH adds once the user approves. */
  readonly confirm: boolean
}

/** One invocation of the CLI found in a bash command, with what the CLI states for it. */
export interface Invocation extends Assessment {
  /** The command words after the CLI's name, such as `im +messages-send`. */
  readonly command: string
}

/** What a bash command does through one CLI. */
export interface Classification {
  /** The highest risk among its invocations; `none` when it does not run the CLI. */
  readonly risk: Risk
  readonly invocations: readonly Invocation[]
}

const ORDER: readonly Risk[] = ['none', 'read', 'write', 'unknown', 'high-risk-write']

/** Shell forms whose effect on a lark-cli call cannot be read from the words. */
const OPAQUE = /`|\$\(|<\(|\beval\b|\b(?:ba|z)?sh\s+-c\b|\bxargs\b/u

/** Separators that start a new command. */
const SEPARATORS = new Set([';', '&', '|', '&&', '||', '(', ')', '\n'])

/** Flags that make a call read-only whatever its command: help, version, and a dry run. */
const READ_ONLY_FLAGS = new Set(['--help', '-h', '--version', '--dry-run'])

/** Longest wait for `--help`, which reads the binary's own command table. */
const HELP_TIMEOUT_MS = 10_000

/** A word or a separator; `expanded` marks a word with an unquoted `$`. */
interface Token {
  readonly text: string
  readonly separator: boolean
  readonly expanded: boolean
}

/**
 * Split a bash command into words and separators, honouring quotes and backslashes.
 * @param command - the bash command.
 * @returns the tokens.
 */
export function tokenize(command: string): Token[] {
  const tokens: Token[] = []
  let word = ''
  let inWord = false
  let expanded = false
  const end = (): void => {
    if (inWord) tokens.push({ text: word, separator: false, expanded })
    word = ''
    inWord = false
    expanded = false
  }
  for (let index = 0; index < command.length; index += 1) {
    const char = command.charAt(index)
    if (char === '\\' && index + 1 < command.length) { word += command.charAt(index + 1); inWord = true; index += 1; continue }
    if (char === "'") {
      const close = command.indexOf("'", index + 1)
      const stop = close === -1 ? command.length : close
      word += command.slice(index + 1, stop)
      inWord = true
      index = stop
      continue
    }
    if (char === '"') {
      let at = index + 1
      while (at < command.length && command.charAt(at) !== '"') {
        if (command.charAt(at) === '\\' && at + 1 < command.length) at += 1
        else if (command.charAt(at) === '$') expanded = true
        word += command.charAt(at)
        at += 1
      }
      inWord = true
      index = at
      continue
    }
    if (char === ' ' || char === '\t') { end(); continue }
    const pair = command.slice(index, index + 2)
    if (pair === '&&' || pair === '||') { end(); tokens.push({ text: pair, separator: true, expanded: false }); index += 1; continue }
    if (SEPARATORS.has(char)) { end(); tokens.push({ text: char, separator: true, expanded: false }); continue }
    if (char === '$') expanded = true
    word += char
    inWord = true
  }
  end()
  return tokens
}

/**
 * The invocations of a CLI in a bash command: each word naming the CLI, by name or by path, with
 * the words after it up to the next separator.
 * @param command - the bash command.
 * @param cli - the CLI's name, such as `lark-cli`.
 * @returns each invocation's arguments, or `opaque` when the command hides how the CLI is called.
 */
export function invocations(command: string, cli: string): readonly Token[][] | 'opaque' {
  const named = (word: string): boolean => word === cli || word.endsWith(`/${cli}`)
  // The name as a whole word: `dws` inside `kdws.txt` or `lark-cli` inside `lark-cli-free` is another word.
  const escaped = cli.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  if (!new RegExp(`(?:^|[^\\w.-])${escaped}(?![\\w.-])`, 'u').test(command)) return []
  if (OPAQUE.test(command)) return 'opaque'
  const tokens = tokenize(command)
  const found: Token[][] = []
  let args: Token[] | undefined
  for (const token of tokens) {
    if (token.separator) args = undefined
    else if (args !== undefined) args.push(token)
    else if (named(token.text)) found.push(args = [])
  }
  return found
}

/** Read what the CLI states for a command from its `--help`; a command it states nothing for is unknown. */
export type RiskReader = (words: readonly string[]) => Promise<Assessment>

/**
 * A reader that runs `<bin> <words> --help` and assesses its text, caching each command.
 * @param bin - the CLI executable.
 * @param env - the environment of the help run.
 * @param assess - reads the stated risk from the help text.
 * @returns the reader.
 */
export function helpRiskReader(bin: string, env: NodeJS.ProcessEnv, assess: (help: string) => Assessment): RiskReader {
  const cache = new Map<string, Promise<Assessment>>()
  return (words) => {
    const key = words.join('\u0000')
    let risk = cache.get(key)
    if (risk === undefined) {
      risk = new Promise((resolve) => {
        // The help run reads no stdin: a CLI that waits on it must not consume the caller's.
        const child = execFile(bin, [...words, '--help'], { env, encoding: 'utf8', timeout: HELP_TIMEOUT_MS, windowsHide: true }, (_error, stdout) => {
          resolve(assess(stdout))
        })
        child.stdin?.end()
      })
      cache.set(key, risk)
    }
    return risk
  }
}

/**
 * Classify one CLI's calls in a bash command.
 * @param command - the bash command.
 * @param cli - the CLI's name, such as `lark-cli`.
 * @param read - reads what the CLI states for a command.
 * @param readOnly - command words that only read, with whatever words follow, although the CLI states no risk for them.
 * @returns the highest risk and each invocation.
 */
export async function classify(command: string, cli: string, read: RiskReader, readOnly: readonly string[] = []): Promise<Classification> {
  const found = invocations(command, cli)
  if (found === 'opaque') return { risk: 'unknown', invocations: [{ command: command.trim(), risk: 'unknown', confirm: false }] }
  const classified: Invocation[] = []
  for (const args of found) {
    // The command path is the words before the first flag; flag values never name a command.
    const first = args.findIndex(token => token.text.startsWith('-'))
    const words = (first === -1 ? args : args.slice(0, first)).map(token => token.text)
    const name = words.join(' ')
    const listed = readOnly.some(words => name === words || name.startsWith(`${words} `))
    if (args.length === 0 || args.some(token => READ_ONLY_FLAGS.has(token.text)) || listed) {
      classified.push({ command: name, risk: 'read', confirm: false })
    } else if (args.some(token => token.expanded)) {
      classified.push({ command: name, risk: 'unknown', confirm: false })
    } else {
      classified.push({ command: name, ...await read(words) })
    }
  }
  const risk = classified.reduce<Risk>((highest, item) => ORDER.indexOf(item.risk) > ORDER.indexOf(highest) ? item.risk : highest, 'none')
  return { risk, invocations: classified }
}
