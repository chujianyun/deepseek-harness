/**
 * Session sharing for Desktop: uploads a snapshot of one Session's conversation to the user center
 * of the current Hub sign-in, which serves it to signed-in members of the same company at a link.
 * The user center holds one share per Session and employee; sharing again replaces its snapshot and
 * keeps the link. Deleting a Session withdraws its share.
 *
 * @module @deepseek-ai/dsh-session-share
 */

import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-assistants'
import { userCenterRefusal } from '@deepseek-ai/dsh-hub-account'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-session-query'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { brandString } from '@deepseek-ai/dsh-brand'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { ShareRecords } from './records.ts'
import { buildShareSnapshot } from './snapshot.ts'
import type { SessionShareId, SessionShareLink, SessionShareRequest, SessionShareStatus, SessionShareTarget } from './types.ts'

export type * from './types.ts'
export { buildShareSnapshot } from './snapshot.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Session sharing over the Hub sign-in, and its Remote namespace. */
    sessionShare: SessionShare
  }
}

/** Deployment configuration. */
export interface Config {
  /** Deadline of each user-center request, in milliseconds. */
  requestTimeoutMs?: number
  /** DeepSeek Harness home; the share record lives at `<dshHome>/session-shares.json`. Defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string
}

/** Validated deployment configuration. */
export const Config: Schema<Config> = Schema.object({
  requestTimeoutMs: Schema.number().min(1).max(600_000).default(60_000).description('Deadline of each user-center request, in milliseconds.'),
  dshHome: Schema.string().description('DeepSeek Harness home; the share record lives at `<dshHome>/session-shares.json`. Defaults to `$DSH_HOME` or `~/.dsh`.'),
})

const linkSchema = z.object({
  shareId: z.string().min(1).transform(id => brandString<SessionShareId>(id)),
  url: z.string().min(1),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
})

/** The user center's refusal, as this service's error. */
async function refusal(res: Response): Promise<RemoteError> {
  const { reason, status } = await userCenterRefusal(res)
  return new RemoteError('session-share/refused', reason, { status })
}

/**
 * The assistant a Session is bound to, read from its log: the last `assistant/selected` event, whose
 * empty id records going back to none.
 */
function boundAssistant(events: readonly SessionEvent[]): string | null {
  let bound: string | null = null
  for (const event of events) {
    if (event.type === 'assistant/selected') bound = event.data.assistantId === '' ? null : event.data.assistantId
  }
  return bound
}

/** Host owner of Session sharing and of the `sessionShare` Remote namespace. */
export class SessionShare extends TypertRemoteService {
  static inject = ['hubAccount', 'sessionQuery']
  static Config = Config

  private readonly requestTimeoutMs: number
  private readonly records: ShareRecords

  /** @param ctx - Host with the Hub sign-in and Session reads. @param config - request deadline and home. */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'sessionShare', { namespace: 'sessionShare' })
    const resolved = Config(config) as Required<Omit<Config, 'dshHome'>> & Pick<Config, 'dshHome'>
    this.requestTimeoutMs = resolved.requestTimeoutMs
    this.records = new ShareRecords(join(resolveDshHome(resolved.dshHome), 'session-shares.json'))
    ctx.on('session/deleted', (sessionId) => {
      void this.withdrawDeleted(sessionId).catch((error: unknown) => {
        // The Session is already gone; its share stays on the user center until its owner or an administrator withdraws it there.
        console.info('[session-share] share of a deleted Session not withdrawn', { sessionId, error: String(error) })
      })
    })
  }

  /**
   * Read whether sharing is possible now and the Session's current share.
   * @param request - the Session.
   * @returns the sign-in state and the link, null when the Session is not shared.
   * @throws RemoteError `session-share/refused` or `session-share/unreachable`.
   */
  @Remote
  async status(request: SessionShareTarget): Promise<SessionShareStatus> {
    const tenant = await this.tenant()
    if (tenant === undefined) return { signedIn: false, link: null }
    const res = await this.call(request.sessionId, { method: 'GET' })
    if (res.status === 404) {
      await res.body?.cancel()
      await this.forget(request.sessionId, tenant)
      return { signedIn: true, link: null }
    }
    const link = await this.link(res)
    await this.records.set(request.sessionId, { tenantId: tenant, shareId: link.shareId })
    return { signedIn: true, link }
  }

  /**
   * Share the Session, or replace its existing share's snapshot with the conversation as it is now.
   * @param request - the Session and the title to show.
   * @returns the share's link, unchanged for a Session shared before.
   * @throws RemoteError `session-share/signed-out`, `session-share/empty`, `session-share/refused`
   *   (the user center's reason; status 413 for a conversation over its size limits), or
   *   `session-share/unreachable`.
   */
  @Remote
  async share(request: SessionShareRequest): Promise<SessionShareLink> {
    const tenant = await this.tenant()
    if (tenant === undefined) throw new RemoteError('session-share/signed-out', 'sign in to the user center before sharing', {})
    const { events } = await this.ctx.sessionQuery.readSession(request.sessionId)
    const messages = buildShareSnapshot(events)
    if (messages.length === 0) {
      throw new RemoteError('session-share/empty', 'the Session has no conversation to share', { sessionId: request.sessionId })
    }
    const body = JSON.stringify({ title: request.title, assistantName: await this.assistantName(events), messages })
    const link = await this.link(await this.call(request.sessionId, { method: 'PUT', headers: { 'content-type': 'application/json' }, body }))
    await this.records.set(request.sessionId, { tenantId: tenant, shareId: link.shareId })
    return link
  }

  /**
   * Withdraw the Session's share; its link stops working. A Session that is not shared is left as is.
   * @param request - the Session.
   * @throws RemoteError `session-share/signed-out`, `session-share/refused`, or `session-share/unreachable`.
   */
  @Remote
  async revoke(request: SessionShareTarget): Promise<void> {
    const tenant = await this.tenant()
    if (tenant === undefined) throw new RemoteError('session-share/signed-out', 'sign in to the user center before withdrawing a share', {})
    await this.withdraw(request.sessionId)
    await this.forget(request.sessionId, tenant)
  }

  /** Tenant of the current sign-in (empty for none), or undefined while signed out. */
  private async tenant(): Promise<string | undefined> {
    const state = await this.ctx.hubAccount.getState()
    return state.status === 'signed-in' ? state.profile?.tenantId ?? '' : undefined
  }

  /** Forget the Session's record when it was made under this tenant; another tenant's record still names its share. */
  private async forget(sessionId: SessionId, tenant: string): Promise<void> {
    if ((await this.records.get(sessionId))?.tenantId === tenant) await this.records.set(sessionId, undefined)
  }

  /** Withdraw as the signed-in employee. */
  private async withdraw(sessionId: SessionId): Promise<void> {
    const res = await this.call(sessionId, { method: 'DELETE' })
    if (res.ok || res.status === 404) await res.body?.cancel()
    else throw await refusal(res)
  }

  /**
   * Withdraw a deleted Session's share when this machine recorded one. Only the tenant that shared it
   * can withdraw it; under another sign-in, or signed out, it is logged and left on the user center.
   */
  private async withdrawDeleted(sessionId: SessionId): Promise<void> {
    const record = await this.records.get(sessionId)
    if (record === undefined) return
    try {
      if (record.tenantId !== await this.tenant()) {
        console.info('[session-share] share of a deleted Session not withdrawn: shared under another sign-in', { sessionId, shareId: record.shareId })
        return
      }
      await this.withdraw(sessionId)
    } finally {
      await this.records.set(sessionId, undefined)
    }
  }

  /** Name of the assistant the Session is bound to; null for none, or one this tenant no longer has. */
  private async assistantName(events: readonly SessionEvent[]): Promise<string | null> {
    const bound = boundAssistant(events)
    const assistants = this.ctx.get('assistants')
    if (bound === null || assistants === undefined) return null
    return (await assistants.getState()).assistants.find(assistant => assistant.id === bound)?.name ?? null
  }

  /** One call to the Session's share on the user center; a transport failure reads as `session-share/unreachable`. */
  private async call(sessionId: SessionId, init: RequestInit): Promise<Response> {
    try {
      return await this.ctx.hubAccount.request(`/api/client/session-shares/${encodeURIComponent(sessionId)}`, {
        ...init, signal: AbortSignal.timeout(this.requestTimeoutMs),
      })
    } catch (error: unknown) {
      if (error instanceof RemoteError && error.code === 'hub-account/signed-out') {
        throw new RemoteError('session-share/signed-out', 'sign in to the user center before sharing', {}, { cause: error })
      }
      throw new RemoteError('session-share/unreachable', 'the user center cannot be reached', {}, { cause: error })
    }
  }

  private async link(res: Response): Promise<SessionShareLink> {
    if (!res.ok) throw await refusal(res)
    const parsed = linkSchema.safeParse(await res.json().catch(() => undefined))
    if (!parsed.success) throw new RemoteError('session-share/refused', 'the user center answered an unreadable share', { status: res.status })
    return parsed.data
  }
}

export default SessionShare
