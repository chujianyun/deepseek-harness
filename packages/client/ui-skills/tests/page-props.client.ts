/** Page props over real snapshot stores, with every callback a spy. */
import { vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { InstalledSnapshot } from '../src/client/installed-source.ts'
import type { MarketSnapshot } from '../src/client/market-source.ts'
import type { UploadSnapshot } from '../src/client/upload-source.ts'
import { zh } from '../src/client/locales.ts'
import type { SkillsPageProps } from '../src/client/SkillsPage.tsx'

/**
 * Build the page props.
 * @param installed - installed snapshot overrides.
 * @param market - market snapshot overrides.
 * @returns the stores and the props.
 */
export function pageProps(
  installed: Partial<InstalledSnapshot> = {}, market: Partial<MarketSnapshot> = {}, upload: Partial<UploadSnapshot> = {},
) {
  const installedStore = createSnapshotStore<InstalledSnapshot>({ status: 'ready', skills: [], busy: [], failure: null, ...installed })
  const marketStore = createSnapshotStore<MarketSnapshot>({
    status: 'ready', error: null, items: [], total: 0, page: 1, q: '', categoryId: null, categories: [], installing: [], failure: null, detail: null,
    statuses: {}, overwrite: null, ...market,
  })
  const uploadStore = createSnapshotStore<UploadSnapshot>({
    open: false, step: 'pick', sources: null, preview: null, options: null, busy: false, failure: null, result: null, copied: false, ...upload,
  })
  const props = {
    t: makeTranslate(zh),
    useInstalled: bindSnapshotSelector(installedStore),
    useMarket: bindSnapshotSelector(marketStore),
    useUpload: bindSnapshotSelector(uploadStore),
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
    onConfirmOverwrite: vi.fn(async () => {}),
    onCancelOverwrite: vi.fn(),
    onRefreshStatus: vi.fn(async () => {}),
    onOpenUpload: vi.fn(async () => {}),
    onCloseUpload: vi.fn(),
    onInspectFolder: vi.fn(async () => {}),
    onBrowseFolder: vi.fn(async () => {}),
    onBackToPick: vi.fn(),
    onSubmitUpload: vi.fn(async () => {}),
    onCopyReviewUrl: vi.fn(async () => {}),
  } satisfies SkillsPageProps
  return { installedStore, marketStore, uploadStore, props }
}
