/** Writing pulled logs and attachments, against small stand-ins for Session storage and the attachment store. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { SessionAlreadyOwnedError, SessionPersistenceNotFoundError, type SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { SESSION_FORMAT_VERSION, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { BundleAttachment } from '../src/bundle.ts'
import { decodeBundle, hasAttachment, isLocalAbsolutePath, removeLogs, storeAttachment, writeLogs } from '../src/pull.ts'
import type { SessionSyncLog } from '../src/types.ts'

const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const event = (seq: number) => ({ type: 'turn/start', seq: SessionSeq(seq), time: seq, data: { turn: seq } }) as never as SessionEvent
const log = (id: string, count: number): SessionSyncLog => ({
  header: { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 1, isSeeded: false }, inheritedEventCount: 0,
  events: Array.from({ length: count }, (_, index) => event(index)),
})

/** In-memory Session storage with handles that can be held open. */
function memoryPersistence(stored: Record<string, SessionEvent[]> = {}, options: { openError?: Error; deleteError?: Error } = {}) {
  const calls: string[] = []
  const handle = (id: string) => ({
    read: async () => ({ events: stored[id] ?? [] }),
    append: async (events: readonly SessionEvent[]) => { calls.push(`append ${id} ${String(events.length)}`); stored[id] = [...stored[id] ?? [], ...events] },
    flush: async () => { calls.push(`flush ${id}`) },
    close: async () => undefined,
  })
  const persistence = {
    stat: async (id: string) => (id in stored ? {} : undefined),
    open: async (id: string) => {
      if (options.openError !== undefined) throw options.openError
      return handle(id)
    },
    create: async (header: { id: string }) => { calls.push(`create ${header.id}`); stored[header.id] = []; return handle(header.id) },
    delete: async (id: string) => {
      if (options.deleteError !== undefined) throw options.deleteError
      calls.push(`delete ${id}`)
      Reflect.deleteProperty(stored, id)
    },
  } as never as SessionPersistence
  return { persistence, stored, calls }
}

describe('writeLogs', () => {
  it('creates new logs, appends to logs it continues, and leaves equal ones', async () => {
    const { persistence, calls } = memoryPersistence({ same: [event(0)], shorter: [event(0)] })
    expect(await writeLogs(persistence, [log('new', 2), log('empty', 0), log('same', 1), log('shorter', 3)], async () => undefined)).toBe('written')
    expect(calls).toEqual(['create new', 'append new 2', 'create empty', 'flush empty', 'append shorter 2'])
  })

  it('replaces a log it does not continue', async () => {
    const { persistence, calls } = memoryPersistence({ other: [event(5)] })
    const removed: string[] = []
    await writeLogs(persistence, [log('other', 1)], async (id) => { removed.push(id); await persistence.delete(id) })
    expect(removed).toEqual(['other'])
    expect(calls).toEqual(['delete other', 'create other', 'append other 1'])
  })

  it('reports a log open for writing as busy, and passes on other failures', async () => {
    const busy = memoryPersistence({ open: [] }, { openError: new SessionAlreadyOwnedError(SessionId('open')) })
    expect(await writeLogs(busy.persistence, [log('open', 1)], async () => undefined)).toBe('busy')
    const broken = memoryPersistence({ open: [] }, { openError: new Error('disk') })
    await expect(writeLogs(broken.persistence, [log('open', 1)], async () => undefined)).rejects.toThrow('disk')
  })
})

describe('removeLogs', () => {
  it('skips logs already gone, reports open ones as busy, and passes on other failures', async () => {
    expect(await removeLogs(memoryPersistence({ a: [] }).persistence, [SessionId('a')])).toBe('removed')
    const gone = memoryPersistence({}, { deleteError: new SessionPersistenceNotFoundError(SessionId('a')) })
    expect(await removeLogs(gone.persistence, [SessionId('a')])).toBe('removed')
    const open = memoryPersistence({}, { deleteError: new SessionAlreadyOwnedError(SessionId('a')) })
    expect(await removeLogs(open.persistence, [SessionId('a')])).toBe('busy')
    const broken = memoryPersistence({}, { deleteError: new Error('disk') })
    await expect(removeLogs(broken.persistence, [SessionId('a')])).rejects.toThrow('disk')
  })
})

describe('attachments', () => {
  const bytes = new TextEncoder().encode('图')
  const image: BundleAttachment = { kind: 'image', sha256: sha(bytes), ref: { attachmentId: `sha256:${sha(bytes)}`, mediaType: 'image/png', bytes: 3, width: 1, height: 1 } as never }
  const file: BundleAttachment = { kind: 'file', sha256: sha(bytes), ref: { attachmentId: `sha256:${sha(bytes)}`, name: '表.csv', bytes: 3 } as never }

  async function store(hostFiles = true) {
    const root = await mkdtemp(join(tmpdir(), 'dsh-session-sync-pull-'))
    dirs.push(root)
    const saved: string[] = []
    return {
      root, saved,
      store: {
        imageHostPath: () => (hostFiles ? join(root, 'image') : undefined),
        fileHostPath: () => (hostFiles ? join(root, 'file') : undefined),
        saveFile: async (input: { name: string }) => { saved.push(`file ${input.name}`); return file.ref },
        saveStoredImage: async (ref: { name?: string }) => { saved.push('image'); await writeFile(join(root, 'image'), bytes); return ref },
      } as never as AttachmentStore,
    }
  }

  it('stores an image as it is and a file through the store, and finds the image afterwards', async () => {
    const { store: target, root, saved } = await store()
    expect(await hasAttachment(target, image)).toBe(false)
    expect(await storeAttachment(target, image, bytes)).toBe(true)
    expect(await readFile(join(root, 'image'), 'utf8')).toBe('图')
    expect(await hasAttachment(target, image)).toBe(true)
    expect(await storeAttachment(target, file, bytes)).toBe(true)
    expect(saved).toEqual(['image', 'file 表.csv'])
  })

  it('refuses bytes that do not match, and holds nothing where the store keeps no host files', async () => {
    const { store: target, saved } = await store(false)
    expect(await storeAttachment(target, image, new TextEncoder().encode('别的'))).toBe(false)
    expect(saved).toEqual([])
    expect(await hasAttachment(target, image)).toBe(false)
  })
})

describe('decodeBundle', () => {
  it('reads a bundle and refuses anything else', async () => {
    const bundle = { format: 1, sessions: [log('a', 1)] }
    expect(await decodeBundle(gzipSync(JSON.stringify(bundle)))).toEqual(JSON.parse(JSON.stringify(bundle)))
    await expect(decodeBundle(gzipSync(JSON.stringify({ format: 2, sessions: [] })))).rejects.toThrow()
  })
})

describe('isLocalAbsolutePath', () => {
  it('accepts only the given system\'s own absolute form', () => {
    expect(isLocalAbsolutePath('/Users/frank/project', 'darwin')).toBe(true)
    expect(isLocalAbsolutePath('C:\\Users\\frank\\project', 'darwin')).toBe(false)
    expect(isLocalAbsolutePath('C:\\Users\\frank\\project', 'win32')).toBe(true)
    expect(isLocalAbsolutePath('d:/work', 'win32')).toBe(true)
    expect(isLocalAbsolutePath('\\\\server\\share\\work', 'win32')).toBe(true)
    expect(isLocalAbsolutePath('/Users/frank/project', 'win32')).toBe(false)
  })
})
