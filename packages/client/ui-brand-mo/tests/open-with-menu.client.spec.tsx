// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { apply, inject } from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'
import { OpenWithMenu } from '../src/client/OpenWithMenu.tsx'

afterEach(cleanup)

const translate = (dictionary: Record<string, string>) => ((key: string) => dictionary[key] ?? key) as never

it.each([[zh, '打开方式', '用默认应用打开', '在文件夹中打开'], [en, 'Open with', 'Open with default app', 'Show in folder']] as const)(
  'opens a two-item menu and runs the chosen native action (%#)',
  async (dictionary, label, openLabel, revealLabel) => {
    const onAction = vi.fn(async () => null)
    const view = render(<OpenWithMenu available pending={false} onAction={onAction} t={translate(dictionary)} />)
    fireEvent.click(view.getByRole('button', { name: label }))
    const items = view.getAllByRole('menuitem').map(item => item.textContent)
    expect(items).toEqual([openLabel, revealLabel])
    fireEvent.click(view.getByRole('menuitem', { name: revealLabel }))
    expect(onAction).toHaveBeenLastCalledWith('reveal')
    expect(view.queryByRole('menuitem')).toBeNull()
    fireEvent.click(view.getByRole('button', { name: label }))
    fireEvent.click(view.getByRole('menuitem', { name: openLabel }))
    expect(onAction).toHaveBeenLastCalledWith('open')
    // A second press on the button closes an open menu.
    fireEvent.click(view.getByRole('button', { name: label }))
    fireEvent.click(view.getByRole('button', { name: label }))
    expect(view.queryByRole('menuitem')).toBeNull()
  },
)

it('closes on Escape without running an action', () => {
  const onAction = vi.fn(async () => null)
  const view = render(<OpenWithMenu available pending={false} onAction={onAction} t={translate(zh)} />)
  fireEvent.click(view.getByRole('button', { name: '打开方式' }))
  fireEvent.keyDown(view.getByRole('menuitem', { name: '用默认应用打开' }), { key: 'Escape' })
  expect(view.queryByRole('menuitem')).toBeNull()
  expect(onAction).not.toHaveBeenCalled()
})

it('is disabled while a request runs and absent without a desktop that can open files', () => {
  const busy = render(<OpenWithMenu available pending onAction={vi.fn()} t={translate(zh)} />)
  expect((busy.getByRole('button', { name: '打开方式' }) as HTMLButtonElement).disabled).toBe(true)
  cleanup()
  expect(render(<OpenWithMenu available={false} pending={false} onAction={vi.fn()} t={translate(zh)} />).container.innerHTML).toBe('')
})

it('occupies the delivered-file and changed-file review action slots until unloaded', async () => {
  const ctx = new Context()
  ctx.provide('theme', { overrideTokens: () => () => {} } as never)
  ctx.provide('locale', { register: () => () => {}, bind: () => (key: string) => key } as never)
  ctx.provide('configForms', { get: () => ({ getSnapshot: () => ({ status: 'loading', value: undefined }), subscribe: () => () => {} }) } as never)
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  const disposeHoles = slots.register({
    name: 'root',
    children: {
      'deliverables.file.actions': { kind: 'list', scope: 'root' },
      'deliverables.review.file.actions': { kind: 'list', scope: 'root' },
    },
  } as never, () => null)
  const fiber = await ctx.plugin({ inject, apply })
  expect(slots.entries('deliverables.file.actions').map(entry => [entry.component, entry.options])).toEqual([[OpenWithMenu, expect.objectContaining({ id: 'mo-open-with' })]])
  expect(slots.entries('deliverables.review.file.actions').map(entry => entry.component)).toEqual([OpenWithMenu])
  await fiber.dispose()
  expect(slots.entries('deliverables.file.actions')).toEqual([])
  disposeHoles()
})
