/**
 * Alimama (万相台) marketing-scene figures, read from the report API the report page itself calls.
 * `csrfId` and `loginPointId` are made at run time in the page, so the skill reuses the body of the
 * page's own scene query rather than building one; the API returns unrounded values, so rates are
 * recomputed from their numerators and denominators.
 */

import { EXIT, SkillError } from './errors.ts'
import { fetchJson, signedOut, type Page } from './page.ts'

/** The account report page for one day. */
export function reportUrl(date: string): string {
  return `https://one.alimama.com/index.html#!/report/account?rptType=account&isRequestedQztDefaultSet=1&startTime=${date}&endTime=${date}`
}

/** The scene query body the report page sent; the skill reuses its session fields. */
export type QueryTemplate = Readonly<Record<string, unknown>> & { readonly csrfId?: string }

/** One scene's raw figures from the report API. */
export interface SceneFigures {
  readonly sceneId: number
  readonly scene1Name?: string
  readonly [field: string]: unknown
}

/** The report API fields the scene report reads. */
export const SCENE_FIELDS = [
  'adPv', 'click', 'charge', 'alipayInshopAmt', 'alipayInshopNum', 'alipayInshopUv', 'cartInshopNum',
  'inshopPotentialUvRate', 'orgNaturalPv', 'naturalPayAmt',
] as const

/** How long the report page may take to send its scene query. */
const TEMPLATE_TIMEOUT_MS = 30_000

/**
 * Open the report page for a day and capture the scene query it sends. A page sent to the sign-in
 * screen that still offers 「进入后台」 keeps its session, so the skill enters once; otherwise the
 * account is signed out.
 * @param page - the tab.
 * @param date - the day.
 * @returns the query body to reuse.
 * @throws SkillError signed-out, or failed when the page sends no query.
 */
export async function openReport(page: Page, date: string): Promise<QueryTemplate> {
  let template: QueryTemplate | undefined
  page.onRequest(({ url, method, body }) => {
    if (method !== 'POST' || !url.includes('/report/query.json') || body?.startsWith('{') !== true) return
    const parsed = JSON.parse(body) as QueryTemplate
    if (JSON.stringify(parsed.queryDomains) === '["scene"]' && Array.isArray(parsed.queryFieldIn)) template = parsed
  })
  const onLogin = async (): Promise<boolean> => (await page.evaluate<string>('location.href')).includes('#!/login')
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.goto(reportUrl(date))
    await page.waitFor(async () => template !== undefined || await onLogin(), TEMPLATE_TIMEOUT_MS)
    if (template !== undefined) return template
    if (!await onLogin()) break
    if (attempt === 1 || !await page.evaluate<boolean>(CLICK_ENTER)) signedOut('万相台')
    await page.waitFor(async () => !await onLogin(), TEMPLATE_TIMEOUT_MS)
  }
  throw new SkillError('万相台报表页没有正常加载（没有发出场景报表查询），请稍后再试。')
}

/** Click 「进入后台」 on the sign-in screen; true when the button was there. */
const CLICK_ENTER = `(() => {
  const button = [...document.querySelectorAll('button, a, span, div')].find(e => e.children.length === 0 && (e.textContent || '').trim().includes('进入后台'))
  if (!button) return false
  button.click()
  return true
})()`

/**
 * Query the scene figures of one day.
 * @param page - the report tab.
 * @param template - the page's own scene query.
 * @param date - the day.
 * @param fields - the API fields to read.
 * @returns one row per scene that ran that day.
 * @throws SkillError when the API refuses.
 */
export async function queryScenes(page: Page, template: QueryTemplate, date: string, fields: readonly string[]): Promise<SceneFigures[]> {
  const body = { ...template, startTime: date, endTime: date, queryFieldIn: fields, pageSize: 100, offset: 0 }
  const csrf = typeof template.csrfId === 'string' ? `csrfId=${template.csrfId}&` : ''
  const answer = await page.evaluate<{ data?: { list?: SceneFigures[] }; info?: { ok?: boolean; message?: string | null } }>(
    fetchJson(`https://one.alimama.com/report/query.json?${csrf}bizCode=universalBP`, body))
  if (answer.info?.ok === false) throw new SkillError(`万相台报表接口拒绝了查询：${answer.info.message ?? '没有说明原因'}`)
  return answer.data?.list ?? []
}

/**
 * Stop unless the day's figures are complete: the de-duplicated buyer counts are computed late
 * (usually after 10:00 the next morning), and until then every scene reads zero buyers.
 * @param scenes - the day's scenes.
 * @param date - the day.
 * @throws SkillError not-ready when there is no scene or every scene has zero buyers.
 */
export function ensureReady(scenes: readonly SceneFigures[], date: string): void {
  if (scenes.length === 0) {
    throw new SkillError(`万相台 ${date} 还没有任何推广场景数据（数据未就绪或当天没有投放），没有生成报表。`, EXIT.notReady)
  }
  if (scenes.every(scene => num(scene.alipayInshopUv) === 0)) {
    throw new SkillError(`万相台 ${date} 各场景的成交人数都是 0：去重指标还没算完（通常上午 10 点后就绪），为避免输出不完整数据，这次没有生成报表，请稍后再试。`, EXIT.notReady)
  }
}

/** The report columns, in order. */
export const REPORT_COLUMNS = [
  '日期', '场景ID', '场景', '花费', '展现量', '点击量', '点击率', '平均点击花费', '总成交金额', '总成交笔数', '成交人数', '投入产出比',
  '总成交成本', '点击转化率', '总购物车数', '加购率', '加购成本', '引导访问潜客占比', '人均成交金额', '自然流量曝光量', '自然流量转化金额',
] as const

/**
 * One report row per scene, from raw figures.
 * @param scenes - the day's scenes.
 * @param date - the day.
 * @returns rows in {@link REPORT_COLUMNS} order, by scene id.
 */
export function reportRows(scenes: readonly SceneFigures[], date: string): string[][] {
  return [...scenes].sort((a, b) => a.sceneId - b.sceneId).map((scene) => {
    const charge = num(scene.charge)
    const impressions = num(scene.adPv)
    const clicks = num(scene.click)
    const amount = num(scene.alipayInshopAmt)
    const orders = num(scene.alipayInshopNum)
    const buyers = num(scene.alipayInshopUv)
    const carts = num(scene.cartInshopNum)
    return [
      date, String(scene.sceneId), scene.scene1Name ?? '', money(charge), whole(impressions), whole(clicks),
      percent(clicks, impressions), ratio(charge, clicks), money(amount), whole(orders), whole(buyers), ratio(amount, charge),
      ratio(charge, orders), percent(orders, clicks), whole(carts), percent(carts, clicks), ratio(charge, carts),
      percent(num(scene.inshopPotentialUvRate), 1), ratio(amount, buyers), whole(num(scene.orgNaturalPv)), money(num(scene.naturalPayAmt)),
    ]
  })
}

/**
 * Each scene's spend.
 * @param scenes - the day's scenes.
 * @returns spend by scene id.
 */
export function sceneSpend(scenes: readonly SceneFigures[]): Map<number, number> {
  return new Map(scenes.map(scene => [scene.sceneId, num(scene.charge)]))
}

/**
 * A figure the API returned, or 0 when it is missing.
 * @param value - the field.
 * @returns the number.
 */
export function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function money(value: number): string {
  return value.toFixed(2)
}

function whole(value: number): string {
  return String(Math.round(value))
}

function ratio(numerator: number, denominator: number): string {
  return denominator === 0 ? '' : (numerator / denominator).toFixed(2)
}

function percent(numerator: number, denominator: number): string {
  return denominator === 0 ? '' : `${(numerator / denominator * 100).toFixed(2)}%`
}
