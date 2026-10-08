/**
 * The fact layer of an item report: deterministic counts from what was read, never opinions. Every
 * sample is labelled with its size and source; reviews and 问大家 are separate pools; quotes are
 * verbatim. The keyword tables are tuned for the adult-health category the first tenant sells.
 */

import type { ImpressionTag, ItemPage, Question, Review } from './item.ts'

/** Explicitly negative words; broad ones (差, 退, 大, 小) would catch praise too. */
const NEGATIVE_WORDS = [
  '失望', '垃圾', '破了', '破损', '破裂', '漏了', '漏液', '漏发', '少发', '少了', '异味', '味道大', '难闻', '退货', '退款', '假货', '骗', '太小', '偏小',
  '太大', '偏大', '太厚', '太薄', '过敏', '疼', '干涩', '太贵', '有点贵', '不划算', '态度差', '物流慢', '快递差', '快递慢', '坏了', '不推荐', '后悔',
  '难用', '不舒服', '不好用', '不行', '一般般', '一般', '脱落', '滑落', '断了', '不值', '坑', '劣质', '不喜欢', '不满意', '投诉', '货不对', '廉价',
  '差点意思', '差评', '不好', '不太好', '不怎么样', '太紧', '有点紧', '偏紧', '勒得', '太勒', '有点勒', '发货慢', '临期', '过期', '不合适', '不适合',
]
const NEGATIVE = NEGATIVE_WORDS.map(word => word.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|')
/** A negation up to two characters before a negative word turns it into praise: 「不干涩」「无异味」「没让我失望」. */
const NEGATED = new RegExp(`(?:不会|不易|不容易|不太容易|不再|不用担心|再也不|没出现|没有出现|没有|没|不像|不是那种|不是|别让|别|不|无|未|非|不曾|避免|防止|杜绝|告别|远离|减).{0,2}?(?:${NEGATIVE})`, 'gu')
/** Neutral set phrases removed first: 「不知道好不好」「物美价廉」「还没用」. */
const NEUTRAL = /好不好|行不行|值不值|好用不好用|物美价廉|物廉价美|还没用|没用过|没有用过|不好意思|到不行|减少了/gu
const NEGATIVE_RE = new RegExp(NEGATIVE, 'u')

/**
 * Whether a review is negative: a 中评 or 差评, one pulled by a negative tag, or text with an
 * un-negated negative word.
 * @param review - the review.
 * @returns true for a negative review.
 */
export function isNegative(review: Pick<Review, 'rateType' | 'source' | 'content' | 'append'>): boolean {
  if (review.rateType === '中评' || review.rateType === '差评' || review.source.startsWith('tag:')) return true
  return NEGATIVE_RE.test(`${review.content} ${review.append}`.replace(NEUTRAL, '').replace(NEGATED, ''))
}

/** Negative-review categories; a review counts under the first that matches. */
const NEGATIVE_CATEGORIES: readonly (readonly [string, RegExp])[] = [
  ['产品质量', /破|漏|烂|裂|滑落|脱落|掉了|干|涩|厚|不薄|异味|臭|味道|过敏|疼|痛|紧|勒|小|大|松|质量|劣质|难用|不好用|不舒服|没感觉|一般/u],
  ['描述不符', /不一样|货不对|假|骗|不像|图片|宣传|少了|少发|数量|不是.{0,4}只|临期|过期|日期/u],
  ['物流包装', /快递|物流|包装|泡水|发货|隐私|保密|外包装|盒子|压/u],
  ['售后服务', /客服|退|售后|态度|不理|回复/u],
  ['价格', /贵|不划算|价格|降价|便宜|优惠|券/u],
]

/** Positive themes; a review can count under several. */
const POSITIVE_THEMES: readonly (readonly [string, RegExp])[] = [
  ['薄/无感', /薄|无感|没戴|裸/u], ['润滑/水润', /润滑|水润|顺滑|丝滑|不干/u], ['隐私包装', /隐私|保密|包装严实|看不出/u],
  ['回购/老客', /回购|一直|老顾客|多次|再来|复购/u], ['性价比/便宜', /性价比|便宜|实惠|划算|价格/u], ['无异味', /无味|没味|没有味|无异味|没有异味|不臭/u],
  ['物流快', /物流|快递|发货|速度|到货/u], ['持久/延时', /持久|延时|时间长/u], ['贴合/舒服', /贴合|舒服|舒适|合适/u],
]

/** 问大家 concerns; a question can count under several. */
const QUESTION_TOPICS: readonly (readonly [string, RegExp])[] = [
  ['会不会破', /破|漏|烂|裂|安全性/u], ['尺寸/松紧', /尺寸|尺码|大小|大号|中号|小号|号|紧|松|勒|粗|长|宽|mm|码/u],
  ['薄不薄/体验', /薄|厚|无感|没戴|感觉|体验|爽|舒服|裸/u], ['味道', /味|臭/u], ['是否正品', /正品|真的|假|真假|授权|官方/u],
  ['延时/持久', /延时|持久|时间|久|早泄|快/u], ['润滑/干涩', /润滑|干|水|油|涩|滑/u], ['包装隐私', /包装|隐私|保密|快递|外箱|看得出|发货/u],
  ['生产日期/保质期', /日期|保质|过期|临期|新鲜/u], ['过敏/刺激/安全', /过敏|刺激|安全|副作用|妇科|炎/u],
  ['数量/赠品/规格', /多少只|几只|数量|赠|送|规格|哪款|哪个|区别|推荐|买哪/u], ['用法/新手', /怎么用|如何|第一次|新手|戴法|会用/u],
  ['价格/优惠', /价格|贵|便宜|优惠|券|活动/u], ['怀孕/避孕效果', /怀孕|避孕|中奖|效果/u],
]

/** The pieces in a SKU name: 【10只】, 共10只, 10只】. */
const PIECES = /(?:【\s*(?:共)?\s*(\d+)\s*只|共\s*(\d+)\s*只|(\d+)\s*只\s*】)/u

/** A review quoted in the report. */
export interface Quote {
  readonly date: string
  readonly rateType: string
  readonly sku: string
  readonly content: string
  readonly append: string
  readonly source: string
}

/** One SKU's place on the price ladder. */
export interface SkuPrice {
  readonly sku: string
  readonly pieces: number | null
  readonly listPrice: number | null
  readonly payPrice: number | null
  readonly unitPrice: number | null
  readonly stockText: string
}

/** A count with its share of the sample. */
export interface Share {
  readonly count: number
  readonly share: number
}

/** A 问大家 question as the report cites it. */
export interface CitedQuestion {
  readonly question: string
  readonly answerCount: number
  readonly topAnswer: string
}

/** The facts of one item. */
export interface ItemFacts {
  readonly item: Omit<ItemPage, 'skus' | 'mainImages'> & { readonly itemId: string; readonly url: string }
  readonly images: { readonly main: number; readonly desc: number; readonly skuWithImage: number; readonly saved: number }
  readonly impressionTags: readonly ImpressionTag[]
  readonly skus: readonly SkuPrice[]
  readonly skuSales: {
    readonly sample: number
    readonly unidentified: number
    readonly rows: readonly (Share & { readonly sku: string })[]
  }
  readonly reviews: {
    readonly sampleMain: number
    readonly rateType: Readonly<Record<string, number>>
    readonly byMonth: Readonly<Record<string, number>>
    readonly negativePool: number
    readonly negativeCategories: Readonly<Record<string, number>>
    readonly negativeExamples: Readonly<Record<string, readonly Quote[]>>
    readonly positiveSample: number
    readonly positiveThemes: readonly (Share & { readonly theme: string; readonly examples: readonly string[] })[]
    readonly appends: {
      readonly sample: number
      readonly negative: number
      readonly medianDays: number | null
      readonly examples: readonly Quote[]
    }
    readonly tagRows: number
  }
  readonly questions: {
    readonly sample: number
    readonly topics: readonly (Share & { readonly topic: string; readonly answers: number; readonly top: readonly CitedQuestion[] })[]
    readonly mostAnswered: readonly (CitedQuestion & { readonly date: string })[]
  }
}

/** What the facts are computed from. */
export interface FactsInput {
  readonly itemId: string
  readonly url: string
  readonly item: ItemPage
  readonly descImages: readonly string[]
  readonly savedImages: number
  readonly tags: readonly ImpressionTag[]
  readonly reviews: readonly Review[]
  readonly questions: readonly Question[]
}

/**
 * Compute the facts of an item.
 * @param input - what was read.
 * @returns the facts.
 */
export function itemFacts(input: FactsInput): ItemFacts {
  const { item } = input
  const skus = item.skus.map((sku) => {
    const match = PIECES.exec(sku.sku)
    const pieces = match === null ? null : Number(match[1] ?? match[2] ?? match[3])
    const listPrice = price(sku.price)
    const payPrice = price(sku.promoPrice) ?? listPrice
    const unitPrice = payPrice !== null && pieces !== null ? round(payPrice / pieces) : null
    return { sku: sku.sku, pieces, listPrice, payPrice, unitPrice, stockText: sku.stockText }
  })

  // Purchased SKUs from the main list only, so reviews pulled by tags or the follow-up tab are not counted twice.
  const main = input.reviews.filter(review => review.source === 'all')
  const sold = new Map<string, number>()
  let unidentified = 0
  for (const review of main) {
    const hit = item.skus.find(sku => sku.sku !== '' && (review.sku.includes(sku.sku) || (review.sku !== '' && sku.sku.includes(review.sku))))
    const key = hit !== undefined ? hit.sku : review.sku !== '' ? `[已下架/改名] ${review.sku.slice(0, 30)}` : undefined
    if (key === undefined) unidentified++
    else sold.set(key, (sold.get(key) ?? 0) + 1)
  }

  const appends = input.reviews.filter(review => review.source === 'append')
  const appendNegative = (review: Review): boolean => isNegative({ rateType: '', source: '', content: review.append, append: '' })
  // The three pools never share a review: each source is read without duplicates and keeps its own label.
  const negativePool = [
    ...main.filter(review => review.rateType === '中评' || review.rateType === '差评'),
    ...input.reviews.filter(review => review.source.startsWith('tag:')),
    ...appends.filter(appendNegative),
  ]
  const categories = new Map<string, number>()
  const examples = new Map<string, Quote[]>()
  for (const review of negativePool) {
    const text = `${review.content} ${review.append}`.trim()
    const category = NEGATIVE_CATEGORIES.find(([, pattern]) => pattern.test(text))?.[0] ?? '其他'
    categories.set(category, (categories.get(category) ?? 0) + 1)
    if (text.length >= 8) examples.set(category, [...examples.get(category) ?? [], quote(review)])
  }

  const positive = main.filter(review => review.rateType === '好评' && review.content.length >= 6)
  const themes = POSITIVE_THEMES.map(([theme, pattern]) => {
    const hits = positive.filter(review => pattern.test(review.content))
    const examples = longest(hits, review => review.content).slice(0, 4).map(review => review.content)
    return { theme, count: hits.length, share: ratio(hits.length, positive.length), examples }
  }).sort((a, b) => b.count - a.count)

  const appendDays = appends.map(review => Number(review.appendDays))
    .filter(days => Number.isInteger(days) && days >= 0).sort((a, b) => a - b)
  const appendNegatives = appends.filter(appendNegative)

  const topics = QUESTION_TOPICS.map(([topic, pattern]) => {
    const hits = input.questions.filter(question => pattern.test(question.question))
    return {
      topic, count: hits.length, share: ratio(hits.length, input.questions.length),
      answers: hits.reduce((sum, question) => sum + question.answerCount, 0),
      top: [...hits].sort((a, b) => b.answerCount - a.answerCount).slice(0, 6).map(cite),
    }
  }).sort((a, b) => b.count - a.count)

  const { skus: _skus, mainImages, ...head } = item
  return {
    item: { ...head, itemId: input.itemId, url: input.url },
    images: { main: mainImages.length, desc: input.descImages.length, skuWithImage: item.skus.filter(sku => sku.image !== '').length, saved: input.savedImages },
    impressionTags: input.tags,
    skus,
    skuSales: {
      sample: main.length, unidentified,
      rows: [...sold].sort((a, b) => b[1] - a[1]).map(([sku, count]) => ({ sku, count, share: ratio(count, main.length) })),
    },
    reviews: {
      sampleMain: main.length,
      rateType: countBy(main, review => review.rateType),
      byMonth: Object.fromEntries(Object.entries(countBy(main.filter(review => monthOf(review.date) !== ''), review => monthOf(review.date))).sort()),
      negativePool: negativePool.length,
      negativeCategories: Object.fromEntries([...categories].sort((a, b) => b[1] - a[1])),
      negativeExamples: Object.fromEntries([...examples].map(([category, quotes]) => [
        category, longest(quotes, item => item.content + item.append).slice(0, 12),
      ])),
      positiveSample: positive.length,
      positiveThemes: themes,
      appends: {
        sample: appends.length, negative: appendNegatives.length,
        medianDays: appendDays.length === 0 ? null : appendDays[Math.floor(appendDays.length / 2)] as number,
        examples: longest(appendNegatives, review => review.append).slice(0, 12).map(quote),
      },
      tagRows: input.reviews.filter(review => review.source.startsWith('tag:')).length,
    },
    questions: {
      sample: input.questions.length, topics,
      mostAnswered: [...input.questions].sort((a, b) => b.answerCount - a.answerCount).slice(0, 15)
        .map(question => ({ ...cite(question), date: question.date.slice(0, 10) })),
    },
  }
}

function quote(review: Review): Quote {
  const { date, rateType, content, append, source } = review
  return { date, rateType, sku: review.sku.slice(0, 30), content, append, source }
}

function cite(question: Question): CitedQuestion {
  return { question: question.question, answerCount: question.answerCount, topAnswer: question.answers[0] ?? '' }
}

function longest<T>(items: readonly T[], text: (item: T) => string): T[] {
  return [...items].sort((a, b) => text(b).length - text(a).length)
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1
  return counts
}

function price(text: string): number | null {
  const value = Number.parseFloat(text.replace('起', ''))
  return Number.isFinite(value) ? value : null
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

function ratio(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round(part / whole * 1000) / 1000
}

/** `YYYY-MM` from a review date such as 2026年9月3日. */
function monthOf(date: string): string {
  const match = /(\d{4})年(\d{1,2})月/u.exec(date)
  return match === null ? '' : `${match[1] as string}-${(match[2] as string).padStart(2, '0')}`
}

/**
 * The report in Markdown, from the facts only: counts with their samples, and quotes copied verbatim.
 * @param facts - the item's facts.
 * @param notes - lines to put first, such as why the run stopped early.
 * @returns the report.
 */
export function factsReport(facts: ItemFacts, notes: readonly string[]): string {
  const { item, reviews, questions } = facts
  const percent = (share: number): string => `${(share * 100).toFixed(1)}%`
  const lines = [
    `# 单品报告 · ${item.title}`,
    '',
    `商品 ${item.itemId}（${item.url}），店铺 ${item.shop}，${item.priceTitle}${item.price}${item.priceDesc === '' ? '' : `（${item.priceDesc}）`}，销量 ${item.sellCount === '' ? '未显示' : item.sellCount}。`,
    ...item.riskDegraded ? ['', '⚠️ 平台对这次访问降级（pcIdentityRisk）：活动价和销量可能缺失。'] : [],
    ...notes.flatMap(note => ['', note]),
    '',
    '## 图片与 SKU',
    '',
    `主图 ${String(facts.images.main)} 张，详情长图 ${String(facts.images.desc)} 张，有图 SKU ${String(facts.images.skuWithImage)} 个，已保存图片 ${String(facts.images.saved)} 张。`,
    '',
    '| SKU | 只数 | 标价 | 到手价 | 单只价 | 库存 |',
    '|---|---:|---:|---:|---:|---|',
    ...facts.skus.map(sku => `| ${sku.sku === '' ? '（单规格）' : sku.sku} | ${text(sku.pieces)} | ${text(sku.listPrice)} | ${text(sku.payPrice)} | ${text(sku.unitPrice)} | ${sku.stockText} |`),
    '',
    `## 已购 SKU 分布（主列表评价 ${String(facts.skuSales.sample)} 条，未识别 ${String(facts.skuSales.unidentified)} 条）`,
    '',
    ...facts.skuSales.rows.length === 0 ? ['没有可识别的已购 SKU。'] : ['| 已购 SKU | 条数 | 占比 |', '|---|---:|---:|', ...facts.skuSales.rows.map(row => `| ${row.sku} | ${String(row.count)} | ${percent(row.share)} |`)],
    '',
    `## 评价（主列表样本 ${String(reviews.sampleMain)} 条，按平台默认排序翻页采样，非全量）`,
    '',
    `好中差：${Object.entries(reviews.rateType).map(([type, count]) => `${type === '' ? '未标' : type} ${String(count)}`).join('，') || '无'}。按月：${Object.entries(reviews.byMonth).map(([month, count]) => `${month} ${String(count)}`).join('，') || '无'}。`,
    `印象标签：${facts.impressionTags.map(tag => `${tag.tag}${tag.negative ? '（负面）' : ''}`).join('、') || '无'}；负面标签拉取 ${String(reviews.tagRows)} 条。`,
    '',
    `### 中差评归类（中差评池 ${String(reviews.negativePool)} 条：主列表中差评 + 负面标签 + 负面追评）`,
    '',
    ...Object.entries(reviews.negativeCategories).flatMap(([category, count]) => [
      `- **${category}** ${String(count)} 条`,
      ...(reviews.negativeExamples[category] ?? []).slice(0, 3).map(item => `  - 「${item.content}${item.append === '' ? '' : ` / 追评：${item.append}`}」（${item.date}，${item.sku}）`),
    ]),
    ...reviews.negativePool === 0 ? ['没有中差评。'] : [],
    '',
    `### 好评主题（好评样本 ${String(reviews.positiveSample)} 条，一条可命中多个主题）`,
    '',
    ...reviews.positiveThemes.filter(theme => theme.count > 0).map(theme => `- **${theme.theme}** ${String(theme.count)} 条（${percent(theme.share)}）：「${theme.examples[0] as string}」`),
    '',
    `### 追评（${String(reviews.appends.sample)} 条，负面 ${String(reviews.appends.negative)} 条，追评间隔中位数 ${text(reviews.appends.medianDays)} 天）`,
    '',
    ...reviews.appends.examples.slice(0, 5).map(item => `- 「${item.append}」（${item.date}，${item.sku}）`),
    '',
    `## 问大家（样本 ${String(questions.sample)} 条，与评价分开统计，一题可命中多个主题）`,
    '',
    ...questions.topics.filter(topic => topic.count > 0).flatMap(topic => [
      `- **${topic.topic}** ${String(topic.count)} 题（${percent(topic.share)}，回答合计 ${String(topic.answers)}）`,
      ...topic.top.slice(0, 2).map(question => `  - 「${question.question}」${String(question.answerCount)} 答；置顶：${question.topAnswer}`),
    ]),
    ...questions.sample === 0 ? ['没有读到问大家。'] : [],
    '',
    '以上全部为确定性统计和原文引用，不含观点；结论请基于这些事实和原文另写，并注明样本口径。',
  ]
  return `${lines.join('\n')}\n`
}

function text(value: number | null): string {
  return value === null ? '—' : String(value)
}
