// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { EcommerceAccountsState, EcommerceAccountView } from '@deepseek-ai/dsh-ecommerce-accounts/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { AccountsSnapshot, Refusal } from '../src/client/accounts-source.ts'
import { EcommerceAccountsSection } from '../src/client/EcommerceAccountsSection.tsx'
import { en, zh } from '../src/client/locales.ts'

afterEach(() => { cleanup() })

const CHROME = { status: 'ready', minVersion: 120, downloadUrl: 'https://www.google.com/chrome/' } as const
const account = (over: Partial<EcommerceAccountView> = {}): EcommerceAccountView => ({
  id: 'e1', platform: 'tmall', kind: 'merchant', storeName: '名流旗舰店', account: 'mingliu:运营', status: 'signed-out', expired: false, inUse: false, createdAt: '2026-10-07T00:00:00Z', ...over,
})
/** A buyer account, which has no store name. */
const buyer = (over: Partial<EcommerceAccountView>): EcommerceAccountView => {
  const { storeName: _storeName, ...rest } = account({ kind: 'buyer', ...over })
  return rest
}
const base: EcommerceAccountsState = { revision: 1, tenantId: 't-a', chrome: CHROME, buyerDailyPages: 20, accounts: [] }

function mount(state: EcommerceAccountsState | undefined, copy: Record<string, string> = zh) {
  const store = createSnapshotStore<AccountsSnapshot>({ state })
  const props = {
    t: makeTranslate(copy), useAccounts: bindSnapshotSelector(store),
    onAdd: vi.fn(async (): Promise<{ accountId: string } | Refusal> => ({ accountId: 'e1' })),
    onStartSignIn: vi.fn(async (_id: string): Promise<Refusal | undefined> => undefined),
    onConfirmSignIn: vi.fn(async (_id: string): Promise<Refusal | undefined> => undefined),
    onRename: vi.fn(async (_id: string, _changes: { account?: string; storeName?: string }): Promise<Refusal | undefined> => undefined),
    onSetDailyPages: vi.fn(async (_pages: number): Promise<Refusal | undefined> => undefined),
    onRefresh: vi.fn(async () => {}),
    onDelete: vi.fn(async (_id: string): Promise<Refusal | undefined> => undefined),
    onOpenUrl: vi.fn(),
  }
  render(<EcommerceAccountsSection {...props} />)
  const set = (next: EcommerceAccountsState) => { act(() => { store.set({ state: next }) }) }
  return { ...props, set }
}

describe('e-commerce accounts section', () => {
  it('checks the accounts when it opens, and leads an empty list to the first account', async () => {
    const props = mount(base)
    expect(props.onRefresh).toHaveBeenCalledOnce()
    expect(screen.getByText('还没有电商账号。')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '新增账号' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '添加第一个账号' }))
    const dialog = screen.getByRole('dialog', { name: '新增账号' })
    expect(dialog.textContent).toContain('本功能需要搭配Google浏览器使用。')
    expect(within(dialog).getByRole<HTMLSelectElement>('combobox', { name: '平台' }).value).toBe('tmall')
    expect(within(dialog).getByRole<HTMLSelectElement>('combobox', { name: '账号类型' }).value).toBe('merchant')
    const signIn = within(dialog).getByRole<HTMLButtonElement>('button', { name: '去登录' })
    expect(signIn.disabled).toBe(true)
    expect(dialog.textContent).toContain('请填写店铺名和账号')
    fireEvent.change(within(dialog).getByPlaceholderText('例如：名流旗舰店'), { target: { value: '名流旗舰店' } })
    expect(signIn.disabled).toBe(true)
    fireEvent.change(within(dialog).getByPlaceholderText('例如：名流旗舰店:运营'), { target: { value: 'mingliu:运营' } })
    await act(async () => { fireEvent.click(signIn) })
    expect(props.onAdd).toHaveBeenCalledWith({ platform: 'tmall', kind: 'merchant', storeName: '名流旗舰店', account: 'mingliu:运营' })
    expect(props.onStartSignIn).toHaveBeenCalledWith('e1')
    expect(screen.queryByRole('dialog', { name: '新增账号' })).toBeNull()
    // The sign-in dialog follows the account as the stream updates it.
    props.set({ ...base, accounts: [account({ status: 'signing-in' })] })
    const signing = screen.getByRole('dialog', { name: '登录天猫' })
    expect(signing.textContent).toContain('已在 Google Chrome 中打开天猫登录页')
    await act(async () => { fireEvent.click(within(signing).getByRole('button', { name: '我已完成登录' })) })
    expect(props.onConfirmSignIn).toHaveBeenCalledWith('e1')
    props.set({ ...base, accounts: [account({ status: 'signed-in', signedInAs: '名流旗舰店:运营' })] })
    expect(signing.textContent).toContain('登录成功，平台显示的账号是「名流旗舰店:运营」')
    expect(within(signing).queryByRole('button', { name: '我已完成登录' })).toBeNull()
    fireEvent.click(within(signing).getByRole('button', { name: '完成' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows a refused add and closes the add dialog on Cancel', async () => {
    const props = mount({ ...base, accounts: [account()] })
    props.onAdd.mockResolvedValueOnce({ kind: 'duplicate' })
    fireEvent.click(screen.getByRole('button', { name: '新增账号' }))
    const dialog = screen.getByRole('dialog', { name: '新增账号' })
    fireEvent.change(within(dialog).getByPlaceholderText('例如：名流旗舰店'), { target: { value: 's' } })
    fireEvent.change(within(dialog).getByPlaceholderText('例如：名流旗舰店:运营'), { target: { value: 'a' } })
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '去登录' })) })
    expect(within(dialog).getByRole('alert').textContent).toBe('当前账号已添加')
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('groups accounts by platform with counts, searches store and account, and says when nothing matches', () => {
    mount({ ...base, accounts: [account(), account({ id: 'e2', storeName: '第二家店', account: 'second', status: 'signed-in' }), buyer({ id: 'e3', account: 'buyer', status: 'check-failed' })] })
    const group = screen.getByText('天猫').closest('details')!
    expect(group.textContent).toContain('3 个')
    expect(within(group).getByRole('button', { name: '查看 名流旗舰店 的详情' }).textContent).toContain('mingliu:运营 · 商家账号未登录或登录过期')
    expect(within(group).getByRole('button', { name: '查看 buyer 的详情' }).textContent).toContain('buyer · 买家账号 · 今日 0/20 页检查失败')
    expect(group.querySelector('[data-status="signed-in"]')).toBeTruthy()
    const search = screen.getByRole('textbox', { name: '搜索店铺名或账号' })
    fireEvent.change(search, { target: { value: 'SECOND' } })
    expect(screen.getAllByRole('button', { name: /查看/ })).toHaveLength(1)
    fireEvent.change(search, { target: { value: '没有' } })
    expect(screen.getByText('没有找到匹配的账号。')).toBeTruthy()
  })

  it('opens an account\'s details, signs in again, and deletes it after confirming', async () => {
    const props = mount({ ...base, accounts: [account({ status: 'signed-in', signedInAs: 'nick', checkedAt: new Date(Date.now() - 5 * 60_000).toISOString() })] })
    fireEvent.click(screen.getByRole('button', { name: '查看 名流旗舰店 的详情' }))
    const detail = screen.getByRole('heading', { name: '名流旗舰店' }).parentElement!
    for (const text of ['平台天猫', '店铺名名流旗舰店', '账号mingliu:运营', '账号类型商家账号', '登录状态已登录', '平台显示的账号nick', '上次检查5 分钟前']) expect(detail.textContent).toContain(text)
    // The platform reports another account than the one entered: use its name, or sign in again.
    const note = screen.getByRole('note')
    expect(note.textContent).toContain('实际登录的是「nick」，与填写的账号不一致。')
    props.onRename.mockResolvedValueOnce({ kind: 'duplicate' })
    await act(async () => { fireEvent.click(within(note).getByRole('button', { name: '改为实际账号名' })) })
    expect(props.onRename).toHaveBeenCalledWith('e1', { account: 'nick' })
    expect(within(note).getByRole('alert').textContent).toBe('当前账号已添加')
    await act(async () => { fireEvent.click(within(note).getByRole('button', { name: '改为实际账号名' })) })
    expect(within(note).queryByRole('alert')).toBeNull()
    await act(async () => { fireEvent.click(within(note).getByRole('button', { name: '重新登录' })) })
    expect(props.onStartSignIn).toHaveBeenCalledWith('e1')
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '完成' }))
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: '重新登录' }).at(-1)!) })
    expect(props.onStartSignIn).toHaveBeenCalledTimes(2)
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '完成' }))
    fireEvent.click(screen.getByRole('button', { name: '删除账号' }))
    const confirm = screen.getByRole('dialog', { name: '删除电商账号' })
    expect(confirm.textContent).toContain('确定删除「名流旗舰店」吗？')
    fireEvent.click(within(confirm).getByRole('button', { name: '取消' }))
    fireEvent.click(screen.getByRole('button', { name: '删除账号' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '关闭' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '删除账号' }))
    await act(async () => { fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '删除' })) })
    expect(props.onDelete).toHaveBeenCalledWith('e1')
    expect(screen.getByRole('button', { name: '查看 名流旗舰店 的详情' })).toBeTruthy()
  })

  it('shows a refused delete, goes back to the list, and offers sign-in to a signed-out account', async () => {
    const props = mount({ ...base, accounts: [buyer({ account: '买家号' })] })
    props.onDelete.mockResolvedValueOnce({ kind: 'in-use' })
    fireEvent.click(screen.getByRole('button', { name: '查看 买家号 的详情' }))
    expect(screen.getByRole('button', { name: '去登录' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '删除账号' }))
    await act(async () => { fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '删除' })) })
    expect(screen.getByRole('alert').textContent).toBe('这个账号正被一个任务使用，请等任务结束后再操作。')
    props.onDelete.mockResolvedValueOnce({ kind: 'delete-failed' })
    fireEvent.click(screen.getByRole('button', { name: '删除账号' }))
    await act(async () => { fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '删除' })) })
    expect(screen.getByRole('alert').textContent).toBe('这个账号的浏览器数据暂时删不掉，可能仍被占用。账号已保留，请稍后再删除。')
    fireEvent.click(screen.getByRole('button', { name: '← 返回账号列表' }))
    expect(screen.getByRole('button', { name: '查看 买家号 的详情' })).toBeTruthy()
  })

  it('asks for Google Chrome, or a newer one, with a way to get it', async () => {
    const props = mount({ ...base, chrome: { ...CHROME, status: 'missing' }, accounts: [account()] })
    const banner = screen.getByRole('alert')
    expect(banner.textContent).toContain('需要 Google Chrome')
    fireEvent.click(within(banner).getByRole('button', { name: '前往下载' }))
    expect(props.onOpenUrl).toHaveBeenCalledWith('https://www.google.com/chrome/')
    props.onStartSignIn.mockResolvedValueOnce({ kind: 'chrome-missing' })
    fireEvent.click(screen.getByRole('button', { name: '查看 名流旗舰店 的详情' }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '去登录' })) })
    const dialog = screen.getByRole('dialog', { name: '登录天猫' })
    expect(dialog.textContent).toContain('需要 Google Chrome')
    fireEvent.click(within(dialog).getByRole('button', { name: '前往下载' }))
    expect(props.onOpenUrl).toHaveBeenCalledTimes(2)
    fireEvent.click(within(dialog).getAllByRole('button', { name: '关闭' }).at(-1)!)
    props.set({ ...base, chrome: { ...CHROME, status: 'outdated', version: '100.0' }, accounts: [account()] })
    expect(screen.getAllByRole('alert')[0]!.textContent).toContain('Google Chrome 版本过低（100.0），请升级到 120 或更高版本。')
    props.set({ ...base, chrome: { ...CHROME, status: 'outdated' }, accounts: [account()] })
    expect(screen.getAllByRole('alert')[0]!.textContent).toContain('版本过低（）')
  })

  it('says a sign-in timed out, shows a refused check, and words an outdated refusal, in English too', async () => {
    const props = mount({ ...base, accounts: [account({ status: 'signing-in' })] }, en)
    props.onConfirmSignIn.mockResolvedValueOnce({ kind: 'other', message: 'offline' })
    fireEvent.click(screen.getByRole('button', { name: 'Open 名流旗舰店' }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Sign in' })) })
    const dialog = screen.getByRole('dialog', { name: 'Sign in to Tmall' })
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'I have signed in' })) })
    expect(dialog.textContent).toContain('Could not complete the action: offline')
    props.set({ ...base, accounts: [account({ status: 'signed-out' })] })
    expect(dialog.textContent).toContain('The sign-in timed out')
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Close' }).at(-1)!)
    props.onStartSignIn.mockResolvedValueOnce({ kind: 'chrome-outdated', version: '99', minVersion: 120 })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Sign in' })) })
    expect(screen.getByRole('dialog').textContent).toContain('Google Chrome 99 is too old')
    fireEvent.click(within(screen.getByRole('dialog')).getAllByRole('button', { name: 'Close' }).at(-1)!)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Sign in' })) })
    props.set({ ...base, accounts: [account({ status: 'signed-in' })] })
    expect(screen.getByRole('dialog').textContent).toContain('Signed in. This Chrome stays signed in in the background.')
  })

  it('adds an account on another platform, and shows why a check failed', async () => {
    const props = mount({ ...base, accounts: [
      account({ platform: 'pinduoduo', status: 'check-failed', problem: 'network' }),
      account({ id: 'e2', platform: 'doudian', storeName: '抖店一号', status: 'check-failed', problem: 'busy' }),
      account({ id: 'e3', platform: 'taobao', storeName: '淘宝店', status: 'check-failed', problem: 'timeout' }),
    ] })
    props.set({ ...base, accounts: [
      account({ platform: 'pinduoduo', status: 'check-failed', problem: 'network' }),
      account({ id: 'e2', platform: 'doudian', storeName: '抖店一号', status: 'check-failed', problem: 'busy' }),
      account({ id: 'e3', platform: 'taobao', storeName: '淘宝店', status: 'check-failed', problem: 'timeout' }),
      account({ id: 'e4', storeName: '天猫店', status: 'signed-in', inUse: true }),
    ] })
    for (const [group, problem] of [['拼多多', '网络不通'], ['抖店', '浏览器正被其他程序占用'], ['淘宝', '检查超时'], ['天猫', '任务使用中']] as const) {
      expect(screen.getByText(group).closest('details')!.textContent).toContain(problem)
    }
    fireEvent.click(screen.getByRole('button', { name: '新增账号' }))
    const dialog = screen.getByRole('dialog', { name: '新增账号' })
    const platform = within(dialog).getByRole<HTMLSelectElement>('combobox', { name: '平台' })
    expect([...platform.options].map(option => option.text)).toEqual(['天猫', '淘宝', '拼多多', '抖店'])
    fireEvent.change(platform, { target: { value: 'doudian' } })
    fireEvent.change(within(dialog).getByPlaceholderText('例如：名流旗舰店'), { target: { value: '抖店二号' } })
    fireEvent.change(within(dialog).getByPlaceholderText('例如：名流旗舰店:运营'), { target: { value: 'b' } })
    props.onStartSignIn.mockResolvedValueOnce({ kind: 'browser-busy' })
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '去登录' })) })
    expect(props.onAdd).toHaveBeenCalledWith({ platform: 'doudian', kind: 'merchant', storeName: '抖店二号', account: 'b' })
    expect(screen.getByRole('dialog', { name: '登录拼多多' }).textContent).toContain('这个账号的浏览器数据正被另一个 Chrome 使用')
  })

  it('offers the actual account name, or signing in again, once the sign-in shows another account', async () => {
    const props = mount({ ...base, accounts: [account({ status: 'signing-in' })] })
    fireEvent.click(screen.getByRole('button', { name: '查看 名流旗舰店 的详情' }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '去登录' })) })
    props.set({ ...base, accounts: [account({ status: 'signed-in', signedInAs: '名流成人用品旗舰店:小美' })] })
    const dialog = screen.getByRole('dialog', { name: '登录天猫' })
    expect(within(dialog).getByRole('note').textContent).toContain('实际登录的是「名流成人用品旗舰店:小美」')
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '重新登录' })) })
    expect(props.onStartSignIn).toHaveBeenCalledTimes(2)
    // Once the names agree there is nothing to say.
    props.set({ ...base, accounts: [account({ status: 'signed-in', account: 'x', signedInAs: 'x' })] })
    expect(within(dialog).queryByRole('note')).toBeNull()
  })

  it('offers the actual store name of a platform that names the store, and says which store signed in', async () => {
    const props = mount({ ...base, accounts: [account({ platform: 'pinduoduo', storeName: '名流保健', status: 'signing-in' })] })
    fireEvent.click(screen.getByRole('button', { name: '查看 名流保健 的详情' }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '去登录' })) })
    props.set({ ...base, accounts: [account({ platform: 'pinduoduo', storeName: '名流保健', status: 'signed-in', signedInStore: '名流保健用品官方旗舰店' })] })
    const dialog = screen.getByRole('dialog', { name: '登录拼多多' })
    expect(dialog.textContent).toContain('登录成功，平台显示的店铺是「名流保健用品官方旗舰店」')
    const note = within(dialog).getByRole('note')
    expect(note.textContent).toContain('实际登录的店铺是「名流保健用品官方旗舰店」，与填写的店铺名不一致。')
    expect(within(note).queryByRole('button', { name: '改为实际账号名' })).toBeNull()
    await act(async () => { fireEvent.click(within(note).getByRole('button', { name: '改为实际店铺名' })) })
    expect(props.onRename).toHaveBeenCalledWith('e1', { storeName: '名流保健用品官方旗舰店' })
    fireEvent.click(within(dialog).getByRole('button', { name: '完成' }))
    expect(screen.getByText('平台显示的店铺').nextSibling?.textContent).toBe('名流保健用品官方旗舰店')
    // A matching store, or a store reported for an account without one, says nothing.
    props.set({ ...base, accounts: [account({ platform: 'pinduoduo', storeName: 'x', status: 'signed-in', signedInStore: 'x' })] })
    expect(screen.queryByRole('note')).toBeNull()
  })

  it('adds a buyer account with only its account, on Taobao or Tmall only', async () => {
    const props = mount({ ...base, accounts: [account()] })
    fireEvent.click(screen.getByRole('button', { name: '新增账号' }))
    const dialog = screen.getByRole('dialog', { name: '新增账号' })
    const kind = within(dialog).getByRole<HTMLSelectElement>('combobox', { name: '账号类型' })
    expect([...kind.options].map(option => option.text)).toEqual(['商家账号', '买家账号'])
    fireEvent.change(kind, { target: { value: 'buyer' } })
    expect(within(dialog).queryByPlaceholderText('例如：名流旗舰店')).toBeNull()
    expect(dialog.textContent).toContain('买家账号只用于查看公开商品页面')
    expect(dialog.textContent).toContain('请填写账号')
    // Pinduoduo has no buyer accounts: the kind goes back to merchant.
    fireEvent.change(within(dialog).getByRole('combobox', { name: '平台' }), { target: { value: 'pinduoduo' } })
    expect(kind.value).toBe('merchant')
    expect([...kind.options].map(option => option.text)).toEqual(['商家账号'])
    fireEvent.change(within(dialog).getByRole('combobox', { name: '平台' }), { target: { value: 'taobao' } })
    fireEvent.change(kind, { target: { value: 'buyer' } })
    fireEvent.change(within(dialog).getByPlaceholderText('例如：名流旗舰店:运营'), { target: { value: '买家号' } })
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '去登录' })) })
    expect(props.onAdd).toHaveBeenCalledWith({ platform: 'taobao', kind: 'buyer', account: '买家号' })
  })

  it('shows a buyer account\'s pages today and its rest after risk control, and sets the daily page limit', async () => {
    const until = new Date(Date.now() + 71.5 * 3_600_000).toISOString()
    const props = mount({ ...base, buyerDailyPages: 20, accounts: [
      buyer({ id: 'b1', account: '买家号一', status: 'signed-in', pagesToday: 3 }),
      buyer({ id: 'b2', account: '买家号二', status: 'signed-in', cooldownUntil: until }),
      account({ status: 'signed-in' }),
    ] })
    const group = screen.getByText('天猫').closest('details')!
    expect(group.textContent).toContain('买家号一 · 买家账号 · 今日 3/20 页')
    expect(group.textContent).toContain('买家号二 · 买家账号 · 风控冷却中，剩 72 小时')
    expect(group.textContent).toContain('mingliu:运营 · 商家账号已登录')
    // The daily limit.
    const limit = screen.getByRole<HTMLInputElement>('textbox', { name: '买家账号每天最多打开' })
    expect(limit.value).toBe('20')
    const save = screen.getByRole<HTMLButtonElement>('button', { name: '保存' })
    expect(save.disabled).toBe(true)
    fireEvent.change(limit, { target: { value: '0' } })
    expect(screen.getByText('请填写 1 到 1000 之间的整数')).toBeTruthy()
    expect(save.disabled).toBe(true)
    fireEvent.change(limit, { target: { value: '30' } })
    await act(async () => { fireEvent.click(save) })
    expect(props.onSetDailyPages).toHaveBeenCalledWith(30)
    expect(screen.getByRole('status').textContent).toBe('已保存')
    props.onSetDailyPages.mockResolvedValueOnce({ kind: 'other', message: 'no' })
    fireEvent.change(limit, { target: { value: '40' } })
    await act(async () => { fireEvent.click(save) })
    expect(screen.getByRole('status').textContent).toBe('操作失败：no')
    props.set({ ...base, buyerDailyPages: 40, accounts: [buyer({ id: 'b1', account: '买家号一', status: 'signed-in', pagesToday: 3 })] })
    expect(limit.value).toBe('40')
    // The details give the same.
    fireEvent.click(screen.getByRole('button', { name: '查看 买家号一 的详情' }))
    expect(screen.getByText('今日已用页数').nextSibling?.textContent).toBe('3 / 40 页')
    props.set({ ...base, buyerDailyPages: 40, accounts: [buyer({ id: 'b1', account: '买家号一', status: 'signed-in', cooldownUntil: '2099-01-02T03:04:00Z' })] })
    expect(screen.getByText('今日已用页数').nextSibling?.textContent).toBe('0 / 40 页')
    expect(screen.getByText('风控冷却').nextSibling?.textContent).toMatch(/^剩 \d+ 小时（01-02 \d\d:04 结束）$/u)
  })

  it('renders nothing but the intro before the first state, and follows an account that disappears', () => {
    const props = mount(undefined)
    expect(screen.queryByText('还没有电商账号。')).toBeNull()
    props.set({ ...base, accounts: [account()] })
    fireEvent.click(screen.getByRole('button', { name: '查看 名流旗舰店 的详情' }))
    props.set({ ...base, revision: 2, accounts: [] })
    expect(screen.getByText('还没有电商账号。')).toBeTruthy()
  })
})
