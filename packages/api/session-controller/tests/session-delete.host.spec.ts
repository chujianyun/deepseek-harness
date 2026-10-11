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
import { SessionCommandController } from '../src/commands.ts'
import { createSessionTestRemote, installSessionReadTestServices, testSessionPersistence } from './test-remote.ts'

const header = (id: string, extra: Partial<SessionHeader> = {}): SessionHeader => ({
  version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 1, cwd: '/proj', isSeeded: false, ...extra,
})

afterEach(() => { vi.useRealTimers() })

/** The command controller over recorded fakes; `stored` is what persistence lists. */
async function bench(stored: SessionHeader[]) {
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
  ctx.provide('workspaceRegistry', { list: () => [] } as never)
  const stop = vi.fn(async ({ sessionId }: { sessionId: SessionId }) => { steps.push(`stop:${sessionId}`) })
  ctx.on('workspace/session-stop', stop)
  const blocked: SessionId[] = []
  const release = vi.fn(async (id: SessionId) => { steps.push(`release:${id}`) })
  const agents = {
    release,
    blockOpens: (ids: readonly SessionId[]) => {
      blocked.push(...ids)
      steps.push('block')
      return () => { steps.push('unblock') }
    },
  }
  const removed: SessionId[] = []
  ctx.on('api-session/removed', (id) => { removed.push(id) })
  const deleted: SessionId[] = []
  ctx.on('session/deleted', (id) => { deleted.push(id) })
  const controller = new SessionCommandController(ctx, agents as never, '/proj')
  return { ctx, controller, steps, removeLog, stop, release, removed, deleted, blocked }
}

describe('sessions.delete', () => {
  it('blocks reopening, stops the Session, unloads it and its subagent descendants, and deletes their logs children first', async () => {
    const b = await bench([
      header('root'), header('child', { origin: 'subagent', parentSession: SessionId('root') }),
      header('sibling', { origin: 'subagent', parentSession: SessionId('root') }),
      header('grandchild', { origin: 'subagent', parentSession: SessionId('child') }),
      // A fork is its own Session, and another Session's child is not this one's.
      header('fork', { parentSession: SessionId('root'), isSeeded: true }),
      header('other'), header('other-child', { origin: 'subagent', parentSession: SessionId('other') }),
    ])
    const result = await b.controller.delete({ sessionId: SessionId('root') })
    expect(result).toEqual({ deletedSessionIds: ['root', 'child', 'sibling', 'grandchild'] })
    expect(b.blocked).toEqual(['root', 'child', 'sibling', 'grandchild'])
    expect(b.steps).toEqual([
      'block', 'stop:root',
      'release:grandchild', 'release:sibling', 'release:child', 'release:root',
      'delete:grandchild', 'delete:sibling', 'delete:child', 'delete:root',
      'unblock',
    ])
    expect(b.removed).toEqual(['root', 'child', 'sibling', 'grandchild'])
    expect((await b.ctx.sessionPersistence.list()).map(snapshot => snapshot.header.id)).toEqual(['fork', 'other', 'other-child'])
  })

  it('announces a Session that never reached storage itself, since no backend will', async () => {
    const b = await bench([])
    // Live, never materialized: unloading erases it, so there is no log to delete.
    const owner = await b.ctx.plugin(Object.assign((inner: Context) => {
      inner.sessions.create(SessionId('blank'), { meta: { cwd: '/proj' } })
    }, { inject: ['sessions'] }))
    b.release.mockImplementationOnce(async () => { await owner.dispose() })
    expect(await b.controller.delete({ sessionId: SessionId('blank') })).toEqual({ deletedSessionIds: ['blank'] })
    expect(b.deleted).toEqual(['blank'])
    expect(b.removed).toContain('blank')
  })

  it('refuses an unknown Session and a subagent child, touching nothing', async () => {
    const b = await bench([header('root'), header('child', { origin: 'subagent', parentSession: SessionId('root') })])
    await expect(b.controller.delete({ sessionId: SessionId('missing') })).rejects.toMatchObject({
      code: 'session/not-found', details: { sessionId: 'missing' },
    })
    await expect(b.controller.delete({ sessionId: SessionId('child') })).rejects.toMatchObject({ code: 'gateway/bad-request' })
    expect(b.steps).toEqual([])
  })

  it('deletes although a provider failed to stop its work', async () => {
    const b = await bench([header('root')])
    b.stop.mockRejectedValueOnce(new Error('job would not stop'))
    const warn = vi.spyOn(b.ctx.logger, 'warn')
    await b.controller.delete({ sessionId: SessionId('root') })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('stopping its work before deletion reported failures'))
    expect(b.steps.at(-2)).toBe('delete:root')
  })

  it('refuses a Session another owner keeps loaded, before any log is deleted, and lifts the block', async () => {
    const b = await bench([header('root'), header('child', { origin: 'subagent', parentSession: SessionId('root') })])
    // Loaded by something this controller holds no handle for: release leaves it in the store.
    b.ctx.sessions.create(SessionId('root'), { meta: { cwd: '/proj', createdAt: 1 } })
    await expect(b.controller.delete({ sessionId: SessionId('root') })).rejects.toMatchObject({
      code: 'session/agent-busy', message: 'session "root" is loaded by another owner and cannot be deleted while it is',
    })
    expect(b.removeLog).not.toHaveBeenCalled()
    expect(b.steps.at(-1)).toBe('unblock')
    expect(b.removed).toEqual([])
  })

  it('waits for a closing writer, then deletes', async () => {
    const b = await bench([header('root')])
    b.removeLog.mockRejectedValueOnce(new SessionAlreadyOwnedError(SessionId('root')))
    b.removeLog.mockRejectedValueOnce(new SessionAlreadyOwnedError(SessionId('root')))
    await b.controller.delete({ sessionId: SessionId('root') })
    expect(b.removeLog).toHaveBeenCalledTimes(3)
    expect(b.removed).toEqual(['root'])
  })

  it('reports a writer that never lets go, leaves the Session in place, and lifts the block', async () => {
    vi.useFakeTimers()
    const b = await bench([header('root')])
    b.removeLog.mockRejectedValue(new SessionAlreadyOwnedError(SessionId('root')))
    const deleting = b.controller.delete({ sessionId: SessionId('root') })
    const failure = expect(deleting).rejects.toMatchObject({ code: 'session/writer-held', details: { sessionId: 'root' } })
    await vi.runAllTimersAsync()
    await failure
    expect(b.steps.at(-1)).toBe('unblock')
    expect(b.removed).toEqual([])
    expect((await b.ctx.sessionPersistence.list()).map(snapshot => snapshot.header.id)).toEqual(['root'])
  })

  it('is unavailable without session persistence', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    const controller = new SessionCommandController(ctx, {} as never, '/proj')
    await expect(controller.delete({ sessionId: SessionId('root') })).rejects.toMatchObject({ code: 'gateway/internal' })
  })

  it('passes another storage failure through, with or without an Error', async () => {
    const b = await bench([header('root')])
    b.removeLog.mockRejectedValueOnce(new Error('disk failure'))
    await expect(b.controller.delete({ sessionId: SessionId('root') })).rejects.toThrow('disk failure')
    b.removeLog.mockRejectedValueOnce('storage offline')
    await expect(b.controller.delete({ sessionId: SessionId('root') })).rejects.toBe('storage offline')
    expect(b.removed).toEqual([])
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
