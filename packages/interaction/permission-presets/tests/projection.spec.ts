/**
 * The `permissions` projection unit and the `/permission` command: mounting
 * the permission service beside the projection registry serves only the
 * effective current value folded from permission events over the composition
 * defaults; the process-level Remote catalog owns selectable options;
 * the command child registers `/permission` whose handler switches
 * through `permission.set` (bare invocation reports, unknown names error).
 * The service requires the projection registry, omits the command without its
 * registry, and removes the projection key on unload (HMR safety). The
 * user's `/permission` switch becomes the default of later sessions, saved
 * through Settings; Auto and a programmatic switch leave it alone.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import PermissionPresetService from '@deepseek-ai/dsh-permission-presets'
import { AUTO_PRESET } from '@deepseek-ai/dsh-permission-presets'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { liveConfig, omitsGeneratedPage } from '../../../settings/settings/tests/live-config.ts'

async function harness(options: {
  withPermission?: boolean
  config?: NonNullable<Parameters<typeof PermissionPresetService.Config>[0]>
  ctx?: Context
} = {}): Promise<{ ctx: Context; session: Session }> {
  const ctx = options.ctx ?? new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(CommandRuntime)
  ctx.provide('shell', {
    sandboxMode: 'workspace-write',
    resolve() { throw new Error('permission tests do not execute bash') },
    run() { throw new Error('permission tests do not execute bash') },
    start() { throw new Error('permission tests do not execute bash') },
  })
  await ctx.plugin(ApprovalService)
  if (options.withPermission !== false) await ctx.plugin(PermissionPresetService, options.config ?? {})
  return { ctx, session: ctx.sessions.create(SessionId('perm-projected')) }
}

/** Mint a scoped agent over a live session (the command executor's addressing shape). */
async function agentFor(ctx: Context, session: Session) {
  const inject = vi.fn<Agent['inject']>()
  const agent = { id: session.id, session, inject } as unknown as Agent
  await ctx.plugin(Object.assign((inner: Context) => { createScope(inner, agent) }, { inject: ['commands'] }))
  return { agent, inject }
}

async function mountAuto(ctx: Context) {
  return ctx.plugin(Object.assign((pluginCtx: Context) => {
    pluginCtx.permissionPresets.registerAuto(() => {})
  }, { inject: ['permissionPresets'] }))
}

describe('permissions projection unit', () => {
  it('serves only the pinned new-session current value', async () => {
    const { ctx, session } = await harness()
    const value = ctx.sessionProjections.snapshot(session).values.permissions
    expect(value).toEqual({ currentValue: 'workspace-write' })
    expect(value).not.toHaveProperty('options')
  })

  it('folds the knob events and notifies the change feed per knob append', async () => {
    const { ctx, session } = await harness()
    const changes: { key: string; value: unknown; seq: number }[] = []
    ctx.sessionProjections.onChanged((_session, key, value, seq) => {
      changes.push({ key, value, seq })
    })
    ctx.permissionPresets.set(session, 'danger-full-access')
    const permissionChanges = changes.filter(change => change.key === 'permissions')
    expect(permissionChanges).toHaveLength(3)
    expect(permissionChanges.at(-1)).toMatchObject({ key: 'permissions', value: { currentValue: 'danger-full-access' } })
    session.append('turn/start', { turn: 1 })
    expect(changes).toHaveLength(3)
  })

  it('projects custom as a current value when the knobs match no preset', async () => {
    const { ctx, session } = await harness()
    session.append('sandbox/mode', { mode: 'read-only' })
    const value = ctx.sessionProjections.snapshot(session).values.permissions
    expect(value).toEqual({ currentValue: 'custom' })
  })

  it('publishes Auto only through the process catalog and never changes Session seq or projection', async () => {
    const { ctx, session } = await harness()
    const beforeSeq = session.seq
    const beforeProjection = ctx.sessionProjections.snapshot(session)
    const notifications: number[] = []
    ctx.on('permission-presets/catalog-changed', () => { notifications.push(notifications.length + 1) })

    expect(ctx.permissionPresets.catalog().options.map(option => option.value))
      .toEqual(['workspace-write', 'danger-full-access'])
    const fiber = await mountAuto(ctx)
    expect(ctx.permissionPresets.catalog().options.map(option => option.value))
      .toEqual(['workspace-write', 'danger-full-access', AUTO_PRESET])
    expect(session.seq).toBe(beforeSeq)
    expect(ctx.sessionProjections.snapshot(session)).toEqual(beforeProjection)

    await fiber.dispose()
    expect(ctx.permissionPresets.catalog().options.map(option => option.value))
      .toEqual(['workspace-write', 'danger-full-access'])
    expect(session.seq).toBe(beforeSeq)
    expect(ctx.sessionProjections.snapshot(session)).toEqual(beforeProjection)

    const reinstalled = await mountAuto(ctx)
    expect(ctx.permissionPresets.catalog().options.map(option => option.value))
      .toEqual(['workspace-write', 'danger-full-access', AUTO_PRESET])
    expect(notifications).toEqual([1, 2, 3])
    await reinstalled.dispose()
    expect(notifications).toEqual([1, 2, 3, 4])
  })

  it('contains synchronous and asynchronous catalog notification failures', async () => {
    const { ctx } = await harness()
    const warned = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    ctx.on('permission-presets/catalog-changed', () => { throw new Error('sync observer failed') })
    ctx.on('permission-presets/catalog-changed', () => { throw 'sync non-error failed' })
    // oxlint-disable-next-line typescript/no-misused-promises -- the runtime intentionally contains thenable listeners.
    ctx.on('permission-presets/catalog-changed', () => Promise.reject(new Error('async observer failed')))
    // oxlint-disable-next-line typescript/no-misused-promises -- the runtime intentionally contains thenable listeners.
    ctx.on('permission-presets/catalog-changed', async () => { throw 'async non-error failed' })

    const fiber = await mountAuto(ctx)
    await vi.waitFor(() => { expect(warned).toHaveBeenCalledTimes(4) })
    expect(warned).toHaveBeenCalledWith('permission: catalog-changed listener failed: sync non-error failed')
    expect(warned).toHaveBeenCalledWith('permission: catalog-changed listener failed: async non-error failed')
    expect(ctx.permissionPresets.names).toContain(AUTO_PRESET)
    await fiber.dispose()
  })

  it('has no permissions key without the service, and drops it on unload (HMR safety)', async () => {
    const { ctx, session } = await harness({ withPermission: false })
    expect('permissions' in ctx.sessionProjections.snapshot(session).values).toBe(false)
    const fiber = await ctx.plugin(PermissionPresetService, {})
    expect(ctx.sessionProjections.snapshot(session).values.permissions)
      .toMatchObject({ currentValue: 'workspace-write' })
    await fiber.dispose()
    expect('permissions' in ctx.sessionProjections.snapshot(session).values).toBe(false)
  })
})

describe('/permission command', () => {
  it('lists and switches a contributed current-session preset', async () => {
    const { ctx, session } = await harness()
    await mountAuto(ctx)
    const { agent } = await agentFor(ctx, session)
    const listed = await ctx.commands.execute(agent, '/permission', [], new AbortController().signal)
    expect(listed?.result).toEqual({
      kind: 'success',
      text: 'current preset workspace-write (available: workspace-write, danger-full-access, auto)',
    })
    const switched = await ctx.commands.execute(agent, '/permission auto', [], new AbortController().signal)
    expect(switched?.result).toEqual({ kind: 'success', text: 'preset auto' })
    expect(ctx.permissionPresets.current(session)).toBe(AUTO_PRESET)
  })

  it('switches through permission.set and logs the lifecycle pair', async () => {
    const { ctx, session } = await harness()
    const { agent, inject } = await agentFor(ctx, session)
    const execution = await ctx.commands.execute(agent, '/permission danger-full-access', [], new AbortController().signal)
    expect(execution?.result).toEqual({ kind: 'success', text: 'preset danger-full-access' })
    expect(ctx.permissionPresets.current(session)).toBe('danger-full-access')
    expect(inject.mock.calls[0]?.[0]).toMatchObject({
      content: [{
        type: 'text',
        text: 'The approval policy changed from "ask" to "never" (changed by the user).',
      }],
    })
    const run = session.snapshotEvents().find(event => event.type === 'command/run')
    expect(run?.data).toMatchObject({ name: 'permission', args: ' danger-full-access' })
  })

  it('reports the current preset and the table on bare invocation', async () => {
    const { ctx, session } = await harness()
    const { agent } = await agentFor(ctx, session)
    const execution = await ctx.commands.execute(agent, '/permission', [], new AbortController().signal)
    expect(execution?.result).toEqual({
      kind: 'success',
      text: 'current preset workspace-write (available: workspace-write, danger-full-access)',
    })
    expect(session.snapshotEvents().filter(event => event.type === 'permission/preset')).toHaveLength(1)
  })

  it('rejects an unknown preset without touching the log', async () => {
    const { ctx, session } = await harness()
    const { agent } = await agentFor(ctx, session)
    const before = session.snapshotEvents().filter(event =>
      event.type !== 'command/run' && event.type !== 'command/done')
    const execution = await ctx.commands.execute(agent, '/permission yolo', [], new AbortController().signal)
    // The error text carries the same no-self-labelling rule as the success
    // texts: `permission · unknown preset "yolo" (…)`, not `unknown permission
    // preset`, which the row's own title already says.
    expect(execution?.result).toEqual({
      kind: 'error',
      text: 'unknown preset "yolo" (available: workspace-write, danger-full-access)',
    })
    expect(session.snapshotEvents().filter(event =>
      event.type !== 'command/run' && event.type !== 'command/done')).toEqual(before)
  })
})

it('keeps its own instance off the generated Settings pages', () => omitsGeneratedPage(async (ctx) => {
  await harness({ ctx, withPermission: false })
  return ctx.plugin(PermissionPresetService, {})
}))

/** The service as a profile entry with a Settings stand-in that writes through to that entry. */
async function mountedEntry(options: { live?: boolean; failSave?: boolean } = {}) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(CommandRuntime)
  ctx.provide('shell', {
    sandboxMode: 'workspace-write',
    resolve() { throw new Error('permission tests do not execute bash') },
    run() { throw new Error('permission tests do not execute bash') },
    start() { throw new Error('permission tests do not execute bash') },
  })
  await ctx.plugin(ApprovalService)
  const live = options.live === false ? undefined : await liveConfig(ctx, PermissionPresetService)
  if (live === undefined) await ctx.plugin(PermissionPresetService, {})
  const update = vi.fn(async (_entry: string, patch: Record<string, unknown>) => {
    // A failing save takes a moment, so a second switch can come in before it fails.
    if (options.failSave === true) await new Promise((_resolve, reject) => { setTimeout(() => { reject(new Error('settings file is read-only')) }, 20) })
    await live?.update(patch)
  })
  ctx.provide('settings', { configure: () => () => {}, update } as never)
  return { ctx, update }
}

async function agentOf(ctx: Context, session: Session): Promise<Agent> {
  return (await agentFor(ctx, session)).agent
}

async function switchTo(ctx: Context, agent: Agent, preset: string): Promise<void> {
  await ctx.commands.execute(agent, `/permission ${preset}`, [], new AbortController().signal)
}

describe('the default of later sessions', () => {
  it('follows the preset the user switches to, in either direction, and leaves existing sessions alone', async () => {
    const { ctx } = await mountedEntry()
    const first = ctx.sessions.create(SessionId('first'))
    const earlier = ctx.sessions.create(SessionId('earlier'))
    await switchTo(ctx, await agentOf(ctx, first), 'danger-full-access')
    await vi.waitFor(() => { expect(ctx.permissionPresets.defaultPreset).toBe('danger-full-access') })
    expect(ctx.permissionPresets.current(ctx.sessions.create(SessionId('next')))).toBe('danger-full-access')
    expect(ctx.permissionPresets.current(earlier)).toBe('workspace-write')
    await switchTo(ctx, await agentOf(ctx, first), 'workspace-write')
    await vi.waitFor(() => { expect(ctx.permissionPresets.defaultPreset).toBe('workspace-write') })
    expect(ctx.permissionPresets.current(ctx.sessions.create(SessionId('after')))).toBe('workspace-write')
  })

  it('ends as the latest of two quick switches', async () => {
    const { ctx, update } = await mountedEntry()
    const agent = await agentOf(ctx, ctx.sessions.create(SessionId('quick')))
    await switchTo(ctx, agent, 'danger-full-access')
    await switchTo(ctx, agent, 'workspace-write')
    await vi.waitFor(() => { expect(update).toHaveBeenCalledTimes(2) })
    await vi.waitFor(() => { expect(ctx.permissionPresets.defaultPreset).toBe('workspace-write') })
  })

  it('stays for Auto, a programmatic switch, and a switch to the default itself', async () => {
    const { ctx, update } = await mountedEntry()
    await ctx.plugin(Object.assign((pluginCtx: Context) => { pluginCtx.permissionPresets.registerAuto(() => {}) }, { inject: ['permissionPresets'] }))
    const session = ctx.sessions.create(SessionId('s'))
    await switchTo(ctx, await agentOf(ctx, session), AUTO_PRESET)
    expect(ctx.permissionPresets.current(session)).toBe(AUTO_PRESET)
    ctx.permissionPresets.set(ctx.sessions.create(SessionId('task')), 'danger-full-access')
    await switchTo(ctx, await agentOf(ctx, ctx.sessions.create(SessionId('same'))), 'workspace-write')
    expect(update).not.toHaveBeenCalled()
    expect(ctx.permissionPresets.defaultPreset).toBe('workspace-write')
  })

  it('logs a save that fails and keeps the default', async () => {
    const { ctx } = await mountedEntry({ failSave: true })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const agent = await agentOf(ctx, ctx.sessions.create(SessionId('s')))
    await switchTo(ctx, agent, 'danger-full-access')
    await switchTo(ctx, agent, 'workspace-write')
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledTimes(2) })
    expect(warn).toHaveBeenCalledWith('permission: could not save the default preset: Error: settings file is read-only')
    expect(ctx.permissionPresets.defaultPreset).toBe('workspace-write')
  })

  it('saves nothing without a profile entry to save it in', async () => {
    const { ctx, update } = await mountedEntry({ live: false })
    await switchTo(ctx, await agentOf(ctx, ctx.sessions.create(SessionId('s'))), 'danger-full-access')
    expect(update).not.toHaveBeenCalled()
  })
})
