/**
 * Shared parts of the services that sync the signed-in employee's data with the user center over
 * this sign-in (Session sync, knowledge base sync): the account a sign-in syncs as, the record file
 * of what was synced, one pass at a time on a timer, and user-center calls whose refusals stop a
 * pass for a retry or stop syncing for the sign-in.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname } from 'node:path'
import type { z } from 'zod'
import type { TenantSource } from './follow.ts'
import type { HubAccountView } from './types.ts'

/**
 * The account a sign-in syncs as: its tenant and phone number, which name one employee.
 * @param state - the Hub sign-in.
 * @returns `<tenantId>/<phone>`, or null while signed out or signed in without a tenant.
 */
export function syncAccountOf(state: HubAccountView): string | null {
  const profile = state.profile
  return state.status === 'signed-in' && profile?.tenantId != null ? `${profile.tenantId}/${profile.phone}` : null
}

/** Longest computer name the user center keeps (new-dsh-ms `SYNC_DEVICE_MAX_LENGTH`). */
const DEVICE_MAX = 100

/**
 * The name of this computer as the employee's other computers show it.
 * @param configured - the configured name, if any.
 * @param owner - the syncing service's name for the error.
 * @returns the configured name, or else the host name without `.local`, trimmed and cut to the user center's limit.
 * @throws when the name is empty.
 */
export function syncDeviceName(configured: string | undefined, owner: string): string {
  const device = (configured ?? hostname().replace(/\.local$/u, '')).trim().slice(0, DEVICE_MAX)
  if (device === '') throw new Error(`${owner}: the device name is empty; set deviceName`)
  return device
}

/** Follow the account the sign-in syncs as: now, then whenever it changes, for as long as the signal lives. */
async function followSyncAccount(
  hub: TenantSource, signal: AbortSignal, current: () => string | null, follow: (account: string | null) => void,
): Promise<void> {
  follow(syncAccountOf(await hub.getState()))
  void (async () => {
    for await (const state of hub.watch(signal)) {
      if (syncAccountOf(state) !== current()) follow(syncAccountOf(state))
    }
  })()
}

/** The user center could not take a request now, or the sign-in changed; the pass stops and is retried later. */
export class SyncRetryLater extends Error {}

/** The sign-in may not sync (not a company member); syncing stops until the sign-in changes. */
export class SyncNotAllowed extends Error {}

/**
 * Throw for a refused user-center answer.
 * @param res - the answer.
 * @returns never; it always throws.
 * @throws SyncNotAllowed for 403, SyncRetryLater for anything else.
 */
export function refuseSync(res: Response): never {
  if (res.status === 403) throw new SyncNotAllowed(`the user center answered ${String(res.status)}`)
  throw new SyncRetryLater(`the user center answered ${String(res.status)}`)
}

/** One user-center call under a deadline; an unreachable user center (signed out, offline, or past the deadline) reads as retry later. */
async function callUserCenter(
  request: (path: string, init: RequestInit) => Promise<Response>, path: string, init: RequestInit, signal: AbortSignal, timeoutMs: number,
): Promise<Response> {
  try {
    return await request(path, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) })
  } catch (error: unknown) {
    throw new SyncRetryLater(`the user center cannot be reached: ${String(error)}`, { cause: error })
  }
}

/** What a sync reads the sign-in from and calls the user center through: the hub account service. */
export interface SyncHub extends TenantSource {
  request(path: string, init?: RequestInit): Promise<Response>
}

/** The account a sync runs as, following the sign-in, and its user-center calls as that account. */
export class SyncSignIn {
  /** The account of the current sign-in, or null while there is none to sync as. */
  account: string | null = null

  /**
   * @param hub - the hub account service.
   * @param signal - the syncing service's lifetime.
   * @param timeoutMs - the deadline of each user-center request.
   */
  constructor(private readonly hub: SyncHub, private readonly signal: AbortSignal, private readonly timeoutMs: number) {}

  /**
   * Follow the account the sign-in syncs as: now, then whenever it changes.
   * @param changed - told after each switch, with the new account or none.
   * @returns once the current account is followed; later changes follow in the background.
   */
  follow(changed: (account: string | null) => void): Promise<void> {
    return followSyncAccount(this.hub, this.signal, () => this.account, (account) => {
      this.account = account
      changed(account)
    })
  }

  /**
   * One user-center call as `account`.
   * @param path - the user-center path.
   * @param init - the request.
   * @param account - the account the pass runs as.
   * @returns the answer, whatever its status.
   * @throws SyncRetryLater when the sign-in changed or the user center cannot be reached.
   */
  call(path: string, init: RequestInit, account: string): Promise<Response> {
    if (this.account !== account) throw new SyncRetryLater('the sign-in changed')
    return callUserCenter((target, options) => this.hub.request(target, options), path, init, this.signal, this.timeoutMs)
  }
}

/**
 * A record with one entry set, or removed.
 * @param record - the record.
 * @param key - the entry's key.
 * @param value - its new value, or undefined to remove it.
 * @returns a new record.
 */
export function withEntry<T>(record: Readonly<Record<string, T>>, key: string, value: T | undefined): Record<string, T> {
  const { [key]: _previous, ...rest } = record
  return value === undefined ? rest : { ...rest, [key]: value }
}

/**
 * A JSON record file read once and rewritten after each change, through a temporary file; a change
 * that cannot be written is not applied, and later changes still run.
 */
export class SyncRecordFile<T> {
  private value: T
  private writes: Promise<void> = Promise.resolve()

  /**
   * @param path - the file.
   * @param schema - what the file holds.
   * @param empty - the record of a missing, unreadable, or damaged file.
   */
  constructor(private readonly path: string, private readonly schema: z.ZodType<T>, empty: T) {
    this.value = empty
  }

  /** The record as last written. */
  get data(): T {
    return this.value
  }

  /**
   * Read the file; a missing, unreadable, or damaged one reads as empty and is replaced on the next write.
   * @param warn - told about a damaged file.
   * @param owner - the syncing service's name for the warning.
   */
  async load(warn: (message: string) => void, owner: string): Promise<void> {
    // Missing on first start.
    const text = await readFile(this.path, 'utf8').catch(() => undefined)
    if (text === undefined) return
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      // Damaged JSON records nothing; the schema check below reports it.
      raw = undefined
    }
    const parsed = this.schema.safeParse(raw)
    if (parsed.success) this.value = parsed.data
    else warn(`${owner}: unreadable sync record ${this.path} ignored`)
  }

  /**
   * Apply one change after the earlier ones; the record reads it only once it is written.
   * @param change - the next record from the current one; returning it unchanged writes nothing.
   * @returns once written.
   */
  write(change: (data: T) => T): Promise<void> {
    const write = this.writes.then(async () => {
      const next = change(this.value)
      if (next === this.value) return
      await mkdir(dirname(this.path), { recursive: true })
      const temporary = `${this.path}.${String(process.pid)}.tmp`
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`)
      await rename(temporary, this.path)
      this.value = next
    })
    this.writes = write.catch(() => undefined)
    return write
  }
}

/**
 * Runs a sync's passes one at a time on a timer: a pass asked for while one runs runs right after it.
 */
export class SyncPasses {
  private running: Promise<void> | undefined
  private requests = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private due = Number.POSITIVE_INFINITY

  /**
   * @param work - one pass.
   * @param signal - the syncing service's lifetime; no pass is scheduled after it ends.
   */
  constructor(private readonly work: () => Promise<void>, private readonly signal: AbortSignal) {}

  /**
   * Run a pass after `delay`, replacing a pass already waiting.
   * @param delay - milliseconds.
   * @param keepSooner - keep a waiting pass that is due sooner, so repeated changes do not push it back.
   */
  schedule(delay: number, keepSooner = false): void {
    if (this.signal.aborted) return
    const due = Date.now() + delay
    if (keepSooner && this.timer !== undefined && this.due <= due) return
    clearTimeout(this.timer)
    this.due = due
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.due = Number.POSITIVE_INFINITY
      void this.pass()
    }, delay)
  }

  /**
   * Cancel the waiting pass.
   * @returns the running pass, for disposal to wait on, or undefined.
   */
  stop(): Promise<void> | undefined {
    clearTimeout(this.timer)
    this.timer = undefined
    return this.running
  }

  private async pass(): Promise<void> {
    this.requests += 1
    if (this.running !== undefined) return
    const run = async () => {
      let seen: number
      do {
        seen = this.requests
        await this.work()
      } while (seen !== this.requests)
    }
    this.running = run().finally(() => { this.running = undefined })
    await this.running
  }
}
