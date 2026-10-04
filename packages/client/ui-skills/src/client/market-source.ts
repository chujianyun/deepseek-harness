/** Skill Hub market list, detail, and install over the `skillMarket` Remote. */

import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  MarketCategory, MarketInstalledStatus, MarketInstallOptions, MarketSkillCard, MarketSkillDetail, MarketSkillPage, MarketSkillQuery,
} from '@deepseek-ai/dsh-skill-market/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

/** Cards fetched per page and per "load more". */
export const MARKET_PAGE_SIZE = 12

/** The detail dialog's state. */
export type MarketDetailState =
  | { readonly status: 'loading'; readonly id: string }
  | { readonly status: 'ready'; readonly id: string; readonly value: MarketSkillDetail }
  | { readonly status: 'error'; readonly id: string; readonly message: string }

/** A refused Host call: its error code (for localized copy) and its message. */
export interface MarketFailure {
  readonly code: string
  readonly message: string
}

/** What the market page renders. */
export interface MarketSnapshot {
  readonly status: 'loading' | 'ready' | 'error'
  /** The failed list read, while `status` is `error`. */
  readonly error: MarketFailure | null
  readonly items: readonly MarketSkillCard[]
  readonly total: number
  /** Last page read. */
  readonly page: number
  readonly q: string
  /** Selected category, or null for "all". */
  readonly categoryId: string | null
  readonly categories: readonly MarketCategory[]
  /** Skill ids whose install is in flight. */
  readonly installing: readonly string[]
  /** The last refused install until the next action or a dismissal. */
  readonly failure: MarketFailure | null
  readonly detail: MarketDetailState | null
  /** Skill Hub state of each installed market Skill, by name; read when the installed view opens. */
  readonly statuses: Readonly<Record<string, MarketInstalledStatus>>
  /** An update waiting for the user to accept overwriting these locally edited files. */
  readonly overwrite: { readonly id: string; readonly name: string; readonly files: readonly string[] } | null
}

/** Remote calls the source drives. */
export interface MarketDependencies {
  readonly list: (query: MarketSkillQuery) => Promise<RemoteResult<MarketSkillPage>>
  readonly categories: () => Promise<RemoteResult<readonly MarketCategory[]>>
  readonly detail: (id: string) => Promise<RemoteResult<MarketSkillDetail>>
  readonly install: (id: string, options: MarketInstallOptions) => Promise<RemoteResult<MarketSkillCard>>
  readonly installedStatus: () => Promise<RemoteResult<readonly MarketInstalledStatus[]>>
  /** Runs after a successful install, so the installed list follows. */
  readonly installed: () => void
}

/** Business face injected into the market page. */
export interface MarketInjected {
  readonly hooks: { readonly market: HostObservable<MarketSnapshot> }
  /** Read categories and the first page again; the page calls it each time it opens. */
  readonly onOpenMarket: () => Promise<void>
  readonly onSearch: (q: string) => Promise<void>
  readonly onCategory: (categoryId: string | null) => Promise<void>
  readonly onLoadMore: () => Promise<void>
  /** Install or update; local edits in the way open the overwrite confirmation instead of failing. */
  readonly onInstall: (id: string) => Promise<void>
  /** Overwrite the edited files of the pending update. */
  readonly onConfirmOverwrite: () => Promise<void>
  readonly onCancelOverwrite: () => void
  /** Read where the installed market Skills stand on the Skill Hub. */
  readonly onRefreshStatus: () => Promise<void>
  readonly onOpenDetail: (id: string) => Promise<void>
  readonly onCloseDetail: () => void
  readonly onDismissMarketFailure: () => void
}

/**
 * Create the market source. A newer list read supersedes an older one, and an install updates the
 * card (and an open detail) in place.
 * @param deps - Remote calls and the installed-list follow-up.
 * @returns the observable snapshot and the page callbacks.
 */
export function createMarketSource(deps: MarketDependencies): MarketInjected {
  const store = createSnapshotStore<MarketSnapshot>({
    status: 'loading', error: null, items: [], total: 0, page: 0, q: '', categoryId: null, categories: [], installing: [], failure: null, detail: null,
    statuses: {}, overwrite: null,
  })
  const patch = (next: (current: MarketSnapshot) => Partial<MarketSnapshot>): void => {
    const current = store.getSnapshot()
    store.set({ ...current, ...next(current) })
  }
  let epoch = 0

  /** Read one page for the current query; page 1 replaces the list, later pages append. */
  const read = async (pageNumber: number): Promise<void> => {
    const current = ++epoch
    const { q, categoryId } = store.getSnapshot()
    if (pageNumber === 1) patch(() => ({ status: 'loading', error: null }))
    const result = await deps.list({ q, ...categoryId === null ? {} : { categoryId }, page: pageNumber, pageSize: MARKET_PAGE_SIZE })
    if (current !== epoch) return
    patch(({ items }) => result.ok
      ? { status: 'ready', items: pageNumber === 1 ? result.value.items : [...items, ...result.value.items], total: result.value.total, page: pageNumber }
      : { status: 'error', error: { code: result.error.code, message: result.error.message } })
  }

  const markInstalled = (card: MarketSkillCard): void => {
    const installed = { installedVersion: card.installedVersion, updateAvailable: card.updateAvailable }
    patch(({ items, detail }) => ({
      items: items.map(item => item.id === card.id ? { ...item, ...installed } : item),
      ...detail?.status === 'ready' && detail.id === card.id ? { detail: { ...detail, value: { ...detail.value, ...installed } } } : {},
    }))
  }

  const refreshStatus = async (): Promise<void> => {
    const result = await deps.installedStatus()
    if (result.ok) patch(() => ({ statuses: Object.fromEntries(result.value.map(status => [status.name, status])) }))
  }

  const install = async (id: string, options: MarketInstallOptions): Promise<void> => {
    patch(({ installing }) => ({ failure: null, overwrite: null, installing: [...installing, id] }))
    const result = await deps.install(id, options)
    const local = !result.ok && result.error.code === 'skill-market/local-changes'
      ? result.error.details as { name: string; files: readonly string[] } : undefined
    const failure = result.ok || local !== undefined ? {} : { failure: { code: result.error.code, message: result.error.message } }
    patch(({ installing }) => ({
      installing: installing.filter(item => item !== id), ...failure,
      ...local === undefined ? {} : { overwrite: { id, name: local.name, files: local.files } },
    }))
    if (result.ok) {
      markInstalled(result.value)
      deps.installed()
      await refreshStatus()
    }
  }

  return {
    hooks: { market: store },
    onOpenMarket: async () => {
      const categories = deps.categories().then((result) => { if (result.ok) patch(() => ({ categories: result.value })) })
      await Promise.all([read(1), categories])
    },
    onSearch: async (q) => {
      patch(() => ({ q }))
      await read(1)
    },
    onCategory: async (categoryId) => {
      patch(() => ({ categoryId }))
      await read(1)
    },
    onLoadMore: () => read(store.getSnapshot().page + 1),
    onInstall: id => install(id, {}),
    onConfirmOverwrite: async () => {
      const pending = store.getSnapshot().overwrite
      if (pending !== null) await install(pending.id, { overwriteLocalChanges: true })
    },
    onCancelOverwrite: () => { patch(() => ({ overwrite: null })) },
    onRefreshStatus: refreshStatus,
    onOpenDetail: async (id) => {
      patch(() => ({ detail: { status: 'loading', id } }))
      const result = await deps.detail(id)
      if (store.getSnapshot().detail?.id !== id) return
      patch(() => ({ detail: result.ok ? { status: 'ready', id, value: result.value } : { status: 'error', id, message: result.error.message } }))
    },
    onCloseDetail: () => { patch(() => ({ detail: null })) },
    onDismissMarketFailure: () => { patch(() => ({ failure: null })) },
  }
}
