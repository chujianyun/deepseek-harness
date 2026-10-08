import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EXIT, SkillError } from '../src/errors.ts'
import { factsReport, isNegative, itemFacts } from '../src/item-facts.ts'
import { main, parseItemOptions, realItemDeps, type ItemDeps } from '../src/item-report.ts'
import { parseItem, reviewRow, type Question, type Review, type Sku } from '../src/item.ts'
import type { BuyerBrowser } from '../src/account.ts'
import { itemPage, mtopAnswer, mtopData, questionPage, rawReview, RENDERED_ITEM, TAGS } from './item-fixtures.ts'
import { FakePage, tempDir } from './support.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function outDir(): Promise<string> {
  const { dir, cleanup } = await tempDir()
  cleanups.push(cleanup)
  return dir
}

const review = (fields: Partial<Review>): Review => ({ ...reviewRow({}, 'all'), ...fields })

describe('negative reviews', () => {
  it('counts 中差评, tag samples, and un-negated negative words', () => {
    expect(isNegative(review({ rateType: '差评' }))).toBe(true)
    expect(isNegative(review({ rateType: '中评' }))).toBe(true)
    expect(isNegative(review({ source: 'tag:容易破' }))).toBe(true)
    expect(isNegative(review({ content: '用到一半破了，很失望' }))).toBe(true)
    expect(isNegative(review({ content: '很好', append: '后来过敏了' }))).toBe(true)
  })

  it('reads negated negative words and neutral phrases as praise', () => {
    for (const content of ['一点都不干涩', '无橡胶异味', '没让我失望', '不知道好不好用，还没用', '物美价廉', '不容易破损']) {
      expect(isNegative(review({ content }))).toBe(false)
    }
  })
})

describe('facts', () => {
  const questions: Question[] = [
    { questionId: '1', question: '会不会破？', date: '2026-09-01 10:00', answerCount: 12, answers: ['不会（a）'] },
    { questionId: '2', question: '尺寸大小合适吗', date: '2026-08-01', answerCount: 3, answers: [] },
  ]
  const reviews: Review[] = [
    review({ id: '1', rateType: '好评', date: '2026年9月3日', sku: '规格:【10只】超薄', content: '很薄很润滑，回购了好几次' }),
    review({ id: '2', rateType: '好评', date: '2026年8月1日', sku: '共20只', content: '物流很快，包装隐私' }),
    review({ id: '3', rateType: '差评', date: '2026年9月9日', sku: '已下架款', content: '用了一次就破了，质量太差' }),
    review({ id: '4', rateType: '好评', date: '', sku: '', content: '好' }),
    review({ id: '9', source: 'tag:容易破', rateType: '好评', content: '有点容易破，客服态度也一般' }),
    review({ id: '8', source: 'append', append: '用了半个月后来破了，很失望', appendDays: '30', sku: '共20只' }),
    review({ id: '7', source: 'append', append: '还在用，很好', appendDays: '5' }),
    review({ id: '6', source: 'append', append: '后来发现有异味，不推荐', appendDays: '12' }),
    review({ id: '5', rateType: '中评', date: '2026年9月1日', content: '快递太慢了，等了一个星期' }),
  ]
  const facts = itemFacts({
    itemId: '9', url: 'https://item.taobao.com/item.htm?id=9', item: parseItem(RENDERED_ITEM), descImages: ['d1', 'd2'], savedImages: 5,
    tags: [{ tag: '容易破', count: '', labelId: '2-13', negative: true }], reviews, questions,
  })

  it('computes the SKU price ladder per piece', () => {
    expect(facts.skus).toEqual([
      { sku: '【10只】超薄', pieces: 10, listPrice: 29.9, payPrice: 19.9, unitPrice: 1.99, stockText: '有货' },
      { sku: '共20只', pieces: 20, listPrice: 49.9, payPrice: 49.9, unitPrice: 2.5, stockText: '无货' },
      { sku: '其它规格', pieces: null, listPrice: null, payPrice: null, unitPrice: null, stockText: '' },
    ])
    expect(facts.images).toEqual({ main: 2, desc: 2, skuWithImage: 1, saved: 5 })
    expect(facts.item).toMatchObject({ itemId: '9', title: '名流 超薄避孕套', shop: '名流旗舰店' })
  })

  it('counts purchased SKUs from the main list only', () => {
    expect(facts.skuSales).toEqual({
      sample: 5, unidentified: 2,
      rows: [{ sku: '【10只】超薄', count: 1, share: 0.2 }, { sku: '共20只', count: 1, share: 0.2 }, { sku: '[已下架/改名] 已下架款', count: 1, share: 0.2 }],
    })
  })

  it('separates review pools and classifies negatives', () => {
    expect(facts.reviews).toMatchObject({
      sampleMain: 5, rateType: { 好评: 3, 差评: 1, 中评: 1 }, byMonth: { '2026-08': 1, '2026-09': 3 }, negativePool: 5,
      negativeCategories: { 产品质量: 4, 物流包装: 1 }, positiveSample: 2, tagRows: 1,
      appends: { sample: 3, negative: 2, medianDays: 12 },
    })
    expect(facts.reviews.negativeExamples['产品质量']?.map(item => item.source)).toEqual(['tag:容易破', 'append', 'all', 'append'])
    expect(facts.reviews.positiveThemes.slice(0, 2).map(theme => [theme.theme, theme.count])).toEqual([['薄/无感', 1], ['润滑/水润', 1]])
  })

  it('counts 问大家 concerns separately from reviews', () => {
    expect(facts.questions.sample).toBe(2)
    expect(facts.questions.topics.slice(0, 2).map(topic => [topic.topic, topic.count])).toEqual([['会不会破', 1], ['尺寸/松紧', 1]])
    expect(facts.questions.mostAnswered[0]).toEqual({ question: '会不会破？', answerCount: 12, date: '2026-09-01', topAnswer: '不会（a）' })
  })

  it('writes a report of counts with their samples and verbatim quotes', () => {
    const report = factsReport(facts, ['⚠️ 采集中途停止'])
    expect(report).toContain('# 单品报告 · 名流 超薄避孕套')
    expect(report).toContain('⚠️ 采集中途停止')
    expect(report).toContain('| 【10只】超薄 | 10 | 29.9 | 19.9 | 1.99 | 有货 |')
    expect(report).toContain('## 评价（主列表样本 5 条，按平台默认排序翻页采样，非全量）')
    expect(report).toContain('「用了一次就破了，质量太差」')
    expect(report).toContain('- **会不会破** 1 题（50.0%，回答合计 12）')
    expect(report).toContain('- 「用了半个月后来破了，很失望」')
  })

  it('reads pieces in every SKU-name form, unlabelled rate types, and uncategorized negatives', () => {
    const base = parseItem(RENDERED_ITEM)
    const facts = itemFacts({
      itemId: '1', url: 'u', descImages: [], savedImages: 0, tags: [], questions: [],
      item: { ...base, skus: [{ ...base.skus[0] as Sku, sku: '超薄款 12只】' }] },
      reviews: [review({ id: '1', content: '还可以吧' }), review({ id: '2', rateType: '差评', content: '无语至极的东西啊' })],
    })
    expect(facts.skus[0]?.pieces).toBe(12)
    const ranked = itemFacts({
      itemId: '1', url: 'u', descImages: [], savedImages: 0, tags: [], item: base,
      reviews: [review({ id: '1', rateType: '好评', content: '很薄' + '很'.repeat(10) }), review({ id: '2', rateType: '好评', content: '很薄很好用的呀' })],
      questions: [{ questionId: '1', question: '会破吗', date: '', answerCount: 1, answers: [] }, { questionId: '2', question: '容易破吗', date: '', answerCount: 5, answers: [] }],
    })
    expect(ranked.reviews.positiveThemes[0]?.examples).toEqual(['很薄' + '很'.repeat(10), '很薄很好用的呀'])
    expect(ranked.questions.topics[0]?.top.map(question => question.question)).toEqual(['容易破吗', '会破吗'])
    expect(facts.reviews.negativeCategories).toEqual({ 其他: 1 })
    expect(factsReport(facts, [])).toContain('好中差：未标 1，差评 1。')
  })

  it('counts a review once in the negative pool, and matches multi-option SKUs to the longest name', () => {
    const item = { ...parseItem(RENDERED_ITEM), skus: [
      { ...parseItem(RENDERED_ITEM).skus[0] as Sku, sku: '红色 / L' },
      { ...parseItem(RENDERED_ITEM).skus[0] as Sku, sku: '【10只】' },
      { ...parseItem(RENDERED_ITEM).skus[0] as Sku, sku: '【10只】超薄' },
    ] }
    const facts = itemFacts({
      itemId: '1', url: 'u', item, descImages: [], savedImages: 0, tags: [], questions: [],
      reviews: [
        review({ id: '1', rateType: '差评', sku: '颜色分类:红色；尺码:L', content: '质量很差，用了就破了' }),
        review({ id: '1', source: 'tag:容易破', rateType: '差评', content: '质量很差，用了就破了' }),
        review({ id: '2', rateType: '好评', sku: '规格:【10只】超薄 加送2只', content: '好' }),
      ],
    })
    expect(facts.reviews.negativePool).toBe(1)
    expect(facts.skuSales.rows.map(row => row.sku)).toEqual(['红色 / L', '【10只】超薄'])
  })

  it('reports an empty item without dividing by zero', () => {
    const empty = itemFacts({ itemId: '1', url: 'u', item: { ...parseItem({ feature: { pcIdentityRisk: 'true' } }), priceDesc: '', sellCount: '' }, descImages: [], savedImages: 0, tags: [], reviews: [], questions: [] })
    expect(empty.reviews.appends.medianDays).toBeNull()
    const report = factsReport(empty, [])
    expect(report).toContain('没有中差评。')
    expect(report).toContain('没有读到问大家。')
    expect(report).toContain('没有可识别的已购 SKU。')
    expect(report).toContain('平台对这次访问降级')
    expect(report).toContain('销量 未显示')
  })
})

describe('the command line', () => {
  it('reads items and limits', () => {
    expect(parseItemOptions(['https://detail.tmall.com/item.htm?id=794818635459', '794818635459', '524565741530', '--reviews', '50', '--out', 'r'])).toEqual({
      items: ['794818635459', '524565741530'], limits: { questions: 100, reviews: 50, appends: 100, perTag: 100 }, out: 'r',
    })
  })

  it('refuses a missing item, an unknown option, and a bad number', () => {
    expect(() => parseItemOptions([])).toThrow('缺少商品链接或 id')
    expect(() => parseItemOptions(['794818635459', '--bogus'])).toThrow('用法')
    expect(() => parseItemOptions(['794818635459', '--reviews', 'many'])).toThrow('--reviews 要非负整数')
  })

  it('uses the real outside world by default', async () => {
    expect(realItemDeps.fetchFile).toBe(fetch)
    realItemDeps.stdout('')
    realItemDeps.stderr('')
    await realItemDeps.pace.sleep(0)
    expect(realItemDeps.pace.random()).toBeLessThan(1)
    await expect(realItemDeps.openPage('http://127.0.0.1:9')).rejects.toThrow()
    const path = process.env.PATH
    process.env.PATH = '/nowhere'
    try {
      await expect(realItemDeps.takeOver()).rejects.toThrow('找不到 dsh-ecommerce 命令')
      expect(await realItemDeps.reportRisk('b1')).toContain('未能通知 DSH 让这个买家号冷却')
    } finally {
      process.env.PATH = path
    }
  })
})

describe('running the script', () => {
  const BUYER: BuyerBrowser = { id: 'b1', platform: 'taobao', account: 'tb797483650', cdpUrl: 'http://127.0.0.1:9', pagesLeft: 18 }
  const reviewsRoute = mtopAnswer('mtop.taobao.rate.detaillist.get', expression => mtopData(expression).expression === '2-13'
    ? { hasNext: false, rateList: [rawReview(90, { rateType: -1, feedback: '容易破' })] }
    : { hasNext: false, imprNewItemVOS: TAGS, rateList: [rawReview(1), rawReview(2, { rateType: 0, feedback: '一般般' })] })
  const questionsRoute = mtopAnswer('mtop.taobao.wdj.list.merge.search', questionPage(1, 2, false))

  function deps(page: FakePage, overrides: Partial<ItemDeps> = {}): ItemDeps & { out: string[]; err: string[] } {
    const out: string[] = []
    const err: string[] = []
    return {
      takeOver: () => Promise.resolve(BUYER), openPage: () => Promise.resolve(page),
      reportRisk: id => Promise.resolve(`DSH 已让买家号 ${id} 冷却到 2026-10-11T03:00:00.000Z，期间不会再被挑选。`),
      fetchFile: url => Promise.resolve((url as string).includes('b.png') ? new Response('', { status: 404 }) : new Response(new Uint8Array([1, 2, 3]))),
      pace: { sleep: () => Promise.resolve(), random: () => 0 }, stdout: (text) => { out.push(text) }, stderr: (text) => { err.push(text) },
      out, err, ...overrides,
    }
  }

  it('reads an item and writes its files and report', async () => {
    const dir = await outDir()
    const page = itemPage([questionsRoute, reviewsRoute])
    const run = deps(page)
    expect(await main(['794818635459', '--out', dir, '--appends', '0'], run)).toBe(0)
    expect(page.closed).toBe(true)
    const item = join(dir, '单品_794818635459')
    expect((await readdir(item)).sort()).toEqual(['facts.json', 'images', 'item.json', 'questions.csv', 'reviews.csv', 'reviews_negative.csv', 'skus.csv', '报告.md'])
    expect((await readdir(join(item, 'images'))).sort()).toEqual(['desc_01.jpg', 'desc_02.jpg', 'main_01.jpg', 'sku_01_【10只】超薄.jpg'])
    expect(await readFile(join(item, 'images', 'main_01.jpg'))).toEqual(Buffer.from([1, 2, 3]))
    expect((await readFile(join(item, 'reviews_negative.csv'), 'utf8')).split('\r\n').filter(line => line !== '')).toHaveLength(3)
    expect((await readFile(join(item, 'skus.csv'), 'utf8')).split('\r\n')[1]).toBe('s10,【10只】超薄,价格,29.9,券后,19.9,200,有货,//img.alicdn.com/s10.jpg')
    expect(JSON.parse(await readFile(join(item, 'facts.json'), 'utf8'))).toMatchObject({ reviews: { sampleMain: 2, tagRows: 1 }, questions: { sample: 2 } })
    const summary = run.out.join('')
    expect(summary).toContain('# 单品采集 · 买家号 tb797483650（DSH 自动挑选，今天开始时剩 18 页）')
    expect(summary).toContain('- 794818635459 名流 超薄避孕套：主图 2、详情图 2（保存图片 4 张），SKU 3，问大家 2，评价 3（主列表 2，负面标签 1，追评 0；中差评视图 2），接口调用 3 次。')
    expect(run.err).toEqual([])
  })

  it('stops before an item when the buyer account has no pages left, keeping the items read', async () => {
    const dir = await outDir()
    const run = deps(itemPage([questionsRoute, reviewsRoute]), { takeOver: () => Promise.resolve({ ...BUYER, pagesLeft: 1 }) })
    expect(await main(['794818635459', '524565741530', '600000000001', '--out', dir], run)).toBe(EXIT.stopped)
    expect(await readdir(dir)).toEqual(['单品_794818635459'])
    expect(run.err.join('')).toContain('买家号 tb797483650 今天只剩 1 个页面，每个商品要打开 1 个页面，商品 524565741530、600000000001 没有采集，已提前停止。')
  })

  it('stops at risk control, saves what was read, and names the items not read', async () => {
    const dir = await outDir()
    let reviewCalls = 0
    const page = itemPage([questionsRoute, expression => expression.includes('detaillist')
      ? ++reviewCalls === 1 ? { ret: 'SUCCESS', data: { hasNext: 'true', rateList: [rawReview(1)] }, punish: false } : { ret: 'FAIL_SYS_USER_VALIDATE', data: null, punish: true }
      : undefined])
    const run = deps(page)
    expect(await main(['794818635459', '524565741530', '--out', dir], run)).toBe(EXIT.stopped)
    expect(await readdir(dir)).toEqual(['单品_794818635459'])
    const report = await readFile(join(dir, '单品_794818635459', '报告.md'), 'utf8')
    expect(report).toContain('⚠️ 采集中途停止，以下只基于已读到的部分：读取评价时平台出现风控')
    expect(run.out.join('')).toContain('问大家 2，评价 1（')
    expect(run.out.join('')).toContain('⚠️ 中途停止，只保存了已读到的部分')
    expect(run.err.join('')).toContain('没有尝试验证、重试或换号')
    expect(run.err.join('')).toContain('\nDSH 已让买家号 b1 冷却到 2026-10-11T03:00:00.000Z，期间不会再被挑选。\n商品 524565741530 没有采集。')
  })

  it('stops at risk control in 问大家 before reading reviews', async () => {
    const dir = await outDir()
    const page = itemPage([expression => expression.includes('wdj.list') ? { ret: 'RGV587_ERROR', data: null, punish: false } : undefined, reviewsRoute])
    const run = deps(page)
    expect(await main(['794818635459', '--out', dir], run)).toBe(EXIT.stopped)
    expect(page.evaluated.some(expression => expression.includes('detaillist'))).toBe(false)
    expect(run.err.join('')).toMatch(/读取问大家时平台出现风控[\s\S]*冷却到 2026-10-11T03:00:00\.000Z，期间不会再被挑选。\n$/u)
  })

  it('goes on to reviews and the next item when 问大家 fails without risk control, and says what was not read', async () => {
    const dir = await outDir()
    const page = itemPage([expression => expression.includes('wdj.list') ? { ret: 'FAIL_BIZ_QA_CLOSED', data: null, punish: false } : undefined, reviewsRoute])
    const run = deps(page)
    expect(await main(['794818635459', '524565741530', '--out', dir], run)).toBe(EXIT.failed)
    expect((await readdir(dir)).sort()).toEqual(['单品_524565741530', '单品_794818635459'])
    expect(run.out.join('')).toContain('评价 5（主列表 2，负面标签 1，追评 2；中差评视图 3），接口调用 4 次；⚠️ 问大家没有读完（mtop.taobao.wdj.list.merge.search 返回 FAIL_BIZ_QA_CLOSED）。')
    expect(await readFile(join(dir, '单品_794818635459', '报告.md'), 'utf8')).toContain('⚠️ 问大家没有读完（mtop.taobao.wdj.list.merge.search 返回 FAIL_BIZ_QA_CLOSED），以下统计不含这部分。')
    expect(run.err).toEqual(['商品 794818635459、524565741530 没有完整采集，原因见上方各行。\n'])
  })

  it('skips an item without a standard page and goes on', async () => {
    const dir = await outDir()
    let opened = 0
    const page = itemPage([questionsRoute, reviewsRoute])
    // The first item page renders nothing; the second renders the item.
    page.evaluate = (original => <T>(expression: string): Promise<T> => expression.includes('__ICE_APP_CONTEXT__')
      ? Promise.resolve((++opened === 1 ? null : RENDERED_ITEM) as T) : original(expression))(page.evaluate.bind(page))
    const run = deps(page)
    expect(await main(['600000000001', '794818635459', '--out', dir], run)).toBe(EXIT.failed)
    expect(run.out.join('')).toContain('- 600000000001：商品 600000000001 没有标准详情页')
    expect(run.err).toEqual(['商品 600000000001 没有完整采集，原因见上方各行。\n'])
    expect(await readdir(dir)).toEqual(['单品_794818635459'])
  })

  it('stops the run when the item page shows the buyer account is signed out', async () => {
    const page = new FakePage([], (_url, self) => { self.href = 'https://login.taobao.com/member/login.jhtml' })
    const run = deps(page)
    expect(await main(['794818635459', '524565741530', '--out', await outDir()], run)).toBe(EXIT.signedOut)
    expect(run.out.join('')).toContain('- 794818635459：未采集（淘宝买家号需要重新登录')
    expect(run.err.join('')).toContain('商品 524565741530 没有采集。')
  })

  it('reports what DSH said when no buyer account can be used, and a wrong command line', async () => {
    const refused = deps(new FakePage([]), { takeOver: () => Promise.reject(new SkillError('DSH: no buyer account can be used now.', EXIT.stopped)) })
    expect(await main(['794818635459'], refused)).toBe(EXIT.stopped)
    expect(refused.err).toEqual(['DSH: no buyer account can be used now.\n'])
    const usage = deps(new FakePage([]))
    expect(await main([], usage)).toBe(EXIT.usage)
    const broken = deps(new FakePage([]), { openPage: () => Promise.reject(new Error('connect ECONNREFUSED')) })
    expect(await main(['794818635459'], broken)).toBe(EXIT.failed)
    expect(broken.err).toEqual(['失败：connect ECONNREFUSED\n'])
  })

  it('reports an unexpected failure and still closes the tab', async () => {
    const page = new FakePage([])
    page.goto = () => Promise.reject(new Error('socket closed'))
    page.close = () => Promise.reject(new Error('gone'))
    const run = deps(page)
    expect(await main(['794818635459', '--out', await outDir()], run)).toBe(EXIT.failed)
    expect(run.err).toEqual(['失败：socket closed\n'])
  })

  it('marks a degraded answer and saves an image without an extension as jpg', async () => {
    const dir = await outDir()
    const degraded = { ...RENDERED_ITEM, feature: { pcIdentityRisk: 'true' }, item: { title: 't', images: ['https://img.alicdn.com/noext'] } }
    const run = deps(itemPage([questionsRoute, reviewsRoute], degraded, null))
    expect(await main(['794818635459', '--out', dir], run)).toBe(0)
    expect(run.out.join('')).toContain('⚠️ 平台降级（活动价和销量可能缺失）')
    expect(await readdir(join(dir, '单品_794818635459', 'images'))).toContain('main_01.jpg')
  })

  it('skips images that fail to download', async () => {
    const dir = await outDir()
    const run = deps(itemPage([questionsRoute, reviewsRoute]), { fetchFile: () => Promise.reject(new Error('offline')) })
    expect(await main(['794818635459', '--out', dir], run)).toBe(0)
    expect(run.out.join('')).toContain('（保存图片 0 张）')
  })
})
