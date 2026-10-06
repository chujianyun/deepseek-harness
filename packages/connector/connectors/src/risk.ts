/**
 * The risk of the lark-cli commands in one bash command. Each `lark-cli` invocation is found
 * by splitting the command into words and separators, and its risk is the one the CLI states in
 * `<command> --help` (`Risk: read | write | high-risk-write`). Anything this cannot read with
 * certainty — command substitution, `eval`, a nested shell, an argument built from a variable, a
 * command without a stated risk — counts as a write, so it is confirmed rather than run unasked.
 */
import { execFile } from 'node:child_process'

/** Risk of a lark-cli command, from least to most; `unknown` is confirmed like a write. */
export type Risk = 'none' | 'read' | 'write' | 'unknown' | 'high-risk-write'

/** One lark-cli invocation found in a bash command, with the risk the CLI states for it. */
export interface Invocation {
  /** The command words after `lark-cli`, such as `im +messages-send`. */
  readonly command: string
  readonly risk: Risk
}

/** What a bash command does through lark-cli. */
export interface Classification {
  /** The highest risk among its invocations; `none` when it runs no lark-cli. */
  readonly risk: Risk
  readonly invocations: readonly Invocation[]
}

const ORDER: readonly Risk[] = ['none', 'read', 'write', 'unknown', 'high-risk-write']

/** Shell forms whose effect on a lark-cli call cannot be read from the words. */
const OPAQUE = /`|\$\(|<\(|\beval\b|\b(?:ba|z)?sh\s+-c\b|\bxargs\b/u

/** Separators that start a new command. */
const SEPARATORS = new Set([';', '&', '|', '&&', '||', '(', ')', '\n'])

/** Flags that make a lark-cli call read-only whatever its command: help, version, and a dry run. */
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

/** Whether a word names the lark-cli executable, by name or by path. */
function isLarkCli(word: string): boolean {
  return word === 'lark-cli' || word.endsWith('/lark-cli')
}

/**
 * The lark-cli invocations of a bash command: each word naming lark-cli, with the words after it up to the next separator.
 * @param command - the bash command.
 * @returns each invocation's arguments, or `opaque` when the command hides how lark-cli is called.
 */
export function invocations(command: string): readonly Token[][] | 'opaque' {
  if (!/lark-cli/u.test(command)) return []
  if (OPAQUE.test(command)) return 'opaque'
  const tokens = tokenize(command)
  const found: Token[][] = []
  let args: Token[] | undefined
  for (const token of tokens) {
    if (token.separator) args = undefined
    else if (args !== undefined) args.push(token)
    else if (isLarkCli(token.text)) found.push(args = [])
  }
  return found
}

/** Read the risk the CLI states for a command from its `--help`; a command without one is unknown. */
export type RiskReader = (words: readonly string[]) => Promise<Risk>

/**
 * A reader that runs `lark-cli <words> --help` and parses its `Risk:` line, caching each command.
 * @param bin - the lark-cli executable.
 * @param env - the environment of the help run.
 * @returns the reader.
 */
export function helpRiskReader(bin: string, env: NodeJS.ProcessEnv): RiskReader {
  const cache = new Map<string, Promise<Risk>>()
  return (words) => {
    const key = words.join('\u0000')
    let risk = cache.get(key)
    if (risk === undefined) {
      risk = new Promise((resolve) => {
        execFile(bin, [...words, '--help'], { env, encoding: 'utf8', timeout: HELP_TIMEOUT_MS, windowsHide: true }, (_error, stdout) => {
          const stated = /^Risk:\s*(read|write|high-risk-write)\b/mu.exec(stdout)?.[1]
          resolve((stated ?? 'unknown') as Risk)
        })
      })
      cache.set(key, risk)
    }
    return risk
  }
}

/**
 * Classify the lark-cli calls of a bash command.
 * @param command - the bash command.
 * @param read - reads the stated risk of a command.
 * @returns the highest risk and each invocation.
 */
export async function classify(command: string, read: RiskReader): Promise<Classification> {
  const found = invocations(command)
  if (found === 'opaque') return { risk: 'unknown', invocations: [{ command: command.trim(), risk: 'unknown' }] }
  const classified: Invocation[] = []
  for (const args of found) {
    // The command path is the words before the first flag; flag values never name a command.
    const first = args.findIndex(token => token.text.startsWith('-'))
    const words = (first === -1 ? args : args.slice(0, first)).map(token => token.text)
    const name = words.join(' ')
    if (args.length === 0 || args.some(token => READ_ONLY_FLAGS.has(token.text))) {
      classified.push({ command: name, risk: 'read' })
    } else if (args.some(token => token.expanded)) {
      classified.push({ command: name, risk: 'unknown' })
    } else {
      classified.push({ command: name, risk: await read(words) })
    }
  }
  const risk = classified.reduce<Risk>((highest, item) => ORDER.indexOf(item.risk) > ORDER.indexOf(highest) ? item.risk : highest, 'none')
  return { risk, invocations: classified }
}
