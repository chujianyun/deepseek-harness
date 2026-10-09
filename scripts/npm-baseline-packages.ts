/** Manifest discovery for the npm baseline's vendor, harness, and application packages. */

import { globSync } from 'node:fs'
import { UNPUBLISHED_PACKAGE_DIRECTORIES } from './repository-only-package-policy.ts'

const PACKAGE_PATTERNS = [
  'vendor/*/package.json',
  'packages/*/*/package.json',
  'apps/*/package.json',
] as const

/**
 * Discover baseline manifests while excluding the directories npm never receives.
 * @param root - repository root to scan.
 * @param privateDirectories - repository-relative directories excluded from publication: private experimental and repository-only packages.
 * @returns Sorted repository-relative manifest paths with forward slashes.
 */
export function discoverNpmBaselineManifests(
  root: string,
  privateDirectories: readonly string[] = UNPUBLISHED_PACKAGE_DIRECTORIES,
): string[] {
  return globSync(PACKAGE_PATTERNS, {
    cwd: root,
    exclude: privateDirectories.map(directory => `${directory}/package.json`),
  }).map(path => path.replaceAll('\\', '/')).sort()
}
