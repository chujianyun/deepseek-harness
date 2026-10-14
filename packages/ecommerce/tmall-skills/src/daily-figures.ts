/**
 * The 「天猫日报取数」 script for a Tmall merchant account: one day's store payment amount and chosen
 * items' payment amounts from Business Advisor (生意参谋), and the spend and sales of three Alimama
 * (万相台) scenes with one-day attribution, each read from the API its own page calls. A figure the
 * platform has not finished yet is null with the reason, never estimated.
 */

import { num, openReport, queryScenes } from './alimama.ts'
import { realCollectDeps, runCollect, type CollectDeps, type CollectValues } from './collect.ts'
import { beijingDate, pastDate } from './dates.ts'
import { EXIT, SkillError } from './errors.ts'
import { fetchJson, signedOut, type Page } from './page.ts'

/** One platform's figures for a day, in yuan; a figure it could not give is null, with the reason in `missing`. */
export interface PlatformFigures {
  readonly platform: string
  readonly date: string
  readonly metrics: Record<string, number | null>
  readonly missing: { field: string; reason: string }[]
  readonly notes: string[]
}

/** What a daily figures script prints as its data. */
export interface DailyFigures {
  readonly date: string
  readonly platforms: PlatformFigures[]
}

/** The Alimama scenes the daily report adds up, by scene id. */
export const DAILY_SCENES = [
  { sceneId: 371, name: '关键词推广' },
  { sceneId: 372, name: '人群推广' },
  { sceneId: 436, name: '货品全站推' },
] as const

const USAGE = '用法：--account <天猫商家账号 id> --date <YYYY-MM-DD> [--item <名称>=<商品ID> …]'

/** How long Business Advisor's page may take to show the store name. */
const STORE_TIMEOUT_MS = 20_000

/**
 * A money figure rounded to the cent, without floating-point noise.
 * @param value - yuan.
 * @returns yuan to two decimals.
 */
export function cents(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * Figures that are all null for one reason.
 * @param platform - the platform's name.
 * @param date - the day.
 * @param fields - the metric names.
 * @param reason - why none could be read.
 * @returns the figures.
 */
export function noFigures(platform: string, date: string, fields: readonly string[], reason: string): PlatformFigures {
  return {
    platform, date, metrics: Object.fromEntries(fields.map(field => [field, null])),
    missing: fields.map(field => ({ field, reason })), notes: [],
  }
}

/**
 * Read a platform's figures, turning a not-ready stop into null figures so the other platforms still count;
 * any other stop ends the run.
 * @param platform - the platform's name.
 * @param date - the day.
 * @param fields - the metric names.
 * @param read - reads the figures.
 * @returns the figures.
 */
export async function unlessNotReady(
  platform: string, date: string, fields: readonly string[], read: () => Promise<PlatformFigures>,
): Promise<PlatformFigures> {
  try {
    return await read()
  } catch (error) {
    if (error instanceof SkillError && error.exitCode === EXIT.notReady) return noFigures(platform, date, fields, error.message)
    throw error
  }
}

/** Business Advisor's answer for the store overview. */
interface OverviewAnswer {
  readonly content?: { readonly code?: number; readonly data?: { readonly self?: OverviewSelf } }
}

/** The store's own figures in the overview. */
interface OverviewSelf {
  readonly statDate?: number
  readonly payAmt?: { readonly value?: number }
}

/** Business Advisor's answer for the item ranking. */
interface RankAnswer {
  readonly code?: number
  readonly message?: string
  readonly data?: { readonly data?: { readonly item?: { readonly itemId?: string }; readonly payAmt?: { readonly value?: number } }[] }
}

/**
 * Read Business Advisor: the store's payment amount for the day and each item's, from the store home page's own APIs.
 * @param page - the tab.
 * @param date - the day.
 * @param store - the store name the page must show.
 * @param items - name → item id.
 * @returns the figures: 全店支付金额 and `<name>支付金额` per item.
 * @throws SkillError signed-out on the sign-in page, not-ready when the day's overview is not there yet.
 */
export async function readSycm(page: Page, date: string, store: string, items: ReadonlyMap<string, string>): Promise<PlatformFigures> {
  await page.goto('https://sycm.taobao.com/portal/home.htm')
  if (/login/iu.test(new URL(await page.evaluate<string>('location.href')).hostname)) signedOut('生意参谋')
  const named = `document.body.innerText.includes(${JSON.stringify(store)})`
  if (!await page.waitFor(() => page.evaluate<boolean>(named), STORE_TIMEOUT_MS)) {
    throw new SkillError(`生意参谋页面上没有店铺名「${store}」：这个账号看到的不是这家店，没有取数。`)
  }
  const range = `dateType=day&dateRange=${date}%7C${date}`
  const overview = await page.evaluate<OverviewAnswer>(fetchJson(`https://sycm.taobao.com/portal/coreIndex/new/overview/v3.json?needCycleCrc=true&${range}`))
  const self = overview.content?.data?.self
  const pay = self?.payAmt?.value
  if (overview.content?.code !== 0 || self?.statDate === undefined || beijingDate(new Date(self.statDate)) !== date || pay === undefined) {
    throw new SkillError(`生意参谋还没有 ${date} 的店铺数据（数据未就绪），请稍后再试。`, EXIT.notReady)
  }
  const metrics: Record<string, number | null> = { 全店支付金额: cents(pay) }
  const missing: PlatformFigures['missing'] = []
  for (const [name, id] of items) {
    const answer = await page.evaluate<RankAnswer>(fetchJson(`https://sycm.taobao.com/cc/item/view/top.json?${range}&pageSize=10&page=1&order=desc`
      + `&orderBy=payAmt&device=0&compareType=cycle&keyword=${id}&follow=false&cateId=&cateLevel=&indexCode=payAmt`))
    if (answer.code !== 0) throw new Error(`生意参谋商品排行接口拒绝了查询：${answer.message ?? '没有说明原因'}`)
    const rows = (answer.data?.data ?? []).filter(row => row.item?.itemId === id)
    const value = rows[0]?.payAmt?.value
    if (rows.length === 1 && value !== undefined) metrics[`${name}支付金额`] = cents(value)
    else {
      metrics[`${name}支付金额`] = null
      missing.push({ field: `${name}支付金额`, reason: rows.length === 0 ? `商品排行里没有 ID:${id}` : `商品排行里 ID:${id} 不止一行` })
    }
  }
  return { platform: '生意参谋', date, metrics, missing, notes: [`店铺 ${store}；统计日 ${date}（日维度）`] }
}

/**
 * Read Alimama: spend and sales of the three daily-report scenes with one-day attribution (转化统计周期 1 天累计).
 * @param page - the tab.
 * @param date - the day.
 * @returns the figures: `<场景>花费` and `<场景>成交` per scene; a scene without a row that day spent nothing and reads 0.
 * @throws SkillError signed-out on the sign-in page, not-ready when no scene has figures for the day yet.
 */
export async function readAlimama(page: Page, date: string): Promise<PlatformFigures> {
  const template = await openReport(page, date)
  const scenes = await queryScenes(page, { ...template, effectEqual: 1 }, date, ['charge', 'alipayInshopAmt'])
  if (scenes.length === 0) throw new SkillError(`万相台还没有 ${date} 的场景数据（数据未就绪或当天没有投放）。`, EXIT.notReady)
  const metrics: Record<string, number | null> = {}
  const notes = ['转化统计周期：1 天累计；不含店铺直达等其他场景']
  for (const { sceneId, name } of DAILY_SCENES) {
    const scene = scenes.find(row => row.sceneId === sceneId)
    if (scene === undefined) notes.push(`当天没有「${name}」（${String(sceneId)}）场景的数据，按 0 计`)
    metrics[`${name}花费`] = cents(num(scene?.charge))
    metrics[`${name}成交`] = cents(num(scene?.alipayInshopAmt))
  }
  return { platform: '万相台', date, metrics, missing: [], notes }
}

/**
 * Read `--item <name>=<id>` options.
 * @param values - the option values.
 * @returns name → item id, in the order given.
 * @throws SkillError usage for a malformed item.
 */
export function itemsOf(values: CollectValues): Map<string, string> {
  const items = new Map<string, string>()
  for (const item of (values.item as string[] | undefined) ?? []) {
    const match = /^([^=]+)=(\d+)$/u.exec(item)
    if (match === null) throw new SkillError(`--item 要写成 <名称>=<商品ID>，例如 MO=610081277604，收到「${item}」。\n${USAGE}`, EXIT.usage)
    items.set(match[1] as string, match[2] as string)
  }
  return items
}

/**
 * The checked `--date` option.
 * @param values - the option values.
 * @param usage - the usage shown with a refusal.
 * @returns the day.
 * @throws SkillError usage when it is missing, malformed, or not over yet.
 */
export function dateOf(values: CollectValues, usage: string): string {
  if (typeof values.date !== 'string') throw new SkillError(`缺少 --date。\n${usage}`, EXIT.usage)
  return pastDate(values.date, new Date())
}

/**
 * Run the script.
 * @param argv - the arguments after the script.
 * @param deps - the outside world.
 * @returns the exit status.
 */
export function main(argv: readonly string[], deps: CollectDeps = realCollectDeps): Promise<number> {
  return runCollect<DailyFigures>(argv, deps, {
    platform: 'tmall', usage: USAGE, timeoutMs: 180_000, attempts: 2,
    options: { date: { type: 'string' }, item: { type: 'string', multiple: true } },
    read: async (page, account, values) => {
      const date = dateOf(values, USAGE)
      const items = itemsOf(values)
      const sycmFields = ['全店支付金额', ...[...items.keys()].map(name => `${name}支付金额`)]
      const sceneFields = DAILY_SCENES.flatMap(({ name }) => [`${name}花费`, `${name}成交`])
      const sycm = await unlessNotReady('生意参谋', date, sycmFields, () => readSycm(page, date, account.store, items))
      const alimama = await unlessNotReady('万相台', date, sceneFields, () => readAlimama(page, date))
      return { date, platforms: [sycm, alimama] }
    },
  })
}
