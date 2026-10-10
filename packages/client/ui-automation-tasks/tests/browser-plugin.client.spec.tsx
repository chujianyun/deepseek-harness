// @vitest-environment jsdom
import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject } from '../src/client/index.ts'
import { apply as applyNode } from '../src/index.ts'
import type { TaskFormInjected } from '../src/client/form-options.ts'
import { TaskForm } from '../src/client/TaskForm.tsx'

describe('ui-automation-tasks browser plugin', () => {
  it('occupies the task page\'s form slot over the Remotes, and leaves it with the plugin', async () => {
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    await ctx.plugin(SlotRegistry).await()
    ctx.provide('locale', new LocaleRuntime(ctx))
    class LocaleHolder extends Service {
      constructor(serviceCtx: Context) { super(serviceCtx, 'localeHolder') }
    }
    new LocaleHolder(ctx)
    const list = createSnapshotStore({ items: [] })
    ctx.provide('workspaces', { list } as never)
    const ok = <T,>(value: T) => vi.fn(async () => ({ ok: true as const, value }))
    const remotes = {
      automationTasks: { create: ok({ sessionId: 's-1', record: {} }) },
      assistants: { getState: ok({ assistants: [{ id: 'a1', name: '电商管家' }] }) },
      session: { modelCatalog: ok({ groups: [] }) },
      permissionPresets: { catalog: ok({ options: [], defaultPreset: 'workspace-write' }) },
      connectors: { getState: ok({ connectors: [] }) },
    }
    new TestRemote(ctx, remotes)
    const slots = ctx.get('slots') as SlotRegistry
    const removeRoot = slots.register({ name: 'root', children: { 'schedule.task.form': { kind: 'single', scope: 'root' } } } as never, () => null)
    onTestFinished(removeRoot)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const [entry] = slots.entries('schedule.task.form')
    expect(entry?.component).toBe(TaskForm)
    const face = entry!.inject!() as { hooks: TaskFormInjected['hooks']; loadOptions: TaskFormInjected['loadOptions']; onCreate: TaskFormInjected['onCreate'] }
    expect(face.hooks.workspaces).toBe(list)
    expect((await face.loadOptions()).assistants).toEqual([{ value: 'a1', label: '电商管家' }])
    await face.onCreate({ title: 't', prompt: 'p', workspaceId: 'ws' as never, timing: { kind: 'every', every_seconds: 60 } })
    expect(remotes.automationTasks.create).toHaveBeenCalledOnce()
    await fiber.dispose()
    expect(slots.entries('schedule.task.form')).toEqual([])
    applyNode()
  })
})
