// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { apply, inject } from '../src/client/index.ts'
import { MoBrandMark, MoWordmark } from '../src/client/Brand.tsx'
import { QuickTasks } from '../src/client/QuickTasks.tsx'
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
      'conversation.composer.dock': { kind: 'list', scope: 'root' },
    },
  } as never, () => null)
  const fiber = await ctx.plugin({ inject, apply })
  expect(inject).toEqual(['theme', 'slots', 'locale', 'configForms'])
  expect(slots.entries('sidebar.brand.mark')[0]?.component).toBe(MoBrandMark)
  expect(slots.entries('sidebar.brand.name')[0]?.component).toBe(MoWordmark)
  const [dock] = slots.entries('conversation.composer.dock')
  expect(dock?.component).toBe(QuickTasks)
  expect(dock?.options).toMatchObject({ id: 'mo-quick-tasks' })
  expect(Object.keys((dock!.inject!() as { hooks: object }).hooks)).toEqual(['brandSettings'])
  await fiber.dispose()
  expect(slots.entries('sidebar.brand.mark')).toEqual([])
  expect(slots.entries('sidebar.brand.name')).toEqual([])
  expect(slots.entries('conversation.composer.dock')).toEqual([])
  disposeHoles()
})
