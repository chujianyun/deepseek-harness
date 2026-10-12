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

/**
 * PowerShell forms that run a command the words do not show: expressions and script blocks it evaluates,
 * another shell, or a started process. A backtick, its escape, is opaque already.
 */
const PWSH_OPAQUE = new RegExp([
  String.raw`\b(?:Invoke-Expression|Invoke-Command|Start-Process|Start-Job|ForEach-Object)\b`,
  String.raw`(?:^|[;|&(]\s*)(?:iex|icm|saps|start|foreach|%)(?=\s|$)`,
  String.raw`(?<![\w.-])(?:cmd|pwsh|powershell)(?:\.exe)?\s`,
  String.raw`\.Invoke\(|[{}]|@\(`,
].join('|'), 'iu')

/** The shell a model command is written for: the bash tool's, or PowerShell's on Windows. */
export type ShellDialect = 'bash' | 'pwsh'

/** Separators that start a new command. */
const SEPARATORS = new Set([';', '&', '|', '&&', '||', '(', ')', '\n'])

/** Flags that make a call read-only whatever its command: help, version, and a dry run. */
const READ_ONLY_FLAGS = new Set(['--help', '-h', '--version', '--dry-run'])

/** Longest wait for `--help`, which reads the binary's own command table. */
const HELP_TIMEOUT_MS = 10_000

/** Words that run the command after them, so the command position moves on past them. */
const PREFIXES = new Set(['sudo', 'env', 'time', 'nohup', 'nice', 'command', 'exec'])

/**
 * A word, a separator, or a redirection; `expanded` marks a word with an unquoted `$`, and
 * `redirect` marks a redirection operator and the file it names, neither of which is an argument.
 */
interface Token {
  readonly text: string
  readonly separator: boolean
  readonly expanded: boolean
  readonly redirect: boolean
}

/**
 * Split a shell command into words, separators, and redirections, honouring quotes, and backslashes in
 * bash; in PowerShell a backslash is a path separator, not an escape.
 * @param command - the command.
 * @param dialect - the shell it is written for.
 * @returns the tokens.
 */
export function tokenize(command: string, dialect: ShellDialect = 'bash'): Token[] {
  const tokens: Token[] = []
  let word = ''
  let inWord = false
  let expanded = false
  // The next word names a redirection's file.
  let target = false
  const end = (): void => {
    if (inWord) {
      tokens.push({ text: word, separator: false, expanded, redirect: target })
      target = false
    }
    word = ''
    inWord = false
    expanded = false
  }
  const push = (text: string, separator: boolean, redirect = false): void => {
    tokens.push({ text, separator, expanded: false, redirect })
  }
  for (let index = 0; index < command.length; index += 1) {
    const char = command.charAt(index)
    if (char === '\\' && dialect === 'bash' && index + 1 < command.length) { word += command.charAt(index + 1); inWord = true; index += 1; continue }
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
    // A redirection: `>`, `>>`, `<`, `2>`, `&>`, `>&2`, `2>&1`; a file descriptor before it is no word.
    if (char === '>' || char === '<' || pair === '&>') {
      if (/^\d+$/u.test(word)) { word = ''; inWord = false } else end()
      let op = pair === '&>' ? '&>' : char
      index += op.length - 1
      const next = command.charAt(index + 1)
      if (next === op.charAt(op.length - 1) || next === '&') { op += next; index += 1 }
      const fd = op.endsWith('&') ? /^(?:\d+|-)/u.exec(command.slice(index + 1))?.[0] : undefined
      if (fd !== undefined) { op += fd; index += fd.length } else target = true
      push(op, false, true)
      continue
    }
    if (pair === '&&' || pair === '||') { end(); push(pair, true); index += 1; continue }
    if (SEPARATORS.has(char)) { end(); push(char, true); continue }
    if (char === '$') expanded = true
    word += char
    inWord = true
  }
  end()
  return tokens
}

/**
 * The invocations of a CLI in a shell command: each word in command position naming the CLI, by
 * name or by path, with the words after it up to the next separator. Command position is the first
 * word of a command, after any variable assignments and prefixes such as `sudo` or `env`; the CLI's
 * name elsewhere, as in `which dws`, is an argument. Redirections are not arguments. In PowerShell the
 * name matches in any case and with a `.cmd`, `.bat`, or `.exe` extension, after `/` or `\\`.
 * @param command - the command.
 * @param cli - the CLI's name, such as `lark-cli`.
 * @param dialect - the shell the command is written for.
 * @returns each invocation's arguments, or `opaque` when the command hides how the CLI is called.
 */
export function invocations(command: string, cli: string, dialect: ShellDialect = 'bash'): readonly Token[][] | 'opaque' {
  const escaped = cli.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const pwsh = dialect === 'pwsh'
  const named = pwsh
    ? (word: string): boolean => new RegExp(`(?:^|[\\\\/])${escaped}(?:\\.(?:cmd|bat|exe))?$`, 'iu').test(word)
    : (word: string): boolean => word === cli || word.endsWith(`/${cli}`)
  // The name as a whole word: `dws` inside `kdws.txt` or `lark-cli` inside `lark-cli-free` is another word.
  const whole = pwsh ? `(?:^|[^\\w.-])${escaped}(?:\\.(?:cmd|bat|exe))?(?![\\w.-])` : `(?:^|[^\\w.-])${escaped}(?![\\w.-])`
  if (!new RegExp(whole, pwsh ? 'iu' : 'u').test(command)) return []
  if (OPAQUE.test(command) || (pwsh && PWSH_OPAQUE.test(command))) return 'opaque'
  const tokens = tokenize(command, dialect)
  const found: Token[][] = []
  let args: Token[] | undefined
  let start = true
  for (const token of tokens) {
    if (token.separator) { args = undefined; start = true } else if (token.redirect) continue
    else if (args !== undefined) args.push(token)
    else if (start && named(token.text)) found.push(args = [])
    else if (start) start = PREFIXES.has(token.text) || /^[A-Za-z_]\w*=/u.test(token.text)
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
 * Classify one CLI's calls in a shell command.
 * @param command - the shell command.
 * @param cli - the CLI's name, such as `lark-cli`.
 * @param read - reads what the CLI states for a command.
 * @param readOnly - command words that only read, with whatever words follow, although the CLI states no risk for them.
 * @param dialect - the shell the command is written for.
 * @returns the highest risk and each invocation.
 */
export async function classify(
  command: string, cli: string, read: RiskReader, readOnly: readonly string[] = [], dialect: ShellDialect = 'bash',
): Promise<Classification> {
  const found = invocations(command, cli, dialect)
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
