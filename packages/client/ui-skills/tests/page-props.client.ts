/** Page props over real snapshot stores, with every callback a spy. */
import { vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { InstalledSnapshot } from '../src/client/installed-source.ts'
import type { MarketSnapshot } from '../src/client/market-source.ts'
import { zh } from '../src/client/locales.ts'
import type { SkillsPageProps } from '../src/client/SkillsPage.tsx'

/**
 * Build the page props.
 * @param installed - installed snapshot overrides.
 * @param market - market snapshot overrides.
 * @returns the stores and the props.
 */
export function pageProps(installed: Partial<InstalledSnapshot> = {}, market: Partial<MarketSnapshot> = {}) {
  const installedStore = createSnapshotStore<InstalledSnapshot>({ status: 'ready', skills: [], busy: [], failure: null, ...installed })
  const marketStore = createSnapshotStore<MarketSnapshot>({
    status: 'ready', error: null, items: [], total: 0, page: 1, q: '', categoryId: null, categories: [], installing: [], failure: null, detail: null, ...market,
  })
  const props = {
    t: makeTranslate(zh),
    useInstalled: bindSnapshotSelector(installedStore),
    useMarket: bindSnapshotSelector(marketStore),
    onRefresh: vi.fn(async () => {}),
    onToggle: vi.fn(async () => {}),
    onReveal: vi.fn(async () => {}),
    onEdit: vi.fn(async () => {}),
    onUninstall: vi.fn(async () => {}),
    onChat: vi.fn(),
    onDismissFailure: vi.fn(),
    onOpenMarket: vi.fn(async () => {}),
    onSearch: vi.fn(async () => {}),
    onCategory: vi.fn(async () => {}),
    onLoadMore: vi.fn(async () => {}),
    onInstall: vi.fn(async () => {}),
    onOpenDetail: vi.fn(async () => {}),
    onCloseDetail: vi.fn(),
    onDismissMarketFailure: vi.fn(),
  } satisfies SkillsPageProps
  return { installedStore, marketStore, props }
}
