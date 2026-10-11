// @vitest-environment jsdom
/** The share menu row and the share dialog rendered directly with hand-built props. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate, RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionShareLink } from '@deepseek-ai/dsh-session-share/client'
import { en, zh, type SessionShareLocaleKey } from '../src/client/locales.ts'
import {
  SessionShareDialog, ShareSessionMenuItem, type SessionShareDialogProps, type SessionShareTarget, type ShareSessionMenuItemProps,
} from '../src/client/ShareSession.tsx'

afterEach(cleanup)

const sid = (id: string) => id as SessionId
const AT = '2026-10-11T12:00:00.000Z'
const LINK: SessionShareLink = { shareId: 'sh-1', url: 'https://hub.example/share/sh-1', createdAt: AT, updatedAt: AT }
const ok = <T,>(value: T) => ({ ok: true as const, value })
const refused = (code: string, message: string, details: object = {}) => ({
  ok: false as const, error: new RemoteError(code as never, message, details as never),
})

function row(options: { signedIn?: boolean; displayTitle?: string; copy?: Record<SessionShareLocaleKey, string> } = {}) {
  const setMenuOpen = vi.fn()
  const requestSessionShare = vi.fn()
  const props = {
    sessionId: sid('one'), displayTitle: options.displayTitle ?? '双十一复盘', t: makeTranslate(options.copy ?? zh),
    useMenuOpenState: () => [true, setMenuOpen],
    useSignedIn: bindSnapshotSelector(createSnapshotStore(options.signedIn ?? true)),
    requestSessionShare,
  } as Partial<ShareSessionMenuItemProps> as ShareSessionMenuItemProps
  render(<ShareSessionMenuItem {...props} />)
  return { setMenuOpen, requestSessionShare }
}

describe('share menu row', () => {
  it.each([[zh, '分享会话'], [en, 'Share session']])('closes the menu, then asks for the dialog with the row title', (copy, name) => {
    const { setMenuOpen, requestSessionShare } = row({ copy })
    fireEvent.click(screen.getByRole('menuitem', { name }))
    expect(requestSessionShare).toHaveBeenCalledWith({ sessionId: 'one', title: '双十一复盘' })
    expect(setMenuOpen.mock.invocationCallOrder[0]).toBeLessThan(requestSessionShare.mock.invocationCallOrder[0]!)
  })

  it.each([[zh, '未命名'], [en, 'Untitled']])('names an unnamed Session as the sidebar shows it', (copy, title) => {
    const { requestSessionShare } = row({ copy, displayTitle: '' })
    fireEvent.click(screen.getByRole('menuitem'))
    expect(requestSessionShare).toHaveBeenCalledWith({ sessionId: 'one', title })
  })

  it('is absent without a sign-in', () => {
    row({ signedIn: false })
    expect(screen.queryByRole('menuitem')).toBeNull()
  })
})

function dialog(options: { copy?: Record<SessionShareLocaleKey, string>; status?: unknown } = {}) {
  const request = createSnapshotStore<SessionShareTarget | null>(null)
  const settleSessionShare = vi.fn(() => { request.set(null) })
  const loadStatus = vi.fn<SessionShareDialogProps['loadStatus']>(async () => (options.status ?? ok({ signedIn: true, link: null })) as never)
  const share = vi.fn<SessionShareDialogProps['share']>(async () => ok(LINK))
  const revoke = vi.fn<SessionShareDialogProps['revoke']>(async () => ok(undefined))
  const copyLink = vi.fn<SessionShareDialogProps['copyLink']>(async () => true)
  const props = {
    t: makeTranslate(options.copy ?? zh), useShareRequest: bindSnapshotSelector(request),
    settleSessionShare, loadStatus, share, revoke, copyLink,
  } as Partial<SessionShareDialogProps> as SessionShareDialogProps
  render(<SessionShareDialog {...props} />)
  const ask = (sessionId = 'one', title = '双十一复盘') => { act(() => { request.set({ sessionId: sid(sessionId), title }) }) }
  return { ask, settleSessionShare, loadStatus, share, revoke, copyLink }
}
const button = (name: string) => screen.getByRole<HTMLButtonElement>('button', { name })

describe('share dialog', () => {
  it('renders nothing until a share is asked for', () => {
    dialog()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('reads the status, then offers to create a link and shows it once created', async () => {
    const d = dialog()
    d.ask()
    expect(screen.getByRole('dialog', { name: '分享会话' }).textContent).toContain('同公司的成员登录后，可以通过链接查看“双十一复盘”的对话内容')
    expect(screen.getByRole('status').textContent).toBe('正在读取分享状态…')
    expect(button('生成链接').disabled).toBe(true)
    await waitFor(() => { expect(button('生成链接').disabled).toBe(false) })
    expect(d.loadStatus).toHaveBeenCalledExactlyOnceWith('one')
    expect(screen.queryByRole('status')).toBeNull()

    let finish: (() => void) | undefined
    d.share.mockImplementationOnce(() => new Promise((resolve) => { finish = () => { resolve(ok(LINK)) } }))
    fireEvent.click(button('生成链接'))
    expect(screen.getByRole('status').textContent).toBe('正在生成链接…')
    expect(button('取消').disabled).toBe(true)
    // The dialog stays while the upload is in flight.
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(d.settleSessionShare).not.toHaveBeenCalled()
    await act(async () => { finish?.() })
    expect(d.share).toHaveBeenCalledExactlyOnceWith({ sessionId: 'one', title: '双十一复盘' })
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: '分享链接' }).value).toBe(LINK.url)
    expect(screen.getByText(/^内容更新于 2026年10月11日/)).toBeTruthy()
    expect(screen.queryByRole('status')).toBeNull()
    fireEvent.click(button('完成'))
    expect(d.settleSessionShare).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows an existing link in English, copies it, and says when the host refuses the copy', async () => {
    const d = dialog({ copy: en, status: ok({ signedIn: true, link: LINK }) })
    d.ask()
    const field = await screen.findByRole<HTMLInputElement>('textbox', { name: 'Share link' })
    expect(field.readOnly).toBe(true)
    const select = vi.spyOn(field, 'select')
    fireEvent.focus(field)
    expect(select).toHaveBeenCalledOnce()
    expect(screen.getByText(/^Content updated Oct 11, 2026/)).toBeTruthy()
    fireEvent.click(button('Copy link'))
    await waitFor(() => { expect(screen.getByRole('status').textContent).toBe('Link copied') })
    expect(d.copyLink).toHaveBeenCalledWith(LINK.url)
    d.copyLink.mockResolvedValueOnce(false)
    fireEvent.click(button('Copy link'))
    await waitFor(() => { expect(screen.getByRole('status').textContent).toBe('Could not copy. Select the link and copy it yourself.') })
  })

  it('updates the content under the same link', async () => {
    const d = dialog({ status: ok({ signedIn: true, link: LINK }) })
    d.ask()
    await screen.findByRole('textbox', { name: '分享链接' })
    d.share.mockResolvedValueOnce(ok({ ...LINK, updatedAt: '2026-10-12T12:00:00.000Z' }))
    fireEvent.click(button('更新内容'))
    expect(screen.getByRole('status').textContent).toBe('正在更新内容…')
    await waitFor(() => { expect(screen.getByRole('status').textContent).toBe('内容已更新，链接不变') })
    expect(screen.getByText(/^内容更新于 2026年10月12日/)).toBeTruthy()
  })

  it('stops sharing and goes back to offering a link', async () => {
    const d = dialog({ status: ok({ signedIn: true, link: LINK }) })
    d.ask()
    await screen.findByRole('textbox', { name: '分享链接' })
    fireEvent.click(button('取消分享'))
    expect(screen.getByRole('status').textContent).toBe('正在取消分享…')
    await waitFor(() => { expect(screen.getByRole('status').textContent).toBe('已取消分享，原链接已失效') })
    expect(d.revoke).toHaveBeenCalledExactlyOnceWith('one')
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(button('生成链接').disabled).toBe(false)
  })

  it.each([
    [refused('session-share/signed-out', 'x'), '请先登录后再分享。'],
    [refused('session-share/empty', 'x'), '这个会话还没有对话内容，暂时不能分享。'],
    [refused('session-share/unreachable', 'x'), '连接不上服务器，请检查网络后重试。'],
    [refused('session-share/refused', 'too big', { status: 413 }), '对话内容太长，超过了分享的上限，无法分享。'],
    [refused('session-share/refused', '标题不能为空', { status: 400 }), '分享没有成功：标题不能为空'],
    [refused('session/not-found', 'session gone'), '操作没有成功：session gone'],
  ])('says why creating a link failed and lets the user try again', async (failure, text) => {
    const d = dialog()
    d.ask()
    await waitFor(() => { expect(button('生成链接').disabled).toBe(false) })
    d.share.mockResolvedValueOnce(failure)
    fireEvent.click(button('生成链接'))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(text) })
    fireEvent.click(button('生成链接'))
    await screen.findByRole('textbox', { name: '分享链接' })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('says why the status could not be read, keeps a failed withdrawal shared, and closes while reading', async () => {
    const failing = dialog({ status: refused('session-share/unreachable', 'x') })
    failing.ask()
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('连接不上服务器，请检查网络后重试。') })
    fireEvent.click(button('取消'))
    expect(failing.settleSessionShare).toHaveBeenCalledOnce()
    cleanup()

    const shared = dialog({ status: ok({ signedIn: true, link: LINK }) })
    shared.ask()
    await screen.findByRole('textbox', { name: '分享链接' })
    shared.revoke.mockResolvedValueOnce(refused('session-share/refused', '稍后再试', { status: 500 }))
    fireEvent.click(button('取消分享'))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('分享没有成功：稍后再试') })
    expect(screen.getByRole('textbox', { name: '分享链接' })).toBeTruthy()
    // Copying after a failure clears it.
    fireEvent.click(button('复制链接'))
    await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
    cleanup()

    let answer: (() => void) | undefined
    const slow = dialog()
    slow.loadStatus.mockImplementationOnce(() => new Promise((resolve) => {
      answer = () => { resolve(ok({ signedIn: true, link: LINK })) }
    }))
    slow.ask()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(slow.settleSessionShare).toHaveBeenCalledOnce()
    // The late answer of a closed dialog changes nothing.
    await act(async () => { answer?.() })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
