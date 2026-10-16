/** macOS in-app update: replace the running App bundle with a verified one extracted from the offered ZIP. */

import { execFile, spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { HubInstaller, HubPreparation } from './hub-updater.ts'

const run = promisify(execFile)

/**
 * Waits for the old process, moves the current App aside, moves the new App into place, and reopens the
 * application. A failed move restores the previous App; output goes to the log file. `DSH_UPDATE_OPEN`
 * replaces `open` in tests.
 */
export const MAC_INSTALL_SCRIPT = `#!/bin/sh
pid="$1"; old="$2"; new="$3"; backup="$old.updating"; open="\${DSH_UPDATE_OPEN:-open}"
i=0
while kill -0 "$pid" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -gt 3000 ]; then echo "application did not exit within ten minutes; not updating"; exit 1; fi
  sleep 0.2
done
rm -rf "$backup"
if ! mv "$old" "$backup"; then echo "cannot move the current application"; "$open" "$old"; exit 1; fi
if mv "$new" "$old"; then
  xattr -dr com.apple.quarantine "$old" 2>/dev/null
  rm -rf "$backup"
  echo "updated"
else
  echo "cannot move the new application; restoring"
  rm -rf "$old"
  if ! mv "$backup" "$old"; then echo "restore failed; the previous application is at $backup"; exit 1; fi
fi
"$open" "$old"
`

/**
 * @param executable - Path of the running main executable, inside `<name>.app/Contents/MacOS/`.
 * @returns The enclosing App bundle.
 */
export function macBundle(executable: string): string {
  return resolve(executable, '../../..')
}

/**
 * Whether the running App can be replaced in place: not on a mounted disk image, not translocated by
 * Gatekeeper, and both the bundle and its folder are writable by this user.
 * @param bundle - Running App bundle.
 */
export function macReplaceable(bundle: string): boolean {
  if (!bundle.endsWith('.app') || bundle.startsWith('/Volumes/') || bundle.includes('/AppTranslocation/')) return false
  return writable(dirname(bundle)) && writable(bundle)
}

function writable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK)
  } catch {
    // Missing write permission is the expected reason to fall back to the disk image.
    return false
  }
  return true
}

async function plistValue(bundle: string, key: string): Promise<string> {
  const { stdout } = await run('plutil', ['-extract', key, 'raw', '-o', '-', join(bundle, 'Contents', 'Info.plist')])
  return stdout.trim()
}

/**
 * Extract the ZIP beside it and accept only a single App with the running App's bundle identifier and the
 * offered version.
 * @param current - Running App bundle, whose identifier the update must keep.
 * @returns Preparation for {@link HubUpdaterOptions.prepare}.
 */
export function macPreparation(current: string): HubPreparation {
  return async (file, version) => {
    const out = join(dirname(file), 'app')
    await rm(out, { recursive: true, force: true })
    await mkdir(out)
    await run('ditto', ['-x', '-k', file, out])
    const [app, ...others] = (await readdir(out)).filter(name => name.endsWith('.app'))
    if (app === undefined || others.length > 0) throw new Error('desktop update: archive must contain exactly one application')
    const next = join(out, app)
    const [identifier, expected, shortVersion] = await Promise.all([
      plistValue(next, 'CFBundleIdentifier'), plistValue(current, 'CFBundleIdentifier'), plistValue(next, 'CFBundleShortVersionString')])
    if (identifier !== expected) throw new Error('desktop update: archive contains a different application')
    if (shortVersion !== version) throw new Error('desktop update: archive version does not match the offer')
    return next
  }
}

/**
 * Start the detached replacement script, then quit so it can move the App.
 * @param current - Running App bundle to replace.
 * @param log - File receiving the script's output.
 * @param quit - Application quit; called only after the script has started.
 * @param spawnProcess - Process creation, replaceable in tests.
 * @returns Installer for {@link HubUpdaterOptions.install}.
 */
export function macInstaller(current: string, log: string, quit: () => void, spawnProcess: typeof spawn = spawn): HubInstaller {
  return async (next) => {
    const script = join(dirname(next), 'install.sh')
    await writeFile(script, MAC_INSTALL_SCRIPT, { mode: 0o755 })
    await new Promise<void>((done, reject) => {
      const wrapper = '"$0" "$@" >> "$LOG" 2>&1'
      const child = spawnProcess('/bin/sh', ['-c', wrapper, script, String(process.pid), current, next],
        { detached: true, stdio: 'ignore', env: { ...process.env, LOG: log } })
      child.once('error', reject)
      child.once('spawn', () => { child.unref(); quit(); done() })
    })
  }
}
