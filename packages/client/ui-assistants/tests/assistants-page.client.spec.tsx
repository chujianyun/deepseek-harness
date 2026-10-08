// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { AssistantDetail, AssistantsState, UpdateAssistantInput } from '@deepseek-ai/dsh-assistants/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { AssistantsSnapshot } from '../src/client/assistants-source.ts'
import { AssistantsPage } from '../src/client/AssistantsPage.tsx'
import { en, zh } from '../src/client/locales.ts'

afterEach(() => { cleanup() })

const state: AssistantsState = {
  revision: 1, tenantId: 't-a', defaultId: 'a1', templates: [{ id: 'daily', name: '日常助手', description: 'd', avatar: { kind: 'preset', key: 'sun' } }],
  assistants: [
    { id: 'a1', name: '日常助手', description: '通用日常助手', avatar: { kind: 'preset', key: 'sun' }, createdAt: '2026-10-07T00:00:00Z' },
    { id: 'a2', name: '电商管家', description: '', avatar: { kind: 'preset', key: 'moon' }, createdAt: '2026-10-07T00:00:01Z' },
  ],
}

function mount(value: AssistantsState | undefined, extra: Partial<AssistantsSnapshot> = {}, copy: Record<string, string> = zh) {
  const initial: AssistantsSnapshot = {
    state: value, bound: null, staged: undefined, busy: false, failure: null, elsewhere: { asked: [], otherTenant: [] },
  }
  const store = createSnapshotStore<AssistantsSnapshot>({ ...initial, ...extra })
  const sessions = createSnapshotStore<SessionListState>({ ids: [], byId: {}, phase: 'ready', projectionsBySession: {} } as never)
  const props = {
    t: makeTranslate(copy), useAssistants: bindSnapshotSelector(store), useSessions: bindSnapshotSelector(sessions),
    onOpenSession: vi.fn(),
    onPick: vi.fn(async (_id: string) => {}), onChat: vi.fn(async (_id: string) => {}), onDismiss: vi.fn(),
    onCreate: vi.fn(async () => undefined), onLoadOptions: vi.fn(async () => ({ models: [], presets: [] })),
    squareAvatar: vi.fn(async () => 'data:image/webp;base64,AA'),
    onRead: vi.fn(async (assistantId: string): Promise<AssistantDetail | string> => ({
      assistant: (value?.assistants ?? []).find(item => item.id === assistantId)!, files: FILES,
    })),
    onUpdate: vi.fn(async (_id: string, _input: UpdateAssistantInput): Promise<string | undefined> => undefined),
    onSetDefault: vi.fn(async (_id: string): Promise<string | undefined> => undefined),
    onDuplicate: vi.fn(async (_id: string): Promise<{ assistantId: string } | string> => ({ assistantId: 'a2' })),
    onDelete: vi.fn(async (_id: string): Promise<string | undefined> => undefined),
    sessionCount: vi.fn((_id: string) => 4),
  }
  const view = render(<AssistantsPage {...props} />)
  return { ...props, store, rerender: () => { view.rerender(<AssistantsPage {...props} />) } }
}

const FILES = { 'IDENTITY.md': '# 身份\n', 'SOUL.md': '# 人格\n', 'USER.md': '# 用户信息\n', 'AGENTS.md': '# 工作方法\n' }
const card = (name: string) => screen.getByText(name, { selector: 'span' }).closest('li')!

describe('assistants page', () => {
  it('shows only the header before the first frame', () => {
    mount(undefined)
    expect(screen.getByRole('heading', { name: '智能体' })).toBeTruthy()
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('lists the cards with the default tag, a placeholder description, and the avatar initial', () => {
    mount(state)
    expect(screen.getByText('2 个智能体')).toBeTruthy()
    const daily = screen.getByText('日常助手').closest('li')!
    expect(daily.textContent).toContain('默认')
    expect(daily.textContent).toContain('通用日常助手')
    expect(daily.querySelector('[data-tone="sun"]')!.textContent).toBe('日')
    const shop = screen.getByText('电商管家').closest('li')!
    expect(shop.textContent).toContain('暂无描述')
    expect(within(shop).getByRole('button', { name: '查看 电商管家 的详情' }).textContent).not.toContain('默认')
    expect(shop.querySelector('[data-tone="neutral"]')).toBeTruthy()
  })

  it('draws an empty initial for a blank name', () => {
    mount({ ...state, assistants: [{ ...state.assistants[0]!, name: ' ' }] })
    expect(document.querySelector('[data-tone="sun"]')!.textContent).toBe('')
  })

  it('opens the creation wizard from the header and closes it', async () => {
    const props = mount(state)
    fireEvent.click(screen.getByRole('button', { name: '新建智能体' }))
    expect(screen.getByRole('dialog', { name: '新建智能体' })).toBeTruthy()
    await act(async () => { await Promise.resolve() })
    expect(props.onLoadOptions).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    cleanup()
    mount({ ...state, tenantId: null, assistants: [] })
    expect(screen.queryByRole('button', { name: '新建智能体' })).toBeNull()
  })

  it('draws an uploaded avatar as an image', () => {
    mount({ ...state, assistants: [{ ...state.assistants[0]!, avatar: { kind: 'image', dataUrl: 'data:image/webp;base64,AA' } }] })
    expect(document.querySelector('img[src="data:image/webp;base64,AA"]')).toBeTruthy()
  })

  it('opens a new session from a card', () => {
    const props = mount(state)
    fireEvent.click(within(card('电商管家')).getByRole('button', { name: '对话' }))
    expect(props.onChat).toHaveBeenCalledWith('a2')
  })

  it('filters by name and description, and says when nothing matches', () => {
    mount(state)
    const search = screen.getByRole('textbox', { name: '搜索智能体' })
    fireEvent.change(search, { target: { value: '通用' } })
    expect(screen.queryByText('电商管家')).toBeNull()
    expect(screen.getByText('日常助手')).toBeTruthy()
    fireEvent.change(search, { target: { value: 'zzz' } })
    expect(screen.getByText('没有找到匹配的智能体，试试别的关键词。')).toBeTruthy()
  })

  it('says when the tenant has none, and when signed out', () => {
    mount({ ...state, defaultId: null, assistants: [] })
    expect(screen.getByText('还没有智能体。')).toBeTruthy()
    cleanup()
    mount({ ...state, tenantId: null, defaultId: null, assistants: [] })
    expect(screen.getByText('登录用户中心后可以使用智能体。')).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('shows a refused action until dismissed, in English too', () => {
    const props = mount(state, { failure: 'gone' }, en)
    expect(screen.getByRole('alert').textContent).toContain('Could not switch the assistant: gone')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(props.onDismiss).toHaveBeenCalledOnce()
    expect(screen.getByText('Assistants', { selector: 'h1' })).toBeTruthy()
  })
})

describe('managing assistants on the page', () => {
  it('sets the default, duplicates, and offers no Make default on the default card', async () => {
    const props = mount(state)
    expect(within(card('日常助手')).queryByRole('button', { name: '设为默认' })).toBeNull()
    await act(async () => { fireEvent.click(within(card('电商管家')).getByRole('button', { name: '设为默认' })) })
    expect(props.onSetDefault).toHaveBeenCalledWith('a2')
    await act(async () => { fireEvent.click(within(card('日常助手')).getByRole('button', { name: '复制' })) })
    expect(props.onDuplicate).toHaveBeenCalledWith('a1')
    expect(screen.getByRole('heading', { name: '智能体' })).toBeTruthy()
  })

  it('shows a refused action until dismissed', async () => {
    const props = mount(state)
    props.onSetDefault.mockResolvedValueOnce('gone')
    await act(async () => { fireEvent.click(within(card('电商管家')).getByRole('button', { name: '设为默认' })) })
    expect(screen.getByRole('alert').textContent).toContain('操作失败：gone')
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(screen.queryByRole('alert')).toBeNull()
    props.onDuplicate.mockResolvedValueOnce('full')
    await act(async () => { fireEvent.click(within(card('电商管家')).getByRole('button', { name: '复制' })) })
    expect(screen.getByRole('alert').textContent).toContain('操作失败：full')
  })

  it('confirms a delete with the session count, and cancels', async () => {
    const props = mount(state)
    fireEvent.click(within(card('电商管家')).getByRole('button', { name: '删除' }))
    const dialog = screen.getByRole('dialog', { name: '删除智能体' })
    expect(dialog.textContent).toContain('确定删除「电商管家」吗？它有 4 个会话。')
    expect(props.sessionCount).toHaveBeenCalledWith('a2')
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(within(card('电商管家')).getByRole('button', { name: '删除' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '关闭' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(within(card('电商管家')).getByRole('button', { name: '删除' }))
    await act(async () => { fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '删除' })) })
    expect(props.onDelete).toHaveBeenCalledWith('a2')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('opens the detail page from a card and returns to the list', async () => {
    const props = mount(state)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '查看 电商管家 的详情' })) })
    expect(screen.getByRole('heading', { level: 1, name: '电商管家' })).toBeTruthy()
    expect(props.onRead).toHaveBeenCalledWith('a2')
    fireEvent.click(screen.getByRole('button', { name: '← 返回智能体列表' }))
    expect(screen.getByRole('heading', { level: 1, name: '智能体' })).toBeTruthy()
  })

  it('runs the card actions from the detail page, opening a copy and closing on delete', async () => {
    const props = mount(state)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '查看 日常助手 的详情' })) })
    expect(screen.queryByRole('button', { name: '设为默认' })).toBeNull()
    expect(screen.getByText('默认')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '对话' }))
    expect(props.onChat).toHaveBeenCalledWith('a1')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '复制' })) })
    expect(screen.getByRole('heading', { level: 1, name: '电商管家' })).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '设为默认' })) })
    expect(props.onSetDefault).toHaveBeenCalledWith('a2')
    props.onSetDefault.mockResolvedValueOnce('gone')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '设为默认' })) })
    expect(screen.getByRole('alert').textContent).toContain('操作失败：gone')
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    await act(async () => { fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '删除' })) })
    expect(props.onDelete).toHaveBeenCalledWith('a2')
    act(() => { props.store.set({ ...props.store.getSnapshot(), state: { ...state, assistants: [state.assistants[0]!] } }) })
    expect(screen.getByRole('heading', { level: 1, name: '智能体' })).toBeTruthy()
  })
})
