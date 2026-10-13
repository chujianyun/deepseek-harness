/** In-app update from installers the user center offers; replaces the signed-feed updater in unsigned builds. */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createWriteStream } from 'node:fs'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { DesktopAvailableRelease, DesktopUpdatePackage } from './mandatory-update-policy.ts'

/** Platform installation of one verified installer; resolves once the platform installer owns the update. */
export type HubInstaller = (file: string) => Promise<void>

/** Process-level operations, replaceable at the platform test boundary. */
export interface HubUpdaterOptions {
  /** Offered release from the latest policy decision, or undefined when none is offered. */
  readonly offer: () => DesktopAvailableRelease | undefined
  readonly currentVersion: () => string
  /** Installer kind this platform installs, or undefined when in-app update is unsupported here. */
  readonly kind: DesktopUpdatePackage['kind'] | undefined
  /** Directory owned by the updater; previous downloads are removed on the next one. */
  readonly directory: string
  readonly install: HubInstaller
  readonly fetch: typeof fetch
  /** A transfer receiving no bytes for this long fails, so a stalled download can be retried. */
  readonly idleTimeoutMs: number
}

/** The subset of electron-updater's surface the update coordinator drives. */
export class HubUpdater extends EventEmitter {
  // Settings the coordinator assigns for electron-updater; the offer alone decides what is downloaded.
  autoDownload = false
  autoInstallOnAppQuit = false
  channel: string | null = null
  allowPrerelease = false
  allowDowngrade = false
  private target: { version: string; pkg: DesktopUpdatePackage } | undefined
  private downloaded: string | undefined
  private clearing: Promise<void> = Promise.resolve()

  constructor(private readonly options: HubUpdaterOptions) { super() }

  /** Whether this platform has an installer kind; the offer can still lack a package for it. */
  get supported(): boolean { return this.options.kind !== undefined }

  /**
   * Select the offered installer for this platform without network work; the policy request already ran
   * and accepted only newer versions.
   * @returns An electron-updater-shaped result; an offer without a usable package is not an update.
   */
  checkForUpdates(): Promise<{ isUpdateAvailable: boolean; updateInfo: { version: string } }> {
    const offer = this.options.offer()
    const pkg = offer?.packages.find(item => item.kind === this.options.kind)
    const next = offer !== undefined && pkg !== undefined ? { version: offer.version, pkg } : undefined
    if (next?.version !== this.target?.version || next?.pkg.sha256 !== this.target?.pkg.sha256) this.downloaded = undefined
    this.target = next
    const version = next?.version ?? this.options.currentVersion()
    return Promise.resolve({ isUpdateAvailable: next !== undefined, updateInfo: { version } })
  }

  /**
   * Download the selected installer, emitting progress, and accept it only when size and SHA-256 match.
   * A verified file of the same target is reused without downloading again.
   */
  async downloadUpdate(): Promise<string[]> {
    const target = this.target
    if (target === undefined) throw new Error('desktop update: no checked update is available')
    const { version, pkg } = target
    await this.clearing
    const directory = join(this.options.directory, version)
    const file = join(directory, basename(new URL(pkg.url).pathname))
    if (this.downloaded !== file || (await stat(file).catch(() => undefined))?.size !== pkg.size) {
      this.downloaded = undefined
      await this.removeOtherVersions(version)
      await mkdir(directory, { recursive: true })
      await this.transfer(pkg, file)
      this.downloaded = file
    }
    this.emit('download-progress', { percent: 100 })
    this.emit('update-downloaded', { version })
    return [file]
  }

  /** Hand the verified installer to the platform; a failure to start it is emitted as an updater error. */
  quitAndInstall(): void {
    if (this.downloaded === undefined) throw new Error('desktop update: no verified installer')
    this.options.install(this.downloaded).catch((error: unknown) => {
      this.emit('error', error instanceof Error ? error : new Error(String(error)))
    })
  }

  /** Remove every retained download; a download survives only within one application run. */
  clear(): Promise<void> {
    this.downloaded = undefined
    this.clearing = rm(this.options.directory, { recursive: true, force: true })
    return this.clearing
  }

  private async transfer(pkg: DesktopUpdatePackage, file: string): Promise<void> {
    const partial = `${file}.part`
    const controller = new AbortController()
    let idle: ReturnType<typeof setTimeout> | undefined
    const arm = (): void => {
      clearTimeout(idle)
      idle = setTimeout(() => { controller.abort(new Error('desktop update: download stalled')) }, this.options.idleTimeoutMs)
    }
    arm()
    try {
      await this.receive(pkg, file, partial, controller.signal, arm)
    } finally {
      clearTimeout(idle)
    }
  }

  private async receive(pkg: DesktopUpdatePackage, file: string, partial: string, signal: AbortSignal, arm: () => void): Promise<void> {
    const response = await this.options.fetch(pkg.url, { cache: 'no-store', redirect: 'error', signal })
    if (!response.ok || response.body === null) throw new Error(`desktop update: download failed with HTTP ${response.status}`)
    const hash = createHash('sha256')
    const body = response.body
    let received = 0
    let reported = -1
    const meter = async function* (updater: HubUpdater): AsyncGenerator<Uint8Array> {
      for await (const chunk of body) {
        arm()
        received += chunk.length
        if (received > pkg.size) throw new Error('desktop update: installer is larger than announced')
        hash.update(chunk)
        const percent = Math.floor(received / pkg.size * 100)
        // Completion is reported only after verification.
        if (percent > reported && percent < 100) { reported = percent; updater.emit('download-progress', { percent }) }
        yield chunk
      }
    }
    try {
      await pipeline(meter(this), createWriteStream(partial))
      if (received !== pkg.size) throw new Error('desktop update: installer size does not match')
      if (hash.digest('hex') !== pkg.sha256) throw new Error('desktop update: installer checksum does not match')
      await rename(partial, file)
    } catch (error) {
      await rm(partial, { force: true })
      throw error
    }
  }

  private async removeOtherVersions(version: string): Promise<void> {
    const entries = await readdir(this.options.directory).catch(() => [])
    await Promise.all(entries.filter(name => name !== version)
      .map(name => rm(join(this.options.directory, name), { recursive: true, force: true })))
  }
}

/**
 * Start the NSIS installer in update mode, then quit. The installer waits for this process to exit,
 * shows its progress window, and relaunches the application with `--updated`.
 * @param quit - Application quit; called only after the installer process has started.
 * @param spawnProcess - Process creation, replaceable in tests.
 * @returns Installer for {@link HubUpdaterOptions.install}.
 */
export function windowsInstaller(quit: () => void, spawnProcess: typeof spawn = spawn): HubInstaller {
  return file => new Promise((resolve, reject) => {
    const child = spawnProcess(file, ['--updated'], { detached: true, stdio: 'ignore' })
    child.once('error', reject)
    child.once('spawn', () => { child.unref(); quit(); resolve() })
  })
}
