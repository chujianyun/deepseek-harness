/**
 * Session deletion through the command controller: what is stopped, unloaded, deleted, and
 * forgotten, in which order, and which failures leave the Session in place.
 */
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionAlreadyOwnedError, SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiSessionAgentController } from '../src/agent.ts'
import { SessionCommandController } from '../src/commands.ts'
import { createSessionTestRemote, installSessionReadTestServices, testSessionPersistence } from './test-remote.ts'

const header = (id: string, extra: Partial<SessionHeader> = {}): SessionHeader => ({
  version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 1, cwd: '/proj', isSeeded: false, ...extra,
})

afterEach(() => { vi.useRealTimers() })

/** The command controller over recorded fakes; `stored` is what persistence lists. */
async function bench(stored: SessionHeader[], archived: string[] = []) {
  const steps: string[] = []
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  const removeLog = vi.fn(async (id: SessionId) => {
    steps.push(`delete:${id}`)
    const at = stored.findIndex(item => item.id === id)
    if (at === -1) throw new SessionPersistenceNotFoundError(id)
    stored.splice(at, 1)
  })
  ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
    list: () => Promise.resolve([...stored]), delete: removeLog,
  }) as never)
  installSessionReadTestServices(ctx)
  const archivedIds = archived.map(SessionId)
  const registry = {
    get archivedSessionIds() { return archivedIds },
    archiveSession: vi.fn(async (id: SessionId, options: object) => {
      steps.push(`archive:${id}:${JSON.stringify(options)}`)
      archivedIds.push(id)
    }),
    unarchiveSession: vi.fn(async (id: SessionId) => {
      steps.push(`unarchive:${id}`)
      archivedIds.splice(archivedIds.indexOf(id), 1)
    }),
    forgetSession: vi.fn(async (id: SessionId) => { steps.push(`forget:${id}`) }),
  }
  ctx.provide('workspaceRegistry', registry as never)
  const release = vi.fn(async (id: SessionId) => { steps.push(`release:${id}`) })
  const removed: SessionId[] = []
  ctx.on('api-session/removed', (id) => { removed.push(id) })
  const controller = new SessionCommandController(ctx, { release } as unknown as ApiSessionAgentController, '/proj')
  return { ctx, controller, steps, removeLog, registry, release, removed }
}

describe('sessions.delete', () => {
  it('stops the Session, unloads it and its subagent descendants, deletes their logs children first, and forgets them', async () => {
    const b = await bench([
      header('root'), header('child', { origin: 'subagent', parentSession: SessionId('root') }),
      header('grandchild', { origin: 'subagent', parentSession: SessionId('child') }),
      // A fork is its own Session, and another Session's child is not this one's.
      header('fork', { parentSession: SessionId('root'), isSeeded: true }),
      header('other'), header('other-child', { origin: 'subagent', parentSession: SessionId('other') }),
    ])
    const result = await b.controller.delete({ sessionId: SessionId('root') })
    expect(result).toEqual({ deletedSessionIds: ['root', 'child', 'grandchild'] })
    expect(b.steps).toEqual([
      'archive:root:{"stopActivity":true}',
      'release:grandchild', 'release:child', 'release:root',
      'delete:grandchild', 'delete:child', 'delete:root',
      'forget:root', 'forget:child', 'forget:grandchild',
    ])
    expect(b.removed).toEqual(['root', 'child', 'grandchild'])
    expect((await b.ctx.sessionPersistence.list()).map(snapshot => snapshot.header.id)).toEqual(['fork', 'other', 'other-child'])
  })

  it('deletes an archived Session without archiving it again, and a blank one that never reached storage', async () => {
    const b = await bench([header('archived')], ['archived'])
    await b.controller.delete({ sessionId: SessionId('archived') })
    expect(b.registry.archiveSession).not.toHaveBeenCalled()
    expect(b.steps).toEqual(['release:archived', 'delete:archived', 'forget:archived'])

    // A live Session that never materialized: unloading erases it, so there is no log to delete.
    b.ctx.sessions.create(SessionId('blank'), { meta: { cwd: '/proj' } })
    b.steps.length = 0
    expect(await b.controller.delete({ sessionId: SessionId('blank') })).toEqual({ deletedSessionIds: ['blank'] })
    expect(b.steps).toEqual(['archive:blank:{"stopActivity":true}', 'release:blank', 'delete:blank', 'forget:blank'])
  })

  it('refuses an unknown Session and a subagent child, touching nothing', async () => {
    const b = await bench([header('root'), header('child', { origin: 'subagent', parentSession: SessionId('root') })])
    await expect(b.controller.delete({ sessionId: SessionId('missing') })).rejects.toMatchObject({
      code: 'session/not-found', details: { sessionId: 'missing' },
    })
    await expect(b.controller.delete({ sessionId: SessionId('child') })).rejects.toMatchObject({ code: 'gateway/bad-request' })
    expect(b.steps).toEqual([])
  })

  it('waits for a closing writer, then deletes', async () => {
    const b = await bench([header('root')])
    b.removeLog.mockRejectedValueOnce(new SessionAlreadyOwnedError(SessionId('root')))
    b.removeLog.mockRejectedValueOnce(new SessionAlreadyOwnedError(SessionId('root')))
    await b.controller.delete({ sessionId: SessionId('root') })
    expect(b.removeLog).toHaveBeenCalledTimes(3)
    expect(b.steps.at(-1)).toBe('forget:root')
  })

  it('reports a writer that never lets go and restores the Session to the list it was in', async () => {
    vi.useFakeTimers()
    const b = await bench([header('root')])
    b.removeLog.mockRejectedValue(new SessionAlreadyOwnedError(SessionId('root')))
    const deleting = b.controller.delete({ sessionId: SessionId('root') })
    const failure = expect(deleting).rejects.toMatchObject({ code: 'session/writer-held', details: { sessionId: 'root' } })
    await vi.runAllTimersAsync()
    await failure
    expect(b.steps.at(-1)).toBe('unarchive:root')
    expect(b.registry.forgetSession).not.toHaveBeenCalled()
    expect(b.removed).toEqual([])
  })

  it('is unavailable without session persistence', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    const controller = new SessionCommandController(ctx, {} as unknown as ApiSessionAgentController, '/proj')
    await expect(controller.delete({ sessionId: SessionId('root') })).rejects.toMatchObject({ code: 'gateway/internal' })
  })

  it('passes another storage failure through and keeps an already archived Session archived', async () => {
    const b = await bench([header('root')], ['root'])
    b.removeLog.mockRejectedValueOnce(new Error('disk failure'))
    await expect(b.controller.delete({ sessionId: SessionId('root') })).rejects.toThrow('disk failure')
    expect(b.registry.unarchiveSession).not.toHaveBeenCalled()
    expect(b.registry.forgetSession).not.toHaveBeenCalled()
    // A rejection that carries no Error passes through as it is.
    b.removeLog.mockRejectedValueOnce('storage offline')
    await expect(b.controller.delete({ sessionId: SessionId('root') })).rejects.toBe('storage offline')
  })

  it('answers through the Remote face', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    ctx.provide('workspaceRegistry', { archivedSessionIds: [], list: () => [] } as never)
    const remote = createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
    const refused = await remote.delete({ sessionId: SessionId('root') })
    expect(refused).toMatchObject({ ok: false, error: { code: 'gateway/internal' } })
    await ctx.fiber.dispose()
  })
})
