// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ConnectorsState, ConnectorView } from '@deepseek-ai/dsh-connectors/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ConnectorsSnapshot } from '../src/client/connectors-source.ts'
import { ConnectorLogo } from '../src/client/ConnectorLogo.tsx'
import { ConnectorsPage } from '../src/client/ConnectorsPage.tsx'
import { en, zh } from '../src/client/locales.ts'

const NO_COMPANY: ConnectorsState['company'] = { status: 'ready', tools: [] }

afterEach(() => { cleanup() })

const feishu = (over: Partial<ConnectorView> = {}): ConnectorView => ({
  id: 'feishu', status: 'not-installed', cli: 'lark-cli', version: '1.0.97', receivedBytes: 0, totalBytes: 1000, error: null,
  login: null, loginError: null, account: null, problem: null, enabled: true, skills: [], ...over,
})
const dingtalk = (over: Partial<ConnectorView> = {}): ConnectorView => ({
  id: 'dingtalk', status: 'not-installed', cli: 'dws', version: '1.0.63', receivedBytes: 0, totalBytes: 2000, error: null,
  login: null, loginError: null, account: null, problem: null, enabled: true, skills: [], ...over,
})
const BOTH_STEPS = ['create-app', 'authorize'] as const

function mount(state: ConnectorsState | undefined, extra: Partial<ConnectorsSnapshot> = {}, copy = zh) {
  const store = createSnapshotStore<ConnectorsSnapshot>({ state, busy: [], failure: null, ...extra })
  const props = {
    t: makeTranslate(copy), useConnectors: bindSnapshotSelector(store),
    onInstall: vi.fn(async (_id: string) => {}), onUninstall: vi.fn(async (_id: string) => {}), onDismiss: vi.fn(),
    onConnect: vi.fn(async (_id: string) => {}), onCancelConnect: vi.fn(async (_id: string) => {}),
    onDisconnect: vi.fn(async (_id: string) => {}), onCheck: vi.fn(async () => {}), onOpenUrl: vi.fn((_url: string) => {}),
    onSetEnabled: vi.fn(async (_id: string, _enabled: boolean) => {}),
    onSetCompanyEnabled: vi.fn(async (_name: string, _enabled: boolean) => {}),
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

  it.each([zh, en])('shows each platform\'s logo beside its name, under a header without an intro', (copy) => {
    mount({ company: NO_COMPANY, connectors: [feishu(), dingtalk()] }, {}, copy)
    expect(card(copy['name.feishu']).querySelector('svg[data-logo="feishu"]')?.getAttribute('aria-hidden')).toBe('true')
    expect(card(copy['name.dingtalk']).querySelector('svg[data-logo="dingtalk"]')?.getAttribute('aria-hidden')).toBe('true')
    expect(screen.getByRole('banner').textContent).toBe(copy.title)
  })

  it('marks a connector without a logo by its name\'s first character', () => {
    render(<ConnectorLogo id="wecom" name="企业微信" />)
    expect(screen.getByText('企').getAttribute('aria-hidden')).toBe('true')
  })

  it.each([zh, en])('offers + on each connector that is not installed, with its pinned CLI', (copy) => {
    const { props } = mount({ company: NO_COMPANY, connectors: [feishu(), dingtalk()] }, {}, copy)
    const install = within(card(copy['name.feishu'])).getByRole('button', { name: copy.install.replace('{name}', copy['name.feishu']) })
    expect(within(card(copy['name.feishu'])).getByText('lark-cli 1.0.97')).toBeTruthy()
    fireEvent.click(install)
    expect(props.onInstall).toHaveBeenCalledWith('feishu')
    expect(within(card(copy['name.dingtalk'])).getByText('dws 1.0.63')).toBeTruthy()
    fireEvent.click(within(card(copy['name.dingtalk'])).getByRole('button', { name: copy.install.replace('{name}', copy['name.dingtalk']) }))
    expect(props.onInstall).toHaveBeenCalledWith('dingtalk')
  })

  it('disables + while the install request is in flight', () => {
    mount({ company: NO_COMPANY, connectors: [feishu()] }, { busy: ['feishu'] })
    expect(within(card('飞书')).getByRole('button', { name: '安装飞书' })).toHaveProperty('disabled', true)
  })

  it('shows download progress, then the check once every byte arrived', () => {
    const { store } = mount({ company: NO_COMPANY, connectors: [feishu({ status: 'installing', receivedBytes: 420 })] })
    expect(within(card('飞书')).getByRole('status', { name: '正在安装飞书' })).toBeTruthy()
    expect(within(card('飞书')).getByText('正在下载 42%')).toBeTruthy()
    expect(within(card('飞书')).getByRole('progressbar')).toHaveProperty('value', 42)
    act(() => { store.set({ ...store.getSnapshot(), state: { company: NO_COMPANY, connectors: [feishu({ status: 'installing', receivedBytes: 1000 })] } }) })
    expect(within(card('飞书')).getByText('正在检查…')).toBeTruthy()
    act(() => { store.set({ ...store.getSnapshot(), state: { company: NO_COMPANY, connectors: [feishu({ status: 'installing', totalBytes: 0 })] } }) })
    expect(within(card('飞书')).getByText('正在下载 0%')).toBeTruthy()
  })

  it.each(['network', 'verification', 'storage', 'busy', 'launch'] as const)('explains a failed install (%s) and offers + again', (error) => {
    mount({ company: NO_COMPANY, connectors: [feishu({ error })] })
    expect(within(card('飞书')).getByRole('alert').textContent).toBe(zh[`error.${error}`].replace('{cli}', 'lark-cli'))
    expect(within(card('飞书')).getByRole('button', { name: '安装飞书' })).toBeTruthy()
  })

  it('shows an installed, unconnected connector with a red dot, connects it, and uninstalls it after confirmation', () => {
    const { props } = mount({ company: NO_COMPANY, connectors: [feishu({ status: 'disconnected' })] })
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
    const { props } = mount({ company: NO_COMPANY, connectors: [feishu({ status: 'connected', account: '韩梅梅' })] })
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
    const { props } = mount({ company: NO_COMPANY, connectors: [feishu({ status: 'degraded', problem: 'refresh failed' })] })
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
    mount({ company: NO_COMPANY, connectors: [feishu({ status: 'disconnected', loginError: { step, message: step === 'create-app' ? 'apps are forbidden' : 'expired' } })] })
    expect(within(card('飞书')).getByRole('alert').textContent).toBe(text)
  })

  it('walks the sign-in dialog through preparing, the app step with its QR code, and the authorize step without one', () => {
    const { props, store } = mount({ company: NO_COMPANY, connectors: [feishu({ status: 'connecting', login: { steps: BOTH_STEPS, step: 'create-app', url: null, qrCode: null } })] })
    expect(within(card('飞书')).getByRole('status', { name: '正在连接飞书' })).toBeTruthy()
    const dialog = screen.getByRole('dialog', { name: '连接飞书' })
    expect(within(dialog).getByRole('status').textContent).toBe('正在准备授权链接…')
    expect(dialog.querySelector('[aria-current="step"]')?.textContent).toBe('1. 创建飞书应用')
    act(() => {
      store.set({ ...store.getSnapshot(), state: { company: NO_COMPANY, connectors: [feishu({ status: 'connecting', login: { steps: BOTH_STEPS, step: 'create-app', url: 'https://open.feishu.cn/x', qrCode: 'data:image/png;base64,UE5H' } })] } })
    })
    expect(within(screen.getByRole('dialog')).getByRole('img', { name: '飞书授权二维码' }).getAttribute('src')).toBe('data:image/png;base64,UE5H')
    expect(within(screen.getByRole('dialog')).getByText('https://open.feishu.cn/x')).toBeTruthy()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '在浏览器中打开' }))
    expect(props.onOpenUrl).toHaveBeenCalledWith('https://open.feishu.cn/x')
    act(() => {
      store.set({ ...store.getSnapshot(), state: { company: NO_COMPANY, connectors: [feishu({ status: 'connecting', login: { steps: BOTH_STEPS, step: 'authorize', url: 'https://accounts.feishu.cn/y', qrCode: null } })] } })
    })
    const authorize = screen.getByRole('dialog')
    expect(authorize.querySelector('[aria-current="step"]')?.textContent).toBe('2. 授权飞书账号')
    expect(within(authorize).getByText('二维码生成失败，请使用下方的链接。')).toBeTruthy()
    fireEvent.click(within(authorize).getAllByRole('button', { name: '取消连接' }).at(-1)!)
    fireEvent.click(within(authorize).getAllByRole('button', { name: '取消连接' })[0]!)
    expect(props.onCancelConnect).toHaveBeenCalledTimes(2)
    act(() => {
      store.set({ ...store.getSnapshot(), state: { company: NO_COMPANY, connectors: [feishu({ status: 'connecting', login: null })] } })
    })
    // Without a sign-in view yet, the dialog lists no steps.
    expect(screen.getByRole('dialog').querySelector('ol')).toBeNull()
    act(() => { store.set({ ...store.getSnapshot(), state: { company: NO_COMPANY, connectors: [feishu({ status: 'connected' })] } }) })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it.each([zh, en])('signs in to DingTalk in one step, without a step list', (copy) => {
    const qr = 'data:image/svg+xml;base64,PHN2Zy8+'
    mount({ company: NO_COMPANY, connectors: [feishu(), dingtalk({ status: 'connecting', login: { steps: ['authorize'], step: 'authorize', url: 'https://login.dingtalk.com/x?user_code=A', qrCode: qr } })] }, {}, copy)
    const dialog = screen.getByRole('dialog', { name: copy.loginTitle.replace('{name}', copy['name.dingtalk']) })
    expect(dialog.querySelector('ol')).toBeNull()
    expect(within(dialog).getByText(copy['login.dingtalk.authorize'])).toBeTruthy()
    expect(within(dialog).getByRole('img', { name: copy.loginQr.replace('{name}', copy['name.dingtalk']) }).getAttribute('src')).toBe(qr)
  })

  it('closes the uninstall confirmation from its close button', () => {
    mount({ company: NO_COMPANY, connectors: [feishu({ status: 'disconnected' })] })
    fireEvent.click(within(card('飞书')).getByRole('button', { name: '飞书的更多操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '卸载' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '关闭' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('labels a connector whose CLI has no build for this system', () => {
    mount({ company: NO_COMPANY, connectors: [feishu({ status: 'unsupported' })] })
    expect(within(card('飞书')).getByText('此系统暂不支持')).toBeTruthy()
  })

  it('shows a refused action until dismissed', () => {
    const { props } = mount({ company: NO_COMPANY, connectors: [] }, { failure: 'no connector x' })
    expect(screen.getByRole('alert').textContent).toContain('操作失败：no connector x')
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(props.onDismiss).toHaveBeenCalledOnce()
  })

  it('lists the Skills the connector adds, collapsing the rest, and switches it off and on', () => {
    const skills = Array.from({ length: 10 }, (_, index) => ({ name: `lark-s${String(index)}`, description: `能力 ${String(index)}` }))
    const { props, store } = mount({ company: NO_COMPANY, connectors: [feishu({ status: 'connected', skills })] })
    const connected = card('飞书')
    expect(within(connected).getByText('带来的 Skill（10）')).toBeTruthy()
    expect(within(connected).getByText('lark-s0').getAttribute('title')).toBe('能力 0')
    expect(within(connected).queryByText('lark-s9')).toBeNull()
    fireEvent.click(within(connected).getByRole('button', { name: '还有 2 个' }))
    expect(within(connected).getByText('lark-s9')).toBeTruthy()
    const toggle = within(connected).getByRole('switch', { name: '在对话中使用飞书' })
    fireEvent.click(toggle)
    expect(props.onSetEnabled).toHaveBeenCalledWith('feishu', false)
    act(() => { store.set({ ...store.getSnapshot(), state: { company: NO_COMPANY, connectors: [feishu({ status: 'connected', skills, enabled: false })] } }) })
    expect(card('飞书').getAttribute('data-enabled')).toBe('false')
    expect(within(card('飞书')).getByText('已停用：对话中的模型不会使用飞书，登录信息保留。')).toBeTruthy()
    fireEvent.click(within(card('飞书')).getByRole('switch', { name: '在对话中使用飞书' }))
    expect(props.onSetEnabled).toHaveBeenLastCalledWith('feishu', true)
    act(() => { store.set({ ...store.getSnapshot(), state: { company: NO_COMPANY, connectors: [feishu({ status: 'installing', skills })] } }) })
    expect(within(card('飞书')).queryByText('带来的 Skill（10）')).toBeNull()
  })

  it('groups the office platforms apart from the company tools, which switch off and on', () => {
    const jackyun = { name: 'jackyun', kind: 'jackyun', displayName: '吉客云', description: '', methods: ['erp.storage.goodslist', 'erp.packagegoods.import'], enabled: true }
    const { props, store } = mount({ company: { status: 'ready', tools: [jackyun] }, connectors: [feishu()] })
    const office = screen.getByRole('region', { name: '办公平台' })
    expect(within(office).getByText('飞书')).toBeTruthy()
    const tools = screen.getByRole('region', { name: '公司提供的工具' })
    const tool = within(tools).getByText('吉客云').closest('li')!
    expect(within(tool).getByText('可用')).toBeTruthy()
    expect(within(tool).getByText('由公司管理员开通，账号与密钥保存在用户中心，不会发到你的电脑。')).toBeTruthy()
    expect(within(tool).getByText('可调用 2 个接口')).toBeTruthy()
    expect(within(tool).getByText('吉').getAttribute('aria-hidden')).toBe('true')
    fireEvent.click(within(tool).getByRole('switch', { name: '在对话中使用吉客云' }))
    expect(props.onSetCompanyEnabled).toHaveBeenCalledWith('jackyun', false)
    fireEvent.click(within(tool).getByRole('button', { name: '吉客云的更多操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '重新检查' }))
    expect(props.onCheck).toHaveBeenCalled()
    act(() => { store.set({ ...store.getSnapshot(), busy: ['company:jackyun'], state: { company: { status: 'ready', tools: [{ ...jackyun, enabled: false, description: '查货品' }] }, connectors: [] } }) })
    const off = within(screen.getByRole('region', { name: '公司提供的工具' })).getByText('吉客云').closest('li')!
    expect(off.getAttribute('data-enabled')).toBe('false')
    expect(within(off).getByText('查货品')).toBeTruthy()
    expect(within(off).getByText('已停用：对话中的模型不会使用吉客云。')).toBeTruthy()
    expect((within(off).getByRole<HTMLButtonElement>('switch', { name: '在对话中使用吉客云' })).disabled).toBe(true)
  })

  it('leaves the company group out without tools, and says when to sign in again or why they cannot be read', () => {
    const { store } = mount({ company: { status: 'loading', tools: [] }, connectors: [feishu()] })
    expect(screen.queryByRole('region', { name: '公司提供的工具' })).toBeNull()
    act(() => { store.set({ ...store.getSnapshot(), state: { company: { status: 'sign-in-again', tools: [] }, connectors: [] } }) })
    expect(screen.getByRole('status').textContent).toBe('公司为你开通了新的工具，需要在「设置 → 账户」退出用户中心后重新登录才能使用。')
    act(() => { store.set({ ...store.getSnapshot(), state: { company: { status: 'unavailable', tools: [] }, connectors: [] } }) })
    expect(screen.getByRole('status').textContent).toBe('暂时读不到公司提供的工具，请检查网络后点「⋯ → 重新检查」。')
  })
})
