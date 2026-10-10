// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
  draft?: string
  occurrences?: number
  attachments?: number
  assistant?: string
  found?: boolean
}

function mount(options: MountOptions = {}) {
  const setDraft = vi.fn()
  const pickAssistant = vi.fn(async (_templateId: string) => options.found ?? true)
  const input = {
    draft: options.draft ?? '',
    occurrences: Array.from({ length: options.occurrences ?? 0 }),
    attachmentIds: Array.from({ length: options.attachments ?? 0 }),
  }
  const session = { blank: options.blank ?? true, promptAttempted: options.promptAttempted ?? false, running: false }
  const settings = options.loading === true
    ? { status: 'loading' as const, value: undefined }
    : {
      status: 'ready' as const,
      value: {
        quickTasks: options.tasks ?? ['multi-publish', 'business-report', 'product-research', 'asset-organize'],
        quickTaskAssistant: options.assistant ?? 'ecommerce',
      },
    }
  // Only the props the cards read; the rest of the Session-scope runtime is not exercised.
  const props: Partial<QuickTasksProps> = {
    t: makeTranslate(options.copy ?? zh),
    useSession: bindSnapshotSelector(createSnapshotStore(session)) as QuickTasksProps['useSession'],
    useInput: bindSnapshotSelector(createSnapshotStore(input)) as Partial<QuickTasksProps['useInput']> as QuickTasksProps['useInput'],
    inputActions: { setDraft } as Partial<QuickTasksProps['inputActions']> as QuickTasksProps['inputActions'],
    useBrandSettings: bindSnapshotSelector(createSnapshotStore(settings)) as QuickTasksProps['useBrandSettings'],
    pickAssistant,
  }
  render(<QuickTasks {...props as QuickTasksProps} />)
  return { setDraft, pickAssistant }
}

it('offers the configured tasks in order on a blank Session, picks the configured assistant, and fills the draft without sending', async () => {
  const { setDraft, pickAssistant } = mount({ tasks: ['asset-organize', 'multi-publish'] })
  const cards = screen.getAllByRole('button')
  expect(cards.map(card => card.getAttribute('data-task'))).toEqual(['asset-organize', 'multi-publish'])
  expect(cards[0]!.textContent).toBe(`商${zh['asset-organize.title']}${zh['asset-organize.description']}`)
  fireEvent.click(cards[1]!)
  expect(pickAssistant).toHaveBeenCalledWith('ecommerce')
  // The prompt lands only after the pick resolves.
  expect(setDraft).not.toHaveBeenCalled()
  await waitFor(() => { expect(setDraft).toHaveBeenCalledWith(zh['multi-publish.prompt']) })
})

it.each([zh, en])('fills nothing and says so when the tenant has no assistant from the template', async (copy) => {
  const { setDraft, pickAssistant } = mount({ found: false, copy })
  fireEvent.click(screen.getAllByRole('button')[0]!)
  expect((await screen.findByRole('alert')).textContent).toBe(copy.missingAssistant)
  expect(pickAssistant).toHaveBeenCalledOnce()
  expect(setDraft).not.toHaveBeenCalled()
})

it('keeps the current assistant when no template is configured', async () => {
  const { setDraft, pickAssistant } = mount({ assistant: '' })
  fireEvent.click(screen.getAllByRole('button')[0]!)
  await waitFor(() => { expect(setDraft).toHaveBeenCalledOnce() })
  expect(pickAssistant).not.toHaveBeenCalled()
})

it('writes the prompt in the active language', async () => {
  const { setDraft } = mount({ copy: en, tasks: ['business-report'] })
  fireEvent.click(screen.getByRole('button', { name: new RegExp(en['business-report.title']) }))
  await waitFor(() => { expect(setDraft).toHaveBeenCalledWith(en['business-report.prompt']) })
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
  // A draft, a reference, or an attachment the user entered is never replaced by a card.
  mount({ draft: '写一份周报' })
  expect(screen.queryByRole('list')).toBeNull()
  cleanup()
  mount({ occurrences: 1 })
  expect(screen.queryByRole('list')).toBeNull()
  cleanup()
  mount({ attachments: 1 })
  expect(screen.queryByRole('list')).toBeNull()
  cleanup()
  mount({ draft: '  ' })
  expect(screen.getByRole('list')).toBeTruthy()
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

it('shows a repeated task id once', () => {
  mount({ tasks: ['multi-publish', 'multi-publish', 'asset-organize'] })
  expect(screen.getAllByRole('button').map(card => card.getAttribute('data-task'))).toEqual(['multi-publish', 'asset-organize'])
})
