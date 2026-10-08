// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { EcommerceAccountsState, EcommerceAccountView } from '@deepseek-ai/dsh-ecommerce-accounts/types'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createExpiredSource, ExpiredToast, type ExpiredToastProps } from '../src/client/ExpiredToast.tsx'
import { en, zh } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.useRealTimers() })

const account = (over: Partial<EcommerceAccountView>): EcommerceAccountView => ({
  id: 'e1', platform: 'tmall', kind: 'merchant', storeName: '名流旗舰店', account: 'a', createdAt: '', status: 'signed-out', expired: true, inUse: false, ...over,
})
/** A buyer account, which has no store name. */
const buyer = (over: Partial<EcommerceAccountView>): EcommerceAccountView => {
  const { storeName: _storeName, ...rest } = account({ kind: 'buyer', ...over })
  return rest
}
const state = (accounts: EcommerceAccountView[]): EcommerceAccountsState => ({
  revision: 1, tenantId: 't-a', chrome: { status: 'ready', minVersion: 120, downloadUrl: 'u' }, buyerDailyPages: 20, accounts,
})

describe('expired sign-in notice', () => {
  it('announces each expiry once, again after the account signs in and expires anew, and names several at once', () => {
    const source = createExpiredSource()
    const notice = () => source.hooks.notice.getSnapshot()
    const seen = vi.fn()
    const stop = source.hooks.notice.subscribe(seen)
    source.observe(state([account({ expired: false, status: 'signed-in' })]))
    expect(notice()).toBeNull()
    source.observe(state([account({})]))
    expect(notice()).toEqual({ name: '名流旗舰店', count: 1, seq: 1 })
    source.dismiss()
    // Still expired, or checking again: announced already.
    source.observe(state([account({})]))
    source.observe(state([account({ expired: false, status: 'checking' })]))
    source.observe(state([account({})]))
    expect(notice()).toBeNull()
    // Signed in, then expired again.
    source.observe(state([account({ expired: false, status: 'signed-in' })]))
    source.observe(state([account({}), buyer({ id: 'e2', account: '买家号' })]))
    expect(notice()).toEqual({ name: '名流旗舰店', count: 2, seq: 2 })
    // Another account expiring while the notice shows joins it.
    source.observe(state([account({}), buyer({ id: 'e2', account: '买家号' }), account({ id: 'e4' })]))
    expect(notice()).toEqual({ name: '名流旗舰店', count: 3, seq: 2 })
    stop()
    expect(seen).toHaveBeenCalledTimes(4)
  })

  it('shows the banner with a way to sign in again, and clears it when it fades', () => {
    vi.useFakeTimers()
    const source = createExpiredSource()
    const openAccounts = vi.fn()
    const toast = (copy: Record<string, string>) => {
      const props = {
        t: makeTranslate(copy), useNotice: bindSnapshotSelector(source.hooks.notice), dismiss: source.dismiss, openAccounts,
      } as ExpiredToastProps
      return <ExpiredToast {...props} />
    }
    const { rerender } = render(toast(zh))
    expect(screen.queryByRole('alert')).toBeNull()
    act(() => { source.observe(state([account({})])) })
    expect(screen.getByRole('alert').textContent).toContain('电商账号「名流旗舰店」的登录已失效')
    fireEvent.click(screen.getByText('去重新登录'))
    expect(openAccounts).toHaveBeenCalledOnce()
    expect(screen.queryByRole('alert')).toBeNull()
    act(() => { source.observe(state([account({ id: 'e2' }), account({ id: 'e3' })])) })
    rerender(toast(en))
    expect(screen.getByRole('alert').textContent).toContain('The sign-in of 2 e-commerce accounts has expired')
    act(() => { vi.advanceTimersByTime(16_000) })
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
