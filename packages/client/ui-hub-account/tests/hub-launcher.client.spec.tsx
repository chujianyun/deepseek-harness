// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { HubAccountView } from '@deepseek-ai/dsh-hub-account/types'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { HubSnapshot } from '../src/client/hub-source.ts'
import { HubLauncher } from '../src/client/HubLauncher.tsx'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

const profile = { nickname: '韩梅梅', phone: '138****0001', tenantId: 't-a', tenantName: '甲公司', isTenantAdmin: false }

function mount(view: HubAccountView | undefined, { wide = true, copy = zh, busy = false } = {}) {
  const store = createSnapshotStore<HubSnapshot>({ view, busy, failure: null })
  const props = {
    t: makeTranslate(copy), useHub: bindSnapshotSelector(store), wide, settingsOpen: false,
    openSettings: vi.fn(), openOnboarding: vi.fn(),
    onSignIn: vi.fn(async () => {}), onCancel: vi.fn(async () => {}), onSignOut: vi.fn(async () => {}),
    onSwitchTenant: vi.fn(async () => {}), onReopen: vi.fn(),
  }
  render(<HubLauncher {...({} as GlobalStandardProps)} {...props} />)
  return props
}

it.each([zh, en])('shows the employee and company, opens Settings, and signs out from its menu', (copy) => {
  const props = mount({ status: 'signed-in', profile, reason: null, attempt: null }, { copy })
  const trigger = screen.getByRole('button', { name: copy.menu })
  expect(trigger.textContent).toBe('韩韩梅梅甲公司')
  fireEvent.click(trigger)
  expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([copy.settings, copy.signOut])
  fireEvent.click(screen.getByRole('menuitem', { name: copy.settings }))
  expect(props.openSettings).toHaveBeenCalledOnce()
  expect(screen.queryByRole('menu')).toBeNull()
  fireEvent.click(trigger)
  fireEvent.click(screen.getByRole('menuitem', { name: copy.signOut }))
  expect(props.onSignOut).toHaveBeenCalledOnce()
})

it('names an account without a company and keeps only the initial in the collapsed rail', () => {
  mount({ status: 'signed-in', profile: { ...profile, tenantName: null }, reason: null, attempt: null })
  expect(screen.getByRole('button', { name: zh.menu }).textContent).toBe('韩韩梅梅不属于任何公司')
  cleanup()
  mount({ status: 'signed-in', profile, reason: null, attempt: null }, { wide: false })
  expect(screen.getByRole('button', { name: zh.menu }).textContent).toBe('韩')
})

it('offers only Settings while signed out and disables sign-out while busy', () => {
  mount(undefined)
  const trigger = screen.getByRole('button', { name: zh.menu })
  expect(trigger.textContent).toBe(zh.signedOut)
  fireEvent.click(trigger)
  expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([zh.settings])
  cleanup()
  mount({ status: 'signed-in', profile, reason: null, attempt: null }, { busy: true })
  fireEvent.click(screen.getByRole('button', { name: zh.menu }))
  expect(screen.getByRole('menuitem', { name: zh.signOut }).hasAttribute('disabled')).toBe(true)
})

it('shows the Settings shortcut when the shell binds one', () => {
  const store = createSnapshotStore<HubSnapshot>({ view: { status: 'signed-in', profile, reason: null, attempt: null }, busy: false, failure: null })
  render(<HubLauncher {...({} as GlobalStandardProps)} t={makeTranslate(zh)} useHub={bindSnapshotSelector(store)} wide settingsOpen={false}
    settingsShortcut={{ keys: ['⌘', ','], aria: 'Meta+Comma' }} openSettings={vi.fn()} openOnboarding={vi.fn()}
    onSignIn={vi.fn(async () => {})} onCancel={vi.fn(async () => {})} onSignOut={vi.fn(async () => {})}
    onSwitchTenant={vi.fn(async () => {})} onReopen={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: zh.menu }))
  expect(screen.getByRole('menuitem', { name: new RegExp(zh.settings) }).textContent).toContain('⌘')
})
