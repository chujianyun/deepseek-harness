/**
 * The system Google Chrome behind e-commerce accounts: find it and read its version, start one
 * Chrome per account on that account's own browser data with a local remote-debugging port, and
 * close it so it writes its cookies first. Chrome is started detached, so it outlives DSH; the
 * port and process id are recorded beside the browser data so a later DSH reattaches to it.
 */

import { execFile, spawn } from 'node:child_process'
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Browser, ChromeReleaseChannel, computeSystemExecutablePath } from '@puppeteer/browsers'
import { Cdp } from './cdp.ts'

const run = promisify(execFile)

/** The installed Chrome. */
export interface ChromeInfo {
  readonly path: string
  /** Version string, such as `141.0.7390.65`; undefined when Chrome does not report one. */
  readonly version: string | undefined
  /** Major version; undefined with {@link version}. */
  readonly major: number | undefined
}

/**
 * Find Google Chrome and read its version.
 * @param override - a Chrome executable to use instead of the platform's standard install.
 * @returns the Chrome, or undefined when it is not installed.
 */
export async function findChrome(override: string | undefined): Promise<ChromeInfo | undefined> {
  let path: string
  try {
    path = override ?? computeSystemExecutablePath({ browser: Browser.CHROME, channel: ChromeReleaseChannel.STABLE })
    await access(path)
  } catch {
    // No standard install for this platform, or nothing at that path.
    return undefined
  }
  let version: string | undefined
  try {
    const { stdout } = await run(path, ['--version'], { timeout: 10_000 })
    version = /(\d+(?:\.\d+)+)/u.exec(stdout)?.[1]
  } catch {
    // Some builds, such as Chrome on Windows, print no version; the version stays unknown.
  }
  return { path, version, major: version === undefined ? undefined : Number(version.split('.')[0]) }
}

/** The recorded Chrome of one account. */
export interface ChromeProcess {
  readonly pid: number
  readonly port: number
}

const RECORD = 'chrome.json'

/**
 * Read the recorded Chrome of an account.
 * @param dir - the account's browser directory.
 * @returns the record, or undefined when none is recorded.
 */
export async function readRecord(dir: string): Promise<ChromeProcess | undefined> {
  try {
    return JSON.parse(await readFile(join(dir, RECORD), 'utf8')) as ChromeProcess
  } catch {
    // No Chrome was started for this account yet, or the record is unreadable.
    return undefined
  }
}

/**
 * Whether a Chrome answers on the port.
 * @param port - the remote-debugging port.
 * @returns true when it answers.
 */
export async function alive(port: number): Promise<boolean> {
  try {
    return (await fetch(`http://127.0.0.1:${String(port)}/json/version`, { signal: AbortSignal.timeout(1500) })).ok
  } catch {
    // Nothing listens there any more.
    return false
  }
}

/**
 * Make sure a running Chrome has a tab: a Chrome whose windows were all closed keeps running and
 * answering but cannot be driven. Opening a blank tab brings it back without restarting it, which
 * would lose the sign-in.
 * @param port - the remote-debugging port.
 */
export async function ensureTab(port: number): Promise<void> {
  const tabs = await (await fetch(`http://127.0.0.1:${String(port)}/json`, { signal: AbortSignal.timeout(1500) })).json() as { type: string }[]
  if (tabs.some(tab => tab.type === 'page')) return
  await fetch(`http://127.0.0.1:${String(port)}/json/new?about:blank`, { method: 'PUT', signal: AbortSignal.timeout(3000) })
}

/**
 * Pick a free local port.
 * @returns the port.
 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const { port } = server.address() as { port: number }
      server.close(() => { resolve(port) })
    })
  })
}

/**
 * Ask Chrome to restore the last session on start, which brings back the session cookies most
 * sign-ins rely on, and to treat the last exit as clean so it shows no restore prompt. Chrome
 * overwrites its preferences while running, so this happens only before a start.
 * @param userDataDir - the account's browser data.
 */
async function restoreSessionOnStart(userDataDir: string): Promise<void> {
  const path = join(userDataDir, 'Default', 'Preferences')
  let preferences: { session?: Record<string, unknown>; profile?: Record<string, unknown> }
  try {
    preferences = JSON.parse(await readFile(path, 'utf8')) as typeof preferences
  } catch {
    // A first start: Chrome creates the preferences itself.
    return
  }
  preferences.session = { ...preferences.session, restore_on_startup: 1 }
  preferences.profile = { ...preferences.profile, exit_type: 'Normal', exited_cleanly: true }
  await writeFile(path, JSON.stringify(preferences))
}

/** How to start an account's Chrome. */
export interface LaunchOptions {
  readonly chrome: string
  /** The account's browser directory; the browser data is its `user-data` folder. */
  readonly dir: string
  /** Page to open. */
  readonly url: string
  /** Start with the window off screen. */
  readonly hidden: boolean
  /** How long to wait for Chrome to answer. */
  readonly timeoutMs: number
  /** Environment of the Chrome process. */
  readonly env: NodeJS.ProcessEnv
}

/**
 * Start an account's Chrome detached, so it outlives DSH, and record it.
 * @param options - which Chrome, where its data lives, and how to show it.
 * @returns the recorded process.
 * @throws when Chrome does not answer in time.
 */
export async function launchChrome(options: LaunchOptions): Promise<ChromeProcess> {
  const userDataDir = join(options.dir, 'user-data')
  await mkdir(userDataDir, { recursive: true })
  await restoreSessionOnStart(userDataDir)
  const port = await freePort()
  const child = spawn(options.chrome, [
    '--restore-last-session',
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${String(port)}`,
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check',
    ...options.hidden ? ['--window-position=-32000,-32000', '--window-size=1600,1000'] : ['--window-position=80,80', '--window-size=1280,880'],
    options.url,
  ], { detached: true, stdio: 'ignore', env: options.env })
  child.unref()
  const deadline = Date.now() + options.timeoutMs
  while (!await alive(port)) {
    if (Date.now() > deadline) throw new Error(`Chrome did not answer on port ${String(port)} in ${String(options.timeoutMs)} ms`)
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  const record = { pid: child.pid as number, port }
  await writeFile(join(options.dir, RECORD), `${JSON.stringify(record)}\n`)
  return record
}

/**
 * Close an account's Chrome through `Browser.close`, so it writes its cookies, and wait until it
 * stops answering; signal the process only when that fails.
 * @param dir - the account's browser directory.
 * @param timeoutMs - how long to wait for each step.
 */
export async function closeChrome(dir: string, timeoutMs: number): Promise<void> {
  const record = await readRecord(dir)
  if (record === undefined) return
  if (await alive(record.port)) {
    try {
      const cdp = await Cdp.connect(record.port, timeoutMs)
      // Chrome closes the socket while it exits, so the call may never be answered.
      void cdp.send('Browser.close').catch(() => undefined)
    } catch {
      // The connection failed; the signals below still stop Chrome.
    }
    const deadline = Date.now() + timeoutMs
    while (await alive(record.port) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 200))
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      if (!await alive(record.port)) break
      try {
        process.kill(record.pid, signal)
      } catch {
        // The process is already gone.
      }
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
  }
  await rm(join(dir, RECORD), { force: true })
}
