import { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { expect, it } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import type { BrandSettings } from '../src/client/QuickTasks.tsx'

/** The brand plugin over a recording sidebar; `workspace: false` leaves the sidebar service out. */
async function mount(workspace = true) {
  const defaults: string[] = []
  const settings = createSnapshotStore<{ status: string; value: BrandSettings | undefined }>({ status: 'loading', value: undefined })
  const ctx = new Context()
  ctx.provide('theme', { overrideTokens: () => () => {} } as never)
  ctx.provide('locale', { register: () => () => {}, bind: () => (key: string) => key } as never)
  ctx.provide('configForms', { get: () => settings } as never)
  if (workspace) {
    ctx.provide('uiWorkspace', {
      setDefaultSessionGrouping: (id: string) => {
        defaults.push(id)
        return () => { defaults.splice(defaults.lastIndexOf(id), 1) }
      },
    } as never)
  }
  await ctx.plugin(SlotRegistry).await()
  const fiber = await ctx.plugin({ inject, apply })
  const configure = (value: BrandSettings) => { settings.set({ status: 'ready', value }) }
  return { defaults, configure, dispose: () => fiber.dispose() }
}

it('makes the configured grouping the sidebar default, follows a change, and withdraws it with the plugin', async () => {
  const h = await mount()
  // Nothing is set before the settings arrive, or while none is configured.
  expect(h.defaults).toEqual([])
  h.configure({ defaultSessionGrouping: '' })
  expect(h.defaults).toEqual([])
  h.configure({ defaultSessionGrouping: 'assistant' })
  expect(h.defaults).toEqual(['assistant'])
  // An unrelated settings change keeps the one default in place.
  h.configure({ defaultSessionGrouping: 'assistant', quickTasks: [] })
  expect(h.defaults).toEqual(['assistant'])
  h.configure({ defaultSessionGrouping: 'date' })
  expect(h.defaults).toEqual(['date'])
  h.configure({})
  expect(h.defaults).toEqual([])
  h.configure({ defaultSessionGrouping: 'assistant' })
  await h.dispose()
  expect(h.defaults).toEqual([])
})

it('leaves the brand in place without the sidebar service', async () => {
  const h = await mount(false)
  h.configure({ defaultSessionGrouping: 'assistant' })
  expect(h.defaults).toEqual([])
  await h.dispose()
})
