import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { TestRemote, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject } from '../src/client/index.ts'
import { apply as applyNode } from '../src/index.ts'
import type { InstalledSkillsInjected } from '../src/client/installed-source.ts'
import type { MarketInjected } from '../src/client/market-source.ts'
import type { UploadInjected } from '../src/client/upload-source.ts'
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
  const page = { items: [], total: 0, page: 1, pageSize: 12 }
  const card = { id: 's1', name: 'pdf-tools', description: '', category: null, version: '1.0.0', updatedAt: '', installedVersion: '1.0.0', updateAvailable: false, conflict: false }
  const skillMarket = {
    list: vi.fn(async () => ({ ok: true as const, value: page })),
    categories: vi.fn(async () => ({ ok: true as const, value: [] })),
    detail: vi.fn(async () => ({ ok: true as const, value: { ...card, ownerName: '', skillMd: '', files: [] } })),
    installSkill: vi.fn(async () => ({ ok: true as const, value: card })),
    installedStatus: vi.fn(async () => ({ ok: true as const, value: [] })),
    uploadSources: vi.fn(async () => ({ ok: true as const, value: [] })),
    inspectFolder: vi.fn(async (dir: string) => ({ ok: true as const, value: { dir, name: 'x', description: 'x', fileCount: 1, sizeBytes: 1, problems: [], existing: null, suggestedVersion: '1.0.0' } })),
    uploadOptions: vi.fn(async () => ({ ok: true as const, value: { categories: [], departments: [], employees: [] } })),
    uploadSkill: vi.fn(async () => ({ ok: true as const, value: { skillId: 's', name: 'x', version: '1.0.0', mode: 'create' as const, status: 'published' as const, reviewUrl: null } })),
  }
  const directoryPicker = { pick: vi.fn(async () => ({ ok: true as const, value: '/picked' as string | null })) }
  new TestRemote(ctx, { installedSkills, skillMarket, directoryPicker })
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
  return { ctx, slots, installedSkills, skillMarket, directoryPicker, startSession, setDraft }
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

  it('wires the market callbacks to the skillMarket Remote and refreshes the installed list after an install', async () => {
    const b = await bench()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const face = pageFace(b.slots) as MarketInjected
    await face.onOpenMarket()
    await face.onOpenDetail('s1')
    await face.onInstall('s1')
    expect(b.skillMarket.list).toHaveBeenCalledWith({ q: '', page: 1, pageSize: 12 })
    expect(b.skillMarket.categories).toHaveBeenCalledOnce()
    expect(b.skillMarket.detail).toHaveBeenCalledWith('s1')
    expect(b.skillMarket.installSkill).toHaveBeenCalledWith('s1', {})
    expect(b.skillMarket.installedStatus).toHaveBeenCalledOnce()
    await vi.waitFor(() => { expect(b.installedSkills.list).toHaveBeenCalledOnce() })
  })

  it('wires the upload dialog to the skillMarket Remote, the folder chooser, and the clipboard', async () => {
    const b = await bench()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const face = pageFace(b.slots) as UploadInjected
    await face.onOpenUpload()
    await face.onBrowseFolder()
    expect(b.directoryPicker.pick).toHaveBeenCalledOnce()
    expect(b.skillMarket.inspectFolder).toHaveBeenCalledWith('/picked')
    await face.onSubmitUpload({ version: '1.0.0' })
    expect(b.skillMarket.uploadSkill).toHaveBeenCalledWith({ version: '1.0.0', dir: '/picked' })
    expect(b.skillMarket.uploadSources).toHaveBeenCalledOnce()
    expect(b.skillMarket.uploadOptions).toHaveBeenCalledOnce()
    await vi.waitFor(() => { expect(b.skillMarket.list).toHaveBeenCalled() })
    b.directoryPicker.pick.mockResolvedValueOnce({ ok: false, error: { code: 'x', message: 'browse only', details: {} } } as never)
    await face.onBrowseFolder()
    expect(b.skillMarket.inspectFolder).toHaveBeenCalledOnce()
    const clipboard = vi.fn(async () => {})
    Object.defineProperty(globalThis.navigator, 'clipboard', { value: { writeText: clipboard }, configurable: true })
    b.skillMarket.uploadSkill.mockResolvedValueOnce({ ok: true, value: { skillId: 's', name: 'x', version: '1.0.1', mode: 'version', status: 'pending', reviewUrl: 'https://hub/r/1' } } as never)
    await face.onInspectFolder('/picked')
    await face.onSubmitUpload({ version: '1.0.1' })
    await face.onCopyReviewUrl()
    expect(clipboard).toHaveBeenCalledWith('https://hub/r/1')
  })

  it('has a node half that contributes nothing', () => {
    expect(() => { applyNode() }).not.toThrow()
  })
})
