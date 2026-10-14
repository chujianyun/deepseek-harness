/**
 * The 「云台日报取数」 script for a 健康品牌云台 account: one day's third-party advertising totals
 * (三方外投 总计 row and its media rows) and, optionally, the sum of the store's own accounts picked by a
 * name keyword (such as 名流's 自投 accounts named `…-ML-…`). It calls the effect query the
 * 三方外投 page itself calls, through the page's own signed mtop client.
 */

import { YUNTAI } from '@deepseek-ai/dsh-ecommerce-accounts/src/platforms.ts'
import { realCollectDeps, runCollect, type CollectDeps } from './collect.ts'
import { cents, dateOf, type DailyFigures, type PlatformFigures } from './daily-figures.ts'
import { EXIT, SkillError } from './errors.ts'
import { signedOut, type Page } from './page.ts'

const USAGE = '用法：--account <健康品牌云台账号 id> --date <YYYY-MM-DD> [--self-keyword <自投账户名关键字>]'

/** The 三方外投 page whose effect query the script calls. */
export const INVEST_URL = 'https://yuntai.taobao.com/v2/third-party-invest'

/** How long the page may take to load its mtop client. */
const MTOP_TIMEOUT_MS = 30_000

/** Accounts per page of the account query. */
const PAGE_SIZE = 100

/** One row of the effect query: the 总计 row, a media row, or an account row. */
export interface EffectRow {
  readonly channelName?: string | null
  readonly accountName?: string | null
  readonly sellerNick?: string | null
  readonly cost?: number | null
  readonly validGmv?: number | null
  readonly gmv?: number | null
  readonly rfdRate?: number | null
}

/** One page of the effect query: its rows and the row count of every page. */
export interface EffectPage {
  readonly result: readonly EffectRow[]
  readonly totalCount: number
}

/** One page of the effect query, or why mtop refused it. */
export type EffectAnswer = EffectPage | { readonly ret: readonly string[] }

/**
 * The expression that runs the effect query with the page's mtop client.
 * @param data - the query fields besides `api`.
 * @returns JavaScript source for {@link Page.evaluate}.
 */
export function effectQuery(data: Readonly<Record<string, unknown>>): string {
  const request = { api: 'mtop.alihealth.dsp.yt.effect.query', v: '1.0', type: 'POST', dataType: 'json', data: { ...data, api: 'v2' } }
  return `window.lib.mtop.request(${JSON.stringify(request)}).then(
    r => ({ result: r.data.result.result || [], totalCount: r.data.result.totalCount || 0 }),
    e => ({ ret: (e && e.ret) || [String(e && e.message || e)] }))`
}

/**
 * Run one effect query page.
 * @param page - the 三方外投 tab.
 * @param data - the query fields.
 * @returns its rows and the total row count.
 * @throws SkillError signed-out when mtop says the session expired, failed when it refuses otherwise.
 */
export async function queryEffect(page: Page, data: Readonly<Record<string, unknown>>): Promise<EffectPage> {
  const answer = await page.evaluate<EffectAnswer>(effectQuery(data))
  if (!('ret' in answer)) return answer
  const why = answer.ret.join('；')
  if (/SESSION_EXPIRED|TOKEN_EX[OP]IRED|NOT_LOGIN/u.test(why)) signedOut('健康品牌云台')
  throw new Error(`云台效果查询被拒绝：${why}`)
}

/**
 * Read the day's 三方外投 totals and, with a keyword, the matching own accounts' sums.
 * @param page - the tab.
 * @param date - the day.
 * @param store - the store name the rows must carry.
 * @param keyword - picks own accounts by name; empty for none.
 * @returns 三方外投消耗 / 有效GMV / 总GMV / 退款率, null with the reason when the 总计 row lacks one, and with a keyword
 *   自投花费 / 自投有效GMV / 自投总GMV.
 * @throws SkillError signed-out on a sign-in page, not-ready when the day has no 总计 row yet, failed for another store.
 */
export async function readYuntai(page: Page, date: string, store: string, keyword: string): Promise<PlatformFigures> {
  await page.goto(INVEST_URL)
  if (YUNTAI.isLoginPage(await page.evaluate<string>('location.href'))) signedOut('健康品牌云台')
  if (!await page.waitFor(() => page.evaluate<boolean>('!!(window.lib && window.lib.mtop)'), MTOP_TIMEOUT_MS)) {
    throw new Error('云台三方外投页面没有加载完（没有 mtop 客户端）。')
  }
  const day = { startDate: date, endDate: date }
  const { result } = await queryEffect(page, { pageNo: 1, pageSize: PAGE_SIZE, resultDim: 'SELLER', queryPageTag: 'SELLER', sumTag: true, advAggre: false, ...day })
  const [total, ...media] = result
  if (total?.sellerNick !== '总计' || typeof total.cost !== 'number') {
    throw new SkillError(`云台还没有 ${date} 的三方外投数据（数据未就绪），请稍后再试。`, EXIT.notReady)
  }
  const others = media.filter(row => row.sellerNick !== store)
  if (others.length > 0) throw new SkillError(`云台三方外投里有别的店铺（${others.map(row => String(row.sellerNick)).join('、')}），不是只有「${store}」，没有取数。`)
  const totalCost = cents(total.cost)
  const metrics: Record<string, number | null> = { 三方外投消耗: totalCost }
  const missing: PlatformFigures['missing'] = []
  for (const [field, value] of [['三方外投有效GMV', total.validGmv], ['三方外投总GMV', total.gmv], ['三方外投退款率', total.rfdRate]] as const) {
    metrics[field] = typeof value === 'number' ? (field === '三方外投退款率' ? value : cents(value)) : null
    if (metrics[field] === null) missing.push({ field, reason: `云台 ${date} 的三方外投总计行没有${field.slice(4)}` })
  }
  const mediaCost = cents(media.reduce((sum, row) => sum + (row.cost ?? 0), 0))
  const notes = [
    `店铺 ${store}；统计日 ${date}（单日）`,
    `媒体明细：${media.map(row => `${String(row.channelName)} 消耗 ${String(cents(row.cost ?? 0))}`).join('；')}；合计 ${String(mediaCost)}`
      + (Math.abs(mediaCost - totalCost) <= 0.05 ? '，与总计一致' : `，与总计 ${String(totalCost)} 不一致`),
  ]
  if (keyword !== '') {
    const own = (await allAccounts(page, day, store)).filter(row => ownAccount(row.accountName ?? '', keyword))
    metrics.自投花费 = cents(own.reduce((sum, row) => sum + (row.cost ?? 0), 0))
    metrics.自投有效GMV = cents(own.reduce((sum, row) => sum + (row.validGmv ?? 0), 0))
    metrics.自投总GMV = cents(own.reduce((sum, row) => sum + (row.gmv ?? 0), 0))
    notes.push(`自投账户（名称里有独立的「${keyword}」，${String(own.length)} 个有数据）：${own.map(row => `${String(row.accountName)} 消耗 ${String(cents(row.cost ?? 0))}`).join('；')}`)
  }
  return { platform: '健康品牌云台', date, metrics, missing, notes }
}

/**
 * Whether an account is one of the store's own: the keyword stands in its name as a segment of its own,
 * not inside another word, as `ML` in 名流-官旗粉MO-ML-2 but not in HTML5.
 * @param name - the account name.
 * @param keyword - the keyword.
 * @returns true for an own account.
 */
export function ownAccount(name: string, keyword: string): boolean {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, 'u').test(name)
}

/** Every account row of the day, page by page. */
async function allAccounts(page: Page, day: Readonly<Record<string, string>>, store: string): Promise<EffectRow[]> {
  const rows: EffectRow[] = []
  for (let pageNo = 1; ; pageNo++) {
    const { result, totalCount } = await queryEffect(page, {
      pageNo, pageSize: PAGE_SIZE, resultDim: 'ACCOUNT', queryPageTag: 'ACCOUNT', sumTag: false, advAggre: true, sellerNames: store, ...day,
    })
    rows.push(...result)
    if (result.length === 0 || rows.length >= totalCount) return rows
  }
}

/**
 * Run the script.
 * @param argv - the arguments after the script.
 * @param deps - the outside world.
 * @returns the exit status.
 */
export function main(argv: readonly string[], deps: CollectDeps = realCollectDeps): Promise<number> {
  return runCollect<DailyFigures>(argv, deps, {
    platform: 'yuntai', usage: USAGE, timeoutMs: 120_000, attempts: 2,
    options: { 'date': { type: 'string' }, 'self-keyword': { type: 'string' } },
    read: async (page, account, values) => {
      const date = dateOf(values, USAGE)
      const keyword = typeof values['self-keyword'] === 'string' ? values['self-keyword'] : ''
      return { date, platforms: [await readYuntai(page, date, account.store, keyword)] }
    },
  })
}
