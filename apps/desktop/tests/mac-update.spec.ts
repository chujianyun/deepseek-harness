import { execFile, spawn, type SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAC_INSTALL_SCRIPT, macBundle, macInstaller, macPreparation, macReplaceable } from '../src/mac-update.ts'

const run = promisify(execFile)
const darwin = process.platform === 'darwin'
// The bundle paths and the replacement script are POSIX; Windows installs through its own installer.
const posix = process.platform !== 'win32'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'mac-update-')) })
afterEach(async () => {
  await chmod(root, 0o755).catch(() => {})
  await rm(root, { recursive: true, force: true })
})

/** Minimal App bundle whose Info.plist carries an identifier and version. */
async function bundle(path: string, identifier: string, version: string): Promise<string> {
  await mkdir(join(path, 'Contents', 'MacOS'), { recursive: true })
  await writeFile(join(path, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${identifier}</string>
<key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>
`)
  await writeFile(join(path, 'Contents', 'MacOS', 'marker'), version)
  return path
}

describe.runIf(posix)('mac bundle location', () => {
  it('finds the App enclosing the main executable', () => {
    expect(macBundle('/Applications/MO WorkAI.app/Contents/MacOS/MO WorkAI')).toBe('/Applications/MO WorkAI.app')
  })

  it('replaces only a writable App outside disk images and translocation', async () => {
    const app = await bundle(join(root, 'MO WorkAI.app'), 'vip.example', '1.0.0')
    expect(macReplaceable(app)).toBe(true)
    expect(macReplaceable('/Volumes/MO WorkAI/MO WorkAI.app')).toBe(false)
    expect(macReplaceable('/private/var/folders/x/AppTranslocation/y/d/MO WorkAI.app')).toBe(false)
    expect(macReplaceable(join(root, 'not-a-bundle'))).toBe(false)
    expect(macReplaceable(join(root, 'Missing.app'))).toBe(false)
    await chmod(root, 0o555)
    expect(macReplaceable(app)).toBe(process.getuid?.() === 0)
  })
})

describe.runIf(darwin)('mac preparation', () => {
  async function archive(app: string): Promise<string> {
    const zip = join(root, 'updates', '1.1.0', 'mo.zip')
    await mkdir(join(root, 'updates', '1.1.0'), { recursive: true })
    await run('ditto', ['-c', '-k', '--keepParent', app, zip])
    return zip
  }

  it('extracts the App and checks its identifier and version', async () => {
    const current = await bundle(join(root, 'current', 'MO WorkAI.app'), 'vip.example', '1.0.0')
    const zip = await archive(await bundle(join(root, 'build', 'MO WorkAI.app'), 'vip.example', '1.1.0'))
    const prepare = macPreparation(current)
    const next = await prepare(zip, '1.1.0')
    expect(next).toBe(join(root, 'updates', '1.1.0', 'app', 'MO WorkAI.app'))
    expect(await readFile(join(next, 'Contents', 'MacOS', 'marker'), 'utf8')).toBe('1.1.0')
    await expect(prepare(zip, '1.2.0')).rejects.toThrow('version does not match')
  })

  it('rejects another application and an archive without exactly one App', async () => {
    const current = await bundle(join(root, 'current', 'MO WorkAI.app'), 'vip.example', '1.0.0')
    const other = await archive(await bundle(join(root, 'build', 'Other.app'), 'com.other', '1.1.0'))
    await expect(macPreparation(current)(other, '1.1.0')).rejects.toThrow('different application')
    await mkdir(join(root, 'empty'))
    await writeFile(join(root, 'empty', 'readme.txt'), 'x')
    const empty = join(root, 'updates', '1.1.0', 'empty.zip')
    await run('ditto', ['-c', '-k', join(root, 'empty'), empty])
    await expect(macPreparation(current)(empty, '1.1.0')).rejects.toThrow('exactly one application')
  })
})

describe.runIf(posix)('mac replacement script', () => {
  async function replace(next: string, prepare?: (current: string) => Promise<void>) {
    const current = await bundle(join(root, 'Apps', 'MO WorkAI.app'), 'vip.example', '1.0.0')
    await prepare?.(current)
    const script = join(root, 'install.sh')
    const opened = join(root, 'opened')
    await writeFile(script, MAC_INSTALL_SCRIPT, { mode: 0o755 })
    await writeFile(join(root, 'open.sh'), `#!/bin/sh\necho "$1" > "${opened}"\n`, { mode: 0o755 })
    // An exited process stands in for the quitting application.
    const gone = spawn('true')
    await new Promise(done => gone.once('exit', done))
    // A refused replacement exits 1 after reopening the current App; its output is still the result.
    const { stdout } = await run('/bin/sh', [script, String(gone.pid), current, next], { env: { ...process.env, DSH_UPDATE_OPEN: join(root, 'open.sh') } })
      .catch((error: unknown) => ({ stdout: (error as { stdout: string }).stdout }))
    return { current, stdout, opened: (await readFile(opened, 'utf8')).trim() }
  }

  it('moves the new App into place, removes the backup, and reopens it', async () => {
    const next = await bundle(join(root, 'updates', 'MO WorkAI.app'), 'vip.example', '1.1.0')
    const result = await replace(next)
    expect(result.stdout.trim()).toBe('updated')
    expect(await readFile(join(result.current, 'Contents', 'MacOS', 'marker'), 'utf8')).toBe('1.1.0')
    await expect(stat(`${result.current}.updating`)).rejects.toThrow()
    expect(result.opened).toBe(result.current)
  })

  it('restores the previous App when the new one cannot be moved', async () => {
    const result = await replace(join(root, 'updates', 'Missing.app'))
    expect(result.stdout).toContain('restoring')
    expect(await readFile(join(result.current, 'Contents', 'MacOS', 'marker'), 'utf8')).toBe('1.0.0')
    expect(result.opened).toBe(result.current)
  })

  it('reopens the current App unchanged when it cannot be moved aside', async () => {
    const next = await bundle(join(root, 'updates', 'MO WorkAI.app'), 'vip.example', '1.1.0')
    const result = await replace(next, current => chmod(join(current, '..'), 0o555))
    await chmod(join(root, 'Apps'), 0o755)
    expect(result.stdout).toContain('cannot move the current application')
    expect(await readFile(join(result.current, 'Contents', 'MacOS', 'marker'), 'utf8')).toBe('1.0.0')
    expect(result.opened).toBe(result.current)
  })
})

describe.runIf(posix)('mac installer', () => {
  it('runs the script through its log wrapper after the application exits, with spaces and non-ASCII paths', async () => {
    const apps = join(root, 'MO 更新测试')
    const current = await bundle(join(apps, 'MO WorkAI.app'), 'vip.example', '1.0.0')
    const next = await bundle(join(root, 'updates 1', 'app', 'MO WorkAI.app'), 'vip.example', '1.1.0')
    const log = join(root, 'Logs dir', 'update-install.log')
    await mkdir(join(root, 'Logs dir'))
    await writeFile(join(root, 'open.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    // A sleeping child stands in for the quitting application; the script must wait for it.
    const app = spawn('sleep', ['1'])
    const spawnProcess = ((command: string, args: string[], options: Parameters<typeof spawn>[2]) =>
      spawn(command, args.map(arg => arg === String(process.pid) ? String(app.pid) : arg),
        { ...options, env: { ...options.env, DSH_UPDATE_OPEN: join(root, 'open.sh') } })) as typeof spawn
    const quit = vi.fn()
    await macInstaller(current, log, quit, spawnProcess)(next)
    expect(quit).toHaveBeenCalledOnce()
    await vi.waitFor(async () => { expect(await readFile(log, 'utf8').catch(() => '')).toContain('updated') }, { timeout: 10_000 })
    expect(await readFile(join(current, 'Contents', 'MacOS', 'marker'), 'utf8')).toBe('1.1.0')
  })

  function child() { return Object.assign(new EventEmitter(), { unref: vi.fn() }) }

  it('writes the script beside the prepared App, starts it detached with this process, then quits', async () => {
    const process_ = child()
    const spawnProcess = vi.fn<(command: string, args: string[], options: SpawnOptions) => typeof process_>(() => process_)
    const quit = vi.fn()
    const next = join(root, 'app', 'MO WorkAI.app')
    await mkdir(next, { recursive: true })
    const started = macInstaller('/Applications/MO WorkAI.app', '/logs/update.log', quit, spawnProcess as never)(next)
    await vi.waitFor(() => { expect(spawnProcess).toHaveBeenCalled() })
    const [command, args, options] = spawnProcess.mock.calls[0]!
    expect(command).toBe('/bin/sh')
    expect(args.slice(2)).toEqual([join(root, 'app', 'install.sh'), String(process.pid), '/Applications/MO WorkAI.app', next])
    expect(options).toMatchObject({ detached: true, stdio: 'ignore', env: { LOG: '/logs/update.log' } })
    expect(await readFile(join(root, 'app', 'install.sh'), 'utf8')).toBe(MAC_INSTALL_SCRIPT)
    process_.emit('spawn')
    await started
    expect(process_.unref).toHaveBeenCalled()
    expect(quit).toHaveBeenCalledOnce()
  })

  it('rejects without quitting when the script cannot start', async () => {
    const process_ = child()
    const quit = vi.fn()
    await mkdir(join(root, 'app'), { recursive: true })
    const started = macInstaller('/Applications/MO WorkAI.app', '/logs/update.log', quit, vi.fn(() => process_) as never)(join(root, 'app', 'MO WorkAI.app'))
    await vi.waitFor(() => { expect(process_.listenerCount('error')).toBe(1) })
    process_.emit('error', new Error('EACCES'))
    await expect(started).rejects.toThrow('EACCES')
    expect(quit).not.toHaveBeenCalled()
  })
})
