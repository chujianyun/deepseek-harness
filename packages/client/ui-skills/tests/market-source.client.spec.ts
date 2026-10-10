import { describe, expect, it, vi } from 'vitest'
import type { MarketSkillCard, MarketSkillDetail, MarketSkillPage } from '@deepseek-ai/dsh-skill-market/types'
import { createMarketSource, MARKET_PAGE_SIZE, type MarketDependencies } from '../src/client/market-source.ts'

const card = (name: string, installedVersion: string | null = null): MarketSkillCard => ({
  id: `id-${name}`, name, displayName: name, description: name, category: null, version: '1.0.0', updatedAt: 'x', installedVersion, updateAvailable: false, conflict: false,
})
const ok = <T>(value: T) => Promise.resolve({ ok: true as const, value })
const fail = (message: string) => Promise.resolve({ ok: false as const, error: { code: 'x', message, details: {} } as never })
const pageOf = (items: MarketSkillCard[], page = 1, total = 3): MarketSkillPage => ({ items, total, page, pageSize: MARKET_PAGE_SIZE })

function deps() {
  return {
    list: vi.fn<MarketDependencies['list']>(() => ok(pageOf([card('a'), card('b')]))),
    categories: vi.fn<MarketDependencies['categories']>(() => ok([{ id: 'c', name: 'C' }])),
    detail: vi.fn<MarketDependencies['detail']>(id => ok({ ...card('a'), id, ownerName: 'o', skillMd: '#', files: [] } satisfies MarketSkillDetail)),
    install: vi.fn<MarketDependencies['install']>(() => ok(card('a', '1.0.0'))),
    installedStatus: vi.fn<MarketDependencies['installedStatus']>(() => ok([{ name: 'a', displayName: 'a', hubSkillId: 'id-a', installedVersion: '1.0.0', latestVersion: '1.0.0', state: 'current' as const }])),
    installed: vi.fn<MarketDependencies['installed']>(),
  }
}

describe('market source', () => {
  it('opens with categories and the first page, then appends further pages', async () => {
    const d = deps()
    const source = createMarketSource(d)
    await source.onOpenMarket()
    expect(d.list).toHaveBeenCalledWith({ q: '', page: 1, pageSize: MARKET_PAGE_SIZE })
    expect(source.hooks.market.getSnapshot()).toMatchObject({ status: 'ready', total: 3, page: 1, categories: [{ id: 'c', name: 'C' }] })
    d.list.mockReturnValueOnce(ok(pageOf([card('c')], 2)))
    await source.onLoadMore()
    expect(d.list).toHaveBeenLastCalledWith({ q: '', page: 2, pageSize: MARKET_PAGE_SIZE })
    expect(source.hooks.market.getSnapshot().items.map(item => item.name)).toEqual(['a', 'b', 'c'])
  })

  it('searches and filters from page 1, and drops a superseded read', async () => {
    const d = deps()
    const source = createMarketSource(d)
    let release!: () => void
    d.list.mockImplementationOnce(() => new Promise((resolve) => { release = () => { resolve({ ok: true, value: pageOf([card('stale')]) }) } }))
    const stale = source.onSearch('old')
    await source.onCategory('c')
    release()
    await stale
    expect(d.list).toHaveBeenLastCalledWith({ q: 'old', categoryId: 'c', page: 1, pageSize: MARKET_PAGE_SIZE })
    expect(source.hooks.market.getSnapshot().items.map(item => item.name)).toEqual(['a', 'b'])
    await source.onCategory(null)
    expect(d.list).toHaveBeenLastCalledWith({ q: 'old', page: 1, pageSize: MARKET_PAGE_SIZE })
  })

  it('reports a failed read and a failed category read leaves the categories alone', async () => {
    const d = deps()
    d.list.mockReturnValueOnce(fail('offline'))
    d.categories.mockReturnValueOnce(fail('offline'))
    const source = createMarketSource(d)
    await source.onOpenMarket()
    expect(source.hooks.market.getSnapshot()).toMatchObject({ status: 'error', error: { code: 'x', message: 'offline' }, categories: [] })
  })

  it('installs, marks the card and the open detail installed, and refreshes the installed list', async () => {
    const d = deps()
    const source = createMarketSource(d)
    await source.onOpenMarket()
    await source.onOpenDetail('id-a')
    await source.onInstall('id-a')
    const snapshot = source.hooks.market.getSnapshot()
    expect(snapshot.items[0]?.installedVersion).toBe('1.0.0')
    expect(snapshot.detail).toMatchObject({ status: 'ready', value: { installedVersion: '1.0.0' } })
    expect(snapshot.installing).toEqual([])
    expect(d.installed).toHaveBeenCalledOnce()
    d.install.mockReturnValueOnce(ok(card('b', '1.0.0')))
    await source.onInstall('id-b')
    expect(source.hooks.market.getSnapshot().detail).toMatchObject({ id: 'id-a', value: { installedVersion: '1.0.0' } })
    expect(source.hooks.market.getSnapshot().items[1]?.installedVersion).toBe('1.0.0')
    d.install.mockReturnValueOnce(fail('本地已有同名 Skill'))
    await source.onInstall('id-b')
    expect(source.hooks.market.getSnapshot().failure).toEqual({ code: 'x', message: '本地已有同名 Skill' })
    source.onDismissMarketFailure()
    expect(source.hooks.market.getSnapshot().failure).toBeNull()
  })

  it('shows the latest detail only, reports a failed detail, and closes', async () => {
    const d = deps()
    const source = createMarketSource(d)
    let release!: () => void
    d.detail.mockImplementationOnce(() => new Promise((resolve) => { release = () => { resolve({ ok: true, value: { ...card('old'), ownerName: 'o', skillMd: '', files: [] } }) } }))
    const old = source.onOpenDetail('id-old')
    d.detail.mockReturnValueOnce(fail('gone'))
    await source.onOpenDetail('id-new')
    release()
    await old
    expect(source.hooks.market.getSnapshot().detail).toEqual({ status: 'error', id: 'id-new', message: 'gone' })
    source.onCloseDetail()
    expect(source.hooks.market.getSnapshot().detail).toBeNull()
  })

  it('reads installed statuses and refreshes them after an install', async () => {
    const d = deps()
    const source = createMarketSource(d)
    await source.onRefreshStatus()
    expect(source.hooks.market.getSnapshot().statuses).toEqual({ a: { name: 'a', displayName: 'a', hubSkillId: 'id-a', installedVersion: '1.0.0', latestVersion: '1.0.0', state: 'current' } })
    await source.onInstall('id-a')
    expect(d.install).toHaveBeenCalledWith('id-a', {})
    expect(d.installedStatus).toHaveBeenCalledTimes(2)
    d.installedStatus.mockReturnValueOnce(fail('offline'))
    await source.onRefreshStatus()
    expect(source.hooks.market.getSnapshot().statuses.a?.state).toBe('current')
  })

  it('asks before overwriting local edits, and overwrites only when confirmed', async () => {
    const d = deps()
    d.install.mockReturnValueOnce(Promise.resolve({ ok: false as const, error: { code: 'skill-market/local-changes', message: 'x', details: { name: 'a', files: ['run.sh'] } } as never }))
    const source = createMarketSource(d)
    await source.onInstall('id-a')
    expect(source.hooks.market.getSnapshot()).toMatchObject({ overwrite: { id: 'id-a', name: 'a', files: ['run.sh'] }, failure: null })
    source.onCancelOverwrite()
    expect(source.hooks.market.getSnapshot().overwrite).toBeNull()
    await source.onConfirmOverwrite()
    expect(d.install).toHaveBeenCalledTimes(1)
    d.install.mockReturnValueOnce(Promise.resolve({ ok: false as const, error: { code: 'skill-market/local-changes', message: 'x', details: { name: 'a', files: ['run.sh'] } } as never }))
    await source.onInstall('id-a')
    await source.onConfirmOverwrite()
    expect(d.install).toHaveBeenLastCalledWith('id-a', { overwriteLocalChanges: true })
    expect(source.hooks.market.getSnapshot().overwrite).toBeNull()
  })
})
