/**
 * The Tmall categories a store may publish in, read with its merchant account from the seller pages'
 * own endpoints: the category tree and the keyword search of Tmall's current publish entry
 * (`/tmall/ai/category.htm`, which replaces the router page Tmall is retiring), and the store's items
 * on the Qianniu item manager. A category the store may publish in is one the endpoints mark `publish`
 * and authorized; the nodes under it are brands, not categories.
 */

import { EXIT, SkillError } from './errors.ts'
import { itemIdOf } from './item.ts'
import { fetchJson, signedOut, sleep, type Page } from './page.ts'

/** Tmall's publish entry, whose page serves the category endpoints. */
export const ENTRY_URL = 'https://sell.publish.tmall.com/tmall/ai/category.htm'

/** The Qianniu item manager, whose page signs the item list calls. */
export const MANAGER_URL = 'https://qn.taobao.com/home.htm/sell-manage-tm/on_sale'

/** One Tmall category. */
export interface TmallCategory {
  readonly id: string
  readonly name: string
  /** Names from the top level down to this category. */
  readonly path: readonly string[]
  /** Ids from the top level down to this category. */
  readonly idPath: readonly string[]
  /** Items can be published in it. */
  readonly publishable: boolean
  /** The store is authorized to publish in it. */
  readonly authorized: boolean
  /** The platform's note on the category, such as an entry requirement. */
  readonly tips?: string
}

/** A category node as the router endpoints send it. */
interface RawCategory {
  readonly id: number
  readonly name: string
  readonly path?: readonly string[]
  readonly idpath?: readonly number[]
  readonly publish?: boolean
  readonly isAuthorized?: boolean
  readonly isBrand?: boolean
  readonly tips?: string
}

/** What the router's endpoints answer. */
interface RouterAnswer<T> {
  readonly success?: boolean
  readonly data?: T
}

/**
 * A category as this skill reports it.
 * @param raw - the endpoint's node.
 * @returns the category.
 */
export function categoryOf(raw: RawCategory): TmallCategory {
  return {
    id: String(raw.id), name: raw.name, path: raw.path ?? [raw.name], idPath: (raw.idpath ?? [raw.id]).map(String),
    publishable: raw.publish === true, authorized: raw.isAuthorized === true,
    ...raw.tips === undefined || raw.tips === '' ? {} : { tips: raw.tips },
  }
}

/**
 * Whether an address is a sign-in page.
 * @param href - the address.
 * @returns true on a login host.
 */
export function isSignIn(href: string): boolean {
  return /^login\./u.test(new URL(href).hostname)
}

/**
 * Wait until the tab is ready or has been sent to sign in, which a page may do some time after loading.
 * @param page - the tab.
 * @param ready - reads the page; true once it is ready.
 * @param waitMs - how long to wait.
 * @returns whether the page became ready.
 * @throws SkillError signed-out once the tab is on a sign-in page.
 */
export async function waitSignedIn(page: Page, ready: () => Promise<boolean>, waitMs: number): Promise<boolean> {
  const seen = { signIn: false }
  const done = await page.waitFor(async () => {
    seen.signIn = isSignIn(await page.evaluate<string>('location.href'))
    return seen.signIn || await ready()
  }, waitMs)
  if (seen.signIn) signedOut('天猫商家后台')
  return done
}

/**
 * Open a seller page and make sure the account is still signed in.
 * @param page - the tab.
 * @param url - the page.
 * @param ready - an expression true once the page can serve its calls.
 * @throws SkillError signed-out on a sign-in page; failed when the page never becomes ready.
 */
async function openSellerPage(page: Page, url: string, ready: string): Promise<void> {
  await page.goto(url)
  if (!await waitSignedIn(page, () => page.evaluate<boolean>(ready), 20_000)) {
    throw new SkillError(`天猫商家后台页面打不开或已改版（${url}）。`, EXIT.failed)
  }
}

/**
 * Open Tmall's publish entry.
 * @param page - the tab.
 */
export function openEntry(page: Page): Promise<void> {
  return openSellerPage(page, ENTRY_URL, "document.readyState === 'complete'")
}

/**
 * Open the Qianniu item manager.
 * @param page - the tab.
 */
export function openManager(page: Page): Promise<void> {
  return openSellerPage(page, MANAGER_URL, 'Boolean(window.lib && window.lib.mtop && window.lib.mtop.request)')
}

/**
 * Read the categories under one category, or the top-level categories the store may publish in.
 * @param page - the publish entry tab.
 * @param parentId - the parent; omitted for the top level.
 * @returns the categories, brand nodes left out.
 * @throws SkillError when the endpoint refuses.
 */
export async function childCategories(page: Page, parentId?: string): Promise<TmallCategory[]> {
  const query = parentId === undefined ? '' : `&catId=${encodeURIComponent(parentId)}`
  const answer = await page.evaluate<RouterAnswer<{ dataSource?: readonly RawCategory[] }>>(
    fetchJson(`/router/asyncOpt.htm?optType=categorySelectChildren&fromSmart=true${query}`),
  )
  if (answer.success !== true) throw new SkillError(`读取天猫类目失败（上级类目 ${parentId ?? '顶层'}）。`, EXIT.failed)
  return (answer.data?.dataSource ?? []).filter(node => node.isBrand !== true).map(categoryOf)
}

/**
 * Read every category the store may publish in, walking down from the top level until a category is publishable.
 * @param page - the publish entry tab.
 * @param pauseMs - the pause between calls.
 * @returns the publishable categories, in tree order.
 */
export async function storeCategories(page: Page, pauseMs = 300): Promise<TmallCategory[]> {
  const found: TmallCategory[] = []
  const walk = async (parentId?: string): Promise<void> => {
    for (const category of await childCategories(page, parentId)) {
      if (category.publishable) {
        if (category.authorized) found.push(category)
        continue
      }
      await sleep(pauseMs)
      await walk(category.id)
    }
  }
  await walk()
  return found
}

/** Tmall's category search, split as it answers. */
export interface CategorySearch {
  readonly authorized: readonly TmallCategory[]
  readonly unauthorized: readonly TmallCategory[]
}

/**
 * Search Tmall's categories by a product name, as the search box of the publish entry does.
 * @param page - the publish entry tab.
 * @param keyword - the product name or a word from it.
 * @returns the publishable categories, those the store may use first.
 * @throws SkillError when the endpoint refuses.
 */
export async function searchCategories(page: Page, keyword: string): Promise<CategorySearch> {
  const jsonBody = encodeURIComponent(JSON.stringify({ keyword }))
  const answer = await page.evaluate<RouterAnswer<{ category?: readonly RawCategory[] }>>(
    fetchJson(`/tmall/ai/asyncOpt.htm?optType=retrievalDataAsyncOpt&jsonBody=${jsonBody}`),
  )
  if (answer.success !== true) throw new SkillError(`天猫类目搜索失败（${keyword}）。`, EXIT.failed)
  const all = (answer.data?.category ?? []).filter(node => node.isBrand !== true).map(categoryOf)
  return { authorized: all.filter(c => c.publishable && c.authorized), unauthorized: all.filter(c => c.publishable && !c.authorized) }
}

/** One of the store's own items. */
export interface OwnItem {
  readonly itemId: string
  readonly catId: string
  readonly title: string
}

/** A row of the item manager's table. */
interface ManagerRow {
  readonly itemId: string | number
  readonly catId: string | number
  readonly itemDesc?: { readonly desc?: readonly { readonly text?: string }[] }
}

/**
 * The expression that lists the store's items through the manager page's signed mtop call.
 * @param filter - the manager's filter fields, such as `queryTitle` or `queryItemId`.
 * @param pageSize - how many rows.
 * @returns the expression; it answers the table's rows, or the mtop return code or the manager's message on failure.
 */
export function ownItemsExpression(filter: Readonly<Record<string, string>>, pageSize: number): string {
  const jsonBody = JSON.stringify({ tab: 'all', pagination: { current: 1, pageSize }, filtertab: '', filter, table: {} })
  return `(async () => {
  const r = await window.lib.mtop.request({ api: 'mtop.tmall.sell.pc.manage.async', v: '1.0', type: 'POST', data: { url: '/tmall/manager/table.htm', jsonBody: ${JSON.stringify(jsonBody)} } }).catch(e => e)
  if (!r || !r.data || !r.data.result) return { ret: String((r && r.ret) || r) }
  const result = typeof r.data.result === 'string' ? JSON.parse(r.data.result) : r.data.result
  const table = result.data && result.data.table
  if (!table) return { ret: String(result.message || result.msg || '商品列表没有返回表格') }
  return { rows: table.dataSource || [] }
})()`
}

/**
 * List the store's items (on sale and in the warehouse) matching a filter.
 * @param page - the item manager tab.
 * @param filter - `queryTitle` for words in the title, or `queryItemId` for ids.
 * @param pageSize - the most rows to read.
 * @returns the items with their categories.
 * @throws SkillError when the list cannot be read.
 */
export async function ownItems(page: Page, filter: Readonly<Record<string, string>>, pageSize = 100): Promise<OwnItem[]> {
  const answer = await page.evaluate<{ rows?: readonly ManagerRow[]; ret?: string }>(ownItemsExpression(filter, pageSize))
  if (answer.rows === undefined) throw new SkillError(`读取店铺商品列表失败（${answer.ret ?? '无应答'}）。`, EXIT.failed)
  return answer.rows.map(row => ({ itemId: String(row.itemId), catId: String(row.catId), title: row.itemDesc?.desc?.[0]?.text ?? '' }))
}

/** Where a category comes from. */
export type CategorySource =
  | { readonly kind: 'id'; readonly id: string }
  | { readonly kind: 'item'; readonly input: string }
  | { readonly kind: 'own'; readonly keyword: string }
  | { readonly kind: 'keyword'; readonly keyword: string }

/** A category the store may use, and why it is offered. */
export interface Candidate {
  readonly category: TmallCategory
  readonly reason: string
}

/** The categories a source offers. */
export interface Resolution {
  readonly source: CategorySource
  readonly candidates: readonly Candidate[]
  /** What the user should know, such as categories the store may not use. */
  readonly note?: string
}

/** What resolving needs besides the tab. */
export interface ResolveContext {
  /** The store's publishable categories, read or cached; read again when a cached list lacks one of `wanted`. */
  readonly categories: (wanted: readonly string[]) => Promise<readonly TmallCategory[]>
}

/**
 * Find the categories a source points to, keeping only those the store may publish in.
 * @param page - a tab of the merchant account.
 * @param source - a category id, an item link, words of the store's own item titles, or a product name.
 * @param context - the store's categories.
 * @returns the candidates, most likely first; none when the source points nowhere usable, with a note.
 * @throws SkillError usage for a category id the store may not publish in.
 */
export async function resolveCategory(page: Page, source: CategorySource, context: ResolveContext): Promise<Resolution> {
  switch (source.kind) {
    case 'id': {
      const category = (await context.categories([source.id])).find(c => c.id === source.id)
      if (category === undefined) {
        throw new SkillError(`类目 ${source.id} 不在这家店可以发布的类目里（可能未授权、不是可发布的末级类目或类目 id 有误）。`, EXIT.usage)
      }
      return { source, candidates: [{ category, reason: '用户指定的类目' }] }
    }
    case 'item': {
      const itemId = itemIdOf(source.input)
      await openManager(page)
      const item = (await ownItems(page, { queryItemId: itemId }, 1)).find(row => row.itemId === itemId)
      if (item === undefined) {
        return { source, candidates: [], note: `商品 ${itemId} 不是这家店的商品。外店商品页只给出一级类目，请改用商品名检索类目。` }
      }
      const category = (await context.categories([item.catId])).find(c => c.id === item.catId)
      return category === undefined
        ? { source, candidates: [], note: `本店商品 ${itemId} 所在类目 ${item.catId} 现在不能发布（可能授权已变化）。` }
        : { source, candidates: [{ category, reason: `本店商品 ${itemId}「${item.title}」所在类目` }] }
    }
    case 'own': {
      await openManager(page)
      const items = await ownItems(page, { queryTitle: source.keyword })
      const byCategory = new Map<string, OwnItem[]>()
      for (const item of items) byCategory.set(item.catId, [...byCategory.get(item.catId) ?? [], item])
      const categories = await context.categories([...byCategory.keys()])
      const candidates = [...byCategory.entries()].sort((a, b) => b[1].length - a[1].length).flatMap(([catId, group]) => {
        const category = categories.find(c => c.id === catId)
        return category === undefined ? [] : [{ category, reason: `本店标题含「${source.keyword}」的 ${String(group.length)} 个商品在此类目，如「${(group[0] as OwnItem).title}」` }]
      })
      if (items.length === 0) return { source, candidates, note: `本店没有标题含「${source.keyword}」的商品。` }
      const lost = [...byCategory.keys()].filter(catId => !categories.some(c => c.id === catId))
      return lost.length === 0
        ? { source, candidates }
        : { source, candidates, note: `本店标题含「${source.keyword}」的商品还有 ${String(lost.length)} 个类目现在不能发布（可能授权已变化）：${lost.join('、')}` }
    }
    case 'keyword': {
      await openEntry(page)
      const found = await searchCategories(page, source.keyword)
      const candidates = found.authorized.map(category => ({ category, reason: `天猫类目搜索「${source.keyword}」` }))
      return found.unauthorized.length === 0
        ? { source, candidates }
        : { source, candidates, note: `另有 ${String(found.unauthorized.length)} 个类目这家店未授权，不能用：${found.unauthorized.map(c => c.path.join(' > ')).join('；')}` }
    }
  }
}
