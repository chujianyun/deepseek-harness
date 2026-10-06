/**
 * Installing a connector CLI: download its pinned archive, unpack only the executable beside
 * the version directory, check that it runs and reports the pinned version, then rename it into
 * place, so an interrupted install never looks installed.
 */
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runNativeCommand } from '@deepseek-ai/dsh-native-command'
import { DownloadError, downloadFile } from '@deepseek-ai/dsh-verified-download'
import { unzipSync } from 'fflate'
import { extract } from 'tar'
import type { CliArchive, CliSpec } from './index.ts'

/** Why an install stopped; the codes are those of {@link import('./types.ts').ConnectorInstallError}. */
export class InstallError extends Error {
  /**
   * @param code - which step failed.
   * @param message - detail for logs.
   */
  constructor(readonly code: 'network' | 'verification' | 'storage' | 'launch', message: string) { super(message) }
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

/**
 * Download, unpack, and check one CLI version; the archive is kept until unpacked so an interrupted download resumes.
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
  const archivePath = join(root, 'downloads', archive.file)
  const urls = spec.mirrors.map(template => template.replaceAll('{version}', spec.version).replaceAll('{file}', archive.file))
  try {
    await downloadFile({ urls, dest: archivePath, size: archive.size, sha256: archive.sha256 }, onBytes, signal)
  } catch (error) {
    if (error instanceof DownloadError) throw new InstallError(error.code, error.message)
    throw error
  }
  const target = join(root, spec.version)
  const staging = `${target}.install`
  const name = executableName(spec)
  try {
    await rm(staging, { recursive: true, force: true })
    await mkdir(staging, { recursive: true })
    await unpack(archivePath, archive.file, name, staging)
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
    await rm(target, { recursive: true, force: true })
    await rename(staging, target)
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw new InstallError('storage', `${target}: ${String(error)}`)
  }
  await rm(archivePath, { force: true })
}
