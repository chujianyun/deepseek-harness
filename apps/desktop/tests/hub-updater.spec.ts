import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HubUpdater, windowsInstaller, type HubUpdaterOptions } from '../src/hub-updater.ts'
import type { DesktopAvailableRelease, DesktopUpdatePackage } from '../src/mandatory-update-policy.ts'

const content = Buffer.from('installer bytes '.repeat(64))
const sha256 = createHash('sha256').update(content).digest('hex')
const exe: DesktopUpdatePackage = { kind: 'exe', url: 'https://hub.example.com/downloads/1.1.0/mo-1.1.0.exe?sha256=x', sha256, size: content.length }
const zip: DesktopUpdatePackage = { ...exe, kind: 'zip', url: 'https://hub.example.com/downloads/1.1.0/mo-1.1.0.zip' }

let directory: string
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'hub-updater-')) })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

/** Response whose body arrives in fixed chunks, so progress is observable. */
function chunked(bytes: Buffer, size = 256): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += size) controller.enqueue(new Uint8Array(bytes.subarray(offset, offset + size)))
      controller.close()
    },
  }))
}

function fixture(overrides: Partial<HubUpdaterOptions> & { release?: DesktopAvailableRelease } = {}) {
  let release: DesktopAvailableRelease | undefined = overrides.release
    ?? { version: '1.1.0', page: 'https://hub.example.com/download', packages: [zip, exe] }
  const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(chunked(content)))
  const install = vi.fn<HubUpdaterOptions['install']>(() => Promise.resolve())
  const prepare = vi.fn<HubUpdaterOptions['prepare']>(file => Promise.resolve(`${file}.prepared`))
  const updater = new HubUpdater({ offer: () => release, currentVersion: () => '1.0.0', kind: 'exe', directory, prepare, install, fetch,
    idleTimeoutMs: 60_000, ...overrides })
  const progress: number[] = []
  const downloaded: string[] = []
  updater.on('download-progress', ({ percent }: { percent: number }) => { progress.push(percent) })
  updater.on('update-downloaded', ({ version }: { version: string }) => { downloaded.push(version) })
  const offer = (next: DesktopAvailableRelease | undefined): void => { release = next }
  return { updater, fetch, prepare, install, progress, downloaded, offer }
}

describe('hub updater', () => {
  it('offers the installer of this platform kind for a newer release', async () => {
    const f = fixture()
    expect(f.updater.supported).toBe(true)
    expect(await f.updater.checkForUpdates()).toEqual({ isUpdateAvailable: true, updateInfo: { version: '1.1.0' } })
    for (const release of [undefined, { version: '1.1.0', page: 'https://hub.example.com/download', packages: [zip] }]) {
      f.offer(release)
      expect(await f.updater.checkForUpdates()).toEqual({ isUpdateAvailable: false, updateInfo: { version: '1.0.0' } })
    }
    expect(new HubUpdater({ offer: () => undefined, currentVersion: () => '1.0.0', kind: undefined, directory, prepare: vi.fn(), install: vi.fn(), fetch: vi.fn(), idleTimeoutMs: 1 }).supported).toBe(false)
    expect(f.updater.kind).toBe('exe')
  })

  it('downloads with progress, verifies size and SHA-256, and reuses the verified file', async () => {
    const f = fixture()
    await f.updater.checkForUpdates()
    const [file] = await f.updater.downloadUpdate()
    expect(file).toBe(join(directory, '1.1.0', 'mo-1.1.0.exe'))
    expect(await readFile(file!)).toEqual(content)
    expect(f.fetch.mock.calls[0]?.[0]).toBe(exe.url)
    expect(f.fetch.mock.calls[0]?.[1]).toMatchObject({ cache: 'no-store', redirect: 'error' })
    expect(f.fetch.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
    expect(f.progress.at(-1)).toBe(100)
    expect(f.progress.slice(0, -1).every((percent, index, all) => percent < 100 && (index === 0 || percent > all[index - 1]!))).toBe(true)
    expect(f.downloaded).toEqual(['1.1.0'])
    await f.updater.checkForUpdates()
    await f.updater.downloadUpdate()
    expect(f.fetch).toHaveBeenCalledTimes(1)
    expect(f.downloaded).toEqual(['1.1.0', '1.1.0'])
  })

  it('downloads again when the offered installer changes or the file disappears, and removes other versions', async () => {
    const f = fixture()
    await mkdir(join(directory, '0.9.0'), { recursive: true })
    await writeFile(join(directory, '0.9.0', 'old.exe'), 'old')
    await f.updater.checkForUpdates()
    const [file] = await f.updater.downloadUpdate()
    expect(await readdir(directory)).toEqual(['1.1.0'])
    await rm(file!)
    await f.updater.downloadUpdate()
    expect(f.fetch).toHaveBeenCalledTimes(2)
    const other = Buffer.from('another build')
    f.fetch.mockResolvedValueOnce(chunked(other))
    f.offer({ version: '1.1.0', page: 'https://hub.example.com/download',
      packages: [{ ...exe, sha256: createHash('sha256').update(other).digest('hex'), size: other.length }] })
    await f.updater.checkForUpdates()
    expect(await readFile((await f.updater.downloadUpdate())[0]!)).toEqual(other)
    expect(f.fetch).toHaveBeenCalledTimes(3)
  })

  it('rejects an HTTP failure, a size or checksum mismatch, and an oversized body without keeping a partial file', async () => {
    const f = fixture()
    await f.updater.checkForUpdates()
    f.fetch.mockResolvedValueOnce(new Response('missing', { status: 404 }))
    await expect(f.updater.downloadUpdate()).rejects.toThrow('download failed with HTTP 404')
    f.fetch.mockResolvedValueOnce(chunked(content.subarray(1)))
    await expect(f.updater.downloadUpdate()).rejects.toThrow('size does not match')
    const tampered = Buffer.from(content)
    tampered[0] = 0
    f.fetch.mockResolvedValueOnce(chunked(tampered))
    await expect(f.updater.downloadUpdate()).rejects.toThrow('checksum does not match')
    f.fetch.mockResolvedValueOnce(chunked(Buffer.concat([content, content])))
    await expect(f.updater.downloadUpdate()).rejects.toThrow('larger than announced')
    expect(await readdir(join(directory, '1.1.0'))).toEqual([])
    expect(f.downloaded).toEqual([])
    expect(() => { f.updater.quitAndInstall() }).toThrow('no verified installer')
  })

  it('fails a transfer that stops receiving bytes, so it can be retried', async () => {
    const f = fixture({ idleTimeoutMs: 20 })
    f.fetch.mockImplementationOnce((_url, init) => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(content.subarray(0, 100)))
        init?.signal?.addEventListener('abort', () => { controller.error(init.signal?.reason) })
      },
    }))))
    await f.updater.checkForUpdates()
    await expect(f.updater.downloadUpdate()).rejects.toThrow('download stalled')
    expect(await readdir(join(directory, '1.1.0'))).toEqual([])
    await f.updater.downloadUpdate()
    expect(f.downloaded).toEqual(['1.1.0'])
  })

  it('waits for the startup cleanup before writing a download', async () => {
    const f = fixture()
    await mkdir(join(directory, 'stale'), { recursive: true })
    const cleared = f.updater.clear()
    await f.updater.checkForUpdates()
    await f.updater.downloadUpdate()
    await cleared
    expect(await readdir(directory)).toEqual(['1.1.0'])
  })

  it('fails the download when preparation fails and prepares again on retry', async () => {
    const f = fixture()
    await f.updater.checkForUpdates()
    f.prepare.mockRejectedValueOnce(new Error('archive contains a different application'))
    await expect(f.updater.downloadUpdate()).rejects.toThrow('different application')
    expect(f.updater.installer).toBeUndefined()
    expect(f.downloaded).toEqual([])
    await f.updater.downloadUpdate()
    expect(f.fetch).toHaveBeenCalledOnce()
    expect(f.prepare).toHaveBeenCalledTimes(2)
    expect(f.updater.installer).toBeDefined()
    f.offer(undefined)
    await f.updater.checkForUpdates()
    expect(f.updater.installer).toBeUndefined()
  })

  it('requires a checked update before downloading', async () => {
    await expect(fixture().updater.downloadUpdate()).rejects.toThrow('no checked update')
  })

  it('hands the verified installer to the platform and reports a failed start as an updater error', async () => {
    const f = fixture()
    await f.updater.checkForUpdates()
    const [file] = await f.updater.downloadUpdate()
    expect(f.prepare).toHaveBeenCalledWith(file, '1.1.0')
    expect(f.updater.installer).toBe(`${file!}.prepared`)
    f.updater.quitAndInstall()
    expect(f.install).toHaveBeenCalledWith(`${file!}.prepared`)
    const errors: Error[] = []
    f.updater.on('error', (error: Error) => { errors.push(error) })
    f.install.mockRejectedValueOnce(new Error('spawn failed')).mockRejectedValueOnce('denied')
    f.updater.quitAndInstall()
    f.updater.quitAndInstall()
    await vi.waitFor(() => { expect(errors.map(error => error.message)).toEqual(['spawn failed', 'denied']) })
  })

  it('clears retained downloads', async () => {
    const f = fixture()
    await f.updater.checkForUpdates()
    await f.updater.downloadUpdate()
    await f.updater.clear()
    expect(await readdir(directory).catch(() => 'gone')).toBe('gone')
    expect(() => { f.updater.quitAndInstall() }).toThrow('no verified installer')
  })
})

describe('windows installer', () => {
  function child() { return Object.assign(new EventEmitter(), { unref: vi.fn() }) }

  it('starts the installer detached in update mode, then quits', async () => {
    const process = child()
    const spawn = vi.fn(() => process)
    const quit = vi.fn()
    const started = windowsInstaller(quit, spawn as never)('C:\\updates\\mo.exe')
    expect(spawn).toHaveBeenCalledWith('C:\\updates\\mo.exe', ['--updated'], { detached: true, stdio: 'ignore' })
    expect(quit).not.toHaveBeenCalled()
    process.emit('spawn')
    await started
    expect(process.unref).toHaveBeenCalled()
    expect(quit).toHaveBeenCalledOnce()
  })

  it('rejects without quitting when the installer cannot start', async () => {
    const process = child()
    const quit = vi.fn()
    const started = windowsInstaller(quit, vi.fn(() => process) as never)('C:\\updates\\mo.exe')
    process.emit('error', new Error('ENOENT'))
    await expect(started).rejects.toThrow('ENOENT')
    expect(quit).not.toHaveBeenCalled()
  })
})
