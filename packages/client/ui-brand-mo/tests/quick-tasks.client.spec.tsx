// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { QuickTasks, type QuickTasksProps } from '../src/client/QuickTasks.tsx'
import { en, zh } from '../src/client/locales.ts'
import type { QuickTaskId } from '../src/quick-tasks.ts'

afterEach(cleanup)

interface MountOptions {
  blank?: boolean
  promptAttempted?: boolean
  tasks?: readonly QuickTaskId[]
  copy?: typeof zh
  loading?: boolean
}

function mount(options: MountOptions = {}) {
  const setDraft = vi.fn()
  const session = { blank: options.blank ?? true, promptAttempted: options.promptAttempted ?? false, running: false }
  const settings = options.loading === true
    ? { status: 'loading' as const, value: undefined }
    : { status: 'ready' as const, value: { quickTasks: options.tasks ?? ['multi-publish', 'business-report', 'product-research', 'asset-organize'] } }
  // Only the props the cards read; the rest of the Session-scope runtime is not exercised.
  const props: Partial<QuickTasksProps> = {
    t: makeTranslate(options.copy ?? zh),
    useSession: bindSnapshotSelector(createSnapshotStore(session)) as QuickTasksProps['useSession'],
    inputActions: { setDraft } as Partial<QuickTasksProps['inputActions']> as QuickTasksProps['inputActions'],
    useBrandSettings: bindSnapshotSelector(createSnapshotStore(settings)) as QuickTasksProps['useBrandSettings'],
  }
  render(<QuickTasks {...props as QuickTasksProps} />)
  return { setDraft }
}

it('offers the configured tasks in order on a blank Session and fills the draft without sending', () => {
  const { setDraft } = mount({ tasks: ['asset-organize', 'multi-publish'] })
  const cards = screen.getAllByRole('button')
  expect(cards.map(card => card.getAttribute('data-task'))).toEqual(['asset-organize', 'multi-publish'])
  expect(cards[0]!.textContent).toBe(`商${zh['asset-organize.title']}${zh['asset-organize.description']}`)
  fireEvent.click(cards[1]!)
  expect(setDraft).toHaveBeenCalledWith(zh['multi-publish.prompt'])
})

it('writes the prompt in the active language', () => {
  const { setDraft } = mount({ copy: en, tasks: ['business-report'] })
  fireEvent.click(screen.getByRole('button', { name: new RegExp(en['business-report.title']) }))
  expect(setDraft).toHaveBeenCalledWith(en['business-report.prompt'])
})

it('shows nothing once the Session left the blank state or with no task configured', () => {
  mount({ blank: false })
  expect(screen.queryByRole('list')).toBeNull()
  cleanup()
  mount({ promptAttempted: true })
  expect(screen.queryByRole('list')).toBeNull()
  cleanup()
  mount({ tasks: [] })
  expect(screen.queryByRole('list')).toBeNull()
  cleanup()
  // Before the settings section arrives, nothing flashes in.
  mount({ loading: true })
  expect(screen.queryByRole('list')).toBeNull()
})

it('has a title, description, and prompt in both languages for every task', () => {
  for (const id of ['multi-publish', 'business-report', 'product-research', 'asset-organize'] as const) {
    for (const field of ['title', 'description', 'prompt'] as const) {
      expect(zh[`${id}.${field}`]).not.toBe('')
      expect(en[`${id}.${field}`]).not.toBe('')
    }
  }
})
