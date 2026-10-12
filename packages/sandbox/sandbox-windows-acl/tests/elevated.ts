/**
 * The ACL cases that need an ordinary user. GitHub's hosted Windows runners, like an administrator's
 * SSH session, run elevated (High or System integrity): ownership and privileges keep the rights these
 * cases take away, so the faults they build do not occur. They pass when run unelevated.
 */
import { execFileSync } from 'node:child_process'
import { it } from 'vitest'

/**
 * Whether this process runs with an elevated token.
 * @returns true only on Windows with a High or System integrity token.
 */
export function elevated(): boolean {
  if (process.platform !== 'win32') return false
  try {
    return /S-1-16-(?:12288|16384)\b/u.test(execFileSync('whoami', ['/groups'], { encoding: 'utf8' }))
  } catch {
    // whoami is unavailable: the cases run.
    return false
  }
}

/** A case that needs an unelevated user; skipped when elevated. */
export const unelevated: ReturnType<typeof it.skipIf> = it.skipIf(elevated())
