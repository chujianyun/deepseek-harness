// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate, RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { TaskFormOptions } from '../src/client/form-options.ts'
import { en, zh } from '../src/client/locales.ts'
import { TaskForm, type TaskFormProps } from '../src/client/TaskForm.tsx'

afterEach(cleanup)

const OPTIONS: TaskFormOptions = {
  assistants: [{ value: 'a-shop', label: '电商管家' }],
  models: [{ value: JSON.stringify(['deepseek', 'v4']), label: 'DeepSeek · V4' }],
  permissions: [{ value: 'workspace-write', label: 'workspace-write' }, { value: 'full-access', label: '完全访问' }],
  defaultPermission: 'workspace-write',
  connectors: ['feishu', 'other'],
}
const RECORD = { id: 'schedule-1', kind: 'daily', title: '店铺日报', prompt: '导出', time: '09:00:00.000', timeZone: 'UTC', scheduledAt: '2026-10-11T09:00:00.000Z' }

/** A complete workspace view with only its id and title varying. */
const view = (workspaceId: string, title: string): WorkspaceSnapshot['items'][number] => ({
  workspaceId: workspaceId as WorkspaceSnapshot['items'][number]['workspaceId'], path: `/tmp/${workspaceId}`, title, sessionIds: [],
  createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z',
})

function workspaces(items: { workspaceId: string; title: string }[]) {
  const snapshot: WorkspaceSnapshot = {
    items: items.map(item => view(item.workspaceId, item.title)), archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null,
  }
  return createSnapshotStore(snapshot)
}

function mount(options: { copy?: typeof zh; loaded?: TaskFormOptions; spaces?: { workspaceId: string; title: string }[] } = {}) {
  const store = workspaces(options.spaces ?? [{ workspaceId: 'ws-1', title: '默认工作区' }, { workspaceId: 'ws-2', title: '店铺' }])
  const onDone = vi.fn()
  const onCreate = vi.fn<TaskFormProps['onCreate']>(async () => ({ ok: true, value: { sessionId: 's-1' as never, record: RECORD as never } }))
  const props = {
    t: makeTranslate(options.copy ?? zh),
    onDone,
    useWorkspaces: bindSnapshotSelector(store),
    loadOptions: vi.fn(async () => options.loaded ?? OPTIONS),
    onCreate,
  } as Partial<TaskFormProps> as TaskFormProps
  const view = render(<TaskForm {...props} />)
  return { onDone, onCreate, store, view }
}

const field = (name: string) => screen.getByLabelText<HTMLInputElement & HTMLSelectElement & HTMLTextAreaElement>(name)
const fill = (name: string, value: string) => { fireEvent.change(field(name), { target: { value } }) }

describe('the Add automation task form', () => {
  it('loads, then saves a daily task with the chosen assistant, model, permission, and connector, and hands it to the page', async () => {
    const h = mount()
    expect(screen.getByRole('status').textContent).toBe(zh.loading)
    await screen.findByRole('form', { name: zh['breadcrumb.current'] })
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(zh['breadcrumb.current'])
    expect(field(zh['field.workspace']).value).toBe('ws-1')
    expect(field(zh['field.permission']).value).toBe('workspace-write')
    // A built-in preset is named in the UI language; another keeps the catalog's name.
    expect([...field(zh['field.permission']).options].map(option => option.textContent)).toEqual(['工作区内修改', '完全访问'])
    fill(zh['field.title'], '店铺日报')
    fill(zh['field.workspace'], 'ws-2')
    fill(zh['field.prompt'], '导出昨日日报')
    fill(zh['field.assistant'], 'a-shop')
    fill(zh['field.model'], JSON.stringify(['deepseek', 'v4']))
    fill(zh['field.permission'], 'full-access')
    fireEvent.click(screen.getByLabelText(zh['connector.feishu']))
    fill(zh['time.label'], '08:30')
    fill(zh['window.end'], '2026-12-31')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['action.save'] })) })
    expect(h.onCreate).toHaveBeenCalledWith({
      title: '店铺日报', prompt: '导出昨日日报', workspaceId: 'ws-2', assistantId: 'a-shop', model: { provider: 'deepseek', model: 'v4' },
      permission: 'full-access', connectors: ['feishu'],
      timing: { kind: 'daily', daily: { time: '08:30:00', time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone } },
      window: { end: '2026-12-31', time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    })
    expect(h.onDone).toHaveBeenCalledWith({ sessionId: 's-1', id: 'schedule-1' })
  })

  it('shows each problem under its field and sends nothing', async () => {
    const h = mount({ copy: en })
    await screen.findByRole('form')
    fireEvent.click(screen.getByRole('button', { name: en['action.save'] }))
    expect(screen.getAllByRole('alert').map(alert => alert.textContent)).toEqual([en['error.titleRequired'], en['error.promptRequired']])
    expect(h.onCreate).not.toHaveBeenCalled()
    // Editing a field clears only its own message.
    fill(en['field.title'], 'Report')
    expect(screen.getAllByRole('alert').map(alert => alert.textContent)).toEqual([en['error.promptRequired']])
  })

  it('switches between recurring, interval, and once, and picks weekdays', async () => {
    const h = mount()
    await screen.findByRole('form')
    fill(zh['field.title'], '周报')
    fill(zh['field.prompt'], '汇总本周')
    fill(zh['repeat.label'], 'weekly')
    const days = screen.getByRole('group', { name: zh['weekdays.label'] })
    fireEvent.click(within(days).getByRole('button', { name: zh['weekday.1'] }))
    fireEvent.click(within(days).getByRole('button', { name: zh['weekday.1'] }))
    expect(within(days).getByRole('button', { name: zh['weekday.1'] }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(within(days).getByRole('button', { name: zh['weekday.5'] }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['action.save'] })) })
    expect(h.onCreate.mock.calls[0]![0].timing).toMatchObject({ kind: 'weekly', weekly: { weekdays: [1, 5] } })
    // Interval.
    fireEvent.click(screen.getByRole('tab', { name: zh['mode.interval'] }))
    fill(zh['interval.value'], '15')
    fill(zh['interval.unit'], 'minutes')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['action.save'] })) })
    expect(h.onCreate.mock.calls[1]![0].timing).toEqual({ kind: 'every', every_seconds: 900 })
    // Once.
    fireEvent.click(screen.getByRole('tab', { name: zh['mode.once'] }))
    fill(zh['date.label'], '2026-10-20')
    fill(zh['time.label'], '10:00')
    fill(zh['window.start'], '2026-10-01')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['action.save'] })) })
    expect(h.onCreate.mock.calls[2]![0]).toMatchObject({ timing: { kind: 'at', at: { date: '2026-10-20', time: '10:00:00' } }, window: { start: '2026-10-01' } })
  })

  it('keeps what was entered and explains a refused save, then a failed one', async () => {
    const h = mount()
    await screen.findByRole('form')
    fill(zh['field.title'], '过期任务')
    fill(zh['field.prompt'], '不会执行')
    h.onCreate.mockResolvedValueOnce({ ok: false, error: new RemoteError('automation-tasks/invalid', 'none', { code: 'invalid_rule' }) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['action.save'] })) })
    expect(screen.getByRole('alert').textContent).toBe(zh['error.outsideWindow'])
    expect(field(zh['field.title']).value).toBe('过期任务')
    expect(h.onDone).not.toHaveBeenCalled()
    h.onCreate.mockRejectedValueOnce(new Error('connection lost'))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['action.save'] })) })
    expect(screen.getByRole('alert').textContent).toBe('保存失败：connection lost')
    h.onCreate.mockRejectedValueOnce('dropped')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['action.save'] })) })
    expect(screen.getByRole('alert').textContent).toBe('保存失败：dropped')
  })

  it('disables both buttons while saving, and cancels back to the page', async () => {
    const h = mount()
    await screen.findByRole('form')
    fill(zh['field.title'], '日报')
    fill(zh['field.prompt'], '导出')
    let release: () => void = () => {}
    h.onCreate.mockImplementationOnce(() => new Promise((resolve) => { release = () => { resolve({ ok: true, value: { sessionId: 's-2' as never, record: RECORD as never } }) } }))
    fireEvent.click(screen.getByRole('button', { name: zh['action.save'] }))
    expect(screen.getByRole('button', { name: zh['action.saving'] }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: zh['action.cancel'] }).hasAttribute('disabled')).toBe(true)
    await act(async () => { release() })
    expect(h.onDone).toHaveBeenCalledWith({ sessionId: 's-2', id: 'schedule-1' })
    cleanup()
    const again = mount()
    await screen.findByRole('form')
    fireEvent.click(screen.getByRole('button', { name: zh['action.cancel'] }))
    expect(again.onDone).toHaveBeenCalledWith(undefined)
  })

  it('dismisses the notice, and says so when no connector is connected', async () => {
    mount({ copy: en, loaded: { ...OPTIONS, connectors: [], permissions: [] } })
    await screen.findByRole('form')
    expect(screen.getByRole('note').textContent).toContain(en['notice.text'])
    fireEvent.click(screen.getByRole('button', { name: en['notice.dismiss'] }))
    expect(screen.queryByRole('note')).toBeNull()
    expect(screen.getByText(en['field.connectorsNone'])).toBeDefined()
    expect(screen.queryByLabelText(en['field.permission'])).toBeNull()
  })

  it('fills the workspace once the list arrives, and unchecks a connector', async () => {
    const h = mount({ spaces: [] })
    await screen.findByRole('form')
    expect(field(zh['field.workspace']).value).toBe('')
    act(() => { h.store.set({ ...h.store.getSnapshot(), items: [view('ws-9', '新工作区')] }) })
    await waitFor(() => { expect(field(zh['field.workspace']).value).toBe('ws-9') })
    fireEvent.click(screen.getByLabelText('other'))
    fireEvent.click(screen.getByLabelText('other'))
    fill(zh['field.title'], '日报')
    fill(zh['field.prompt'], '导出')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['action.save'] })) })
    expect(h.onCreate.mock.calls[0]![0]).not.toHaveProperty('connectors')
  })

  it('stops after the page has gone', async () => {
    const h = mount()
    await screen.findByRole('form')
    fill(zh['field.title'], '日报')
    fill(zh['field.prompt'], '导出')
    let release: () => void = () => {}
    h.onCreate.mockImplementationOnce(() => new Promise((resolve) => { release = () => { resolve({ ok: true, value: { sessionId: 's-3' as never, record: RECORD as never } }) } }))
    fireEvent.click(screen.getByRole('button', { name: zh['action.save'] }))
    h.view.unmount()
    await act(async () => { release() })
    expect(h.onDone).not.toHaveBeenCalled()
  })
})

describe('closing before the options arrive', () => {
  it('drops the late options', async () => {
    let deliver: (options: TaskFormOptions) => void = () => {}
    const props = {
      t: makeTranslate(zh), onDone: vi.fn(), useWorkspaces: bindSnapshotSelector(workspaces([])), onCreate: vi.fn(),
      loadOptions: () => new Promise<TaskFormOptions>((resolve) => { deliver = resolve }),
    } as Partial<TaskFormProps> as TaskFormProps
    const view = render(<TaskForm {...props} />)
    view.unmount()
    await act(async () => { deliver(OPTIONS) })
    expect(screen.queryByRole('form')).toBeNull()
  })
})
