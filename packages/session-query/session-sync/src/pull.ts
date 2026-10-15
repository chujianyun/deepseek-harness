/**
 * Writing a conversation pulled from another machine into this machine's Session storage, and
 * removing it again. The stored logs are the other machine's logs, unchanged: a newer revision of
 * the same conversation appends to them, and one that does not continue them replaces them.
 */
import { stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import { gunzip } from 'node:zlib'
import { createHash } from 'node:crypto'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { SessionAlreadyOwnedError, SessionPersistenceNotFoundError, type SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { z } from 'zod'
import type { BundleAttachment } from './bundle.ts'
import type { SessionSyncBundle, SessionSyncLog } from './types.ts'

const decompress = promisify(gunzip)

const bundleSchema = z.object({
  format: z.literal(1),
  sessions: z.array(z.object({
    header: z.object({ id: z.string().min(1) }).loose(),
    inheritedEventCount: z.number().int().nonnegative(),
    events: z.array(z.object({ seq: z.number().int().nonnegative() }).loose()),
  })).min(1),
  assistants: z.array(z.object({ id: z.string(), name: z.string(), templateId: z.string().nullable() })).optional(),
})

/**
 * Read a downloaded bundle. Its logs are checked again by Session storage when they are written.
 * @param bytes - the gzip-compressed bundle.
 * @returns the bundle.
 * @throws when it is not a bundle of this format.
 */
export async function decodeBundle(bytes: Uint8Array): Promise<SessionSyncBundle> {
  const parsed = bundleSchema.parse(JSON.parse((await decompress(bytes)).toString('utf8')))
  // The storage backend validates every header and event before it writes them.
  return parsed as never
}

/**
 * Whether a path is absolute in the given operating system's own form: a drive or share on
 * Windows, a root slash elsewhere. A path recorded on another system does not count.
 * @param path - a path recorded on some computer.
 * @param platform - this computer's `process.platform`.
 * @returns true when the path names a location on this kind of system.
 */
export function isLocalAbsolutePath(path: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? /^(?:[A-Za-z]:[\\/]|\\\\)/u.test(path) : path.startsWith('/')
}

/** Whether the file exists. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    // Missing, or unreadable: either way it is fetched again.
    return false
  }
}

/**
 * Whether this machine's attachment store already holds an attachment.
 * @param store - the attachment store.
 * @param attachment - the attachment.
 * @returns true when its stored object exists.
 */
export async function hasAttachment(store: AttachmentStore, attachment: BundleAttachment): Promise<boolean> {
  const path = attachment.kind === 'image' ? store.imageHostPath(attachment.ref) : store.fileHostPath(attachment.ref)
  return path !== undefined && exists(path)
}

/**
 * Store a downloaded attachment through the attachment store, under the digest its id names. A
 * normalized image is stored as it is: normalizing it again could change its bytes and digest.
 * @param store - the attachment store.
 * @param attachment - the attachment.
 * @param bytes - its bytes.
 * @returns false when the bytes do not match the digest.
 * @throws when the store refuses the bytes.
 */
export async function storeAttachment(store: AttachmentStore, attachment: BundleAttachment, bytes: Uint8Array): Promise<boolean> {
  if (createHash('sha256').update(bytes).digest('hex') !== attachment.sha256) return false
  if (attachment.kind === 'file') await store.saveFile({ data: bytes, name: attachment.ref.name })
  else await store.saveStoredImage(attachment.ref, bytes)
  return true
}

/**
 * Write a pulled bundle's logs into Session storage: a log not stored yet is created; a stored log
 * the new one continues gets the new events appended; any other stored log is replaced.
 * @param persistence - Session storage.
 * @param logs - the bundle's logs.
 * @param remove - deletes one stored Session that is being replaced.
 * @returns `busy` when a stored log is open for writing here (its conversation is open), `written` otherwise.
 */
export async function writeLogs(
  persistence: SessionPersistence, logs: readonly SessionSyncLog[], remove: (sessionId: SessionId) => Promise<void>,
): Promise<'written' | 'busy'> {
  for (const log of logs) {
    const id = log.header.id
    if (await persistence.stat(id) !== undefined) {
      let handle
      try {
        handle = await persistence.open(id, 'write')
      } catch (error) {
        if (error instanceof SessionAlreadyOwnedError) return 'busy'
        throw error
      }
      try {
        const { events } = await handle.read()
        const continued = events.length <= log.events.length
          && JSON.stringify(events) === JSON.stringify(log.events.slice(0, events.length))
        if (continued) {
          if (log.events.length > events.length) await handle.append(log.events.slice(events.length))
          continue
        }
      } finally {
        await handle.close()
      }
      await remove(id)
    }
    const handle = await persistence.create(log.header, { inheritedEventCount: log.inheritedEventCount as never })
    try {
      if (log.events.length > 0) await handle.append(log.events)
      else await handle.flush()
    } finally {
      await handle.close()
    }
  }
  return 'written'
}

/**
 * Delete a conversation's stored Sessions, subagent Sessions before the top-level one, skipping
 * those already gone. One open for writing here stops the deletion, so the top-level Session stays
 * while any part of it does and a later attempt finds it.
 * @param persistence - Session storage.
 * @param ids - the Sessions, the top-level Session first.
 * @returns `busy` when one is open for writing here, `removed` once all are gone.
 */
export async function removeLogs(persistence: SessionPersistence, ids: readonly SessionId[]): Promise<'removed' | 'busy'> {
  for (const id of [...ids].reverse()) {
    try {
      await persistence.delete(id)
    } catch (error) {
      if (error instanceof SessionAlreadyOwnedError) return 'busy'
      if (!(error instanceof SessionPersistenceNotFoundError)) throw error
    }
  }
  return 'removed'
}
