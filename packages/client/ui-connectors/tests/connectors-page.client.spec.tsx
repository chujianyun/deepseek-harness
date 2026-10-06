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
  id: 'feishu', status: 'not-installed', cli: 'lark-cli', version: '1.0.97', receivedBytes: 0, totalBytes: 1000, error: null, ...over,
})
const dingtalk: ConnectorView = { id: 'dingtalk', status: 'coming-soon', cli: null, version: null, receivedBytes: 0, totalBytes: 0, error: null }

function mount(state: ConnectorsState | undefined, extra: Partial<ConnectorsSnapshot> = {}, copy = zh) {
  const store = createSnapshotStore<ConnectorsSnapshot>({ state, busy: [], failure: null, ...extra })
  const props = {
    t: makeTranslate(copy), useConnectors: bindSnapshotSelector(store),
    onInstall: vi.fn(async (_id: string) => {}), onUninstall: vi.fn(async (_id: string) => {}), onDismiss: vi.fn(),
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

  it('shows an installed, unconnected connector with a red dot and uninstalls it after confirmation', () => {
    const { props } = mount({ connectors: [feishu({ status: 'disconnected' })] })
    const installed = card('飞书')
    expect(within(installed).getByText('未连接')).toBeTruthy()
    expect(installed.querySelector('[data-state="error"]')).toBeTruthy()
    const more = within(installed).getByRole('button', { name: '飞书的更多操作' })
    fireEvent.click(more)
    fireEvent.click(more)
    expect(screen.queryByRole('menuitem', { name: '卸载' })).toBeNull()
    fireEvent.click(more)
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menuitem', { name: '卸载' })).toBeNull()
    fireEvent.click(more)
    fireEvent.click(screen.getByRole('menuitem', { name: '卸载' }))
    const dialog = screen.getByRole('dialog', { name: '卸载飞书连接器' })
    expect(within(dialog).getByText(zh.uninstallDescription.replaceAll('{cli}', 'lark-cli'))).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(props.onUninstall).not.toHaveBeenCalled()
    fireEvent.click(more)
    fireEvent.click(screen.getByRole('menuitem', { name: '卸载' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '卸载' }))
    expect(props.onUninstall).toHaveBeenCalledWith('feishu')
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
