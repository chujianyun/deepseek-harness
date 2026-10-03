import { describe, expect, it, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { InstalledSkillView } from '@deepseek-ai/dsh-skill-controller/types'
import { createInstalledSource, type InstalledDependencies } from '../src/client/installed-source.ts'

function skill(name: string, enabled = true): InstalledSkillView {
  return { name, description: `${name} description`, group: 'custom', source: 'user-dsh', path: `/home/.dsh/skills/${name}/SKILL.md`, enabled }
}

const done = { ok: true as const, value: { done: true as const } }
const refused = (message: string) => ({ ok: false as const, error: new RemoteError('installed-skills/rejected', message, { name: 'x' }) })

function deps(overrides: Partial<InstalledDependencies> = {}): InstalledDependencies {
  return {
    list: vi.fn(async () => ({ ok: true as const, value: { skills: [skill('alpha'), skill('beta', false)] } })),
    setEnabled: vi.fn(async (name: string, enabled: boolean) => ({ ok: true as const, value: skill(name, enabled) })),
    reveal: vi.fn(async () => done),
    edit: vi.fn(async () => done),
    uninstall: vi.fn(async () => done),
    chat: vi.fn(),
    ...overrides,
  }
}

describe('installed-skill source', () => {
  it('starts loading, then publishes the listed skills', async () => {
    const source = createInstalledSource(deps())
    expect(source.hooks.installed.getSnapshot()).toEqual({ status: 'loading', skills: [], busy: [], failure: null })
    await source.onRefresh()
    expect(source.hooks.installed.getSnapshot()).toMatchObject({ status: 'ready', skills: [skill('alpha'), skill('beta', false)] })
  })

  it('reports a failed read and keeps the last good list', async () => {
    const list = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: { skills: [skill('alpha')] } })
      .mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'down', {}) })
    const source = createInstalledSource(deps({ list }))
    await source.onRefresh()
    await source.onRefresh()
    expect(source.hooks.installed.getSnapshot()).toMatchObject({ status: 'error', skills: [skill('alpha')] })
  })

  it('ignores a read superseded by a newer one', async () => {
    const first = Promise.withResolvers<Awaited<ReturnType<InstalledDependencies['list']>>>()
    const list = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ ok: true, value: { skills: [skill('newer')] } })
    const source = createInstalledSource(deps({ list }))
    const stale = source.onRefresh()
    await source.onRefresh()
    first.resolve({ ok: true, value: { skills: [skill('older')] } })
    await stale
    expect(source.hooks.installed.getSnapshot().skills.map(item => item.name)).toEqual(['newer'])
  })

  it('moves a switch at once, marks the skill busy, and returns it when the Host refuses', async () => {
    const answer = Promise.withResolvers<Awaited<ReturnType<InstalledDependencies['setEnabled']>>>()
    const setEnabled = vi.fn().mockReturnValueOnce(answer.promise).mockResolvedValueOnce(refused('read-only profile'))
    const source = createInstalledSource(deps({ setEnabled }))
    await source.onRefresh()
    const toggling = source.onToggle('alpha', false)
    expect(source.hooks.installed.getSnapshot()).toMatchObject({ busy: ['alpha'], skills: [skill('alpha', false), skill('beta', false)] })
    answer.resolve({ ok: true, value: skill('alpha', false) })
    await toggling
    expect(source.hooks.installed.getSnapshot()).toMatchObject({ busy: [], failure: null, skills: [skill('alpha', false), skill('beta', false)] })
    await source.onToggle('beta', true)
    expect(source.hooks.installed.getSnapshot()).toMatchObject({ failure: 'read-only profile', skills: [skill('alpha', false), skill('beta', false)] })
    expect(setEnabled).toHaveBeenLastCalledWith('beta', true)
  })

  it('reveals and edits through the Host, recording a refusal until the next action or a dismissal', async () => {
    const edit = vi.fn().mockResolvedValueOnce(refused('no editor')).mockResolvedValueOnce(done)
    const d = deps({ edit })
    const source = createInstalledSource(d)
    await source.onEdit('alpha')
    expect(source.hooks.installed.getSnapshot().failure).toBe('no editor')
    await source.onReveal('alpha')
    expect(d.reveal).toHaveBeenCalledWith('alpha')
    expect(source.hooks.installed.getSnapshot().failure).toBeNull()
    await source.onEdit('alpha')
    await source.onEdit('alpha').catch(() => undefined)
    source.onDismissFailure()
    expect(source.hooks.installed.getSnapshot().failure).toBeNull()
  })

  it('drops an uninstalled skill only after the Host confirms the move', async () => {
    const uninstall = vi.fn().mockResolvedValueOnce(refused('locked')).mockResolvedValueOnce(done)
    const source = createInstalledSource(deps({ uninstall }))
    await source.onRefresh()
    await source.onUninstall('alpha')
    expect(source.hooks.installed.getSnapshot().skills.map(item => item.name)).toEqual(['alpha', 'beta'])
    await source.onUninstall('alpha')
    expect(source.hooks.installed.getSnapshot().skills.map(item => item.name)).toEqual(['beta'])
  })

  it('hands chat requests to the navigation dependency', () => {
    const d = deps()
    createInstalledSource(d).onChat('alpha')
    expect(d.chat).toHaveBeenCalledWith('alpha')
  })
})
