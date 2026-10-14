/**
 * The 健康品牌云台 detail scripts: one day's 三方外投 account rows of one media channel with the
 * channel's total row (「云台账户明细」), and a window's plan rows (「云台计划明细」), each read
 * through the 三方外投 page's own signed effect query, page by page.
 */

import { realCollectDeps, runCollect, type CollectDeps, type CollectValues } from './collect.ts'
import { cents, dateOf } from './daily-figures.ts'
import { EXIT, SkillError } from './errors.ts'
import type { Page } from './page.ts'
import { allRows, openInvestPage, queryEffect, type EffectRow } from './yuntai-figures.ts'

/** The media channels the detail scripts take, by the name the page shows. */
export const CHANNELS: Readonly<Record<string, string>> = { 抖音: '53' }

/** One account or plan row, in yuan; 退款率 is a ratio as the page shows it, to four decimals. */
export interface DetailRow {
  readonly 账户id: string
  readonly 账户名称: string
  readonly 消耗: number
  readonly 总GMV: number
  readonly 有效GMV: number
  readonly 退款率: number
  readonly 退款金额: number
  readonly 总ROI: number
  readonly 有效ROI: number
}

/** A plan row: an account row with its plan. */
export interface PlanRow extends DetailRow {
  readonly 计划ID: string
  readonly 计划名称: string
}

/** The four sums checked against the channel's total row. */
const SUMMED = ['消耗', '总GMV', '有效GMV', '退款金额'] as const

/**
 * One row as the scripts print it.
 * @param row - the effect query row.
 * @returns the row in yuan.
 */
export function detailOf(row: EffectRow): DetailRow {
  return {
    账户id: row.subAccountId ?? '', 账户名称: row.accountName ?? '', 消耗: cents(row.cost ?? 0), 总GMV: cents(row.gmv ?? 0), 有效GMV: cents(row.validGmv ?? 0),
    退款率: row.rfdRate ?? 0, 退款金额: cents(row.rfdAmt ?? 0), 总ROI: row.roi ?? 0, 有效ROI: row.validRoi ?? 0,
  }
}

/** The channel id of `--channel`, 抖音 by default. */
function channelOf(values: CollectValues): { name: string; id: string } {
  const name = typeof values.channel === 'string' ? values.channel : '抖音'
  const id = CHANNELS[name]
  if (id === undefined) throw new SkillError(`--channel 只支持 ${Object.keys(CHANNELS).join('、')}，收到「${name}」。`, EXIT.usage)
  return { name, id }
}

/** What 「云台账户明细」 prints as its data. */
export interface YuntaiAccountDetails {
  readonly date: string
  readonly channel: string
  readonly store: string
  readonly total: Readonly<Record<(typeof SUMMED)[number], number>>
  readonly accounts: DetailRow[]
  /** Each sum of the account rows against the total row; every one must match for the rows to be complete. */
  readonly check: { field: string; rows: number; total: number; matches: boolean }[]
}

/**
 * Read one day's account rows of one channel and check them against its total row.
 * @param page - the tab.
 * @param date - the day.
 * @param store - the store whose rows these are.
 * @param channel - the channel's name and id.
 * @returns the rows, the total, and the check; no rows and a zero total is a day without advertising.
 * @throws SkillError signed-out on a sign-in page, not-ready when the day has no total row, or one without its spend, yet.
 */
export async function readAccounts(
  page: Page, date: string, store: string, channel: { name: string; id: string },
): Promise<YuntaiAccountDetails> {
  await openInvestPage(page)
  const scope = { channelIds: channel.id, advAggre: true, sellerNames: store, startDate: date, endDate: date }
  const totals = await queryEffect(page, { ...scope, pageNo: 1, pageSize: 10, resultDim: 'SELLER', queryPageTag: 'ACCOUNT', sumTag: true })
  const totalRow = totals.result[0]
  if (typeof totalRow?.cost !== 'number') throw new SkillError(`云台还没有 ${date} 的${channel.name}账户数据（数据未就绪），请稍后再试。`, EXIT.notReady)
  const accounts = (await allRows(page, { ...scope, resultDim: 'ACCOUNT', queryPageTag: 'ACCOUNT', sumTag: false })).map(detailOf)
  const total = detailOf(totalRow)
  const check = SUMMED.map((field) => {
    const rows = cents(accounts.reduce((sum, row) => sum + row[field], 0))
    return { field, rows, total: total[field], matches: Math.abs(rows - total[field]) <= 0.05 }
  })
  return {
    date, channel: channel.name, store, accounts, check,
    total: { 消耗: total.消耗, 总GMV: total.总GMV, 有效GMV: total.有效GMV, 退款金额: total.退款金额 },
  }
}

/** What 「云台计划明细」 prints as its data. */
export interface YuntaiPlanDetails {
  readonly from: string
  readonly to: string
  readonly channel: string
  readonly store: string
  /** Plans in the window, all of them, by spend from high to low. */
  readonly plans: PlanRow[]
}

/**
 * Read a window's plan rows of one channel, summed over the window.
 * @param page - the tab.
 * @param from - the first day.
 * @param to - the last day.
 * @param store - the store whose rows these are.
 * @param channel - the channel's name and id.
 * @returns every plan, by spend from high to low.
 * @throws SkillError signed-out on a sign-in page.
 */
export async function readPlans(
  page: Page, from: string, to: string, store: string, channel: { name: string; id: string },
): Promise<YuntaiPlanDetails> {
  await openInvestPage(page)
  const rows = await allRows(page, {
    channelIds: channel.id, advAggre: true, sellerNames: store, startDate: from, endDate: to, resultDim: 'AD', queryPageTag: 'AD', sumTag: false,
  })
  const plans = rows.map(row => ({ 计划ID: row.adid ?? '', 计划名称: row.adname ?? '', ...detailOf(row) })).sort((a, b) => b.消耗 - a.消耗)
  return { from, to, channel: channel.name, store, plans }
}

/** The checked `YYYY-MM-DD` value of a date option. */
function dayOption(values: CollectValues, name: string, usage: string): string {
  const value = values[name]
  if (typeof value !== 'string') throw new SkillError(`缺少 --${name}。\n${usage}`, EXIT.usage)
  return dateOf({ date: value }, usage)
}

const ACCOUNTS_USAGE = '用法：--account <健康品牌云台账号 id> --date <YYYY-MM-DD> [--channel 抖音]'
const PLANS_USAGE = '用法：--account <健康品牌云台账号 id> --from <YYYY-MM-DD> --to <YYYY-MM-DD> [--channel 抖音]'

/**
 * Run 「云台账户明细」.
 * @param argv - the arguments after the script.
 * @param deps - the outside world.
 * @returns the exit status.
 */
export function accountsMain(argv: readonly string[], deps: CollectDeps = realCollectDeps): Promise<number> {
  return runCollect<YuntaiAccountDetails>(argv, deps, {
    platform: 'yuntai', usage: ACCOUNTS_USAGE, timeoutMs: 120_000, attempts: 2,
    options: { date: { type: 'string' }, channel: { type: 'string' } },
    read: (page, account, values) => readAccounts(page, dayOption(values, 'date', ACCOUNTS_USAGE), account.store, channelOf(values)),
  })
}

/**
 * Run 「云台计划明细」.
 * @param argv - the arguments after the script.
 * @param deps - the outside world.
 * @returns the exit status.
 */
export function plansMain(argv: readonly string[], deps: CollectDeps = realCollectDeps): Promise<number> {
  return runCollect<YuntaiPlanDetails>(argv, deps, {
    platform: 'yuntai', usage: PLANS_USAGE, timeoutMs: 180_000, attempts: 2,
    options: { from: { type: 'string' }, to: { type: 'string' }, channel: { type: 'string' } },
    read: (page, account, values) => {
      const from = dayOption(values, 'from', PLANS_USAGE)
      const to = dayOption(values, 'to', PLANS_USAGE)
      if (from > to) throw new SkillError(`--from ${from} 晚于 --to ${to}。\n${PLANS_USAGE}`, EXIT.usage)
      return readPlans(page, from, to, account.store, channelOf(values))
    },
  })
}
