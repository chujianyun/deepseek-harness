/**
 * Resumable, verified file download over an ordered mirror list: bytes land in `<dest>.part`,
 * a later attempt continues from its length with an HTTP Range request, and the finished file
 * is renamed into place only when its size and sha256 match.
 */
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'

/** The file to fetch and what it must be. */
export interface DownloadTarget {
  /** Candidate URLs, tried in order until one serves the file. */
  readonly urls: readonly string[]
  /** Final path. */
  readonly dest: string
  readonly size: number
  /** Expected sha256, lowercase hex. */
  readonly sha256: string
}

/** Why a download stopped. */
export class DownloadError extends Error {
  /**
   * @param code - `network`: no mirror served the bytes; `verification`: the finished bytes are not the expected file;
   *   `storage`: the file could not be written.
   * @param message - detail for logs.
   */
  constructor(readonly code: 'network' | 'verification' | 'storage', message: string) { super(message) }
}

/**
 * Bytes already on disk for a target: the finished file's size, else the partial file's.
 * @param dest - final path.
 * @returns byte count, 0 when nothing is there.
 */
export async function bytesOnDisk(dest: string): Promise<number> {
  const done = await stat(dest).catch(() => undefined)
  if (done !== undefined) return done.size
  return (await stat(`${dest}.part`).catch(() => undefined))?.size ?? 0
}

/**
 * sha256 of a file.
 * @param path - file to hash.
 * @returns lowercase hex digest.
 */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

/**
 * Download one file, resuming a partial one, and verify it; a mirror whose bytes fail verification is skipped like an unreachable one.
 * @param target - URLs, destination, size, and digest.
 * @param onBytes - called with each chunk's length as it is written, and with minus the partial length when a mirror restarts the file.
 * @param signal - stops the transfer; the partial file is kept for the next attempt.
 * @throws DownloadError `verification` when a mirror served bytes that failed verification and none served the file,
 *   `network` when no mirror served it at all, `storage` when it cannot be written; the abort reason when aborted.
 */
export async function downloadFile(target: DownloadTarget, onBytes: (bytes: number) => void, signal: AbortSignal): Promise<void> {
  const part = `${target.dest}.part`
  await mkdir(dirname(target.dest), { recursive: true }).catch((error: unknown) => { throw new DownloadError('storage', String(error)) })
  let lastError = 'no mirror configured'
  let failure: 'network' | 'verification' = 'network'
  for (const url of target.urls) {
    signal.throwIfAborted()
    const offset = (await stat(part).catch(() => undefined))?.size ?? 0
    if (offset < target.size) {
      let res: Response
      try {
        res = await fetch(url, { signal, ...offset > 0 ? { headers: { range: `bytes=${String(offset)}-` } } : {} })
      } catch (error) {
        if (signal.aborted) throw signal.reason
        lastError = `${url}: ${String(error)}`
        continue
      }
      if (!res.ok || res.body === null) {
        await res.body?.cancel()
        lastError = `${url}: HTTP ${String(res.status)}`
        continue
      }
      // A server that ignores Range sends the whole file: start over, uncounting the partial bytes.
      const resumed = res.status === 206
      if (!resumed && offset > 0) onBytes(-offset)
      const counter = new Transform({ transform(chunk: Buffer, _encoding, done) { onBytes(chunk.length); done(null, chunk) } })
      const source = Readable.fromWeb(res.body as WebReadableStream<Uint8Array>)
      const out = createWriteStream(part, { flags: resumed ? 'a' : 'w' })
      // The first stream to fail is the cause; the pipeline then destroys the other with the same error.
      let failedFirst: 'source' | 'disk' | undefined
      source.once('error', () => { failedFirst ??= 'source' })
      out.once('error', () => { failedFirst ??= 'disk' })
      try {
        await pipeline(source, counter, out, { signal })
      } catch (error) {
        if (signal.aborted) throw signal.reason
        // A disk that refuses the bytes is no reason to try another mirror.
        if (failedFirst === 'disk') throw new DownloadError('storage', `${target.dest}: ${String(error)}`)
        lastError = `${url}: ${String(error)}`
        continue
      }
    }
    if ((await stat(part)).size !== target.size || await sha256File(part) !== target.sha256) {
      await rm(part, { force: true })
      failure = 'verification'
      lastError = `${url}: size or sha256 mismatch`
      continue
    }
    await rename(part, target.dest)
    return
  }
  throw new DownloadError(failure, lastError)
}
