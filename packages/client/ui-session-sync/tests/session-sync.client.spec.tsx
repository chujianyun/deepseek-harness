// @vitest-environment jsdom
/** The row mark, the hover line, and the view-only composer rendered directly with hand-built props. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate, RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { en, zh } from '../src/client/locales.ts'
import {
  ContinuationHover, ContinuationLabel, ContinueDialog, PulledBadge, PulledComposer, PulledHover,
  type ContinuationHoverProps, type ContinuationLabelProps, type ContinuationsById, type ContinueDialogProps,
  type PulledBadgeProps, type PulledDevices, type PulledHoverProps,
} from '../src/client/SessionSync.tsx'

afterEach(cleanup)

const pulled: PulledDevices = { ['from-a' as SessionId]: '前台电脑' }
const rowProps = (sessionId: string, copy = zh) => ({
  sessionId: sessionId as SessionId, t: makeTranslate(copy), usePulled: bindSnapshotSelector(createSnapshotStore(pulled)),
}) as Partial<PulledBadgeProps & PulledHoverProps> as PulledBadgeProps & PulledHoverProps

describe('rows of conversations from other computers', () => {
  it.each([[zh, '来自其他电脑：前台电脑'], [en, 'From another computer: 前台电脑']])('marks the row with the computer\'s name', (copy, label) => {
    render(<PulledBadge {...rowProps('from-a', copy)} />)
    expect(screen.getByRole('img', { name: label })).toHaveProperty('title', label)
  })

  it('names the computer in the hover card', () => {
    render(<PulledHover {...rowProps('from-a')} />)
    expect(screen.getByText('来自其他电脑 · 前台电脑')).toBeDefined()
  })

  it('leaves this computer\'s own rows alone', () => {
    const { container } = render(<><PulledBadge {...rowProps('own')} /><PulledHover {...rowProps('own')} /></>)
    expect(container.innerHTML).toBe('')
  })
})

describe('view-only composer', () => {
  it.each([
    [zh, '来自「前台电脑」的对话', '在这台电脑上只能查看，不能继续对话。'],
    [en, 'Conversation from “前台电脑”', 'On this computer it can be read, not continued.'],
  ])('says where the conversation comes from and that it is view-only', (copy, title, body) => {
    const requestContinue = vi.fn()
    render(<PulledComposer matched={{ sessionId: 'from-a' as SessionId, device: '前台电脑' }} requestContinue={requestContinue} t={makeTranslate(copy)} />)
    expect(screen.getByRole('status').textContent).toBe(`${title}${body}${copy.continue}`)
    fireEvent.click(screen.getByRole('button', { name: copy.continue }))
    expect(requestContinue).toHaveBeenCalledWith('from-a')
  })
})

const sid = (id: string) => id as SessionId
const continuations: ContinuationsById = {
  [sid('named')]: { sessionId: sid('named'), sourceId: sid('from-a'), title: '双十一复盘', device: '前台电脑' },
  [sid('unnamed')]: { sessionId: sid('unnamed'), sourceId: sid('gone'), title: null, device: '前台电脑' },
}
const sessions = { byId: { [sid('from-a')]: { id: sid('from-a'), title: '双十一复盘' } } }

describe('continuation label and hover line', () => {
  const label = (sessionId: string, open = vi.fn()) => {
    render(<ContinuationLabel {...({
      sessionId: sid(sessionId), t: makeTranslate(zh), open,
      useContinuations: bindSnapshotSelector(createSnapshotStore(continuations)),
      useSessions: bindSnapshotSelector(createSnapshotStore(sessions)),
    } as never as ContinuationLabelProps)} />)
    return open
  }

  it('links back to the original while it is here', () => {
    const open = label('named')
    fireEvent.click(screen.getByRole('button', { name: '接续自「双十一复盘」' }))
    expect(open).toHaveBeenCalledWith('from-a')
  })

  it('names the computer when the original has no title, as plain text once it is gone', () => {
    label('unnamed')
    expect(screen.getByText('接续自「前台电脑」的对话').tagName).toBe('SPAN')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('says nothing on other conversations', () => {
    label('own')
    const hover = (sessionId: string) => render(<ContinuationHover {...({
      sessionId: sid(sessionId), t: makeTranslate(en), useContinuations: bindSnapshotSelector(createSnapshotStore(continuations)),
    } as Partial<ContinuationHoverProps> as ContinuationHoverProps)} />)
    hover('own')
    expect(document.body.textContent).toBe('')
    hover('named')
    hover('unnamed')
    expect(document.body.textContent).toBe('Continued from “双十一复盘”Continued from a conversation on “前台电脑”')
  })
})

describe('continue dialog', () => {
  const ok = <T,>(value: T) => ({ ok: true as const, value })
  const refused = (code: string, message: string) => ({ ok: false as const, error: new RemoteError(code as never, message, {} as never) })

  function dialog(options: {
    info?: ReturnType<typeof ok<{ folder: string | null; folderHere: boolean }>> | ReturnType<typeof refused>
    picked?: (string | null)[]
    results?: (ReturnType<typeof ok<{ sessionId: SessionId }>> | ReturnType<typeof refused>)[]
    request?: string | null
  } = {}) {
    const request = createSnapshotStore<SessionId | null>((options.request === undefined ? 'from-a' : options.request) as SessionId | null)
    const picked = [...options.picked ?? []]
    const results = [...options.results ?? [ok({ sessionId: sid('continued-1') })]]
    const face = {
      settleContinue: vi.fn(() => { request.set(null) }),
      continueInfo: vi.fn(async () => options.info ?? ok({ folder: '/work/双十一', folderHere: true })),
      pickFolder: vi.fn(async () => picked.shift() ?? null),
      continueConversation: vi.fn(async () => results.shift()!),
      open: vi.fn(),
    }
    render(<ContinueDialog {...({
      ...face, t: makeTranslate(zh),
      useContinueRequest: bindSnapshotSelector(request),
      useSessions: bindSnapshotSelector(createSnapshotStore(sessions)),
    } as never as ContinueDialogProps)} />)
    return face
  }

  it('shows nothing until a continue is asked for', () => {
    dialog({ request: null })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('offers the original folder when it is here, continues there, and opens the new conversation', async () => {
    const face = dialog()
    expect(screen.getByRole('dialog').textContent).toContain('带上「双十一复盘」的全部内容')
    await waitFor(() => { expect(screen.getByText('/work/双十一')).toBeDefined() })
    expect(screen.queryByRole('note')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '接着聊' }))
    await waitFor(() => { expect(face.open).toHaveBeenCalledWith('continued-1') })
    expect(face.continueConversation).toHaveBeenCalledWith('from-a', '/work/双十一')
    expect(face.settleContinue).toHaveBeenCalled()
  })

  it('warns when the original folder is not here and asks for one, keeping the choice when picking is cancelled', async () => {
    const face = dialog({ info: ok({ folder: '/other/computer', folderHere: false }), picked: ['/here/project', null] })
    await waitFor(() => { expect(screen.getAllByRole('note').map(note => note.textContent)).toEqual(['原工作文件夹不在这台电脑上，AI 改过的文件不会带过来。', '请选择一个本机文件夹。']) })
    expect(screen.getByText('还没有选择')).toBeDefined()
    expect(screen.getByRole('button', { name: '接着聊' })).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('button', { name: '选择文件夹…' }))
    await waitFor(() => { expect(screen.getByText('/here/project')).toBeDefined() })
    // Chosen: the folder is no longer asked for, and the warning about the original stays.
    expect(screen.getAllByRole('note').map(note => note.textContent)).toEqual(['原工作文件夹不在这台电脑上，AI 改过的文件不会带过来。'])
    fireEvent.click(screen.getByRole('button', { name: '选择文件夹…' }))
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText('/here/project')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: '接着聊' }))
    await waitFor(() => { expect(face.continueConversation).toHaveBeenCalledWith('from-a', '/here/project') })
  })

  it('says why continuing failed and lets the user try again', async () => {
    const face = dialog({ results: [refused('session/fork-folder-unavailable', 'gone'), refused('gateway/internal', '磁盘满了'), ok({ sessionId: sid('continued-1') })] })
    await waitFor(() => { expect(screen.getByText('/work/双十一')).toBeDefined() })
    fireEvent.click(screen.getByRole('button', { name: '接着聊' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('这个文件夹在这台电脑上不存在，请重新选择。') })
    fireEvent.click(screen.getByRole('button', { name: '接着聊' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('没能接着聊：磁盘满了') })
    fireEvent.click(screen.getByRole('button', { name: '接着聊' }))
    await waitFor(() => { expect(face.open).toHaveBeenCalledWith('continued-1') })
  })

  it('reports a failed folder read, and closes on cancel or the close button', async () => {
    const face = dialog({ info: refused('session-sync/not-pulled', 'not pulled') })
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('没能接着聊：not pulled') })
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(face.settleContinue).toHaveBeenCalledOnce()
    cleanup()
    const other = dialog({ request: 'unknown-title' })
    expect(screen.getByRole('dialog').textContent).toContain('带上「这个对话」的全部内容')
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(other.settleContinue).toHaveBeenCalledOnce()
  })

  it('cannot be closed while it is continuing', async () => {
    let finish!: (value: { ok: true; value: { sessionId: SessionId } }) => void
    const face = dialog()
    face.continueConversation.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    await waitFor(() => { expect(screen.getByText('/work/双十一')).toBeDefined() })
    fireEvent.click(screen.getByRole('button', { name: '接着聊' }))
    await waitFor(() => { expect(screen.getByRole('status').textContent).toBe('正在创建接续对话…') })
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(face.settleContinue).not.toHaveBeenCalled()
    finish({ ok: true, value: { sessionId: sid('continued-1') } })
    await waitFor(() => { expect(face.settleContinue).toHaveBeenCalledOnce() })
  })

  it('asks for a folder when the original names none, and says why when the chooser fails', async () => {
    const face = dialog({ info: ok({ folder: null, folderHere: false }) })
    await waitFor(() => { expect(screen.getAllByRole('note').map(note => note.textContent)).toEqual(['请选择一个本机文件夹。']) })
    face.pickFolder.mockRejectedValueOnce(new Error('directory picker failed'))
    fireEvent.click(screen.getByRole('button', { name: '选择文件夹…' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('没能接着聊：directory picker failed') })
    face.pickFolder.mockRejectedValueOnce('no chooser')
    fireEvent.click(screen.getByRole('button', { name: '选择文件夹…' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('没能接着聊：no chooser') })
  })

  it('keeps its folder across a language switch and ignores an answer that comes after it closed', async () => {
    let answer!: (value: ReturnType<typeof ok<{ folder: string | null; folderHere: boolean }>>) => void
    const request = createSnapshotStore<SessionId | null>(sid('from-a'))
    const face = {
      settleContinue: vi.fn(), pickFolder: vi.fn(async () => '/picked'), continueConversation: vi.fn(), open: vi.fn(),
      continueInfo: vi.fn(() => new Promise((resolve) => { answer = resolve })),
    }
    const props = (copy: typeof zh) => ({
      ...face, t: makeTranslate(copy),
      useContinueRequest: bindSnapshotSelector(request), useSessions: bindSnapshotSelector(createSnapshotStore(sessions)),
    }) as never as ContinueDialogProps
    const view = render(<ContinueDialog {...props(zh)} />)
    view.rerender(<ContinueDialog {...props(en)} />)
    expect(face.continueInfo).toHaveBeenCalledOnce()
    act(() => { request.set(null) })
    await act(async () => { answer(ok({ folder: '/late', folderHere: true })); await Promise.resolve() })
    expect(screen.queryByText('/late')).toBeNull()
  })
})
