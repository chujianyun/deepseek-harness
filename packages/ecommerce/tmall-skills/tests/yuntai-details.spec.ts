import { describe, expect, it } from 'vitest'
import type { CollectDeps } from '../src/collect.ts'
import { EXIT } from '../src/errors.ts'
import { main as accountsCli } from '../src/yuntai-accounts-cli.ts'
import { detailOf, readAccounts, readPlans } from '../src/yuntai-details.ts'
import { main as plansCli } from '../src/yuntai-plans-cli.ts'
import type { EffectRow } from '../src/yuntai-figures.ts'
import { FakePage, on, type Route } from './support.ts'

const DOUYIN = { name: '抖音', id: '53' }

/** The data an effect query expression sends. */
function sent(expression: string): Record<string, unknown> {
  return (JSON.parse(/request\((\{.*\})\)\.then/su.exec(expression)?.[1] as string) as { data: Record<string, unknown> }).data
}

/** 2026-10-13's 抖音 account rows (real figures, two of them) and their total. */
const ZAIDA: EffectRow = {
  subAccountId: '1871401277666316', accountName: '上海法马有性格网络科技有限公司-在达ad01', cost: 27748.53, gmv: 40176.62, validGmv: 36334.78,
  rfdRate: 0.0835, rfdAmt: 3841.84, roi: 1.45, validRoi: 1.31,
}
const IDLE: EffectRow = { subAccountId: '1834795796782091', accountName: '豹擎-名流-官旗店-粉MO-9-jw-测新素材', cost: 0, gmv: 44.31, validGmv: 44.31 }
const TOTAL: EffectRow = { cost: 27748.53, gmv: 40220.93, validGmv: 36379.09, rfdAmt: 3841.84 }

/** Rows of no spend that fill a page to the 100 rows a full page has. */
const fill = (rows: EffectRow[]): EffectRow[] => [...rows, ...Array.from({ length: 100 - rows.length }, (_v, i) => ({ subAccountId: `z${String(i)}`, cost: 0 }))]

/** The 三方外投 page answering the detail queries: `total` for the total row, `pages` of rows by page number. */
function detailPage(total: EffectRow[], pages: EffectRow[][], count = pages.flat().length, routes: Route[] = []): FakePage {
  return new FakePage([
    ...routes,
    on('window.lib && window.lib.mtop', true),
    on('effect.query', (expression: string) => {
      const data = sent(expression)
      if (data.resultDim === 'SELLER') return { result: total, totalCount: total.length }
      return { result: pages[(data.pageNo as number) - 1] ?? [], totalCount: count }
    }),
  ])
}

describe('readAccounts', () => {
  it('reads every account row of the day and checks the four sums against the total row', async () => {
    const page = detailPage([TOTAL], [fill([ZAIDA]), [IDLE]])
    const details = await readAccounts(page, '2026-10-13', '名流官方旗舰店', DOUYIN)
    expect(details.accounts).toHaveLength(101)
    expect([details.accounts[0], details.accounts[100]]).toEqual([
      { 账户id: '1871401277666316', 账户名称: '上海法马有性格网络科技有限公司-在达ad01', 消耗: 27748.53, 总GMV: 40176.62, 有效GMV: 36334.78, 退款率: 0.0835, 退款金额: 3841.84, 总ROI: 1.45, 有效ROI: 1.31 },
      { 账户id: '1834795796782091', 账户名称: '豹擎-名流-官旗店-粉MO-9-jw-测新素材', 消耗: 0, 总GMV: 44.31, 有效GMV: 44.31, 退款率: 0, 退款金额: 0, 总ROI: 0, 有效ROI: 0 },
    ])
    expect(details.total).toEqual({ 消耗: 27748.53, 总GMV: 40220.93, 有效GMV: 36379.09, 退款金额: 3841.84 })
    expect(details.check.every(item => item.matches)).toBe(true)
    const queries = page.evaluated.filter(expression => expression.includes('effect.query')).map(sent)
    expect(queries[0]).toMatchObject({ resultDim: 'SELLER', queryPageTag: 'ACCOUNT', sumTag: true, channelIds: '53', sellerNames: '名流官方旗舰店', startDate: '2026-10-13' })
    expect(queries.slice(1).map(query => [query.resultDim, query.pageNo, query.pageSize])).toEqual([['ACCOUNT', 1, 100], ['ACCOUNT', 2, 100]])
  })

  it('reports sums that do not match, stops paging at an empty page, and stops as not ready without a total row', async () => {
    const short = await readAccounts(detailPage([TOTAL], [fill([ZAIDA]), []], 500), '2026-10-13', '店', DOUYIN)
    expect(short.check.find(item => item.field === '总GMV')).toEqual({ field: '总GMV', rows: 40176.62, total: 40220.93, matches: false })
    for (const total of [[], [{ cost: null }]]) {
      await expect(readAccounts(detailPage(total, []), '2026-10-13', '店', DOUYIN)).rejects.toThrow(
        expect.objectContaining({ exitCode: EXIT.notReady, message: '云台还没有 2026-10-13 的抖音账户数据（数据未就绪），请稍后再试。' }) as Error)
    }
    expect(detailOf({})).toEqual({ 账户id: '', 账户名称: '', 消耗: 0, 总GMV: 0, 有效GMV: 0, 退款率: 0, 退款金额: 0, 总ROI: 0, 有效ROI: 0 })
  })
})

describe('readPlans', () => {
  it('reads every plan of the window, by spend from high to low, keeping the plan ids', async () => {
    const plan = (adid: string, cost: number): EffectRow => ({ ...ZAIDA, adid, adname: `计划${adid.slice(-1)}`, cost })
    // A page without totalCount does not end paging while it is full.
    const page = new FakePage([
      on('window.lib && window.lib.mtop', true),
      on('effect.query', (expression: string) => ({
        result: sent(expression).pageNo === 1 ? fill([plan('7688162732307005481', 900), plan('7686335944308195374', 37362.09)]) : [{ cost: 1 }], totalCount: 0,
      })),
    ])
    const details = await readPlans(page, '2026-10-07', '2026-10-13', '名流官方旗舰店', DOUYIN)
    expect(details.plans).toHaveLength(101)
    expect(details.plans.slice(0, 3).map(row => [row.计划ID, row.计划名称, row.消耗])).toEqual([
      ['7686335944308195374', '计划4', 37362.09], ['7688162732307005481', '计划1', 900], ['', '', 1],
    ])
    expect(sent(page.evaluated.find(expression => expression.includes('effect.query')) as string)).toMatchObject({
      resultDim: 'AD', queryPageTag: 'AD', startDate: '2026-10-07', endDate: '2026-10-13',
    })
  })
})

/** Collect deps around one fake page for the 云台 account `y1`. */
function deps(page: FakePage) {
  const out: string[] = []
  const err: string[] = []
  const collectDeps: CollectDeps = {
    takeOver: id => Promise.resolve({ id, store: '名流官方旗舰店', account: '名流官方旗舰店:诺诺', cdpUrl: 'http://127.0.0.1:9' }),
    reportSignedOut: () => Promise.resolve(),
    openPage: () => Promise.resolve(page),
    stdout: (text) => { out.push(text) },
    stderr: (text) => { err.push(text) },
  }
  return { collectDeps, out, err }
}

describe('scripts', () => {
  it('print the account details of a day and the plans of a window', async () => {
    const accounts = deps(detailPage([TOTAL], [[ZAIDA, IDLE]], 2))
    expect(await accountsCli(['--account', 'y1', '--date', '2026-10-13'], accounts.collectDeps)).toBe(0)
    expect((JSON.parse(accounts.out.join('')) as { data: { channel: string; accounts: unknown[] } }).data).toMatchObject({ channel: '抖音', accounts: [{}, {}] })
    const plans = deps(detailPage([], [[{ adid: '1', cost: 2 }]]))
    expect(await plansCli(['--account', 'y1', '--from', '2026-10-07', '--to', '2026-10-13', '--channel', '抖音'], plans.collectDeps)).toBe(0)
    expect((JSON.parse(plans.out.join('')) as { data: { from: string; plans: unknown[] } }).data).toMatchObject({ from: '2026-10-07', plans: [{ 计划ID: '1' }] })
  })

  it('refuse a missing or reversed date and an unknown channel', async () => {
    const { collectDeps, err } = deps(detailPage([], []))
    expect(await accountsCli(['--account', 'y1'], collectDeps)).toBe(EXIT.usage)
    expect(await plansCli(['--account', 'y1', '--from', '2026-10-13'], collectDeps)).toBe(EXIT.usage)
    expect(await plansCli(['--account', 'y1', '--from', '2026-10-13', '--to', '2026-10-07'], collectDeps)).toBe(EXIT.usage)
    expect(await accountsCli(['--account', 'y1', '--date', '2026-10-13', '--channel', '快手'], collectDeps)).toBe(EXIT.usage)
    expect(err.join('')).toMatch(/缺少 --date[\s\S]*缺少 --to[\s\S]*--from 2026-10-13 晚于 --to 2026-10-07[\s\S]*--channel 只支持 抖音，收到「快手」/u)
  })
})
