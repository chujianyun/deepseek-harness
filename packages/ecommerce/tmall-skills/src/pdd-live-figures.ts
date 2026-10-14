/**
 * The 「拼多多直播取数」 script for a Pinduoduo merchant account: one day's live-stream figures from the
 * merchant backend's live data page (直播成交额, orders, conversion, average watch time, views) and from
 * the live creator center, which signs in with the same account (千次进人成交, fans gained in the live
 * room), each read from the API its page calls. Figures of a day the platform has not finished stop the
 * run as not ready; nothing is estimated.
 */

import { PINDUODUO } from '@deepseek-ai/dsh-ecommerce-accounts/src/platforms.ts'
import { realCollectDeps, runCollect, type CollectDeps } from './collect.ts'
import { beijingDate } from './dates.ts'
import { cents, dateOf, type DailyFigures, type PlatformFigures } from './daily-figures.ts'
import { EXIT, SkillError } from './errors.ts'
import { fetchJson, signedOut, sleep, type Page } from './page.ts'

const USAGE = '用法：--account <拼多多商家账号 id> --date <YYYY-MM-DD>'

/** The merchant backend's live data page for a day. */
export function liveDataUrl(date: string): string {
  return `https://mms.pinduoduo.com/sycm/search_data/live?dateFlag=5&day=${date}`
}

/** The live creator center's data page. */
export const CREATOR_URL = 'https://live.pinduoduo.com/n-creator/live/data-center?from=mms&activeTab=overall'

/** The pause between the two pages, which keeps the run from reaching Pinduoduo's rate limit. */
const PAUSE_MS = 5000

/** The answer every Pinduoduo API here gives. */
interface PddAnswer<T> {
  readonly success?: boolean
  readonly errorCode?: number
  readonly errorMsg?: string | null
  readonly error_code?: number
  readonly result?: T
}

/** The live overview of one day. */
interface LiveOverview {
  readonly statDate?: string
  readonly liveViewCnt?: number
  readonly liveAvgUsrViewDur?: number
  readonly livePayOrdrCnt?: number
  readonly livePayOrdrAmt?: number
  readonly livePayUvCvr?: number
}

/** One point of a creator-center trend line: Beijing midnight in milliseconds, and the day's value. */
interface LinePoint {
  readonly xvalue: number
  readonly ystringValue: string
}

/**
 * Ask a Pinduoduo API, stopping when it refuses.
 * @param page - a tab on the API's site.
 * @param url - the API.
 * @param body - the JSON it is posted; none for a GET.
 * @param name - what it is, for the message.
 * @returns its result.
 * @throws SkillError signed-out when it says the account is not signed in, failed when it refuses otherwise.
 */
async function ask<T>(page: Page, url: string, body: object | undefined, name: string): Promise<T | undefined> {
  const answer = await page.evaluate<PddAnswer<T>>(fetchJson(url, body))
  if (answer.error_code === 40001 || answer.errorCode === 40001) signedOut('拼多多')
  if (answer.success !== true) throw new SkillError(`拼多多${name}接口拒绝了查询：${answer.errorMsg ?? String(answer.errorCode ?? answer.error_code ?? '没有说明原因')}`)
  return answer.result
}

/**
 * Read one day's live figures.
 * @param page - the tab.
 * @param date - the day.
 * @param pauseMs - the pause between the two pages.
 * @returns 直播GMV, 直播支付订单, 直播支付转化率 (a ratio), 人均观看时长 (minutes), 累计观看量, 千次进人成交, 直播间涨粉数;
 *   an overview figure the API leaves out is null with the reason.
 * @throws SkillError signed-out on either page's sign-in page, not-ready when either page has no figures for the day yet.
 */
export async function readLive(page: Page, date: string, pauseMs = PAUSE_MS): Promise<PlatformFigures> {
  await page.goto(liveDataUrl(date))
  if (PINDUODUO.isLoginPage(await page.evaluate<string>('location.href'))) signedOut('拼多多')
  const ready = await ask<string>(page, 'https://mms.pinduoduo.com/sydney/api/mallFlow/queryLiveOverViewReadyTime', {}, '直播数据就绪时间')
  if (typeof ready !== 'string' || ready < date) {
    throw new SkillError(`拼多多直播数据只更新到 ${typeof ready === 'string' ? ready : '（未知）'}，还没有 ${date} 的数据（数据未就绪），请稍后再试。`, EXIT.notReady)
  }
  const overview = await ask<LiveOverview>(page, 'https://mms.pinduoduo.com/sydney/api/mallFlow/queryLiveOverView', { queryType: 0, queryDate: date }, '直播数据')
  if (overview?.statDate !== date) throw new SkillError(`拼多多直播数据返回的日期是 ${String(overview?.statDate)}，不是 ${date}，没有取数。`)
  await sleep(pauseMs)
  await page.goto(CREATOR_URL)
  if (/login/iu.test(new URL(await page.evaluate<string>('location.href')).pathname)) signedOut('多多直播')
  const room = await ask<{ name?: string }>(page, 'https://live.pinduoduo.com/kiwi/obs/anchor/info', undefined, '直播间信息')
  const line = async (key: string): Promise<number> => {
    const points = (await ask<{ lineChartPointVOList?: LinePoint[] }>(page, 'https://live.pinduoduo.com/kiwi/obs/statistic/line', { key }, '直播数据趋势'))
      ?.lineChartPointVOList ?? []
    const point = points.find(p => beijingDate(new Date(p.xvalue)) === date)
    const value = Number(point?.ystringValue)
    if (point === undefined || Number.isNaN(value)) {
      throw new SkillError(`多多直播数据中心还没有 ${date} 的「${key}」数据（数据未就绪或已超过 30 天），请稍后再试。`, EXIT.notReady)
    }
    return value
  }
  const fields = [
    ['直播GMV', overview.livePayOrdrAmt], ['直播支付订单', overview.livePayOrdrCnt], ['直播支付转化率', overview.livePayUvCvr],
    ['人均观看时长', overview.liveAvgUsrViewDur], ['累计观看量', overview.liveViewCnt],
  ] as const
  const metrics: Record<string, number | null> = {}
  const missing: PlatformFigures['missing'] = []
  for (const [field, value] of fields) {
    metrics[field] = typeof value === 'number' ? (field === '直播GMV' ? cents(value) : value) : null
    if (metrics[field] === null) missing.push({ field, reason: `拼多多直播数据没有返回 ${date} 的${field}` })
  }
  metrics.千次进人成交 = cents(await line('thousandPvGmv'))
  metrics.直播间涨粉数 = await line('liveFansIncr')
  const notes = [`直播间 ${room?.name ?? '（未返回名称）'}；统计日 ${date}`, '直播GMV 取商家后台「直播成交额」；人均观看时长单位为分钟；直播支付转化率为比值（0.0061 即 0.61%）']
  return { platform: '拼多多直播', date, metrics, missing, notes }
}

/**
 * Run the script.
 * @param argv - the arguments after the script.
 * @param deps - the outside world.
 * @returns the exit status.
 */
export function main(argv: readonly string[], deps: CollectDeps = realCollectDeps): Promise<number> {
  return runCollect<DailyFigures>(argv, deps, {
    platform: 'pinduoduo', usage: USAGE, timeoutMs: 120_000, attempts: 2,
    options: { date: { type: 'string' } },
    read: async (page, _account, values) => {
      const date = dateOf(values, USAGE)
      return { date, platforms: [await readLive(page, date)] }
    },
  })
}
