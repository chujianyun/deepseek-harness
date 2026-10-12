/** Why a skill run stopped, as the message the model reads and the exit status its script ends with. */
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util'

/** Exit status of a run that stopped for a reason it names. */
export const EXIT = {
  /** Anything else went wrong. */
  failed: 1,
  /** The platform has not finished the day's figures; nothing was written. */
  notReady: 2,
  /** The account is signed out of the platform; a person has to sign in again. */
  signedOut: 3,
  /** Platform risk control or the buyer account's page limit stopped the run; what was read so far is saved. */
  stopped: 4,
  /** The command line was wrong. */
  usage: 64,
} as const

/** A stop the skill explains in its own words. */
export class SkillError extends Error {
  /**
   * @param message - what the model is told, in Chinese for the user.
   * @param exitCode - the script's exit status.
   */
  constructor(message: string, readonly exitCode: number = EXIT.failed) {
    super(message)
    this.name = 'SkillError'
  }
}

/**
 * Read a script's command line, stopping with its usage when the line is malformed.
 * @param argv - the arguments after the script.
 * @param options - the options the script takes.
 * @param usage - the usage shown with a refusal.
 * @param allowPositionals - whether the script takes arguments besides its options.
 * @returns the options' values and the positionals.
 * @throws SkillError usage for a malformed command line.
 */
export function parseCommandLine<const T extends ParseArgsOptionsConfig>(
  argv: readonly string[], options: T, usage: string, allowPositionals = true,
) {
  try {
    return parseArgs({ args: [...argv], allowPositionals, options })
  } catch (error) {
    throw new SkillError(`${(error as Error).message}\n${usage}`, EXIT.usage)
  }
}

/**
 * Tell why a script stopped and pick its exit status: a SkillError's own message and status, or any other
 * error's message under 失败 and the failed status.
 * @param stderr - the script's error output.
 * @param error - what stopped it.
 * @returns the exit status.
 */
export function stopped(stderr: (text: string) => void, error: unknown): number {
  if (error instanceof SkillError) {
    stderr(`${error.message}\n`)
    return error.exitCode
  }
  stderr(`失败：${error instanceof Error ? error.message : String(error)}\n`)
  return EXIT.failed
}
