// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ConnectorsState, ConnectorView } from '@deepseek-ai/dsh-connectors/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ConnectorsSnapshot } from '../src/client/connectors-source.ts'
import { ConnectorsPage } from '../src/client/ConnectorsPage.tsx'
import { en, zh } from '../src/client/locales.ts'

afterEach(() => { cleanup() })

const feishu = (over: Partial<ConnectorView> = {}): ConnectorView => ({
  id: 'feishu', status: 'not-installed', cli: 'lark-cli', version: '1.0.97', receivedBytes: 0, totalBytes: 1000, error: null,
  login: null, loginError: null, account: null, problem: null, ...over,
})
const dingtalk: ConnectorView = {
  id: 'dingtalk', status: 'coming-soon', cli: null, version: null, receivedBytes: 0, totalBytes: 0, error: null,
  login: null, loginError: null, account: null, problem: null,
}

function mount(state: ConnectorsState | undefined, extra: Partial<ConnectorsSnapshot> = {}, copy = zh) {
  const store = createSnapshotStore<ConnectorsSnapshot>({ state, busy: [], failure: null, ...extra })
  const props = {
    t: makeTranslate(copy), useConnectors: bindSnapshotSelector(store),
    onInstall: vi.fn(async (_id: string) => {}), onUninstall: vi.fn(async (_id: string) => {}), onDismiss: vi.fn(),
    onConnect: vi.fn(async (_id: string) => {}), onCancelConnect: vi.fn(async (_id: string) => {}),
    onDisconnect: vi.fn(async (_id: string) => {}), onCheck: vi.fn(async () => {}), onOpenUrl: vi.fn((_url: string) => {}),
  }
  render(<ConnectorsPage {...props} />)
  return { props, store }
}

const card = (name: string) => screen.getByText(name).closest('li')!

describe('connectors page', () => {
  it('shows the header before the first frame', () => {
    mount(undefined)
    expect(screen.getByRole('heading', { name: '连接器' })).toBeTruthy()
    expect(screen.queryByRole('listitem')).toBeNull()
  })

  it.each([zh, en])('offers + on a connector that is not installed, and labels one DSH does not support yet', (copy) => {
    const { props } = mount({ connectors: [feishu(), dingtalk] }, {}, copy)
    const install = within(card(copy['name.feishu'])).getByRole('button', { name: copy.install.replace('{name}', copy['name.feishu']) })
    expect(within(card(copy['name.feishu'])).getByText('lark-cli 1.0.97')).toBeTruthy()
    fireEvent.click(install)
    expect(props.onInstall).toHaveBeenCalledWith('feishu')
    const coming = card(copy['name.dingtalk'])
    expect(coming.getAttribute('data-status')).toBe('coming-soon')
    expect(within(coming).getByText(copy['status.coming-soon'])).toBeTruthy()
    expect(within(coming).queryByRole('button')).toBeNull()
  })

  it('disables + while the install request is in flight', () => {
    mount({ connectors: [feishu()] }, { busy: ['feishu'] })
    expect(within(card('飞书')).getByRole('button', { name: '安装飞书' })).toHaveProperty('disabled', true)
  })

  it('shows download progress, then the check once every byte arrived', () => {
    const { store } = mount({ connectors: [feishu({ status: 'installing', receivedBytes: 420 })] })
    expect(within(card('飞书')).getByRole('status', { name: '正在安装飞书' })).toBeTruthy()
    expect(within(card('飞书')).getByText('正在下载 42%')).toBeTruthy()
    expect(within(card('飞书')).getByRole('progressbar')).toHaveProperty('value', 42)
    act(() => { store.set({ ...store.getSnapshot(), state: { connectors: [feishu({ status: 'installing', receivedBytes: 1000 })] } }) })
    expect(within(card('飞书')).getByText('正在检查…')).toBeTruthy()
    act(() => { store.set({ ...store.getSnapshot(), state: { connectors: [feishu({ status: 'installing', totalBytes: 0 })] } }) })
    expect(within(card('飞书')).getByText('正在下载 0%')).toBeTruthy()
  })

  it.each(['network', 'verification', 'storage', 'launch'] as const)('explains a failed install (%s) and offers + again', (error) => {
    mount({ connectors: [feishu({ error })] })
    expect(within(card('飞书')).getByRole('alert').textContent).toBe(zh[`error.${error}`].replace('{cli}', 'lark-cli'))
    expect(within(card('飞书')).getByRole('button', { name: '安装飞书' })).toBeTruthy()
  })

  it('shows an installed, unconnected connector with a red dot, connects it, and uninstalls it after confirmation', () => {
    const { props } = mount({ connectors: [feishu({ status: 'disconnected' })] })
    expect(props.onCheck).toHaveBeenCalledOnce()
    const installed = card('飞书')
    expect(within(installed).getByText('未连接')).toBeTruthy()
    expect(installed.querySelector('[data-state="error"]')).toBeTruthy()
    fireEvent.click(within(installed).getByRole('button', { name: '连接' }))
    expect(props.onConnect).toHaveBeenCalledWith('feishu')
    const more = within(installed).getByRole('button', { name: '飞书的更多操作' })
    fireEvent.click(more)
    fireEvent.click(more)
    expect(screen.queryByRole('menuitem', { name: '卸载' })).toBeNull()
    fireEvent.click(more)
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menuitem', { name: '卸载' })).toBeNull()
    fireEvent.click(more)
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['连接', '卸载'])
    fireEvent.click(screen.getByRole('menuitem', { name: '连接' }))
    expect(props.onConnect).toHaveBeenCalledTimes(2)
    fireEvent.click(more)
    fireEvent.click(screen.getByRole('menuitem', { name: '卸载' }))
    const dialog = screen.getByRole('dialog', { name: '卸载飞书连接器' })
    expect(within(dialog).getByText(zh.uninstallDescription.replaceAll('{cli}', 'lark-cli').replace('{name}', '飞书'))).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(props.onUninstall).not.toHaveBeenCalled()
    fireEvent.click(more)
    fireEvent.click(screen.getByRole('menuitem', { name: '卸载' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '卸载' }))
    expect(props.onUninstall).toHaveBeenCalledWith('feishu')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows a connected connector with a green dot and its account, checks it again, and disconnects after confirmation', () => {
    const { props } = mount({ connectors: [feishu({ status: 'connected', account: '韩梅梅' })] })
    const connected = card('飞书')
    expect(within(connected).getByText('已连接')).toBeTruthy()
    expect(connected.querySelector('[data-state="done"]')).toBeTruthy()
    expect(within(connected).getByText('已登录：韩梅梅')).toBeTruthy()
    expect(within(connected).queryByRole('button', { name: '连接' })).toBeNull()
    const more = within(connected).getByRole('button', { name: '飞书的更多操作' })
    fireEvent.click(more)
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['重新检查', '断开', '卸载'])
    fireEvent.click(screen.getByRole('menuitem', { name: '重新检查' }))
    expect(props.onCheck).toHaveBeenCalledTimes(2)
    fireEvent.click(more)
    fireEvent.click(screen.getByRole('menuitem', { name: '断开' }))
    const dialog = screen.getByRole('dialog', { name: '断开飞书' })
    expect(within(dialog).getByText(zh.disconnectDescription.replaceAll('{name}', '飞书').replace('{cli}', 'lark-cli'))).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: '断开' }))
    expect(props.onDisconnect).toHaveBeenCalledWith('feishu')
  })

  it('shows a degraded connection with a yellow dot and its problem, and reconnects it', () => {
    const { props } = mount({ connectors: [feishu({ status: 'degraded', problem: 'refresh failed' })] })
    const degraded = card('飞书')
    expect(within(degraded).getByText('异常')).toBeTruthy()
    expect(degraded.querySelector('[data-state="warning"]')).toBeTruthy()
    expect(within(degraded).getByRole('alert').textContent).toBe('连接异常：refresh failed。可以点「⋯」重新检查或重新连接。')
    fireEvent.click(within(degraded).getByRole('button', { name: '飞书的更多操作' }))
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['重新连接', '重新检查', '断开', '卸载'])
    fireEvent.click(screen.getByRole('menuitem', { name: '重新连接' }))
    expect(props.onConnect).toHaveBeenCalledWith('feishu')
  })

  it.each([
    ['create-app', '无法创建飞书应用：apps are forbidden。如果公司不允许员工自建应用，请联系管理员。'],
    ['authorize', '授权没有完成：expired。请点「连接」重试。'],
  ] as const)('explains a failed %s sign-in step', (step, text) => {
    mount({ connectors: [feishu({ status: 'disconnected', loginError: { step, message: step === 'create-app' ? 'apps are forbidden' : 'expired' } })] })
    expect(within(card('飞书')).getByRole('alert').textContent).toBe(text)
  })

  it('walks the sign-in dialog through preparing, the app step with its QR code, and the authorize step without one', () => {
    const { props, store } = mount({ connectors: [feishu({ status: 'connecting', login: { step: 'create-app', url: null, qrCode: null } })] })
    expect(within(card('飞书')).getByRole('status', { name: '正在连接飞书' })).toBeTruthy()
    const dialog = screen.getByRole('dialog', { name: '连接飞书' })
    expect(within(dialog).getByRole('status').textContent).toBe('正在准备授权链接…')
    expect(dialog.querySelector('[aria-current="step"]')?.textContent).toBe('1. 创建飞书应用')
    act(() => {
      store.set({ ...store.getSnapshot(), state: { connectors: [feishu({ status: 'connecting', login: { step: 'create-app', url: 'https://open.feishu.cn/x', qrCode: 'data:image/png;base64,UE5H' } })] } })
    })
    expect(within(screen.getByRole('dialog')).getByRole('img', { name: '飞书授权二维码' }).getAttribute('src')).toBe('data:image/png;base64,UE5H')
    expect(within(screen.getByRole('dialog')).getByText('https://open.feishu.cn/x')).toBeTruthy()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '在浏览器中打开' }))
    expect(props.onOpenUrl).toHaveBeenCalledWith('https://open.feishu.cn/x')
    act(() => {
      store.set({ ...store.getSnapshot(), state: { connectors: [feishu({ status: 'connecting', login: { step: 'authorize', url: 'https://accounts.feishu.cn/y', qrCode: null } })] } })
    })
    const authorize = screen.getByRole('dialog')
    expect(authorize.querySelector('[aria-current="step"]')?.textContent).toBe('2. 授权飞书账号')
    expect(within(authorize).getByText('二维码生成失败，请使用下方的链接。')).toBeTruthy()
    fireEvent.click(within(authorize).getAllByRole('button', { name: '取消连接' }).at(-1)!)
    fireEvent.click(within(authorize).getAllByRole('button', { name: '取消连接' })[0]!)
    expect(props.onCancelConnect).toHaveBeenCalledTimes(2)
    act(() => {
      store.set({ ...store.getSnapshot(), state: { connectors: [feishu({ status: 'connecting', login: null })] } })
    })
    expect(screen.getByRole('dialog').querySelector('[aria-current="step"]')?.textContent).toBe('2. 授权飞书账号')
    act(() => { store.set({ ...store.getSnapshot(), state: { connectors: [feishu({ status: 'connected' })] } }) })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('closes the uninstall confirmation from its close button', () => {
    mount({ connectors: [feishu({ status: 'disconnected' })] })
    fireEvent.click(within(card('飞书')).getByRole('button', { name: '飞书的更多操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '卸载' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '关闭' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('labels a connector whose CLI has no build for this system', () => {
    mount({ connectors: [feishu({ status: 'unsupported' })] })
    expect(within(card('飞书')).getByText('此系统暂不支持')).toBeTruthy()
  })

  it('shows a refused action until dismissed', () => {
    const { props } = mount({ connectors: [] }, { failure: 'no connector x' })
    expect(screen.getByRole('alert').textContent).toContain('操作失败：no connector x')
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(props.onDismiss).toHaveBeenCalledOnce()
  })
})
