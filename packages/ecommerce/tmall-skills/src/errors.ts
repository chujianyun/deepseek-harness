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
 * @returns the options' values and the positionals.
 * @throws SkillError usage for a malformed command line.
 */
export function parseCommandLine<const T extends ParseArgsOptionsConfig>(argv: readonly string[], options: T, usage: string) {
  try {
    return parseArgs({ args: [...argv], allowPositionals: true, options })
  } catch (error) {
    throw new SkillError(`${(error as Error).message}\n${usage}`, EXIT.usage)
  }
}
