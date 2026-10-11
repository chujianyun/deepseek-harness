/**
 * The Sessions this machine shared, kept in `<dshHome>/session-shares.json`: for each Session, the
 * tenant it was shared under and the share's id. The user center holds the shares themselves; the
 * record lets a deleted Session's share be withdrawn only when one exists, and as the right tenant.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** One Session's share as this machine recorded it. */
export interface ShareRecord {
  /** Tenant of the sign-in that shared it. */
  readonly tenantId: string
  readonly shareId: string
}

const recordFile = z.object({
  version: z.literal(1),
  shares: z.record(z.string(), z.object({ tenantId: z.string(), shareId: z.string() })),
})

/** Reads and writes of the record file, one at a time. */
export class ShareRecords {
  private queue: Promise<unknown> = Promise.resolve()

  /** @param path - the record file. */
  constructor(private readonly path: string) {}

  /**
   * Read one Session's record.
   * @param sessionId - the Session.
   * @returns its record, or undefined when this machine did not record a share.
   */
  get(sessionId: SessionId): Promise<ShareRecord | undefined> {
    return this.serial(async () => (await this.read())[sessionId])
  }

  /**
   * Record a Session's share, or forget it.
   * @param sessionId - the Session.
   * @param record - its share, or undefined to forget it.
   */
  set(sessionId: SessionId, record: ShareRecord | undefined): Promise<void> {
    return this.serial(async () => {
      const shares = await this.read()
      const next = Object.fromEntries(Object.entries(shares).filter(([id]) => id !== sessionId))
      if (record !== undefined) next[sessionId] = record
      await mkdir(dirname(this.path), { recursive: true })
      const temporary = `${this.path}.${String(process.pid)}.tmp`
      await writeFile(temporary, `${JSON.stringify({ version: 1, shares: next }, null, 2)}\n`)
      await rename(temporary, this.path)
    })
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const result = this.queue.then(run)
    this.queue = result.catch(() => undefined)
    return result
  }

  private async read(): Promise<Record<string, ShareRecord>> {
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    }
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      // A damaged file records nothing; the next write replaces it.
      raw = undefined
    }
    const parsed = recordFile.safeParse(raw)
    if (!parsed.success) {
      console.info('[session-share] unreadable share record file ignored', { path: this.path })
      return {}
    }
    return parsed.data.shares
  }
}
