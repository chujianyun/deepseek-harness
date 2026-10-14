// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { InstalledSkillView } from '@deepseek-ai/dsh-skill-controller/types'
import type { InstalledSnapshot } from '../src/client/installed-source.ts'
import { InstalledView } from '../src/client/SkillsPage.tsx'
import { pageProps } from './page-props.client.ts'
import { SkillsPanelIcon } from '../src/client/SkillsPanelIcon.tsx'

afterEach(cleanup)

function skill(name: string, enabled = true, group: InstalledSkillView['group'] = 'custom', withdrawn = false): InstalledSkillView {
  return { name, description: `${name} description`, group, source: group === 'custom' ? 'user-dsh' : 'market', path: `/s/${name}/SKILL.md`, enabled, withdrawn }
}

function renderPage(initial: Partial<InstalledSnapshot> = {}) {
  const { installedStore: store, props } = pageProps(initial)
  const onBack = vi.fn()
  render(<InstalledView {...props} onBack={onBack} />)
  return { store, props, onBack }
}

function openMenu(name: string): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: `${name} 的更多操作` }))
  return screen.getByRole('menu')
}

describe('Skills page', () => {
  it('reads the installed skills when it mounts and shows the loading state until then', () => {
    const { props } = renderPage({ status: 'loading' })
    expect(props.onRefresh).toHaveBeenCalledOnce()
    expect(screen.getByText('正在读取 Skill…')).toBeTruthy()
  })

  it('offers a retry when the first read failed', () => {
    const { props } = renderPage({ status: 'error' })
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(props.onRefresh).toHaveBeenCalledTimes(2)
  })

  it('says when nothing is installed', () => {
    renderPage()
    expect(screen.getByText('还没有安装任何 Skill')).toBeTruthy()
    expect(screen.getByRole('heading', { name: /^用户自定义\s*0$/ })).toBeTruthy()
  })

  it('shows each skill as a card, greys a disabled one, and pages with load more', () => {
    const skills = Array.from({ length: 14 }, (_, index) => skill(`skill-${String(index).padStart(2, '0')}`, index !== 1))
    renderPage({ skills })
    expect(screen.getByRole('heading', { name: /^用户自定义\s*14$/ })).toBeTruthy()
    expect(screen.getAllByRole('listitem').filter(item => item.dataset.enabled !== undefined)).toHaveLength(12)
    const disabled = screen.getByText('skill-01').closest('li')!
    expect(disabled.dataset.enabled).toBe('false')
    expect(within(disabled).getByText('skill-01 description')).toBeTruthy()
    expect(within(disabled).getByText('S')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '加载更多（剩 2 个）' }))
    expect(screen.getByText('skill-13')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /加载更多/ })).toBeNull()
  })

  it('switches a skill and locks its controls while the Host answers', () => {
    const { store, props } = renderPage({ skills: [skill('alpha')] })
    fireEvent.click(screen.getByRole('switch', { name: '启用 alpha' }))
    expect(props.onToggle).toHaveBeenCalledWith('alpha', false)
    act(() => { store.set({ ...store.getSnapshot(), busy: ['alpha'] }) })
    expect(screen.getByRole('switch', { name: '启用 alpha' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'alpha 的更多操作' }).hasAttribute('disabled')).toBe(true)
  })

  it('runs chat, edit, and reveal from the card menu', () => {
    const { props } = renderPage({ skills: [skill('alpha')] })
    fireEvent.click(within(openMenu('alpha')).getByRole('menuitem', { name: '去对话' }))
    expect(props.onChat).toHaveBeenCalledWith('alpha')
    fireEvent.click(within(openMenu('alpha')).getByRole('menuitem', { name: '编辑' }))
    expect(props.onEdit).toHaveBeenCalledWith('alpha')
    fireEvent.click(within(openMenu('alpha')).getByRole('menuitem', { name: '打开文件夹' }))
    expect(props.onReveal).toHaveBeenCalledWith('alpha')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('closes the card menu on Escape without running an action', () => {
    const { props } = renderPage({ skills: [skill('alpha')] })
    openMenu('alpha')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(props.onChat).not.toHaveBeenCalled()
  })

  it('cannot start a chat with a disabled skill', () => {
    const { props } = renderPage({ skills: [skill('alpha', false)] })
    const chat = within(openMenu('alpha')).getByRole('menuitem', { name: '去对话' })
    expect(chat.getAttribute('aria-disabled') === 'true' || (chat as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(chat)
    expect(props.onChat).not.toHaveBeenCalled()
  })

  it('asks before uninstalling and does nothing when cancelled', () => {
    const { props } = renderPage({ skills: [skill('alpha')] })
    fireEvent.click(within(openMenu('alpha')).getByRole('menuitem', { name: '卸载' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('卸载「alpha」？')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    expect(props.onUninstall).not.toHaveBeenCalled()
    fireEvent.click(within(openMenu('alpha')).getByRole('menuitem', { name: '卸载' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '卸载' }))
    expect(props.onUninstall).toHaveBeenCalledWith('alpha')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows a refused action until dismissed', () => {
    const { props } = renderPage({ skills: [skill('alpha')], failure: 'no editor' })
    expect(screen.getByRole('alert').textContent).toContain('操作失败：no editor')
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: '关闭' }))
    expect(props.onDismissFailure).toHaveBeenCalledOnce()
  })

  it('draws the sidebar glyph at the requested size without reading application state', () => {
    const unread = () => { throw new Error('The sidebar icon must not read application state') }
    const glyph = render(<SkillsPanelIcon size={18} active={false}
      usePanelInfo={unread} useSessions={unread} useSessionStatus={unread} useSessionRetainInfo={unread}
      useWorkspaces={unread} useResource={unread} />)
    expect(glyph.container.querySelector('svg')?.getAttribute('width')).toBe('18')
  })

  it('groups market Skills under 来自市场 with the same switch and menu, and goes back to the market', () => {
    const { props, onBack } = renderPage({ skills: [skill('alpha'), skill('hub-pdf', false, 'market')] })
    const market = screen.getByRole('region', { name: /来自市场/ })
    expect(within(market).getByText('hub-pdf')).toBeTruthy()
    expect(within(screen.getByRole('region', { name: /用户自定义/ })).queryByText('hub-pdf')).toBeNull()
    fireEvent.click(within(market).getByRole('switch', { name: '启用 hub-pdf' }))
    expect(props.onToggle).toHaveBeenCalledWith('hub-pdf', true)
    fireEvent.click(screen.getByRole('button', { name: '返回 Skills' }))
    expect(onBack).toHaveBeenCalledOnce()
  })

  it('names a market Skill by the display name its status carries, with the slug beside it; a user Skill keeps its name', () => {
    const { props } = pageProps({ skills: [skill('alpha'), skill('tmall-publish', true, 'market')] }, {
      statuses: { 'tmall-publish': { name: 'tmall-publish', displayName: '天猫发品', hubSkillId: 's-t', installedVersion: '1.0.0', latestVersion: '1.0.0', state: 'current' } },
    })
    render(<InstalledView {...props} onBack={() => {}} />)
    const market = screen.getByRole('region', { name: /来自市场/ })
    expect(within(market).getByText('天猫发品')).toBeTruthy()
    expect(within(market).getByText('tmall-publish')).toBeTruthy()
    expect(within(market).getByRole('switch', { name: '启用 天猫发品' })).toBeTruthy()
    fireEvent.click(within(market).getByRole('button', { name: '天猫发品 的更多操作' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '卸载' }))
    expect(screen.getByRole('dialog').textContent).toContain('天猫发品')
    expect(within(screen.getByRole('region', { name: /用户自定义/ })).getByText('alpha')).toBeTruthy()
  })

  it('marks a withdrawn market Skill and locks its switch, while uninstall stays available', () => {
    const { props } = pageProps({ skills: [skill('hub-pdf', false, 'market', true)] }, {
      statuses: { 'hub-pdf': { name: 'hub-pdf', displayName: 'hub-pdf', hubSkillId: 's-pdf', installedVersion: '1.0.0', latestVersion: null, state: 'withdrawn' } },
    })
    render(<InstalledView {...props} onBack={() => {}} />)
    const market = screen.getByRole('region', { name: /来自市场/ })
    expect(within(market).getByTestId('skill-withdrawn').textContent).toContain('已被收回')
    expect((within(market).getByRole('switch', { name: '启用 hub-pdf' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(within(market).getByRole('button', { name: 'hub-pdf 的更多操作' }))
    expect(screen.getByRole('menuitem', { name: '卸载' })).toBeTruthy()
  })

  it('reads the list again quietly once the Hub check finished', async () => {
    const { props } = pageProps({ skills: [skill('alpha')] })
    render(<InstalledView {...props} onBack={() => {}} />)
    await vi.waitFor(() => { expect(props.onSync).toHaveBeenCalledOnce() })
  })

  it('drops the withdrawn mark as soon as the Hub check reports the Skill offered again', () => {
    const { props } = pageProps({ skills: [skill('hub-pdf', false, 'market', true)] }, {
      statuses: { 'hub-pdf': { name: 'hub-pdf', displayName: 'hub-pdf', hubSkillId: 's-pdf', installedVersion: '1.0.0', latestVersion: '1.0.0', state: 'current' } },
    })
    render(<InstalledView {...props} onBack={() => {}} />)
    expect(screen.queryByTestId('skill-withdrawn')).toBeNull()
    expect((screen.getByRole('switch', { name: '启用 hub-pdf' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('says when nothing came from the market yet', () => {
    renderPage({ skills: [skill('alpha')] })
    expect(within(screen.getByRole('region', { name: /来自市场/ })).getByText('还没有从市场安装 Skill')).toBeTruthy()
  })

  describe('pins and bulk management (Spec #221 T176)', () => {
    const names = (region: HTMLElement) => within(region).getAllByRole('listitem').map(item => item.textContent ?? '')

    it('puts pinned cards first in their group, most recently pinned first, and unpins', () => {
      const { props } = renderPage({ skills: [skill('alpha'), skill('beta'), skill('gamma')] })
      const custom = screen.getByRole('region', { name: /用户自定义/ })
      fireEvent.click(within(custom).getByRole('button', { name: '置顶 gamma' }))
      fireEvent.click(within(custom).getByRole('button', { name: '置顶 beta' }))
      expect(props.onTogglePin).toHaveBeenCalledWith('/s/gamma/SKILL.md', true)
      expect(names(custom).map(text => /alpha|beta|gamma/.exec(text)?.[0])).toEqual(['beta', 'gamma', 'alpha'])
      expect(within(custom).getByRole('button', { name: '置顶 beta' }).getAttribute('aria-pressed')).toBe('true')
      expect(within(custom).getByRole('button', { name: '置顶 alpha' }).getAttribute('aria-pressed')).toBe('false')
      fireEvent.click(within(custom).getByRole('button', { name: '置顶 beta' }))
      expect(props.onTogglePin).toHaveBeenLastCalledWith('/s/beta/SKILL.md', false)
    })

    it('selects skills and enables, disables, or uninstalls them after one confirmation', async () => {
      const { props } = renderPage({ skills: [skill('alpha'), skill('beta', false), skill('hub', true, 'market')] })
      expect(screen.queryByRole('checkbox', { name: '选择 alpha' })).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: '批量管理' }))
      const bar = screen.getByRole('toolbar', { name: '批量管理' })
      for (const name of ['启用', '停用', '卸载']) expect((within(bar).getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true)
      fireEvent.click(screen.getByRole('checkbox', { name: '选择 beta' }))
      fireEvent.click(screen.getByRole('checkbox', { name: '选择 beta' }))
      fireEvent.click(screen.getByRole('checkbox', { name: '选择 alpha' }))
      fireEvent.click(screen.getByRole('checkbox', { name: '选择 hub' }))
      expect(within(bar).getByText('已选 2 个')).toBeTruthy()
      fireEvent.click(within(bar).getByRole('button', { name: '停用' }))
      await vi.waitFor(() => { expect(props.onBatch).toHaveBeenCalledWith('disable', ['alpha', 'hub']) })
      // The buttons stay locked while a batch runs
      await vi.waitFor(() => { expect((within(bar).getByRole('button', { name: '启用' }) as HTMLButtonElement).disabled).toBe(false) })
      fireEvent.click(within(bar).getByRole('button', { name: '启用' }))
      await vi.waitFor(() => { expect(props.onBatch).toHaveBeenLastCalledWith('enable', ['alpha', 'hub']) })
      await vi.waitFor(() => { expect((within(bar).getByRole('button', { name: '卸载' }) as HTMLButtonElement).disabled).toBe(false) })

      fireEvent.click(within(bar).getByRole('checkbox', { name: '全选' }))
      expect(within(bar).getByText('已选 3 个')).toBeTruthy()
      fireEvent.click(within(bar).getByRole('button', { name: '卸载' }))
      const dialog = screen.getByRole('dialog', { name: '卸载选中的 3 个 Skill？' })
      expect(dialog.textContent).toContain('将卸载：alpha、beta、hub。')
      fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }))
      expect(screen.queryByRole('dialog')).toBeNull()
      fireEvent.click(within(bar).getByRole('button', { name: '卸载' }))
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '取消' }))
      expect(props.onBatch).toHaveBeenCalledTimes(2)
      fireEvent.click(within(bar).getByRole('button', { name: '卸载' }))
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '卸载' }))
      await vi.waitFor(() => { expect(props.onBatch).toHaveBeenLastCalledWith('uninstall', ['alpha', 'beta', 'hub']) })
      await vi.waitFor(() => { expect(within(bar).getByText('已选 0 个')).toBeTruthy() })

      fireEvent.click(within(bar).getByRole('checkbox', { name: '全选' }))
      fireEvent.click(within(bar).getByRole('checkbox', { name: '全选' }))
      expect(within(bar).getByText('已选 0 个')).toBeTruthy()
      fireEvent.click(within(bar).getByRole('button', { name: '完成' }))
      expect(screen.queryByRole('toolbar')).toBeNull()
      expect(screen.queryByRole('checkbox', { name: '选择 alpha' })).toBeNull()
    })

    it('says which skills a batch could not do, keeps them selected, and dismisses the message', async () => {
      const { props } = renderPage({ skills: [skill('alpha'), skill('beta')] })
      props.onBatch.mockResolvedValueOnce(['beta'])
      fireEvent.click(screen.getByRole('button', { name: '批量管理' }))
      fireEvent.click(screen.getByRole('checkbox', { name: '全选' }))
      fireEvent.click(screen.getByRole('button', { name: '卸载' }))
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '卸载' }))
      await vi.waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('1 个没有完成：beta') })
      expect(screen.getByText('已选 1 个')).toBeTruthy()
      fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: '关闭' }))
      expect(screen.queryByRole('alert')).toBeNull()
    })

    it('leaves withdrawn skills out of a bulk enable, shows the partial selection, and locks the cards while a batch runs', async () => {
      const { props, installedStore } = pageProps({ skills: [skill('alpha', false), skill('gone', false, 'market', true)] }, {
        statuses: { gone: { name: 'gone', displayName: '已收回的', hubSkillId: 's-g', installedVersion: '1.0.0', latestVersion: null, state: 'withdrawn' } },
      })
      let finish: (refused: readonly string[]) => void = () => {}
      props.onBatch.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
      render(<InstalledView {...props} onBack={() => {}} />)
      fireEvent.click(screen.getByRole('button', { name: '批量管理' }))
      fireEvent.click(screen.getByRole('checkbox', { name: '选择 alpha' }))
      expect((screen.getByRole('checkbox', { name: '全选' }) as HTMLInputElement).indeterminate).toBe(true)
      fireEvent.click(screen.getByRole('checkbox', { name: '选择 已收回的' }))
      fireEvent.click(screen.getByRole('button', { name: '启用' }))
      expect(props.onBatch).toHaveBeenCalledWith('enable', ['alpha'])
      expect((screen.getByRole('button', { name: '完成' }) as HTMLButtonElement).disabled).toBe(true)
      // Bulk mode keeps only the checkbox on each card
      expect(screen.queryByRole('switch', { name: '启用 alpha' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'alpha 的更多操作' })).toBeNull()
      expect((screen.getByRole('checkbox', { name: '选择 alpha' }) as HTMLInputElement).disabled).toBe(true)
      await act(async () => { finish([]) })
      expect((screen.getByRole('button', { name: '完成' }) as HTMLButtonElement).disabled).toBe(false)

      // A skill that leaves the list leaves the selection
      act(() => { installedStore.set({ ...installedStore.getSnapshot(), skills: [skill('alpha', false)] }) })
      expect(screen.getByText('已选 1 个')).toBeTruthy()
    })

    it('names refused market skills by their display name, and a failed batch still unlocks', async () => {
      const { props } = pageProps({ skills: [skill('hub', true, 'market')] }, {
        statuses: { hub: { name: 'hub', displayName: '天猫发品', hubSkillId: 's-h', installedVersion: '1.0.0', latestVersion: '1.0.0', state: 'current' } },
      })
      props.onBatch.mockResolvedValueOnce(['hub'])
      render(<InstalledView {...props} onBack={() => {}} />)
      fireEvent.click(screen.getByRole('button', { name: '批量管理' }))
      fireEvent.click(screen.getByRole('checkbox', { name: '全选' }))
      fireEvent.click(screen.getByRole('button', { name: '停用' }))
      await vi.waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('1 个没有完成：天猫发品') })
      props.onBatch.mockRejectedValueOnce(new Error('lost'))
      fireEvent.click(screen.getByRole('button', { name: '停用' }))
      await vi.waitFor(() => { expect((screen.getByRole('button', { name: '完成' }) as HTMLButtonElement).disabled).toBe(false) })
      expect(screen.getByRole('alert').textContent).toContain('1 个没有完成：天猫发品')
    })

    it('stays out of bulk mode when the user left it before an uninstall finished', async () => {
      const { props } = renderPage({ skills: [skill('alpha')] })
      fireEvent.click(screen.getByRole('button', { name: '批量管理' }))
      fireEvent.click(screen.getByRole('checkbox', { name: '全选' }))
      fireEvent.click(screen.getByRole('button', { name: '卸载' }))
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '卸载' }))
      await vi.waitFor(() => { expect(props.onBatch).toHaveBeenCalledWith('uninstall', ['alpha']) })
      await vi.waitFor(() => { expect((screen.getByRole('button', { name: '完成' }) as HTMLButtonElement).disabled).toBe(false) })
      fireEvent.click(screen.getByRole('button', { name: '完成' }))
      expect(screen.queryByRole('toolbar')).toBeNull()
    })

    it('offers no bulk management when nothing is installed', () => {
      renderPage({ skills: [] })
      expect(screen.queryByRole('button', { name: '批量管理' })).toBeNull()
    })
  })

  describe('search (Spec #221 T177)', () => {
    const search = () => screen.getByRole('searchbox', { name: '搜索已安装的 Skill' })
    const type = (text: string) => { fireEvent.change(search(), { target: { value: text } }) }
    const statuses = {
      'tmall-publish': { name: 'tmall-publish', displayName: '天猫发品', hubSkillId: 's-t', installedVersion: '1.0.0', latestVersion: '1.0.0', state: 'current' as const },
    }
    const renderMixed = () => {
      const { props } = pageProps({ skills: [skill('alpha'), { ...skill('beta'), description: 'Writes SQL queries' }, skill('tmall-publish', true, 'market')] }, { statuses })
      render(<InstalledView {...props} onBack={() => {}} />)
      return props
    }

    it('filters as the user types by display name, name, or description, ignoring case, and hides groups without a match', () => {
      renderMixed()
      type('天猫')
      expect(screen.getByText('天猫发品')).toBeTruthy()
      expect(screen.queryByRole('region', { name: /用户自定义/ })).toBeNull()
      type('TMALL')
      expect(within(screen.getByRole('region', { name: /来自市场/ })).getByText('tmall-publish')).toBeTruthy()
      type('  sql ')
      expect(screen.getByRole('heading', { name: /^用户自定义\s*1$/ })).toBeTruthy()
      expect(screen.getByText('beta')).toBeTruthy()
      expect(screen.queryByText('alpha')).toBeNull()
      expect(screen.queryByRole('region', { name: /来自市场/ })).toBeNull()
    })

    it('shows every skill again when the field is emptied', () => {
      renderMixed()
      type('alpha')
      expect(screen.queryByText('beta')).toBeNull()
      type('')
      expect(screen.getByText('beta')).toBeTruthy()
      expect(screen.getByRole('region', { name: /来自市场/ })).toBeTruthy()
    })

    it('says when nothing matches, in a status region that stays mounted', () => {
      renderMixed()
      expect(screen.getByRole('status').textContent).toBe('')
      type(' zzz ')
      expect(screen.getByRole('status').textContent).toBe('没有找到和「zzz」匹配的 Skill')
      expect(screen.queryByRole('region')).toBeNull()
    })

    it('limits select all and the batch to the matching skills, and starts a new selection with each search', async () => {
      const props = renderMixed()
      fireEvent.click(screen.getByRole('button', { name: '批量管理' }))
      expect(search()).toBeTruthy()
      fireEvent.click(screen.getByRole('checkbox', { name: '选择 beta' }))
      type('alpha')
      expect(screen.getByText('已选 0 个')).toBeTruthy()
      fireEvent.click(screen.getByRole('checkbox', { name: '全选' }))
      expect(screen.getByText('已选 1 个')).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: '停用' }))
      await vi.waitFor(() => { expect(props.onBatch).toHaveBeenCalledWith('disable', ['alpha']) })
      type('')
      expect(screen.getByText('已选 0 个')).toBeTruthy()
      type('天猫')
      fireEvent.click(screen.getByRole('checkbox', { name: '全选' }))
      fireEvent.click(screen.getByRole('button', { name: '卸载' }))
      expect(screen.getByRole('dialog').textContent).toContain('将卸载：天猫发品。')
    })

    it('starts each search at the first page of a group', () => {
      renderPage({ skills: Array.from({ length: 30 }, (_, index) => skill(`skill-${String(index).padStart(2, '0')}`)) })
      fireEvent.click(screen.getByRole('button', { name: '加载更多（剩 18 个）' }))
      expect(screen.getByText('skill-20')).toBeTruthy()
      type('skill-')
      expect(screen.getByRole('button', { name: '加载更多（剩 18 个）' })).toBeTruthy()
      expect(screen.queryByText('skill-20')).toBeNull()
    })

    it('matches a custom skill by its own name, not a market display name for the same slug', () => {
      const { props } = pageProps({ skills: [skill('tmall-publish')] }, { statuses })
      render(<InstalledView {...props} onBack={() => {}} />)
      type('天猫')
      expect(screen.getByRole('status').textContent).toBe('没有找到和「天猫」匹配的 Skill')
    })

    it('offers no search when nothing is installed', () => {
      renderPage({ skills: [] })
      expect(screen.queryByRole('searchbox')).toBeNull()
    })
  })
})
