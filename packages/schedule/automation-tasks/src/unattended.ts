/**
 * Unattended runs of an automation task: a turn its schedule started runs with nobody to answer an
 * approval, so a call that would ask runs when it is one of the task's declared operations and is
 * refused otherwise, and each answer is recorded in the Session log.
 */
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import { declarable } from './operations.ts'

/** The shell a model command is written for: the bash tool's, or PowerShell on Windows. */
export type ShellDialect = 'bash' | 'pwsh'

/**
 * The message source of the instruction a schedule sends. The schedule declares it in its runtime
 * module, which its public types leave out, so it is compared as a string.
 */
const SCHEDULE_SOURCE: string = 'schedule'

/** The message source of what a person writes. */
const PERSON_SOURCE: string = 'user'

/** The `automationUnattended` Session projection's state. */
export interface UnattendedState {
  /** The operations the task declares; empty when it declares none. */
  readonly operations: string[]
  /** The open turn; null between turns. */
  readonly openTurn: number | null
  /** Whether a person has written in the open turn. */
  readonly personWrote: boolean
  /** The open turn when a schedule message came in it before anything a person wrote; null otherwise. */
  readonly scheduledTurn: number | null
}

/**
 * The `automationUnattended` Session projection: the task's declared operations, and whether the
 * open turn is a scheduled run — a turn where a schedule message came before anything a person wrote,
 * until a person writes in it or it ends. A turn a person wrote in asks as usual, also when a
 * schedule message joins it; messages DSH adds itself, such as context, change nothing.
 */
export const unattendedProjection = {
  key: 'automationUnattended',
  stateSchema: z.object({
    operations: z.array(z.string()), openTurn: z.number().nullable(), personWrote: z.boolean(), scheduledTurn: z.number().nullable(),
  }),
  init: () => ({ operations: [], openTurn: null, personWrote: false, scheduledTurn: null }),
  apply: (state, event) => {
    switch (event.type) {
      case 'automation-tasks/operations': return { ...state, operations: [...event.data.operations] }
      case 'turn/start': return { ...state, openTurn: event.data.turn, personWrote: false, scheduledTurn: null }
      case 'user/message': {
        const kind: string = event.data.source.kind
        if (kind === PERSON_SOURCE) {
          return state.personWrote && state.scheduledTurn === null ? state : { ...state, personWrote: true, scheduledTurn: null }
        }
        return kind === SCHEDULE_SOURCE && !state.personWrote && state.scheduledTurn === null && state.openTurn !== null
          ? { ...state, scheduledTurn: state.openTurn }
          : state
      }
      case 'turn/end': return { ...state, openTurn: null, personWrote: false, scheduledTurn: null }
      default: return state
    }
  },
  stateVersion: 1,
} satisfies ProjectionDefinition<'automationUnattended', UnattendedState>

/** One command word: its text, and whether part of it comes from a variable, whose value the words do not show. */
export interface Word {
  readonly text: string
  readonly expanded: boolean
}

/** One simple command: its words, and whether it redirects output. */
export interface SimpleCommand {
  readonly words: readonly Word[]
  readonly redirected: boolean
}

/**
 * Split a shell command into simple commands, reading only what is certain: single quotes, double
 * quotes, a backslash escape (in bash), whitespace, and the separators `;`, `|`, `&&`, `||`, with
 * output redirections `>` and `>>`. Anything else that changes what runs or what the words mean
 * makes the command unreadable: a comment, `$'…'` or `$"…"` quoting, command or process
 * substitution, a backtick, input redirection or a here-document, a lone `&`, parentheses or
 * braces, `!`, a line break, or an unclosed quote.
 * @param command - the command.
 * @param dialect - the shell it is written for; PowerShell has no backslash escape.
 * @returns the simple commands, or undefined when the command is unreadable.
 */
export function readCommand(command: string, dialect: ShellDialect): SimpleCommand[] | undefined {
  const commands: SimpleCommand[] = []
  let words: Word[] = []
  let redirected = false
  let text = ''
  let started = false
  let expanded = false
  const endWord = (): void => {
    if (started) words.push({ text, expanded })
    text = ''
    started = false
    expanded = false
  }
  const endCommand = (): boolean => {
    endWord()
    if (words.length === 0) return false
    commands.push({ words, redirected })
    words = []
    redirected = false
    return true
  }
  for (let index = 0; index < command.length; index += 1) {
    const char = command.charAt(index)
    const next = command.charAt(index + 1)
    if (char === '\\' && dialect === 'bash') {
      if (next === '' || next === '\n') return undefined
      text += next
      started = true
      index += 1
    } else if (char === "'") {
      const close = command.indexOf("'", index + 1)
      if (close === -1) return undefined
      text += command.slice(index + 1, close)
      started = true
      index = close
    } else if (char === '"') {
      let at = index + 1
      for (; at < command.length && command.charAt(at) !== '"'; at += 1) {
        const inner = command.charAt(at)
        if (inner === '`' || (inner === '$' && command.charAt(at + 1) === '(')) return undefined
        if (inner === '$') expanded = true
        if (inner === '\\' && dialect === 'bash' && at + 1 < command.length) at += 1
        text += command.charAt(at)
      }
      if (at >= command.length) return undefined
      started = true
      index = at
    } else if (char === ' ' || char === '\t') {
      endWord()
    } else if (char === ';' || char === '|' || (char === '&' && next === '&')) {
      if (!endCommand()) return undefined
      if ((char === '|' && next === '|') || char === '&') index += 1
    } else if (char === '>') {
      if (next === '(') return undefined
      // `2>&1` names no file; `>` and `>>` name the next word, which is not an argument.
      if (/^\d+$/u.test(text) && started) { text = ''; started = false }
      endWord()
      redirected = true
      if (next === '>') index += 1
      if (command.charAt(index + 1) === '&') {
        const fd = /^&\d+/u.exec(command.slice(index + 1))?.[0]
        if (fd === undefined) return undefined
        index += fd.length
      } else {
        const rest = command.slice(index + 1).replace(/^[ \t]+/u, '')
        const target = /^[^\s;&|<>()`$'"\\#!{}]+/u.exec(rest)?.[0]
        if (target === undefined) return undefined
        index = command.length - rest.length + target.length - 1
      }
    } else if (char === '$') {
      if (next === '(' || next === "'" || next === '"' || next === '{') return undefined
      text += char
      started = true
      expanded = true
    } else if ('#`<&(){}!\n\r'.includes(char)) {
      return undefined
    } else {
      text += char
      started = true
    }
  }
  if (!endCommand() && commands.length > 0) return undefined
  return commands
}

/**
 * Whether a command word runs the program by its bare name; in PowerShell in any case and with a
 * `.cmd`, `.bat`, or `.exe` extension.
 */
function runs(word: string, program: string, dialect: ShellDialect): boolean {
  if (dialect === 'bash') return word === program
  return word.toLowerCase().replace(/\.(?:cmd|bat|exe)$/u, '') === program.toLowerCase()
}

/**
 * The declared operations a shell command runs, when every simple command in it is one. A simple
 * command is an operation when its first word is the operation's program by its bare name and the
 * next words are the operation's other words, none built from a variable; the words after them are
 * free. A path, a leading variable assignment, or an unreadable command (see {@link readCommand})
 * never matches, nor does an operation that may not be declared.
 * @param command - the shell command.
 * @param dialect - the shell it is written for.
 * @param operations - the declared operations.
 * @param sandboxed - false when the command would run outside the sandbox, which also refuses a redirection.
 * @returns the operation each simple command runs, or undefined when one is not declared, the
 *   command is unreadable, or it holds no command.
 */
export function declaredOperations(
  command: string, dialect: ShellDialect, operations: readonly string[], sandboxed: boolean,
): string[] | undefined {
  const commands = readCommand(command, dialect)
  if (commands === undefined || commands.length === 0) return undefined
  const usable = operations.filter(declarable)
  const matched: string[] = []
  for (const simple of commands) {
    if (!sandboxed && simple.redirected) return undefined
    const operation = usable.find((declared) => {
      const [program, ...rest] = declared.split(' ') as [string, ...string[]]
      const head = simple.words.slice(0, rest.length + 1)
      return head.length === rest.length + 1 && head.every(word => !word.expanded)
        && runs((head[0] as Word).text, program, dialect) && rest.every((part, index) => head[index + 1]?.text === part)
    })
    if (operation === undefined) return undefined
    matched.push(operation)
  }
  return matched
}

/** Longest command text a record keeps, in characters. */
export const RECORDED_COMMAND_CHARS = 500

/**
 * A command as a record keeps it: cut to {@link RECORDED_COMMAND_CHARS} characters.
 * @param command - the command.
 * @returns the text to record.
 */
export function recordedCommand(command: string): string {
  return command.length > RECORDED_COMMAND_CHARS ? `${command.slice(0, RECORDED_COMMAND_CHARS)}…` : command
}
