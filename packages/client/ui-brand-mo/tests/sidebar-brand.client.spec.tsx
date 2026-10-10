// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { apply, inject } from '../src/client/index.ts'
import { MoBrandMark, MoWordmark } from '../src/client/Brand.tsx'
import { QuickTasks, type QuickTasksInjected } from '../src/client/QuickTasks.tsx'
import { MO_MARK } from '../src/mark.ts'
import { MO_WORDMARK } from '../src/wordmark.ts'

afterEach(cleanup)

it('draws only the wordmark in the expanded row: no mark beside it', () => {
  expect(render(<MoBrandMark size={24} placement="row" />).container.innerHTML).toBe('')
  const img = render(<MoWordmark />).container.querySelector('img')!
  expect(img.getAttribute('src')).toBe(MO_WORDMARK)
  // Decorative: the sidebar hides the brand row from assistive technology.
  expect(img.alt).toBe('')
})

it('keeps the app icon on the collapsed rail', () => {
  const img = render(<MoBrandMark size={24} placement="rail" />).container.querySelector('img')!
  expect(img.getAttribute('src')).toBe(MO_MARK)
  expect(img).toMatchObject({ width: 24, height: 24 })
})

it('occupies both sidebar brand slots and the quick-task dock until unloaded', async () => {
  const ctx = new Context()
  ctx.provide('theme', { overrideTokens: () => () => {} } as never)
  ctx.provide('locale', { register: () => () => {}, bind: () => (key: string) => key } as never)
  ctx.provide('configForms', { get: () => ({ getSnapshot: () => ({ status: 'loading', value: undefined }), subscribe: () => () => {} }) } as never)
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  const disposeHoles = slots.register({
    name: 'root',
    children: {
      'sidebar.brand.mark': { kind: 'single', scope: 'root' },
      'sidebar.brand.name': { kind: 'single', scope: 'root' },
      'conversation.hero.dock': { kind: 'list', scope: 'root' },
    },
  } as never, () => null)
  const fiber = await ctx.plugin({ inject, apply })
  expect(inject).toEqual(['theme', 'slots'])
  expect(slots.entries('sidebar.brand.mark')[0]?.component).toBe(MoBrandMark)
  expect(slots.entries('sidebar.brand.name')[0]?.component).toBe(MoWordmark)
  const [dock] = slots.entries('conversation.hero.dock')
  expect(dock?.component).toBe(QuickTasks)
  expect(dock?.options).toMatchObject({ id: 'mo-quick-tasks' })
  const face = dock!.inject!() as { hooks: object; pickAssistant: QuickTasksInjected['pickAssistant'] }
  expect(Object.keys(face.hooks)).toEqual(['brandSettings'])
  // Without the assistants UI a card only fills the draft; with it, the card picks by template.
  face.pickAssistant('ecommerce')
  const pickTemplate = vi.fn(async () => true)
  ctx.provide('assistantPicker', { pickTemplate })
  face.pickAssistant('ecommerce')
  expect(pickTemplate).toHaveBeenCalledWith('ecommerce')
  await fiber.dispose()
  expect(slots.entries('sidebar.brand.mark')).toEqual([])
  expect(slots.entries('sidebar.brand.name')).toEqual([])
  expect(slots.entries('conversation.hero.dock')).toEqual([])
  disposeHoles()
})

it('keeps the theme and the brand row without the settings forms, offering no quick tasks', async () => {
  const ctx = new Context()
  const layers: string[] = []
  ctx.provide('theme', { overrideTokens: (source: string) => { layers.push(source); return () => {} } } as never)
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  const disposeHoles = slots.register({
    name: 'root',
    children: {
      'sidebar.brand.mark': { kind: 'single', scope: 'root' },
      'sidebar.brand.name': { kind: 'single', scope: 'root' },
      'conversation.hero.dock': { kind: 'list', scope: 'root' },
    },
  } as never, () => null)
  const fiber = await ctx.plugin({ inject, apply })
  expect(layers).toEqual(['@deepseek-ai/dsh-client-ui-brand-mo'])
  expect(slots.entries('sidebar.brand.name')[0]?.component).toBe(MoWordmark)
  expect(slots.entries('conversation.hero.dock')).toEqual([])
  await fiber.dispose()
  disposeHoles()
})
