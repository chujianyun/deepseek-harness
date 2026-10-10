// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { MarketSkillCard, MarketSkillDetail } from '@deepseek-ai/dsh-skill-market/types'
import { categoryTint, initial, MarketView, skillMdBody } from '../src/client/MarketView.tsx'
import { InstalledView, SkillsPage } from '../src/client/SkillsPage.tsx'
import { pageProps } from './page-props.client.ts'

afterEach(cleanup)

function card(name: string, extra: Partial<MarketSkillCard> = {}): MarketSkillCard {
  return { id: `id-${name}`, name, displayName: name, description: `${name} description`, category: null, version: '1.0.0', updatedAt: '2026-10-01T08:00:00.000Z', installedVersion: null, updateAvailable: false, conflict: false, ...extra }
}

const detail: MarketSkillDetail = {
  ...card('pdf-tools', { category: { id: 'c-doc', name: '文档' } }),
  ownerName: '韩梅梅',
  skillMd: '---\nname: pdf-tools\ndescription: x\n---\n\n# PDF 工具\n\n<script>alert(1)</script>\n\n- 读取 PDF\n',
  files: [{ path: 'SKILL.md', size: 80 }, { path: 'scripts/run.sh', size: 2048 }],
}

describe('Market view', () => {
  it('tints a card avatar by its category, the same tint for the same category', () => {
    const { props } = pageProps({}, {
      items: [
        card('a', { category: { id: 'c-doc', name: '文档' } }),
        card('b', { category: { id: 'c-doc', name: '文档' } }),
        card('c', { category: { id: 'c-data', name: '数据' } }),
        card('d'),
      ],
      total: 4,
    })
    render(<MarketView {...props} onShowInstalled={() => {}} />)
    const tints = ['a', 'b', 'c', 'd'].map(name => screen.getByText(name.toUpperCase(), { selector: 'span' }).getAttribute('data-tint'))
    expect(tints[0]).toBe(tints[1])
    expect(tints[0]).toMatch(/^[0-4]$/u)
    expect(tints[2]).toMatch(/^[0-4]$/u)
    expect(tints[3]).toBe('none')
    expect(categoryTint('c-doc')).toBe(categoryTint('c-doc'))
  })

  it('takes the avatar letter from the first character and leaves an empty name blank', () => {
    expect(initial('pdf')).toBe('P')
    expect(initial('')).toBe('')
  })

  it('reads the market and the installed count when it opens, and shows cards with their install state', () => {
    const { props } = pageProps({ skills: [] }, {
      items: [card('pdf-tools'), card('sql-helper', { installedVersion: '2.0.0' }), card('my-notes', { conflict: true })], total: 5,
      categories: [{ id: 'c-doc', name: '文档' }],
    })
    render(<MarketView {...props} onShowInstalled={() => {}} />)
    expect(props.onOpenMarket).toHaveBeenCalledOnce()
    expect(props.onRefresh).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: '我安装的（0）' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '安装 pdf-tools' }))
    expect(props.onInstall).toHaveBeenCalledWith('id-pdf-tools')
    expect(screen.getByText('已安装 v2.0.0').hasAttribute('data-installed')).toBe(true)
    // An installable card reads 安装 on its button, not a bare +.
    expect(screen.getByRole('button', { name: '安装 pdf-tools' }).textContent).toBe('安装')
    const conflict = screen.getByRole('button', { name: '本地已有同名 Skill' })
    expect(conflict.hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('本地已有同名 Skill', { selector: 'span' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '加载更多（剩 2 个）' }))
    expect(props.onLoadMore).toHaveBeenCalledOnce()
  })

  it('names cards and the detail by display name, initials from it, and shows the slug in the detail', () => {
    const named = card('tmall-publish', { displayName: '天猫发品' })
    const { props, marketStore } = pageProps({}, { items: [named], total: 1 })
    render(<MarketView {...props} onShowInstalled={() => {}} />)
    expect(screen.getByRole('button', { name: '天猫发品' })).toBeTruthy()
    expect(screen.queryByText('tmall-publish')).toBeNull()
    expect(screen.getByText('天', { selector: 'span' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '安装 天猫发品' })).toBeTruthy()
    act(() => { marketStore.set({ ...marketStore.getSnapshot(), detail: { status: 'ready', id: named.id, value: { ...detail, ...named } } }) })
    const dialog = screen.getByRole('dialog', { name: '天猫发品' })
    expect(within(dialog).getByText('tmall-publish')).toBeTruthy()
    expect(within(dialog).getByText('标识')).toBeTruthy()
  })

  it('searches and filters by category', () => {
    const { props } = pageProps({}, { items: [card('pdf-tools')], total: 1, categories: [{ id: 'c-doc', name: '文档' }] })
    render(<MarketView {...props} onShowInstalled={() => {}} />)
    const searchbox = screen.getByRole('searchbox', { name: '搜索 Skill' })
    fireEvent.change(searchbox, { target: { value: ' pdf ' } })
    // Enter submits the search; there is no separate search button.
    fireEvent.submit(searchbox.closest('form')!)
    expect(props.onSearch).toHaveBeenCalledWith('pdf')
    expect(screen.queryByRole('button', { name: '搜索' })).toBeNull()
    // Emptying the field shows every Skill again without Enter.
    fireEvent.change(searchbox, { target: { value: '' } })
    expect(props.onSearch).toHaveBeenLastCalledWith('')
    fireEvent.click(screen.getByRole('tab', { name: '文档' }))
    expect(props.onCategory).toHaveBeenCalledWith('c-doc')
  })

  it('shows loading, empty, list failure with retry, and a refused install', () => {
    const { props, marketStore } = pageProps({}, { status: 'loading' })
    render(<MarketView {...props} onShowInstalled={() => {}} />)
    expect(screen.getByText('正在读取 Skill Hub…')).toBeTruthy()
    act(() => { marketStore.set({ ...marketStore.getSnapshot(), status: 'ready' }) })
    expect(screen.getByText('没有找到 Skill')).toBeTruthy()
    act(() => { marketStore.set({ ...marketStore.getSnapshot(), status: 'error', error: { code: 'skill-market/unavailable', message: 'x' }, failure: { code: 'other/code', message: 'boom' } }) })
    expect(screen.getByText('无法读取 Skill Hub：无法连接 Skill Hub，请稍后重试')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(props.onOpenMarket).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('alert').textContent).toContain('安装失败：boom')
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button'))
    expect(props.onDismissMarketFailure).toHaveBeenCalledOnce()
  })

  it('opens the detail with rendered SKILL.md (raw HTML stays text), facts, files, and install', () => {
    const { props, marketStore } = pageProps({}, { items: [card('pdf-tools')], total: 1 })
    render(<MarketView {...props} onShowInstalled={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'pdf-tools' }))
    expect(props.onOpenDetail).toHaveBeenCalledWith('id-pdf-tools')
    act(() => { marketStore.set({ ...marketStore.getSnapshot(), detail: { status: 'loading', id: 'id-pdf-tools' } }) })
    expect(screen.getByText('正在读取详情…')).toBeTruthy()
    act(() => { marketStore.set({ ...marketStore.getSnapshot(), detail: { status: 'ready', id: 'id-pdf-tools', value: detail } }) })
    const dialog = screen.getByRole('dialog', { name: 'pdf-tools' })
    expect(within(dialog).getByRole('heading', { name: 'PDF 工具' })).toBeTruthy()
    expect(dialog.querySelector('script')).toBeNull()
    expect(within(dialog).getByText('韩梅梅')).toBeTruthy()
    expect(within(dialog).getByText('文档')).toBeTruthy()
    expect(within(dialog).getByText('scripts/run.sh')).toBeTruthy()
    expect(within(dialog).getByText('文件（2）')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: '安装 pdf-tools' }))
    expect(props.onInstall).toHaveBeenCalledWith('id-pdf-tools')
    act(() => { marketStore.set({ ...marketStore.getSnapshot(), detail: { status: 'error', id: 'id-pdf-tools', message: 'gone' } }) })
    expect(screen.getByText('无法读取详情：gone')).toBeTruthy()
  })

  it('names a conflicting Skill in its detail, and marks an install in flight', () => {
    const { props } = pageProps({}, {
      items: [card('pdf-tools')], total: 1, installing: ['id-pdf-tools'],
      detail: { status: 'ready', id: 'id-x', value: { ...detail, id: 'id-x', name: 'x-skill', displayName: 'x-skill', conflict: true, category: null } },
    })
    render(<MarketView {...props} onShowInstalled={() => {}} />)
    expect(screen.getByRole('button', { name: '安装 pdf-tools' }).textContent).toBe('安装中…')
    const dialog = screen.getByRole('dialog', { name: 'x-skill' })
    expect(within(dialog).getByRole('alert').textContent).toBe('本地已有同名 Skill')
    expect(within(dialog).getByText('未分类')).toBeTruthy()
  })

  it('switches between the market and the installed Skills', () => {
    const { props } = pageProps()
    render(<SkillsPage {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '我安装的（0）' }))
    expect(screen.getByRole('heading', { name: '我安装的' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '返回 Skills' }))
    expect(screen.getByRole('heading', { name: 'Skills' })).toBeTruthy()
  })

  it('shows card categories, returns to all categories, and falls back to all when a category disappears', () => {
    const { props } = pageProps({}, { items: [card('pdf-tools', { category: { id: 'c-doc', name: '文档' } })], total: 1, categoryId: 'gone', categories: [{ id: 'c-doc', name: '文档' }] })
    render(<MarketView {...props} onShowInstalled={() => {}} />)
    expect(screen.getByRole('tab', { name: '全部' }).getAttribute('aria-selected')).toBe('true')
    expect(within(screen.getByRole('tabpanel')).getByText('文档')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: '文档' }))
    fireEvent.click(screen.getByRole('tab', { name: '全部' }))
    expect(props.onCategory).toHaveBeenLastCalledWith(null)
  })

  it('reports a list failure without a message', () => {
    const { props } = pageProps({}, { status: 'error', error: null })
    render(<MarketView {...props} onShowInstalled={() => {}} />)
    expect(screen.getByText('无法读取 Skill Hub：')).toBeTruthy()
  })

  it('explains the market refusals in the page language', () => {
    const { props, marketStore } = pageProps({}, { items: [card('pdf-tools')], total: 1, failure: { code: 'skill-market/invalid-package', message: 'the Skill package is invalid' } })
    render(<MarketView {...props} onShowInstalled={() => {}} />)
    expect(screen.getByRole('alert').textContent).toContain('安装失败：安装包校验未通过，本机没有任何改动')
    for (const [code, text] of [['skill-market/name-conflict', '本地已有同名 Skill'], ['skill-market/not-found', '这个 Skill 已不在 Skill Hub 上'], ['hub-account/signed-out', '请先登录 Skill Hub']] as const) {
      act(() => { marketStore.set({ ...marketStore.getSnapshot(), failure: { code, message: 'x' } }) })
      expect(screen.getByRole('alert').textContent).toContain(text)
    }
  })

  it('offers an update on cards and in the detail when the Hub has a newer version', () => {
    const { props } = pageProps({}, {
      items: [card('pdf-tools', { installedVersion: '1.0.0', version: '1.1.0', updateAvailable: true })], total: 1,
      detail: { status: 'ready', id: 'id-pdf-tools', value: { ...detail, installedVersion: '1.0.0', version: '1.1.0', updateAvailable: true } },
    })
    render(<MarketView {...props} onShowInstalled={() => {}} />)
    const buttons = screen.getAllByRole('button', { name: '更新 pdf-tools' })
    expect(buttons.map(button => button.textContent)).toEqual(['更新到 v1.1.0', '更新到 v1.1.0'])
    fireEvent.click(buttons[0]!)
    expect(props.onInstall).toHaveBeenCalledWith('id-pdf-tools')
  })

  it('marks an update in flight', () => {
    const { props } = pageProps({}, { items: [card('pdf-tools', { installedVersion: '1.0.0', updateAvailable: true })], total: 1, installing: ['id-pdf-tools'] })
    render(<MarketView {...props} onShowInstalled={() => {}} />)
    expect(screen.getByRole('button', { name: '更新 pdf-tools' }).textContent).toBe('安装中…')
  })

  it('shows update and unavailable states on installed market cards and reads them when the view opens', () => {
    const market = (name: string) => ({ name, description: `${name} description`, group: 'market' as const, source: 'market', path: `/m/${name}/SKILL.md`, enabled: true })
    const { props, marketStore } = pageProps({ skills: [market('pdf-tools'), market('old-skill'), market('fresh')] }, {
      statuses: {
        'pdf-tools': { name: 'pdf-tools', displayName: 'PDF 工具', hubSkillId: 's-pdf', installedVersion: '1.0.0', latestVersion: '1.1.0', state: 'update' },
        'old-skill': { name: 'old-skill', displayName: 'old-skill', hubSkillId: 's-old', installedVersion: '1.0.0', latestVersion: null, state: 'unavailable' },
        'fresh': { name: 'fresh', displayName: 'fresh', hubSkillId: 's-fresh', installedVersion: '1.0.0', latestVersion: '1.0.0', state: 'current' },
      },
    })
    render(<InstalledView {...props} onBack={() => {}} />)
    expect(props.onRefreshStatus).toHaveBeenCalledOnce()
    expect(screen.getByText('可更新到 v1.1.0')).toBeTruthy()
    expect(screen.getByText('市场已不可用')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /^更新 / })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: '更新 PDF 工具' }))
    expect(props.onInstall).toHaveBeenCalledWith('s-pdf')
    act(() => { marketStore.set({ ...marketStore.getSnapshot(), installing: ['s-pdf'] }) })
    expect(screen.getByRole('button', { name: '更新 PDF 工具' }).textContent).toBe('安装中…')
  })

  it('asks before overwriting local edits', () => {
    const { props, marketStore } = pageProps({}, { overwrite: { id: 's-pdf', name: 'pdf-tools', files: ['scripts/run.sh', 'notes.md'] } })
    render(<SkillsPage {...props} />)
    const dialog = screen.getByRole('dialog', { name: '本地修改将被覆盖' })
    expect(dialog.textContent).toContain('「pdf-tools」的以下文件在本机被修改过')
    expect(within(dialog).getByText('scripts/run.sh')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: '覆盖并更新' }))
    expect(props.onConfirmOverwrite).toHaveBeenCalledOnce()
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    expect(props.onCancelOverwrite).toHaveBeenCalledOnce()
    act(() => { marketStore.set({ ...marketStore.getSnapshot(), overwrite: null }) })
    expect(screen.queryByRole('dialog', { name: '本地修改将被覆盖' })).toBeNull()
  })

  it('strips YAML frontmatter from SKILL.md', () => {
    expect(skillMdBody('---\nname: a\n---\n\n# A\n')).toBe('# A\n')
    expect(skillMdBody('# No frontmatter')).toBe('# No frontmatter')
  })
})
