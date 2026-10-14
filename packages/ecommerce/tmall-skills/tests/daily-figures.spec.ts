import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import type { CollectDeps } from '../src/collect.ts'
import { cents, dateOf, itemsOf, main, noFigures, readAlimama, readSycm, unlessNotReady } from '../src/daily-figures.ts'
import { EXIT, SkillError } from '../src/errors.ts'
import type { Page } from '../src/page.ts'
import { effectQuery, main as yuntaiMain, ownAccount, queryEffect, readYuntai, type EffectRow } from '../src/yuntai-figures.ts'
import { FakePage, on, postedBody, sendsTemplate, type Route } from './support.ts'

/** 2026-10-13 00:00 in Beijing, as Business Advisor stamps the day. */
const OCT13 = 1791820800000

const overview = (fields: object = {}) => ({
  content: { code: 0, data: { self: { statDate: OCT13, payAmt: { value: 326455.4699999998 }, ...fields } } },
})
const rank = (...rows: [string, number][]) => ({
  code: 0, data: { data: rows.map(([itemId, value]) => ({ item: { itemId }, payAmt: { value } })) },
})

/** Business Advisor's home page for 名流官方旗舰店, answering the overview and the item ranking. */
function sycmPage(routes: Route[] = []): FakePage {
  return new FakePage([
    ...routes,
    on('document.body.innerText.includes', true),
    on('overview/v3.json', overview()),
    on('keyword=610081277604', rank(['610081277604', 107565.75000000092])),
    on('keyword=524565741530', rank(['524565741530', 104542.58000000013])),
  ])
}

const ITEMS = new Map([['MO', '610081277604'], ['003', '524565741530']])

/** Alimama's 2026-10-13 scenes with one-day attribution (real figures). */
const SCENES = [
  { sceneId: 372, charge: 39783.680000000066, alipayInshopAmt: 53286.31 },
  { sceneId: 371, charge: 67351.24999999987, alipayInshopAmt: 77473.03 },
  { sceneId: 436, charge: 6056.869999999972, alipayInshopAmt: 13603 },
  { sceneId: 479, charge: 2866.4465399999967, alipayInshopAmt: 5824.59 },
]

function alimamaPage(list: unknown[] = SCENES): FakePage {
  return new FakePage([on('report/query.json', { info: { ok: true }, data: { list } })], sendsTemplate)
}

describe('figures helpers', () => {
  it('rounds money to the cent and makes all-null figures with one reason', () => {
    expect([cents(107565.75000000092), cents(6056.869999999972), cents(49723.984)]).toEqual([107565.75, 6056.87, 49723.98])
    expect(noFigures('万相台', '2026-10-13', ['a', 'b'], '未就绪')).toEqual({
      platform: '万相台', date: '2026-10-13', metrics: { a: null, b: null }, missing: [{ field: 'a', reason: '未就绪' }, { field: 'b', reason: '未就绪' }], notes: [],
    })
  })

  it('turns only a not-ready stop into null figures', async () => {
    const notReady = () => Promise.reject(new SkillError('还没出来', EXIT.notReady))
    expect((await unlessNotReady('万相台', '2026-10-13', ['a'], notReady)).missing).toEqual([{ field: 'a', reason: '还没出来' }])
    await expect(unlessNotReady('万相台', '2026-10-13', ['a'], () => Promise.reject(new SkillError('要登录', EXIT.signedOut)))).rejects.toThrow('要登录')
    await expect(unlessNotReady('万相台', '2026-10-13', ['a'], () => Promise.reject(new Error('断网')))).rejects.toThrow('断网')
  })

  it('reads items and the date from the command line', () => {
    expect([...itemsOf({ item: ['MO=610081277604', '003=524565741530'] })]).toEqual([['MO', '610081277604'], ['003', '524565741530']])
    expect(itemsOf({}).size).toBe(0)
    expect(() => itemsOf({ item: ['610081277604'] })).toThrow('MO=610081277604')
    expect(() => itemsOf({ item: ['610081277604'] })).toThrow(SkillError)
    expect(dateOf({ date: '2026-10-13' }, '用法')).toBe('2026-10-13')
    expect(() => dateOf({}, '用法')).toThrow('缺少 --date。\n用法')
    expect(() => dateOf({ date: '2999-01-01' }, '用法')).toThrow('还没有结束')
  })
})

describe('readSycm', () => {
  it('reads the store and each item payment amount of the day', async () => {
    const page = sycmPage()
    expect(await readSycm(page, '2026-10-13', '名流官方旗舰店', ITEMS)).toEqual({
      platform: '生意参谋', date: '2026-10-13', metrics: { 全店支付金额: 326455.47, MO支付金额: 107565.75, '003支付金额': 104542.58 },
      missing: [], notes: ['店铺 名流官方旗舰店；统计日 2026-10-13（日维度）'],
    })
    expect(page.visited).toEqual(['https://sycm.taobao.com/portal/home.htm'])
    expect(page.evaluated).toContainEqual(expect.stringContaining('dateType=day&dateRange=2026-10-13%7C2026-10-13'))
  })

  it('marks an item that is missing or not unique, and fails when the ranking refuses', async () => {
    const page = sycmPage([on('keyword=610081277604', rank()), on('keyword=524565741530', rank(['524565741530', 1], ['524565741530', 2]))])
    const figures = await readSycm(page, '2026-10-13', '名流官方旗舰店', ITEMS)
    expect(figures.metrics).toEqual({ 全店支付金额: 326455.47, MO支付金额: null, '003支付金额': null })
    expect(figures.missing).toEqual([
      { field: 'MO支付金额', reason: '商品排行里没有 ID:610081277604' }, { field: '003支付金额', reason: '商品排行里 ID:524565741530 不止一行' },
    ])
    expect((await readSycm(sycmPage([on('keyword=', { code: 0 })]), '2026-10-13', '店', new Map([['MO', '1']]))).missing[0]?.reason).toBe('商品排行里没有 ID:1')
    await expect(readSycm(sycmPage([on('keyword=', { code: 1, message: '限流' })]), '2026-10-13', '店', ITEMS)).rejects.toThrow('商品排行接口拒绝了查询：限流')
    await expect(readSycm(sycmPage([on('keyword=', { code: 1 })]), '2026-10-13', '店', ITEMS)).rejects.toThrow('没有说明原因')
  })

  it('stops when the day is not ready, the page is another store, or the account is signed out', async () => {
    for (const answer of [{}, { content: { code: 1 } }, overview({ statDate: OCT13 - 86_400_000 }), overview({ payAmt: {} })]) {
      await expect(readSycm(sycmPage([on('overview/v3.json', answer)]), '2026-10-13', '店', ITEMS)).rejects.toThrow(
        expect.objectContaining({ exitCode: EXIT.notReady, message: '生意参谋还没有 2026-10-13 的店铺数据（数据未就绪），请稍后再试。' }) as Error)
    }
    await expect(readSycm(sycmPage([on('document.body.innerText.includes', false)]), '2026-10-13', '名流官方旗舰店', ITEMS))
      .rejects.toThrow('生意参谋页面上没有店铺名「名流官方旗舰店」')
    const login = sycmPage()
    vi.spyOn(login, 'goto').mockImplementation((url) => { login.href = `https://login.taobao.com/?redirect=${url}`; return Promise.resolve() })
    await expect(readSycm(login, '2026-10-13', '店', ITEMS)).rejects.toThrow(expect.objectContaining({ exitCode: EXIT.signedOut }) as Error)
  })
})

describe('readAlimama', () => {
  it('reads the three scenes with one-day attribution, leaving other scenes out', async () => {
    const page = alimamaPage()
    expect(await readAlimama(page, '2026-10-13')).toEqual({
      platform: '万相台', date: '2026-10-13',
      metrics: { 关键词推广花费: 67351.25, 关键词推广成交: 77473.03, 人群推广花费: 39783.68, 人群推广成交: 53286.31, 货品全站推花费: 6056.87, 货品全站推成交: 13603 },
      missing: [], notes: ['转化统计周期：1 天累计；不含店铺直达等其他场景'],
    })
    const query = postedBody(page.evaluated.find(expression => expression.includes('report/query.json')) as string)
    expect(query).toMatchObject({ effectEqual: 1, startTime: '2026-10-13', endTime: '2026-10-13', queryFieldIn: ['charge', 'alipayInshopAmt'] })
  })

  it('reads a scene without a row that day as 0 with a note, and stops as not ready without any scene', async () => {
    const figures = await readAlimama(alimamaPage([SCENES[0], SCENES[1], { sceneId: 436 }]), '2026-10-13')
    expect(figures.metrics).toMatchObject({ 货品全站推花费: 0, 货品全站推成交: 0 })
    const paused = await readAlimama(alimamaPage([SCENES[0], SCENES[1]]), '2026-10-13')
    expect([paused.metrics.货品全站推花费, paused.missing, paused.notes[1]]).toEqual([0, [], '当天没有「货品全站推」（436）场景的数据，按 0 计'])
    await expect(readAlimama(alimamaPage([]), '2026-10-13')).rejects.toThrow(expect.objectContaining({ exitCode: EXIT.notReady }) as Error)
  })
})

/** The 总计 and media rows of 2026-10-13 (real figures). */
const SELLER: EffectRow[] = [
  { channelName: '抖音,腾讯,快手,B站', sellerNick: '总计', cost: 75318.96, validGmv: 91920.27, gmv: 102553.32, rfdRate: 0.0933 },
  { channelName: '抖音', sellerNick: '名流官方旗舰店', cost: 61139.21 },
  { channelName: '腾讯', sellerNick: '名流官方旗舰店', cost: 2289.06 },
  { channelName: '快手', sellerNick: '名流官方旗舰店', cost: 6928.885 },
  { channelName: 'B站', sellerNick: '名流官方旗舰店', cost: 4961.808 },
]

/** Account rows: two pages, the own accounts named with ML. */
const ACCOUNTS: EffectRow[][] = [
  [
    { accountName: '上海法马有性格网络科技有限公司-在达ad01', cost: 27748.53, validGmv: 36414.68, gmv: 40176.62 },
    { accountName: '名流-爆款003-ML-1', cost: 9804.14, validGmv: 14109.69, gmv: 15783.64 },
    { accountName: '名流-官旗粉MO-ML-2', cost: 5669.85, validGmv: 6050.38, gmv: 6713.91 },
  ],
  [{ accountName: '名流-官旗粉MO-ML-1', cost: 2595.07, validGmv: 3188.15, gmv: 3563.02 }, { accountName: '名流-官旗粉MO-ML-3' }, {}],
]

/** The data an effect query expression sends. */
function sent(expression: string): Record<string, unknown> {
  return (JSON.parse(/request\((\{.*\})\)\.then/su.exec(expression)?.[1] as string) as { data: Record<string, unknown> }).data
}

/** The 三方外投 page answering effect queries: `seller` for the 总计 query, `accounts` pages for the account query. */
function yuntaiPage(
  seller: unknown = { result: SELLER, totalCount: 4 }, accounts: EffectRow[][] = ACCOUNTS, routes: Route[] = [],
): FakePage {
  return new FakePage([
    ...routes,
    on('window.lib && window.lib.mtop', true),
    on('effect.query', (expression: string) => {
      const data = sent(expression)
      if (data.resultDim === 'SELLER') return seller
      return { result: accounts[(data.pageNo as number) - 1] ?? [], totalCount: accounts.flat().length }
    }),
  ])
}

describe('readYuntai', () => {
  it('reads the 总计 row and sums the accounts named with the keyword over every page', async () => {
    const page = yuntaiPage()
    expect(await readYuntai(page, '2026-10-13', '名流官方旗舰店', 'ML')).toEqual({
      platform: '健康品牌云台', date: '2026-10-13',
      metrics: {
        三方外投消耗: 75318.96, 三方外投有效GMV: 91920.27, 三方外投总GMV: 102553.32, 三方外投退款率: 0.0933,
        自投花费: 18069.06, 自投有效GMV: 23348.22, 自投总GMV: 26060.57,
      },
      missing: [],
      notes: [
        '店铺 名流官方旗舰店；统计日 2026-10-13（单日）',
        '媒体明细：抖音 消耗 61139.21；腾讯 消耗 2289.06；快手 消耗 6928.89；B站 消耗 4961.81；合计 75318.96，与总计一致',
        '自投账户（名称里有独立的「ML」，4 个有数据）：名流-爆款003-ML-1 消耗 9804.14；名流-官旗粉MO-ML-2 消耗 5669.85；名流-官旗粉MO-ML-1 消耗 2595.07；名流-官旗粉MO-ML-3 消耗 0',
      ],
    })
    const queries = page.evaluated.filter(expression => expression.includes('effect.query')).map(sent)
    expect(queries).toEqual([
      expect.objectContaining({ resultDim: 'SELLER', sumTag: true, startDate: '2026-10-13', endDate: '2026-10-13', api: 'v2' }),
      expect.objectContaining({ resultDim: 'ACCOUNT', pageNo: 1, sellerNames: '名流官方旗舰店' }),
      expect.objectContaining({ resultDim: 'ACCOUNT', pageNo: 2 }),
    ])
    expect(page.visited).toEqual(['https://yuntai.taobao.com/v2/third-party-invest'])
  })

  it('skips own accounts without a keyword, stops paging at an empty page, and notes media that do not add up', async () => {
    const page = yuntaiPage({ result: [{ sellerNick: '总计', cost: 100 }, { channelName: '抖音', sellerNick: '店', cost: 90 }, { sellerNick: '店' }], totalCount: 2 })
    const figures = await readYuntai(page, '2026-10-13', '店', '')
    expect(figures.metrics).toEqual({ 三方外投消耗: 100, 三方外投有效GMV: null, 三方外投总GMV: null, 三方外投退款率: null })
    expect(figures.missing).toEqual([
      { field: '三方外投有效GMV', reason: '云台 2026-10-13 的三方外投总计行没有有效GMV' },
      { field: '三方外投总GMV', reason: '云台 2026-10-13 的三方外投总计行没有总GMV' },
      { field: '三方外投退款率', reason: '云台 2026-10-13 的三方外投总计行没有退款率' },
    ])
    expect(figures.notes[1]).toBe('媒体明细：抖音 消耗 90；undefined 消耗 0；合计 90，与总计 100 不一致')
    const short = yuntaiPage(undefined, undefined, [on('"resultDim":"ACCOUNT"', (expression: string) =>
      ({ result: sent(expression).pageNo === 1 ? [{ accountName: 'ML', cost: 1 }] : [], totalCount: 5 }))])
    const own = await readYuntai(short, '2026-10-13', '名流官方旗舰店', 'ML')
    expect(own.metrics.自投花费).toBe(1)
  })

  it('stops as not ready without a 总计 row, and for rows of another store', async () => {
    for (const seller of [{ result: [], totalCount: 0 }, { result: [{ sellerNick: '总计' }], totalCount: 0 }]) {
      await expect(readYuntai(yuntaiPage(seller), '2026-10-13', '店', '')).rejects.toThrow(
        expect.objectContaining({ exitCode: EXIT.notReady, message: '云台还没有 2026-10-13 的三方外投数据（数据未就绪），请稍后再试。' }) as Error)
    }
    await expect(readYuntai(yuntaiPage(), '2026-10-13', '名流成人用品旗舰店', '')).rejects.toThrow(
      '云台三方外投里有别的店铺（名流官方旗舰店、名流官方旗舰店、名流官方旗舰店、名流官方旗舰店），不是只有「名流成人用品旗舰店」，没有取数。')
  })

  it('stops on the sign-in page, when the page has no mtop client, or when mtop refuses', async () => {
    const login = yuntaiPage()
    vi.spyOn(login, 'goto').mockImplementation(() => { login.href = 'https://mozi-login.alibaba-inc.com/ssoLogin.htm'; return Promise.resolve() })
    await expect(readYuntai(login, '2026-10-13', '店', '')).rejects.toThrow(expect.objectContaining({ exitCode: EXIT.signedOut }) as Error)
    await expect(readYuntai(yuntaiPage(undefined, undefined, [on('window.lib && window.lib.mtop', false)]), '2026-10-13', '店', '')).rejects.toThrow('没有 mtop 客户端')
    await expect(readYuntai(yuntaiPage({ ret: ['FAIL_SYS_SESSION_EXPIRED::Session过期'] }), '2026-10-13', '店', '')).rejects.toThrow(
      expect.objectContaining({ exitCode: EXIT.signedOut }) as Error)
    await expect(readYuntai(yuntaiPage({ ret: ['FAIL_BIZ_PARAM::参数错误', 'x'] }), '2026-10-13', '店', '')).rejects.toThrow('云台效果查询被拒绝：FAIL_BIZ_PARAM::参数错误；x')
  })

  it('counts an account as own only when the keyword is a segment of its name', () => {
    expect(['名流-官旗粉MO-ML-2', '名流-爆款003-ML-1', 'ML', '名流ML投放', 'XX-HTML5投放', 'MLX-1', 'a.ML'].map(name => ownAccount(name, 'ML')))
      .toEqual([true, true, true, true, false, false, true])
    expect([ownAccount('a+b-1', 'a+b'), ownAccount('aab-1', 'a+b')]).toEqual([true, false])
  })

  it('builds the effect query on the page mtop client, mapping a rejection to its ret', async () => {
    const source = effectQuery({ pageNo: 1 })
    expect(sent(source)).toEqual({ pageNo: 1, api: 'v2' })
    const run = (lib: object) => runInNewContext(source, { window: { lib } }) as Promise<unknown>
    const answer = { data: { result: { result: [{ cost: 1 }], totalCount: 1 } } }
    await expect(run({ mtop: { request: () => Promise.resolve(answer) } })).resolves.toEqual({ result: [{ cost: 1 }], totalCount: 1 })
    const empty = { data: { result: {} } }
    await expect(run({ mtop: { request: () => Promise.resolve(empty) } })).resolves.toEqual({ result: [], totalCount: 0 })
    const refused = Object.assign(new Error('refused'), { ret: ['FAIL'] })
    await expect(run({ mtop: { request: () => Promise.reject(refused) } })).resolves.toEqual({ ret: ['FAIL'] })
    await expect(run({ mtop: { request: () => Promise.reject(new Error('断网')) } })).resolves.toEqual({ ret: ['断网'] })
    const page = { evaluate: () => Promise.resolve({ result: [], totalCount: 0 }) } as unknown as Page
    expect(await queryEffect(page, {})).toEqual({ result: [], totalCount: 0 })
  })
})

/** Collect deps around one fake page for the account `a1`. */
function deps(page: FakePage, platform: string) {
  const out: string[] = []
  const err: string[] = []
  const collectDeps: CollectDeps = {
    takeOver: (id, wanted) => wanted === platform
      ? Promise.resolve({ id, store: '名流官方旗舰店', account: '名流官方旗舰店:诺诺', cdpUrl: 'http://127.0.0.1:9' })
      : Promise.reject(new Error(`wrong platform ${wanted}`)),
    reportSignedOut: () => Promise.resolve(),
    openPage: () => Promise.resolve(page),
    stdout: (text) => { out.push(text) },
    stderr: (text) => { err.push(text) },
  }
  return { collectDeps, out, err }
}

describe('scripts', () => {
  it('prints the Tmall figures as one JSON line, with a not-ready platform as nulls', async () => {
    const page = new FakePage([on('document.body.innerText.includes', true), on('overview/v3.json', overview()),
      on('keyword=610081277604', rank(['610081277604', 1])), on('report/query.json', { info: { ok: true }, data: { list: [] } })], sendsTemplate)
    const { collectDeps, out, err } = deps(page, 'tmall')
    expect(await main(['--account', 'a1', '--date', '2026-10-13', '--item', 'MO=610081277604'], collectDeps)).toBe(0)
    expect(err).toEqual([])
    const printed = JSON.parse(out.join('')) as { platform: string; data: { date: string; platforms: { platform: string; metrics: object }[] } }
    expect(printed.platform).toBe('tmall')
    expect(printed.data.date).toBe('2026-10-13')
    expect(printed.data.platforms.map(({ platform, metrics }) => [platform, metrics])).toEqual([
      ['生意参谋', { 全店支付金额: 326455.47, MO支付金额: 1 }],
      ['万相台', {
        关键词推广花费: null, 关键词推广成交: null, 人群推广花费: null, 人群推广成交: null, 货品全站推花费: null, 货品全站推成交: null,
      }],
    ])
    expect(await main(['--account', 'a1'], collectDeps)).toBe(EXIT.usage)
  })

  it('prints the Yuntai figures as one JSON line', async () => {
    const { collectDeps, out } = deps(yuntaiPage(), 'yuntai')
    expect(await yuntaiMain(['--account', 'a1', '--date', '2026-10-13', '--self-keyword', 'ML'], collectDeps)).toBe(0)
    const printed = JSON.parse(out.join('')) as { platform: string; data: { platforms: { metrics: Record<string, number> }[] } }
    expect([printed.platform, printed.data.platforms[0]?.metrics.自投花费]).toEqual(['yuntai', 18069.06])
    const plain = deps(yuntaiPage(), 'yuntai')
    expect(await yuntaiMain(['--account', 'a1', '--date', '2026-10-13'], plain.collectDeps)).toBe(0)
    const plainPrinted = JSON.parse(plain.out.join('')) as { data: { platforms: { metrics: object }[] } }
    expect(plainPrinted.data.platforms[0]?.metrics).not.toHaveProperty('自投花费')
  })
})
