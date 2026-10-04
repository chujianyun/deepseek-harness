// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { HubAccountView } from '@deepseek-ai/dsh-hub-account/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { HubSnapshot } from '../src/client/hub-source.ts'
import { HubAccountSection } from '../src/client/HubAccountSection.tsx'
import { HubGate } from '../src/client/HubGate.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const profile = { nickname: '李雷', phone: '138****0001', tenantId: 't-a', tenantName: '甲公司', isTenantAdmin: false }

function props(view: HubAccountView | undefined, extra: Partial<HubSnapshot> = {}) {
  const store = createSnapshotStore<HubSnapshot>({ view, busy: false, failure: null, ...extra })
  const face = {
    t: makeTranslate(zh), useHub: bindSnapshotSelector(store),
    onSignIn: vi.fn(async () => {}), onCancel: vi.fn(async () => {}), onSignOut: vi.fn(async () => {}),
    onSwitchTenant: vi.fn(async () => {}), onReopen: vi.fn(),
  }
  return { store, props: face }
}

describe('Hub gate', () => {
  it('blocks the application while the state is unknown', () => {
    const { props: p } = props(undefined)
    render(<HubGate {...p} />)
    expect(screen.getByRole('dialog', { name: '登录 Skill Hub' })).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe('正在检查登录状态…')
  })

  it('offers sign-in when signed out and starts it', () => {
    const { props: p } = props({ status: 'signed-out', profile: null, reason: null, attempt: null })
    render(<HubGate {...p} />)
    fireEvent.click(screen.getByRole('button', { name: '用用户中心登录' }))
    expect(p.onSignIn).toHaveBeenCalledOnce()
  })

  it('shows the waiting state with reopen and cancel', () => {
    const { props: p } = props({ status: 'signed-out', profile: null, reason: null, attempt: { id: 'a', phase: 'waiting-browser', authorizeUrl: 'https://hub/x' } })
    render(<HubGate {...p} />)
    expect(screen.getByRole('status').textContent).toContain('请在浏览器中完成登录')
    fireEvent.click(screen.getByRole('button', { name: '重新打开登录页' }))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(p.onReopen).toHaveBeenCalledOnce()
    expect(p.onCancel).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: '用用户中心登录' })).toBeNull()
  })

  it('explains an expired sign-in and a failed attempt', () => {
    const { props: p } = props({ status: 'signed-out', profile: null, reason: 'expired', attempt: { id: 'a', phase: 'failed', error: 'denied' } })
    render(<HubGate {...p} />)
    const alerts = screen.getAllByRole('alert').map(node => node.textContent)
    expect(alerts).toEqual([zh.expired, zh['error.denied']])
    expect(screen.getByRole('button', { name: '重新登录' })).toBeTruthy()
  })

  it('shows the exchange in progress and a refused action', () => {
    const { props: p } = props({ status: 'signed-out', profile: null, reason: null, attempt: { id: 'a', phase: 'exchanging' } }, { failure: 'offline' })
    render(<HubGate {...p} />)
    expect(screen.getByRole('status').textContent).toBe(zh.exchanging)
    expect(screen.getByRole('alert').textContent).toBe('操作失败：offline')
    expect(screen.queryByRole('button', { name: '重新打开登录页' })).toBeNull()
  })

  it('renders nothing once signed in', () => {
    const { props: p } = props({ status: 'signed-in', profile, reason: null, attempt: null })
    render(<HubGate {...p} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('Hub account section', () => {
  it('shows nickname and tenant with switch tenant and sign out', () => {
    const { props: p } = props({ status: 'signed-in', profile, reason: null, attempt: null })
    render(<HubAccountSection {...p} />)
    expect(screen.getByRole('region', { name: 'Skill Hub 账号' }).textContent).toContain('李雷')
    expect(screen.getByText('租户：甲公司')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '切换租户' }))
    fireEvent.click(screen.getByRole('button', { name: '退出登录' }))
    expect(p.onSwitchTenant).toHaveBeenCalledOnce()
    expect(p.onSignOut).toHaveBeenCalledOnce()
  })

  it('shows a missing tenant and a refused action', () => {
    const { props: p } = props({ status: 'signed-in', profile: { ...profile, tenantName: null }, reason: null, attempt: null }, { failure: 'offline' })
    render(<HubAccountSection {...p} />)
    expect(screen.getByText('租户：—')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toBe('操作失败：offline')
  })

  it('renders nothing while signed out', () => {
    const { props: p } = props({ status: 'signed-out', profile: null, reason: null, attempt: null })
    const { container } = render(<HubAccountSection {...p} />)
    expect(container.textContent).toBe('')
  })
})
