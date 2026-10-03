// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { InstalledSkillView } from '@deepseek-ai/dsh-skill-controller/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { InstalledSnapshot } from '../src/client/installed-source.ts'
import { zh } from '../src/client/locales.ts'
import { SkillsPage, type SkillsPageProps } from '../src/client/SkillsPage.tsx'
import { SkillsPanelIcon } from '../src/client/SkillsPanelIcon.tsx'

afterEach(cleanup)

function skill(name: string, enabled = true): InstalledSkillView {
  return { name, description: `${name} description`, group: 'custom', source: 'user-dsh', path: `/s/${name}/SKILL.md`, enabled }
}

function renderPage(initial: Partial<InstalledSnapshot> = {}) {
  const store = createSnapshotStore<InstalledSnapshot>({ status: 'ready', skills: [], busy: [], failure: null, ...initial })
  const props = {
    t: makeTranslate(zh),
    useInstalled: bindSnapshotSelector(store),
    onRefresh: vi.fn(async () => {}),
    onToggle: vi.fn(async () => {}),
    onReveal: vi.fn(async () => {}),
    onEdit: vi.fn(async () => {}),
    onUninstall: vi.fn(async () => {}),
    onChat: vi.fn(),
    onDismissFailure: vi.fn(),
  } as unknown as SkillsPageProps
  render(<SkillsPage {...props} />)
  return { store, props }
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
})
