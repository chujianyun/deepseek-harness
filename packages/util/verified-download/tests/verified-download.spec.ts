/** Verified downloads against a loopback server that can fail, drop, tamper with, or hold a response. */
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bytesOnDisk, DownloadError, downloadFile, sha256File } from '@deepseek-ai/dsh-verified-download'

const BODY = Buffer.from('0123456789'.repeat(1000))
const DIGEST = createHash('sha256').update(BODY).digest('hex')

interface Mirror {
  readonly origin: string
  readonly requests: { path: string; range: string | undefined }[]
  /** Status to answer a path with instead of the file. */
  fail?: (path: string) => number | undefined
  /** Bytes to serve in place of the file. */
  replace?: Buffer
  /** Ignore Range and send the whole file with 200. */
  ignoreRange?: boolean
  /** Send this many bytes, then destroy the connection. */
  dropAfter?: number
  close(): Promise<void>
}

async function startMirror(): Promise<Mirror> {
  const requests: Mirror['requests'] = []
  const mirror: Mirror = {
    origin: '',
    requests,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => { resolve() }) }),
  }
  const server = createServer((req, res) => {
    const range = req.headers.range
    requests.push({ path: req.url!, range })
    const status = mirror.fail?.(req.url!)
    if (status !== undefined) { res.writeHead(status).end(); return }
    const body = mirror.replace ?? BODY
    if (mirror.dropAfter !== undefined) {
      res.writeHead(200, { 'content-length': String(body.length) })
      res.write(body.subarray(0, mirror.dropAfter), () => { res.destroy() })
      return
    }
    const offset = range !== undefined && mirror.ignoreRange !== true ? Number(/bytes=(\d+)-/u.exec(range)![1]) : 0
    res.writeHead(offset > 0 ? 206 : 200).end(body.subarray(offset))
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  return Object.assign(mirror, { origin: `http://127.0.0.1:${String(typeof address === 'object' && address !== null ? address.port : 0)}` })
}

let dir: string
let mirror: Mirror

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-verified-download-'))
  mirror = await startMirror()
})

afterEach(async () => {
  await mirror.close()
  await rm(dir, { recursive: true, force: true })
})

function target(urls: string[], dest = join(dir, 'nested', 'file.bin')) {
  return { urls, dest, size: BODY.length, sha256: DIGEST }
}

describe('downloadFile', () => {
  it('downloads, verifies, and renames the file into place, reporting every byte', async () => {
    let bytes = 0
    await downloadFile(target([`${mirror.origin}/a`]), (n) => { bytes += n }, new AbortController().signal)
    expect(await readFile(join(dir, 'nested', 'file.bin'))).toEqual(BODY)
    expect(bytes).toBe(BODY.length)
    expect(await stat(join(dir, 'nested', 'file.bin.part')).catch(() => undefined)).toBeUndefined()
  })

  it('tries the next mirror after an HTTP error or an unreachable one', async () => {
    mirror.fail = path => path === '/first' ? 503 : undefined
    await downloadFile(target(['http://127.0.0.1:9/x', `${mirror.origin}/first`, `${mirror.origin}/second`]), () => {}, new AbortController().signal)
    expect(mirror.requests.map(request => request.path)).toEqual(['/first', '/second'])
  })

  it('resumes a partial file with a Range request', async () => {
    const dest = join(dir, 'file.bin')
    await writeFile(`${dest}.part`, BODY.subarray(0, 4000))
    expect(await bytesOnDisk(dest)).toBe(4000)
    let bytes = 0
    await downloadFile(target([`${mirror.origin}/a`], dest), (n) => { bytes += n }, new AbortController().signal)
    expect(mirror.requests).toEqual([{ path: '/a', range: 'bytes=4000-' }])
    expect(bytes).toBe(BODY.length - 4000)
    expect(await bytesOnDisk(dest)).toBe(BODY.length)
  })

  it('starts over when the mirror ignores Range, uncounting the partial bytes', async () => {
    const dest = join(dir, 'file.bin')
    await writeFile(`${dest}.part`, BODY.subarray(0, 4000))
    mirror.ignoreRange = true
    let bytes = 0
    await downloadFile(target([`${mirror.origin}/a`], dest), (n) => { bytes += n }, new AbortController().signal)
    expect(bytes).toBe(BODY.length - 4000)
    expect(await sha256File(dest)).toBe(DIGEST)
  })

  it('reports network when the only mirror drops the connection midway', async () => {
    mirror.dropAfter = 100
    const dest = join(dir, 'file.bin')
    const error = await downloadFile(target([`${mirror.origin}/a`], dest), () => {}, new AbortController().signal).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DownloadError)
    expect((error as DownloadError).code).toBe('network')
    expect(await bytesOnDisk(dest)).toBeLessThan(BODY.length)
  })

  it('reports verification when the only mirror serves the wrong bytes, and drops them', async () => {
    mirror.replace = Buffer.alloc(BODY.length, 1)
    const dest = join(dir, 'file.bin')
    const error = await downloadFile(target([`${mirror.origin}/a`], dest), () => {}, new AbortController().signal).catch((e: unknown) => e)
    expect((error as DownloadError).code).toBe('verification')
    expect(await bytesOnDisk(dest)).toBe(0)
  })

  it('reports network when no mirror is configured', async () => {
    const error = await downloadFile(target([]), () => {}, new AbortController().signal).catch((e: unknown) => e)
    expect(error).toEqual(new DownloadError('network', 'no mirror configured'))
  })

  it('reports storage when the destination cannot be created or written', async () => {
    await writeFile(join(dir, 'blocker'), '')
    const created = await downloadFile(target([`${mirror.origin}/a`], join(dir, 'blocker', 'x', 'file.bin')), () => {}, new AbortController().signal)
      .catch((e: unknown) => e)
    expect((created as DownloadError).code).toBe('storage')
    // The partial path is a directory, so the bytes cannot be written.
    const dest = join(dir, 'file.bin')
    await import('node:fs/promises').then(fs => fs.mkdir(`${dest}.part`))
    const written = await downloadFile(target([`${mirror.origin}/a`], dest), () => {}, new AbortController().signal).catch((e: unknown) => e)
    expect((written as DownloadError).code).toBe('storage')
  })

  it('stops with the abort reason, before and during a transfer', async () => {
    const before = new AbortController()
    before.abort('stop')
    await expect(downloadFile(target([`${mirror.origin}/a`]), () => {}, before.signal)).rejects.toBe('stop')
    const during = new AbortController()
    await expect(downloadFile(target([`${mirror.origin}/a`]), () => { during.abort('paused') }, during.signal)).rejects.toBe('paused')
  })

  it('stops with the abort reason when aborted while connecting', async () => {
    const controller = new AbortController()
    // A listener that accepts the connection and never answers keeps fetch waiting.
    const silent = createServer(() => {})
    await new Promise<void>((resolve) => { silent.listen(0, '127.0.0.1', resolve) })
    const address = silent.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    setTimeout(() => { controller.abort('cancelled') }, 50)
    await expect(downloadFile(target([`http://127.0.0.1:${String(port)}/a`]), () => {}, controller.signal)).rejects.toBe('cancelled')
    silent.closeAllConnections()
    silent.close()
  })
})
