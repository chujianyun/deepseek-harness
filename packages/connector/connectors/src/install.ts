/**
 * Installing a connector CLI: download its pinned archive, and its Skills archive when the release
 * ships one, unpack only the executable and the Skills beside the version directory, check that it
 * runs and reports the pinned version, then rename it into place, so an interrupted install never
 * looks installed.
 */
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, normalize, sep } from 'node:path'
import { runNativeCommand } from '@deepseek-ai/dsh-native-command'
import { DownloadError, downloadFile } from '@deepseek-ai/dsh-verified-download'
import { unzipSync } from 'fflate'
import { extract } from 'tar'
import type { CliArchive, CliAsset, CliSpec } from './index.ts'

/** Why an install stopped; the codes are those of {@link import('./types.ts').ConnectorInstallError}. */
export class InstallError extends Error {
  /**
   * @param code - which step failed.
   * @param message - detail for logs.
   */
  constructor(readonly code: 'network' | 'verification' | 'storage' | 'busy' | 'launch', message: string) { super(message) }
}

/** Waits between attempts to move files that another process still holds, about 4.5 s in all. */
const HELD_RETRY_DELAYS_MS = [100, 200, 400, 800, 1000, 1000, 1000]

/**
 * Whether a file operation failed because another process holds the files, as Windows reports for a CLI
 * that just exited or a file a scanner is reading; elsewhere EPERM and EACCES mean missing permission.
 */
function held(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'EBUSY' || (process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES'))
}

/** Run a file operation, retrying it while another process holds the files. */
async function retryHeld(operation: () => Promise<void>): Promise<void> {
  for (const delay of [...HELD_RETRY_DELAYS_MS, undefined]) {
    try {
      await operation()
      return
    } catch (error) {
      if (delay === undefined || !held(error)) throw error
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
}

/** Longest wait for the unpacked CLI to report its version. */
const LAUNCH_TIMEOUT_MS = 15_000

/**
 * Platform key of the running process, as archives are keyed.
 * @returns `<platform>-<arch>`.
 */
export function platformKey(): string {
  return `${process.platform}-${process.arch}`
}

/**
 * File name of a CLI's executable on this platform.
 * @param spec - the CLI.
 * @returns the binary name, with `.exe` on Windows.
 */
export function executableName(spec: CliSpec): string {
  /* v8 ignore next -- POSIX coverage cannot take the Windows name; native Windows coverage does. */
  return process.platform === 'win32' ? `${spec.binary}.exe` : spec.binary
}

/**
 * Whether a CLI version is installed in its directory.
 * @param dir - the version directory.
 * @param spec - the CLI.
 * @returns true when its executable is there.
 */
export async function cliInstalled(dir: string, spec: CliSpec): Promise<boolean> {
  return (await stat(join(dir, executableName(spec))).catch(() => undefined)) !== undefined
}

/** Unpack the executable alone from a `.zip` or `.tar.gz` archive into `dir`. */
async function unpack(archivePath: string, file: string, name: string, dir: string): Promise<void> {
  if (file.endsWith('.zip')) {
    const entries = unzipSync(await readFile(archivePath), { filter: entry => entry.name === name })
    const bytes = entries[name]
    if (bytes === undefined) throw new Error(`${file} has no ${name}`)
    await writeFile(join(dir, name), bytes)
  } else {
    await extract({ file: archivePath, cwd: dir, filter: path => path === name || path === `./${name}` })
    if ((await stat(join(dir, name)).catch(() => undefined)) === undefined) throw new Error(`${file} has no ${name}`)
  }
  await chmod(join(dir, name), 0o755)
}

/** The directory of an installed version's Skills, one directory per Skill. */
export const SKILLS_DIR = 'skills'

/** The tree of a Skills archive DSH installs: one directory per Skill. */
const SKILLS_TREE = 'multi/'

/** Unpack a Skills archive's per-Skill tree into `dir`, refusing an entry that would leave it. */
async function unpackSkills(archivePath: string, dir: string): Promise<void> {
  const entries = unzipSync(await readFile(archivePath), { filter: entry => entry.name.startsWith(SKILLS_TREE) && !entry.name.endsWith('/') })
  for (const [name, bytes] of Object.entries(entries)) {
    const relative = normalize(name.slice(SKILLS_TREE.length))
    if (relative.startsWith('..') || relative.startsWith(sep)) throw new Error(`${name} leaves the Skills directory`)
    const target = join(dir, relative)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, bytes)
  }
}

/**
 * Download one file of a release from the mirrors in order, verifying its size and sha256.
 * @throws InstallError `network` or `verification`; the abort reason when aborted.
 */
async function download(
  root: string, spec: CliSpec, asset: CliAsset, onBytes: (bytes: number) => void, signal: AbortSignal,
): Promise<string> {
  const dest = join(root, 'downloads', asset.file)
  const urls = spec.mirrors.map(template => template.replaceAll('{version}', spec.version).replaceAll('{file}', asset.file))
  try {
    await downloadFile({ urls, dest, size: asset.size, sha256: asset.sha256 }, onBytes, signal)
  } catch (error) {
    if (error instanceof DownloadError) throw new InstallError(error.code, error.message)
    throw error
  }
  return dest
}

/**
 * Download, unpack, and check one CLI version; the archives are kept until unpacked so an interrupted download resumes.
 * @param root - the connector's directory; the version lands in `<root>/<version>`.
 * @param spec - the CLI.
 * @param archive - this platform's archive.
 * @param onBytes - download progress, in bytes.
 * @param signal - stops the install.
 * @throws InstallError with the failed step; the abort reason, and nothing else, when aborted.
 */
export async function installCli(
  root: string, spec: CliSpec, archive: CliArchive, onBytes: (bytes: number) => void, signal: AbortSignal,
): Promise<void> {
  const archivePath = await download(root, spec, archive, onBytes, signal)
  const skillsPath = spec.skills === undefined ? undefined : await download(root, spec, spec.skills, onBytes, signal)
  const target = join(root, spec.version)
  const staging = `${target}.install`
  const name = executableName(spec)
  try {
    await rm(staging, { recursive: true, force: true })
    await mkdir(staging, { recursive: true })
    await unpack(archivePath, archive.file, name, staging)
    if (skillsPath !== undefined) await unpackSkills(skillsPath, join(staging, SKILLS_DIR))
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw new InstallError('storage', `${archive.file}: ${String(error)}`)
  }
  try {
    const { stdout } = await runNativeCommand(join(staging, name), ['--version'], AbortSignal.any([signal, AbortSignal.timeout(LAUNCH_TIMEOUT_MS)]), 'hidden')
    if (!stdout.includes(spec.version)) throw new Error(`reported ${JSON.stringify(stdout.trim())}`)
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    signal.throwIfAborted()
    throw new InstallError('launch', `${name} --version: ${String(error)}`)
  }
  try {
    await retryHeld(() => rm(target, { recursive: true, force: true }))
    await retryHeld(() => rename(staging, target))
  } catch (error) {
    await rm(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    throw new InstallError(held(error) ? 'busy' : 'storage', `${target}: ${String(error)}`)
  }
  await rm(archivePath, { force: true })
  if (skillsPath !== undefined) await rm(skillsPath, { force: true })
}
