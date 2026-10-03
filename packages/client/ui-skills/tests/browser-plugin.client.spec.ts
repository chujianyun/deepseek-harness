import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { TestRemote, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject } from '../src/client/index.ts'
import { apply as applyNode } from '../src/index.ts'
import type { InstalledSkillsInjected } from '../src/client/installed-source.ts'
import { SkillsPage } from '../src/client/SkillsPage.tsx'
import { SkillsPanelIcon } from '../src/client/SkillsPanelIcon.tsx'

usePinnedBrowserLanguages('zh-CN')

const done = { ok: true as const, value: { done: true as const } }

async function bench() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  class LocaleHolder extends Service {
    constructor(serviceCtx: Context) {
      super(serviceCtx, 'localeHolder')
    }
  }
  new LocaleHolder(ctx)
  const installedSkills = {
    list: vi.fn(async () => ({ ok: true as const, value: { skills: [] } })),
    setEnabled: vi.fn(async (name: string, enabled: boolean) => ({ ok: true as const, value: { name, description: '', group: 'custom' as const, source: 'user-dsh', path: '/x', enabled } })),
    reveal: vi.fn(async () => done),
    edit: vi.fn(async () => done),
    uninstall: vi.fn(async () => done),
  }
  new TestRemote(ctx, { installedSkills })
  const setDraft = vi.fn()
  const sessionCtx = new Context()
  const binding = vi.fn((sessionId: string) => sessionId === 'fresh' ? { ctx: sessionCtx } : undefined)
  ctx.provide('sessions', { binding } as never)
  ctx.provide('conversation', { input: { for: vi.fn((actx: Context) => { expect(actx).toBe(sessionCtx); return { setDraft } }) } } as never)
  const startSession = vi.fn()
  ctx.provide('uiWorkspace', { startSession } as never)
  const slots = ctx.get('slots') as SlotRegistry
  const removeRoot = slots.register({
    name: 'root',
    children: {
      'main': { kind: 'keyed', scope: 'root' },
      'sidebar.panellist': { kind: 'list', scope: 'root' },
    },
  } as never, () => null)
  onTestFinished(removeRoot)
  return { ctx, slots, installedSkills, startSession, setDraft }
}

/**
 * Read the page entry's injected face. A stored entry types its callback as returning a plain record,
 * while the plugin's callback returns the face object.
 * @param slots - slot registry the plugin registered into.
 * @returns the injected face object.
 */
function pageFace(slots: SlotRegistry): object {
  const face = slots.entries('main')[0]?.inject?.()
  if (face === undefined) throw new Error('Skills page injected no face')
  return face
}

describe('ui-skills browser plugin', () => {
  it('registers the sidebar entry and the page, and withdraws both with the plugin', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const [panel] = b.slots.entries('sidebar.panellist')
    expect(panel?.component).toBe(SkillsPanelIcon)
    expect(resolveSlotLabel(panel!.options.label)).toBe('Skills')
    expect(panel!.options).toMatchObject({ id: 'skills', order: 5 })
    const [page] = b.slots.entries('main')
    expect(page?.component).toBe(SkillsPage)
    await fiber.dispose()
    expect(b.slots.entries('sidebar.panellist')).toEqual([])
    expect(b.slots.entries('main')).toEqual([])
  })

  it('wires the page callbacks to the installedSkills Remote', async () => {
    const b = await bench()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const face = pageFace(b.slots) as InstalledSkillsInjected
    await face.onRefresh()
    await face.onToggle('alpha', false)
    await face.onReveal('alpha')
    await face.onEdit('alpha')
    await face.onUninstall('alpha')
    expect(b.installedSkills.list).toHaveBeenCalledOnce()
    expect(b.installedSkills.setEnabled).toHaveBeenCalledWith('alpha', false)
    expect(b.installedSkills.reveal).toHaveBeenCalledWith('alpha')
    expect(b.installedSkills.edit).toHaveBeenCalledWith('alpha')
    expect(b.installedSkills.uninstall).toHaveBeenCalledWith('alpha')
  })

  it('starts a new Session whose draft invokes the skill', async () => {
    const b = await bench()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const face = pageFace(b.slots) as InstalledSkillsInjected
    face.onChat('alpha')
    const [workspaceId, beforeOpen] = b.startSession.mock.calls[0] as [undefined, (sessionId: string) => void]
    expect(workspaceId).toBeUndefined()
    beforeOpen('fresh')
    expect(b.setDraft).toHaveBeenCalledWith('/alpha ')
    beforeOpen('unknown')
    expect(b.setDraft).toHaveBeenCalledOnce()
  })

  it('has a node half that contributes nothing', () => {
    expect(() => { applyNode() }).not.toThrow()
  })
})
