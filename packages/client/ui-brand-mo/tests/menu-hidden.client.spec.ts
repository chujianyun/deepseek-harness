import { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { expect, it } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import type { BrandSettings } from '../src/client/QuickTasks.tsx'

/** The brand plugin over a recording command UI; `commands: false` leaves the command UI out. */
async function mount(commands = true) {
  const hidden: string[] = []
  const settings = createSnapshotStore<{ status: string; value: BrandSettings | undefined }>({ status: 'loading', value: undefined })
  const ctx = new Context()
  ctx.provide('theme', { overrideTokens: () => () => {} } as never)
  ctx.provide('locale', { register: () => () => {}, bind: () => (key: string) => key } as never)
  ctx.provide('configForms', { get: () => settings } as never)
  if (commands) {
    ctx.provide('commandUi', {
      hideFromMenu: (name: string) => {
        hidden.push(name)
        return () => { hidden.splice(hidden.lastIndexOf(name), 1) }
      },
    } as never)
  }
  await ctx.plugin(SlotRegistry).await()
  const fiber = await ctx.plugin({ inject, apply })
  const configure = (value: BrandSettings) => { settings.set({ status: 'ready', value }) }
  return { hidden, configure, dispose: () => fiber.dispose() }
}

it('leaves the configured commands out of the + menu, follows a change, and puts them back with the plugin', async () => {
  const h = await mount()
  // Nothing is hidden before the settings arrive, or while none is configured.
  expect(h.hidden).toEqual([])
  h.configure({ menuHiddenCommands: [] })
  expect(h.hidden).toEqual([])
  h.configure({ menuHiddenCommands: ['feedback'] })
  expect(h.hidden).toEqual(['feedback'])
  // An unrelated settings change keeps the one registration in place.
  h.configure({ menuHiddenCommands: ['feedback'], quickTasks: [] })
  expect(h.hidden).toEqual(['feedback'])
  h.configure({ menuHiddenCommands: ['feedback', 'goal'] })
  expect(h.hidden).toEqual(['feedback', 'goal'])
  h.configure({})
  expect(h.hidden).toEqual([])
  h.configure({ menuHiddenCommands: ['feedback'] })
  await h.dispose()
  expect(h.hidden).toEqual([])
})

it('leaves the brand in place without the command UI', async () => {
  const h = await mount(false)
  h.configure({ menuHiddenCommands: ['feedback'] })
  expect(h.hidden).toEqual([])
  await h.dispose()
})
