import { describe, expect, it } from 'vitest'
import { EXIT, SkillError } from '../src/errors.ts'
import {
  descImages, impressionTags, itemIdOf, itemUrl, mtop, openItem, parseItem, readQuestions, readReviews, reviewRow, RiskStop,
  type Collected, type Pace,
} from '../src/item.ts'
import { FakePage } from './support.ts'
import { DESC_BODY, itemPage, mtopAnswer, mtopData, questionPage, rawReview, RENDERED_ITEM, TAGS } from './item-fixtures.ts'

const sleeps: number[] = []
const PACE: Pace = { sleep: (ms) => { sleeps.push(ms); return Promise.resolve() }, random: () => 0.5 }
const fresh = (): Collected => ({ questions: [], reviews: [], tags: [], calls: 0 })

async function stopped(work: Promise<unknown>): Promise<SkillError> {
  try {
    await work
  } catch (error) {
    expect(error).toBeInstanceOf(SkillError)
    return error as SkillError
  }
  throw new Error('expected a SkillError')
}

describe('item ids and pages', () => {
  it('reads the id from a link or a bare id', async () => {
    expect(itemIdOf('https://detail.tmall.com/item.htm?spm=a&id=794818635459&skuId=1')).toBe('794818635459')
    expect(itemIdOf(' 524565741530 ')).toBe('524565741530')
    expect((await stopped(Promise.resolve().then(() => itemIdOf('12345')))).exitCode).toBe(EXIT.usage)
    expect(itemUrl('1')).toBe('https://item.taobao.com/item.htm?id=1')
  })

  it('reads the item, its SKUs with option images, and leaves placeholder options out of names', () => {
    expect(parseItem(RENDERED_ITEM)).toEqual({
      title: '名流 超薄避孕套', shop: '名流旗舰店', shopId: '123', sellCount: '1万+', priceTitle: '券后', price: '39.9', priceDesc: '起', riskDegraded: false,
      mainImages: ['https://img.alicdn.com/a.jpg', 'https://img.alicdn.com/b.png'], video: 'https://cloud.video/v.mp4',
      skus: [
        { skuId: 's10', sku: '【10只】超薄', priceTitle: '价格', price: '29.9', promoTitle: '券后', promoPrice: '19.9', stock: '200', stockText: '有货', image: '//img.alicdn.com/s10.jpg' },
        { skuId: 's20', sku: '共20只', priceTitle: '', price: '49.9', promoTitle: '', promoPrice: '', stock: '0', stockText: '无货', image: '' },
        { skuId: 'sx', sku: '其它规格', priceTitle: '', price: '', promoTitle: '', promoPrice: '', stock: '', stockText: '', image: '' },
      ],
    })
  })

  it('reads a single-SKU item, a degraded answer, and missing fields', () => {
    const single = parseItem({ feature: { pcIdentityRisk: 'true' }, componentsVO: { priceVO: { price: { priceText: '9.9' } } }, skuCore: { sku2info: { 0: { price: { priceText: '9.9' } } } } })
    expect(single).toMatchObject({ title: '', shop: '', shopId: '', price: '9.9', riskDegraded: true, mainImages: [], video: '' })
    expect(single.skus).toEqual([{ skuId: '', sku: '', priceTitle: '', price: '9.9', promoTitle: '', promoPrice: '', stock: '', stockText: '', image: '' }])
    expect(parseItem({ skuBase: { props: [{ pid: 1, name: 'x' }], skus: [{ skuId: 'a', propPath: '9:9' }] } }).skus[0]?.sku).toBe('9:9')
    expect(parseItem({}).price).toBe('')
  })

  it('reads the description images in layout order from JSON or JSONP', () => {
    expect(descImages(DESC_BODY)).toEqual(['https://img.alicdn.com/d1.jpg', 'https://img.alicdn.com/d2.jpg'])
    expect(descImages('{"data":{}}')).toEqual([])
    expect(descImages('{}')).toEqual([])
  })
})

describe('mtop calls', () => {
  const page = (answers: object[]): FakePage => new FakePage([() => answers.shift()])

  it('paces each call and returns the data', async () => {
    sleeps.length = 0
    expect(await mtop(page([{ ret: 'SUCCESS::ok', data: { a: 1 }, punish: false }]), PACE, '评价', 'api.x', '1.0', { b: 2 })).toEqual({ a: 1 })
    expect(sleeps).toEqual([5250])
  })

  it('retries a transient failure once, then gives up', async () => {
    expect(await mtop(page([{ ret: 'ABORT::接口异常', data: null, punish: false }, { ret: 'SUCCESS', data: 1, punish: false }]), PACE, 'x', 'a', '1', {})).toBe(1)
    await expect(mtop(page([{ ret: 'ABORT', data: null, punish: false }, { ret: 'FAIL_BIZ', data: null, punish: false }]), PACE, 'x', 'a', '1', {})).rejects.toThrow('a 返回 FAIL_BIZ')
  })

  it('stops at once on risk control, without retrying', async () => {
    for (const answer of [{ ret: 'FAIL_SYS_USER_VALIDATE', data: null, punish: false }, { ret: 'RGV587_ERROR', data: null, punish: false },
      { ret: 'TIMEOUT', data: null, punish: false }, { ret: 'SUCCESS', data: {}, punish: true }]) {
      const fake = page([answer, { ret: 'SUCCESS', data: {}, punish: false }])
      const stop = await stopped(mtop(fake, PACE, '问大家', 'a', '1', {}))
      expect(stop).toBeInstanceOf(RiskStop)
      expect(stop.exitCode).toBe(EXIT.stopped)
      expect(stop.message).toContain('读取问大家时平台出现风控')
      expect(fake.evaluated).toHaveLength(1)
    }
  })

  it('sends the API, its version, and its data through the page own signer', async () => {
    const fake = page([{ ret: 'SUCCESS', data: {}, punish: false }])
    await mtop(fake, PACE, 'x', 'mtop.a', '6.0', { auctionNumId: '1' })
    expect(fake.evaluated[0]).toContain('window.lib.mtop.request({ api: "mtop.a", v: "6.0"')
    expect(mtopData(fake.evaluated[0] as string)).toEqual({ auctionNumId: '1' })
  })
})

describe('问大家', () => {
  it('pages 20 at a time up to the limit, with each question top answers', async () => {
    const into = fresh()
    const fake = itemPage([mtopAnswer('mtop.taobao.wdj.list.merge.search', expression => questionPage((Number(mtopData(expression).page) - 1) * 20 + 1, 20, true))])
    await readQuestions(fake, PACE, '9', 25, into)
    expect(into.questions).toHaveLength(25)
    expect(into.calls).toBe(2)
    expect(into.questions[0]).toEqual({ questionId: '1', question: '会不会破？', date: '2026-09-01 10:00:00', answerCount: 12, answers: ['不会破（a**1·已购）', '还行（）', '（b**2）'] })
    expect(mtopData(fake.evaluated.at(-1) as string)).toMatchObject({ itemId: '9', pageSize: 20, page: 2, type: 'mix_group' })
  })

  it('stops at the last page or an empty one', async () => {
    const last = fresh()
    await readQuestions(itemPage([mtopAnswer('mtop.taobao.wdj.list.merge.search', questionPage(1, 3, false))]), PACE, '9', 100, last)
    expect([last.questions.length, last.calls]).toEqual([3, 1])
    const empty = fresh()
    await readQuestions(itemPage([mtopAnswer('mtop.taobao.wdj.list.merge.search', { hasNext: true })]), PACE, '9', 100, empty)
    expect([empty.questions.length, empty.calls]).toEqual([0, 1])
    const bare = fresh()
    await readQuestions(itemPage([mtopAnswer('mtop.taobao.wdj.list.merge.search', { hasNext: false, questionList: [{}] })]), PACE, '9', 100, bare)
    expect(bare.questions).toEqual([{ questionId: '', question: '', date: '', answerCount: 0, answers: [] }])
  })
})

describe('reviews', () => {
  it('reads a review row with media, follow-up, and the merchant reply', () => {
    expect(reviewRow(rawReview(7, { appendedFeed: { appendedFeedback: '用了一个月破了', intervalDay: 30, reply: '抱歉' } }) as never, 'all')).toEqual({
      source: 'all', rateType: '好评', date: '2026年9月3日', user: 'u**1', sku: '规格:【10只】超薄', content: '很薄很润滑，回购了 7', append: '用了一个月破了', appendDays: '30',
      reply: '抱歉', media: 'https://img/r.jpg;https://img/p.jpg', repurchase: '回购2次', id: '7',
    })
    expect(reviewRow({ rateType: 5, reply: '谢谢' }, 'append')).toMatchObject({ rateType: '5', reply: '谢谢', id: '', appendDays: '' })
    expect(reviewRow({}, 'all')).toMatchObject({ rateType: '', sku: '', media: '' })
  })

  it('marks negative impression tags', () => {
    expect(impressionTags(TAGS)).toEqual([
      { tag: '很薄', count: '30', labelId: '1-11', negative: false },
      { tag: '容易破', count: '', labelId: '2-13', negative: true },
    ])
    expect(impressionTags([{ extraInfo: { labelType: 'impr', gray: true } }])).toEqual([{ tag: '', count: '', labelId: '', negative: true }])
  })

  it('reads the main list, every negative tag, and follow-ups, each labelled and de-duplicated', async () => {
    const into = fresh()
    const fake = itemPage([mtopAnswer('mtop.taobao.rate.detaillist.get', (expression) => {
      const data = mtopData(expression)
      if (data.expression === '2-13') return { hasNext: 'false', rateList: [rawReview(90, { rateType: -1, feedback: '容易破' })] }
      if (data.rateType === '2') return { hasNext: 'false', rateList: [rawReview(80, { appendedFeed: { appendedFeedback: '后来破了' } })] }
      const pageNo = Number(data.pageNo)
      return { hasNext: 'true', imprNewItemVOS: pageNo === 1 ? TAGS : [], rateList: [rawReview(pageNo * 10), rawReview(pageNo * 10), rawReview(pageNo * 10 + 1)] }
    })])
    await readReviews(fake, PACE, '9', { questions: 0, reviews: 3, appends: 5, perTag: 5 }, into)
    expect(into.reviews.map(review => `${review.source}:${review.id}`)).toEqual(['all:10', 'all:11', 'all:20', 'tag:容易破:90', 'append:80'])
    expect(into.tags.map(tag => tag.tag)).toEqual(['很薄', '容易破'])
    expect(into.calls).toBe(4)
    expect(mtopData(fake.evaluated.find(expression => expression.includes('detaillist')) as string)).toMatchObject({ auctionNumId: '9', pageSize: 50, searchImpr: '-8', rateSrc: 'pc_rate_list' })
  })

  it('reads the first page for its tags even with no main reviews wanted, and skips follow-ups when asked', async () => {
    const into = fresh()
    await readReviews(itemPage([mtopAnswer('mtop.taobao.rate.detaillist.get', { hasNext: false, rateList: [rawReview(1)] })]), PACE, '9', { questions: 0, reviews: 0, appends: 0, perTag: 5 }, into)
    expect([into.reviews.length, into.calls, into.tags]).toEqual([1, 1, []])
    const empty = fresh()
    await readReviews(itemPage([mtopAnswer('mtop.taobao.rate.detaillist.get', { hasNext: true })]), PACE, '9', { questions: 0, reviews: 5, appends: 0, perTag: 5 }, empty)
    expect([empty.reviews.length, empty.calls]).toEqual([0, 1])
  })

  it('keeps what was read when risk control stops it', async () => {
    const into = fresh()
    let calls = 0
    const fake = itemPage([expression => expression.includes('detaillist')
      ? ++calls === 1 ? { ret: 'SUCCESS', data: { hasNext: 'true', rateList: [rawReview(1)] }, punish: false } : { ret: 'RGV587_ERROR', data: null, punish: false }
      : undefined])
    await expect(readReviews(fake, PACE, '9', { questions: 0, reviews: 100, appends: 0, perTag: 5 }, into)).rejects.toBeInstanceOf(RiskStop)
    expect(into.reviews).toHaveLength(1)
  })
})

describe('opening the item page', () => {
  it('reads what the page rendered and the description it fetched for itself', async () => {
    const fake = itemPage([])
    expect(await openItem(fake, '794818635459')).toEqual({ item: parseItem(RENDERED_ITEM), descImages: ['https://img.alicdn.com/d1.jpg', 'https://img.alicdn.com/d2.jpg'] })
    expect(fake.visited).toEqual(['https://item.taobao.com/item.htm?id=794818635459'])
  })

  it('goes on without description images when the page fetched none', async () => {
    expect((await openItem(itemPage([], RENDERED_ITEM, null), '1')).descImages).toEqual([])
  })

  it('stops when DSH refuses the page, on risk control, and on sign-in pages', async () => {
    const refused = new FakePage([])
    refused.goto = () => Promise.reject(new SkillError('打不开 https://item.taobao.com/item.htm?id=1：net::ERR_BLOCKED_BY_CLIENT'))
    const blocked = await stopped(openItem(refused, '1'))
    expect([blocked.exitCode, blocked.message]).toEqual([EXIT.stopped, expect.stringContaining('今天的页数已用完，或刚出现风控正在冷却')])
    const offline = new FakePage([])
    offline.goto = () => Promise.reject(new SkillError('打不开：net::ERR_INTERNET_DISCONNECTED'))
    expect((await stopped(openItem(offline, '1'))).exitCode).toBe(EXIT.failed)
    const broken = new FakePage([])
    broken.goto = () => Promise.reject(new Error('socket closed'))
    await expect(openItem(broken, '1')).rejects.toThrow('socket closed')

    const toLogin = new FakePage([], (_url, page) => { page.href = 'https://login.taobao.com/member/login.jhtml' })
    expect((await stopped(openItem(toLogin, '1'))).exitCode).toBe(EXIT.signedOut)
    const punished = new FakePage([], (_url, page) => { page.href = 'https://item.taobao.com/_____tmd_____/punish?x5' })
    expect(await stopped(openItem(punished, '1'))).toBeInstanceOf(RiskStop)
    const slider = new FakePage([expression => expression.includes('#nocaptcha') ? true : undefined])
    expect(await stopped(openItem(slider, '1'))).toBeInstanceOf(RiskStop)
  })

  it('skips a page that is not a standard item page, and reads an item without SKU data as signed out', async () => {
    const none = await stopped(openItem(itemPage([], null), '1'))
    expect([none.exitCode, none.message]).toEqual([EXIT.failed, expect.stringContaining('没有标准详情页')])
    expect((await stopped(openItem(itemPage([], { item: {} }), '1'))).exitCode).toBe(EXIT.signedOut)
  })
})
