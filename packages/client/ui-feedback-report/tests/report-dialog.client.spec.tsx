// @vitest-environment jsdom
/** The Report a problem button, its dialog, and the notice, rendered directly with hand-built props. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate, RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { FeedbackReportId, FeedbackReportReceipt } from '@deepseek-ai/dsh-feedback-report/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { en, zh, type FeedbackReportLocaleKey } from '../src/client/locales.ts'
import {
  ReportButton, ReportDialog, ReportNotice, type ReportButtonProps, type ReportDialogProps, type ReportNoticeProps, type ReportTarget,
} from '../src/client/ReportDialog.tsx'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const sid = (id: string) => id as SessionId
const RECEIPT: FeedbackReportReceipt = { id: 'fb-1' as FeedbackReportId, createdAt: '2026-10-11T12:00:00.000Z' }
const ok = <T,>(value: T) => ({ ok: true as const, value })
const refused = (code: string, message: string) => ({ ok: false as const, error: new RemoteError(code as never, message, {} as never) })
const png = (name = 'shot.png', size = 16) => new File([new Uint8Array(size)], name, { type: 'image/png' })

/** A sessions snapshot whose main view shows `main` (blank or not), beside another Session. */
function sessions(main: { id: string; blank: boolean } | null) {
  const row = (id: string, blank: boolean, shown: boolean) => ({
    id: sid(id), displayTitle: id, running: false, blank, updatedAt: 1, retainedBy: shown ? { mainView: 1 } : {},
  })
  const rows = [row('other', false, false), ...main === null ? [] : [row(main.id, main.blank, true)]]
  return { ids: rows.map(r => r.id), byId: Object.fromEntries(rows.map(r => [r.id, r])), phase: 'ready', projectionsBySession: {} }
}

interface ButtonOptions {
  signedIn?: boolean
  main?: { id: string; blank: boolean } | null
  panel?: string | null
  copy?: Record<FeedbackReportLocaleKey, string>
}

function renderButton(options: ButtonOptions = {}) {
  const requestReport = vi.fn()
  const props = {
    t: makeTranslate(options.copy ?? zh),
    useSignedIn: bindSnapshotSelector(createSnapshotStore(options.signedIn ?? true)),
    useSessions: bindSnapshotSelector(createSnapshotStore(sessions(options.main === undefined ? { id: 'one', blank: false } : options.main))),
    usePanelInfo: bindSnapshotSelector(createSnapshotStore({ activePanelId: options.panel ?? null })),
    requestReport,
  } as Partial<ReportButtonProps> as ReportButtonProps
  render(<ReportButton {...props} />)
  return requestReport
}

describe('Report a problem button', () => {
  it.each([[zh, '问题反馈'], [en, 'Report a problem']])('asks for the dialog about the Session on screen, which can be attached', (copy, name) => {
    const requestReport = renderButton({ copy })
    fireEvent.click(screen.getByRole('button', { name }))
    expect(requestReport).toHaveBeenCalledWith({ sessionId: 'one', attachable: true })
  })

  it('offers no attachment for a blank new Session, but still names it for its environment', () => {
    const requestReport = renderButton({ main: { id: 'blank', blank: true } })
    fireEvent.click(screen.getByRole('button', { name: '问题反馈' }))
    expect(requestReport).toHaveBeenCalledWith({ sessionId: 'blank', attachable: false })
  })

  it.each([['a page such as Assistants', { panel: 'assistants' }], ['no Session at all', { main: null }]])('reports without a Session on %s', (_label, options) => {
    const requestReport = renderButton(options)
    fireEvent.click(screen.getByRole('button', { name: '问题反馈' }))
    expect(requestReport).toHaveBeenCalledWith({ sessionId: null, attachable: false })
  })

  it('is absent without a sign-in', () => {
    renderButton({ signedIn: false })
    expect(screen.queryByRole('button')).toBeNull()
  })
})

function dialog(copy: Record<FeedbackReportLocaleKey, string> = zh) {
  const request = createSnapshotStore<ReportTarget | null>(null)
  const settleReport = vi.fn(() => { request.set(null) })
  const submit = vi.fn<ReportDialogProps['submit']>(async () => ok(RECEIPT))
  const notifySubmitted = vi.fn()
  const props = {
    t: makeTranslate(copy), useReportRequest: bindSnapshotSelector(request), settleReport, submit, notifySubmitted, uiLanguage: () => 'zh-CN',
  } as Partial<ReportDialogProps> as ReportDialogProps
  render(<ReportDialog {...props} />)
  const ask = (sessionId: SessionId | null = sid('one'), attachable = sessionId !== null) => { act(() => { request.set({ sessionId, attachable }) }) }
  return { ask, settleReport, submit, notifySubmitted }
}
const button = (name: string) => screen.getByRole<HTMLButtonElement>('button', { name })
const describeIt = (text: string) => { fireEvent.change(screen.getByRole('textbox', { name: '问题描述' }), { target: { value: text } }) }
/** Pick files and wait until every read settles (jsdom's FileReader answers on a later task). */
const addFiles = async (files: File[]) => {
  await act(async () => {
    fireEvent.change(screen.getByLabelText('添加截图', { selector: 'input' }), { target: { files } })
    await new Promise((resolve) => { setTimeout(resolve, 30) })
  })
}

describe('report dialog', () => {
  it('renders nothing until a report is asked for', () => {
    dialog()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('needs a type and a description, then sends them with the Session and the screenshots, and thanks the user', async () => {
    const d = dialog()
    d.ask()
    expect(screen.getByRole('dialog', { name: '报告问题' }).textContent).toContain('告诉 MO WorkAI 平台')
    expect(button('提交').disabled).toBe(true)
    fireEvent.click(screen.getByRole('radio', { name: '卡顿' }))
    expect(screen.getByRole('radio', { name: '卡顿' }).getAttribute('aria-checked')).toBe('true')
    expect(button('提交').disabled).toBe(true)
    describeIt('  点发送后一直转圈  ')
    expect(screen.getByText('12/2000')).toBeTruthy()
    await addFiles([png('a.png')])
    expect(screen.getByRole('img', { name: 'a.png' })).toBeTruthy()
    expect(screen.getByRole<HTMLInputElement>('checkbox').checked).toBe(false)
    fireEvent.click(screen.getByRole('checkbox'))

    let finish: (() => void) | undefined
    d.submit.mockImplementationOnce(() => new Promise((resolve) => { finish = () => { resolve(ok(RECEIPT)) } }))
    fireEvent.click(button('提交'))
    expect(screen.getByRole('status').textContent).toBe('正在提交…')
    expect(button('取消').disabled).toBe(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(d.settleReport).not.toHaveBeenCalled()
    await act(async () => { finish?.() })
    expect(d.submit).toHaveBeenCalledWith({
      category: 'lag', description: '  点发送后一直转圈  ', sessionId: 'one', attachSession: true, uiLanguage: 'zh-CN',
      images: [{ name: 'a.png', contentType: 'image/png', data: btoa(String.fromCharCode(...new Uint8Array(16))) }],
    })
    expect(d.settleReport).toHaveBeenCalledOnce()
    expect(d.notifySubmitted).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('leaves the conversation out unless ticked, and offers no attachment without a Session', async () => {
    const d = dialog()
    d.ask()
    fireEvent.click(screen.getByRole('radio', { name: '报错' }))
    describeIt('x')
    fireEvent.click(button('提交'))
    await waitFor(() => { expect(d.submit).toHaveBeenCalledOnce() })
    expect(d.submit.mock.calls[0]![0]).toMatchObject({ attachSession: false, images: [] })
    cleanup()

    // A blank new Session has nothing to attach: no checkbox, but the Session still names its environment.
    const blank = dialog()
    blank.ask(sid('blank'), false)
    expect(screen.queryByRole('checkbox')).toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: '其他' }))
    describeIt('z')
    fireEvent.click(button('提交'))
    await waitFor(() => { expect(blank.submit).toHaveBeenCalledOnce() })
    expect(blank.submit.mock.calls[0]![0]).toMatchObject({ sessionId: 'blank', attachSession: false })
    cleanup()

    const none = dialog(en)
    none.ask(null)
    expect(screen.queryByRole('checkbox')).toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: 'Other' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), { target: { value: 'y' } })
    fireEvent.click(button('Submit'))
    await waitFor(() => { expect(none.submit).toHaveBeenCalledOnce() })
    expect(none.submit.mock.calls[0]![0]).toMatchObject({ sessionId: null, attachSession: false })
  })

  it('keeps at most three screenshots, refuses other files with the reason, removes one, and takes pasted images', async () => {
    const d = dialog()
    d.ask()
    await addFiles([new File(['<svg/>'], 'x.svg', { type: 'image/svg+xml' })])
    expect(screen.getByRole('alert').textContent).toBe('只支持 PNG、JPG、WebP、GIF 图片')
    await addFiles([new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' })])
    expect(screen.getByRole('alert').textContent).toBe('单张截图不能超过 5 MB')
    await addFiles([])
    await addFiles([png('1.png'), png('2.png'), png('3.png'), png('4.png')])
    expect(screen.getByRole('alert').textContent).toBe('最多添加 3 张截图')
    expect(screen.getAllByRole('img')).toHaveLength(3)
    expect(screen.queryByRole('button', { name: '添加截图' })).toBeNull()
    fireEvent.click(button('移除 2.png'))
    expect(screen.getAllByRole('img').map(img => img.getAttribute('alt'))).toEqual(['1.png', '3.png'])
    // The add tile opens the file picker.
    const picker = screen.getByLabelText('添加截图', { selector: 'input' })
    const click = vi.spyOn(picker, 'click')
    fireEvent.click(button('添加截图'))
    expect(click).toHaveBeenCalledOnce()

    // Overlapping adds share the room: two pastes of two images while one slot is left keep one.
    const body = screen.getByRole('dialog').firstElementChild!
    await act(async () => {
      fireEvent.paste(body, { clipboardData: { files: [png('p1.png'), png('p2.png')] } })
      fireEvent.paste(body, { clipboardData: { files: [png('p3.png'), png('p4.png')] } })
      await new Promise((resolve) => { setTimeout(resolve, 30) })
    })
    expect(screen.getAllByRole('img').map(img => img.getAttribute('alt'))).toEqual(['1.png', '3.png', 'p1.png'])
    expect(screen.getByRole('alert').textContent).toBe('最多添加 3 张截图')
    fireEvent.click(button('移除 p1.png'))
    const dialogBody = screen.getByRole('dialog').firstElementChild!
    await act(async () => {
      fireEvent.paste(dialogBody, { clipboardData: { files: [png('pasted.png')] } })
      await new Promise((resolve) => { setTimeout(resolve, 30) })
    })
    expect(screen.getByRole('img', { name: 'pasted.png' })).toBeTruthy()
    // Pasted text is left to the field it lands in.
    fireEvent.paste(dialogBody, { clipboardData: { files: [] } })
    expect(screen.getAllByRole('img')).toHaveLength(3)
  })

  it('reads an unreadable file as not an image', async () => {
    const failing = vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementation(function readAsDataURL(this: FileReader) {
      queueMicrotask(() => { this.onerror?.(new ProgressEvent('error') as ProgressEvent<FileReader>) })
    })
    try {
      dialog().ask()
      await addFiles([png()])
      expect(screen.getByRole('alert').textContent).toBe('只支持 PNG、JPG、WebP、GIF 图片')
      expect(screen.queryAllByRole('img')).toHaveLength(0)
    } finally {
      failing.mockRestore()
    }
  })

  it.each([
    [refused('feedback-report/signed-out', 'x'), '请先登录后再提交。'],
    [refused('feedback-report/unreachable', 'x'), '连接不上服务器，请检查网络后重试。'],
    [refused('feedback-report/refused', '请描述遇到的问题'), '提交没有成功：请描述遇到的问题'],
    [refused('feedback-report/invalid', 'at most 3 images'), '提交没有成功：at most 3 images'],
  ])('says why the report was not sent and keeps the draft', async (failure, text) => {
    const d = dialog()
    d.ask()
    fireEvent.click(screen.getByRole('radio', { name: '其他' }))
    describeIt('draft')
    d.submit.mockResolvedValueOnce(failure)
    fireEvent.click(button('提交'))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(text) })
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '问题描述' }).value).toBe('draft')
    expect(d.notifySubmitted).not.toHaveBeenCalled()
    expect(button('提交').disabled).toBe(false)
  })

  it('closes from its close button and Cancel, and ignores a late answer after it closed', async () => {
    const d = dialog()
    d.ask()
    fireEvent.click(button('关闭'))
    expect(d.settleReport).toHaveBeenCalledOnce()
    d.ask(sid('two'))
    fireEvent.click(button('取消'))
    expect(d.settleReport).toHaveBeenCalledTimes(2)

    let finish: (() => void) | undefined
    d.ask(sid('three'))
    fireEvent.click(screen.getByRole('radio', { name: '报错' }))
    describeIt('x')
    d.submit.mockImplementationOnce(() => new Promise((resolve) => { finish = () => { resolve(ok(RECEIPT)) } }))
    fireEvent.click(button('提交'))
    act(() => { d.settleReport() })
    await act(async () => { finish?.() })
    expect(d.notifySubmitted).not.toHaveBeenCalled()
  })
})

describe('report notice', () => {
  it('thanks the user after each stored report and takes itself down', () => {
    vi.useFakeTimers()
    const submitted = createSnapshotStore(0)
    const dismissNotice = vi.fn(() => { submitted.set(0) })
    const props = {
      t: makeTranslate(zh), useSubmitted: bindSnapshotSelector(submitted), dismissNotice,
    } as Partial<ReportNoticeProps> as ReportNoticeProps
    render(<ReportNotice {...props} />)
    expect(screen.queryByRole('alert')).toBeNull()
    act(() => { submitted.set(1) })
    expect(screen.getByRole('alert').textContent).toBe('已提交，感谢你的反馈')
    act(() => { vi.advanceTimersByTime(5000) })
    expect(dismissNotice).toHaveBeenCalledOnce()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
