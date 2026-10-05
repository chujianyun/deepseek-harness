// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { HubAccountView } from '@deepseek-ai/dsh-hub-account/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { HubSnapshot } from '../src/client/hub-source.ts'
import { HubAccountSection } from '../src/client/HubAccountSection.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const profile = { nickname: '李雷', phone: '138****0001', tenantId: 't-a', tenantName: '甲公司', isTenantAdmin: false }

function props(view: HubAccountView | undefined, extra: Partial<HubSnapshot> = {}) {
  const store = createSnapshotStore<HubSnapshot>({ view, busy: false, failure: null, ...extra })
  return {
    t: makeTranslate(zh), useHub: bindSnapshotSelector(store),
    onSignIn: vi.fn(async () => {}), onCancel: vi.fn(async () => {}), onSignOut: vi.fn(async () => {}),
    onSwitchTenant: vi.fn(async () => {}), onReopen: vi.fn(),
  }
}

describe('Hub account section, signed in', () => {
  it('shows nickname and tenant with switch tenant and sign out', () => {
    const p = props({ status: 'signed-in', profile, reason: null, attempt: null, branding: null })
    render(<HubAccountSection {...p} />)
    expect(screen.getByRole('region', { name: 'Skill Hub 账号' }).textContent).toContain('李雷')
    expect(screen.getByText('租户：甲公司')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '切换租户' }))
    fireEvent.click(screen.getByRole('button', { name: '退出登录' }))
    expect(p.onSwitchTenant).toHaveBeenCalledOnce()
    expect(p.onSignOut).toHaveBeenCalledOnce()
  })

  it('names an account without a company and shows a refused action', () => {
    const p = props({ status: 'signed-in', profile: { ...profile, tenantId: null, tenantName: null }, reason: null, attempt: null, branding: null }, { failure: 'offline' })
    render(<HubAccountSection {...p} />)
    expect(screen.getByText('租户：不属于任何公司')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toBe('操作失败：offline')
  })
})

describe('Hub account section, signed out', () => {
  it('reports the check while the state is unknown', () => {
    render(<HubAccountSection {...props(undefined)} />)
    expect(screen.getByRole('status').textContent).toBe(zh.checking)
  })

  it('says it is signed out and starts a sign-in', () => {
    const p = props({ status: 'signed-out', profile: null, reason: null, attempt: null, branding: null })
    render(<HubAccountSection {...p} />)
    expect(screen.getByRole('region', { name: 'Skill Hub 账号' }).textContent).toContain(zh.signedOut)
    fireEvent.click(screen.getByRole('button', { name: '登录 Skill Hub' }))
    expect(p.onSignIn).toHaveBeenCalledOnce()
  })

  it('shows the waiting state with reopen and cancel', () => {
    const p = props({ status: 'signed-out', profile: null, reason: null, attempt: { id: 'a', phase: 'waiting-browser', authorizeUrl: 'https://hub/x' }, branding: null })
    render(<HubAccountSection {...p} />)
    expect(screen.getByRole('status').textContent).toBe(zh.waiting)
    fireEvent.click(screen.getByRole('button', { name: '重新打开登录页' }))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(p.onReopen).toHaveBeenCalledOnce()
    expect(p.onCancel).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: '登录 Skill Hub' })).toBeNull()
  })

  it('explains an expired sign-in and a failed attempt, and offers a retry', () => {
    const p = props({ status: 'signed-out', profile: null, reason: 'expired', attempt: { id: 'a', phase: 'failed', error: 'denied' }, branding: null })
    render(<HubAccountSection {...p} />)
    expect(screen.getAllByRole('alert').map(node => node.textContent)).toEqual([zh.expired, zh['error.denied']])
    fireEvent.click(screen.getByRole('button', { name: '重新登录' }))
    expect(p.onSignIn).toHaveBeenCalledOnce()
  })

  it('shows the exchange in progress and a refused action', () => {
    const p = props({ status: 'signed-out', profile: null, reason: null, attempt: { id: 'a', phase: 'exchanging' }, branding: null }, { failure: 'offline' })
    render(<HubAccountSection {...p} />)
    expect(screen.getByRole('status').textContent).toBe(zh.exchanging)
    expect(screen.getByRole('alert').textContent).toBe('操作失败：offline')
    expect(screen.queryByRole('button', { name: '重新打开登录页' })).toBeNull()
  })
})
