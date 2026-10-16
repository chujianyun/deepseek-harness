import { describe, expect, it, vi } from 'vitest'
import type { CollectDeps } from '../src/collect.ts'
import { EXIT } from '../src/errors.ts'
import { CREATOR_URL, liveDataUrl, main, readLive } from '../src/pdd-live-figures.ts'
import { FakePage, on, type Route } from './support.ts'

/** Beijing midnight of a day, as the creator center stamps its points. */
const midnight = (date: string) => new Date(`${date}T00:00:00+08:00`).getTime()

/** The 2026-10-13 overview of 名流计生用品官方旗舰店 (real figures). */
const OVERVIEW = {
  statDate: '2026-10-13', livePlayDur: 18, liveViewCnt: 106590, liveAvgUsrViewDur: 0.3, livePayOrdrCnt: 494, livePayOrdrAmt: 12721.91, livePayUvCvr: 0.0061,
}

const ok = (result: unknown) => ({ success: true, errorCode: 1000000, errorMsg: null, result })
const line = (values: Record<string, string>) => ok({
  lineChartPointVOList: Object.entries(values).map(([date, v]) => ({ xvalue: midnight(date), ystringValue: v })),
})

/** Both live pages answering their APIs; `routes` come first. */
function livePage(routes: Route[] = []): FakePage {
  return new FakePage([
    ...routes,
    on('queryLiveOverViewReadyTime', ok('2026-10-13')),
    on('queryLiveOverView', ok(OVERVIEW)),
    on('anchor/info', ok({ name: '名流计生用品官方旗舰店' })),
    on('thousandPvGmv', line({ '2026-10-12': '109.22', '2026-10-13': '120.29' })),
    on('liveFansIncr', line({ '2026-10-12': '1262', '2026-10-13': '1078' })),
  ])
}

describe('readLive', () => {
  it('reads the day from the merchant backend and the creator center', async () => {
    const page = livePage()
    expect(await readLive(page, '2026-10-13', 0)).toEqual({
      platform: '拼多多直播', date: '2026-10-13',
      metrics: { 直播GMV: 12721.91, 直播支付订单: 494, 直播支付转化率: 0.0061, 人均观看时长: 0.3, 累计观看量: 106590, 千次进人成交: 120.29, 直播间涨粉数: 1078 },
      missing: [],
      notes: ['直播间 名流计生用品官方旗舰店；统计日 2026-10-13', '直播GMV 取商家后台「直播成交额」；人均观看时长单位为分钟；直播支付转化率为比值（0.0061 即 0.61%）'],
    })
    expect(page.visited).toEqual([liveDataUrl('2026-10-13'), CREATOR_URL])
    expect(page.evaluated.find(expression => expression.includes('queryLiveOverView"'))).toContain('\\"queryDate\\":\\"2026-10-13\\"')
    // The room's name is a GET.
    expect(page.evaluated.find(expression => expression.includes('anchor/info'))).not.toContain('POST')
  })

  it('leaves overview figures the API leaves out null with the reason, and an unnamed room unnamed', async () => {
    const page = livePage([on('queryLiveOverView"', ok({ statDate: '2026-10-13', livePayOrdrCnt: 494 })), on('anchor/info', ok(undefined))])
    const figures = await readLive(page, '2026-10-13', 0)
    expect(figures.metrics).toMatchObject({ 直播GMV: null, 直播支付订单: 494, 直播支付转化率: null, 人均观看时长: null, 累计观看量: null })
    expect(figures.missing[0]).toEqual({ field: '直播GMV', reason: '拼多多直播数据没有返回 2026-10-13 的直播GMV' })
    expect(figures.missing).toHaveLength(4)
    expect(figures.notes[0]).toBe('直播间 （未返回名称）；统计日 2026-10-13')
  })

  it('stops as not ready before the backend has the day or when the creator center lacks it', async () => {
    for (const [routes, why] of [
      [[on('queryLiveOverViewReadyTime', ok('2026-10-12'))], '拼多多直播数据只更新到 2026-10-12，还没有 2026-10-13 的数据'],
      [[on('queryLiveOverViewReadyTime', ok(undefined))], '只更新到 （未知）'],
      [[on('queryLiveOverViewReadyTime', ok(null))], '只更新到 （未知）'],
      [[on('queryLiveOverViewReadyTime', ok(1791820800000))], '只更新到 （未知）'],
      [[on('thousandPvGmv', line({ '2026-10-12': '1' }))], '多多直播数据中心还没有 2026-10-13 的「thousandPvGmv」数据'],
      [[on('liveFansIncr', line({ '2026-10-13': '-' }))], '「liveFansIncr」数据'],
      [[on('liveFansIncr', ok({}))], '「liveFansIncr」数据'],
    ] as const) {
      const stopped = expect.objectContaining({ exitCode: EXIT.notReady, message: expect.stringContaining(why) as string }) as Error
      await expect(readLive(livePage([...routes]), '2026-10-13', 0)).rejects.toThrow(stopped)
    }
  })

  it('stops on another day, a refusal, the sign-in page, or a signed-out API', async () => {
    const otherDay = livePage([on('queryLiveOverView"', ok({ statDate: '2026-10-12' }))])
    await expect(readLive(otherDay, '2026-10-13', 0)).rejects.toThrow('返回的日期是 2026-10-12，不是 2026-10-13')
    await expect(readLive(livePage([on('queryLiveOverView"', ok(undefined))]), '2026-10-13', 0)).rejects.toThrow('返回的日期是 undefined')
    const limited = livePage([on('queryLiveOverView"', { success: false, errorMsg: '限流' })])
    await expect(readLive(limited, '2026-10-13', 0)).rejects.toThrow('拼多多直播数据接口拒绝了查询：限流')
    await expect(readLive(livePage([on('queryLiveOverView"', { success: false, errorCode: 54001 })]), '2026-10-13', 0)).rejects.toThrow('拒绝了查询：54001')
    await expect(readLive(livePage([on('anchor/info', { error_code: 50000 })]), '2026-10-13', 0)).rejects.toThrow('拒绝了查询：50000')
    await expect(readLive(livePage([on('anchor/info', {})]), '2026-10-13', 0)).rejects.toThrow('拒绝了查询：没有说明原因')
    for (const refusal of [{ error_code: 40001 }, { errorCode: 40001 }]) {
      const out = expect.objectContaining({ exitCode: EXIT.signedOut }) as Error
      await expect(readLive(livePage([on('anchor/info', refusal)]), '2026-10-13', 0)).rejects.toThrow(out)
    }
    const creator = livePage()
    vi.spyOn(creator, 'goto').mockImplementation((url) => {
      creator.href = url === CREATOR_URL ? 'https://live.pinduoduo.com/login?redirect=x' : url
      return Promise.resolve()
    })
    await expect(readLive(creator, '2026-10-13', 0, 0)).rejects.toThrow('多多直播需要重新登录')
    // Without its own session the creator center signs in through the backend first, and lands after a few hops.
    const hopping = livePage()
    vi.spyOn(hopping, 'goto').mockImplementation((url) => {
      hopping.href = url === CREATOR_URL ? 'https://live.pinduoduo.com/login/checker?from=mms' : url
      if (url === CREATOR_URL) {
        setTimeout(() => { hopping.href = 'https://mms.pinduoduo.com/login/sso?platform=live&accessType=auto' }, 100)
        setTimeout(() => { hopping.href = CREATOR_URL }, 700)
      }
      return Promise.resolve()
    })
    expect(await readLive(hopping, '2026-10-13', 0, 5000)).toMatchObject({ metrics: { 千次进人成交: 120.29 } })
    const login = livePage()
    vi.spyOn(login, 'goto').mockImplementation(() => { login.href = 'https://mms.pinduoduo.com/login/?redirectUrl=x'; return Promise.resolve() })
    await expect(readLive(login, '2026-10-13', 0)).rejects.toThrow(expect.objectContaining({ exitCode: EXIT.signedOut }) as Error)
  })
})

describe('pdd-live-figures.mjs', () => {
  it('takes a Pinduoduo merchant account and a date, and stops as not ready without printing', async () => {
    const out: string[] = []
    const err: string[] = []
    const page = livePage([on('queryLiveOverViewReadyTime', ok('2026-10-12'))])
    const deps: CollectDeps = {
      takeOver: (id, platform) => Promise.resolve({ id, store: platform, account: '名流计生用品Frank', cdpUrl: 'http://127.0.0.1:9' }),
      reportSignedOut: () => Promise.resolve(),
      openPage: () => Promise.resolve(page),
      stdout: (text) => { out.push(text) },
      stderr: (text) => { err.push(text) },
    }
    expect(await main(['--account', 'p1', '--date', '2026-10-13'], deps)).toBe(EXIT.notReady)
    expect([out, err.join('')]).toEqual([[], expect.stringContaining('还没有 2026-10-13 的数据')])
    expect(await main(['--account', 'p1'], deps)).toBe(EXIT.usage)
  })
})
