/**
 * One public Tmall or Taobao item, read with a buyer account: the item page's own server-rendered data
 * (title, shop, price, main images, SKUs), the description images the page fetches for itself, and
 * the 问大家 questions and reviews through the page's own `lib.mtop.request`, which signs each call.
 * Only the item page is a page load; the API calls are paced, and the first sign of risk control
 * stops everything, keeping what was read.
 */

import { EXIT, SkillError } from './errors.ts'
import { signedOut, type Page } from './page.ts'

/**
 * The item id in a link or a bare id.
 * @param input - `https://detail.tmall.com/item.htm?id=…`, `https://item.taobao.com/item.htm?id=…`, or the id.
 * @returns the id.
 * @throws SkillError usage when there is no id.
 */
export function itemIdOf(input: string): string {
  const match = /[?&]id=(\d+)/u.exec(input) ?? /^\s*(\d{6,})\s*$/u.exec(input)
  if (match === null) throw new SkillError(`认不出商品 id：${input}（要商品链接或纯数字 id）`, EXIT.usage)
  return match[1] as string
}

/** The item page; a Tmall item redirects from here to detail.tmall.com, which still counts as one page. */
export function itemUrl(id: string): string {
  return `https://item.taobao.com/item.htm?id=${id}`
}

/** One SKU of the item. */
export interface Sku {
  readonly skuId: string
  readonly sku: string
  readonly priceTitle: string
  readonly price: string
  readonly promoTitle: string
  readonly promoPrice: string
  readonly stock: string
  readonly stockText: string
  /** The image of the SKU's option, or empty. */
  readonly image: string
}

/** What the item page itself rendered. */
export interface ItemPage {
  readonly title: string
  readonly shop: string
  readonly shopId: string
  readonly sellCount: string
  readonly priceTitle: string
  readonly price: string
  readonly priceDesc: string
  /** The platform answered with less (pcIdentityRisk): promotion prices and sales are missing. */
  readonly riskDegraded: boolean
  readonly mainImages: readonly string[]
  readonly video: string
  readonly skus: readonly Sku[]
}

/** The page's server-rendered data, as the page keeps it. */
export interface RenderedItem {
  readonly item?: {
    readonly title?: string
    readonly vagueSellCount?: string
    readonly images?: readonly string[]
    readonly videos?: readonly { readonly url?: string }[]
  }
  readonly seller?: { readonly shopName?: string; readonly shopId?: string | number }
  readonly feature?: { readonly pcIdentityRisk?: string }
  readonly componentsVO?: { readonly priceVO?: { readonly extraPrice?: PriceText; readonly price?: PriceText } }
  readonly skuBase?: {
    readonly props?: readonly {
      readonly pid: string | number
      readonly name: string
      readonly values?: readonly { readonly vid: string | number; readonly name: string; readonly image?: string }[]
    }[]
    readonly skus?: readonly { readonly skuId: string; readonly propPath: string }[]
  }
  readonly skuCore?: { readonly sku2info?: Readonly<Record<string, SkuInfo>> }
}

/** One SKU's price and stock in the rendered data. */
interface SkuInfo {
  readonly price?: PriceText
  readonly subPrice?: PriceText
  readonly quantity?: string | number
  readonly quantityText?: string
}

/** A price block of the rendered data. */
interface PriceText {
  readonly priceTitle?: string
  readonly priceText?: string
  readonly priceDesc?: string
}

/** The expression that tells whether the page shows a slider or a verification frame. */
const SLIDER = '!!document.querySelector(\'#nocaptcha, .nc_wrapper, iframe[src*="punish"]\')'

/** The expression that reads the item page's server-rendered data. */
export const RENDERED = '(() => window.__ICE_APP_CONTEXT__?.loaderData?.home?.data?.res ?? null)()'

/**
 * The item from the page's server-rendered data. A single-SKU item has one row with an empty name;
 * placeholder options such as 「其它规格」 are left out of SKU names.
 * @param res - the rendered data.
 * @returns the item.
 */
export function parseItem(res: RenderedItem): ItemPage {
  const props = res.skuBase?.props ?? []
  const names = new Map<string, string>()
  const images = new Map<string, string>()
  for (const prop of props) {
    for (const value of prop.values ?? []) {
      const key = `${String(prop.pid)}:${String(value.vid)}`
      names.set(key, value.name.trim())
      if (value.image !== undefined && value.image !== '') images.set(key, value.image)
    }
  }
  const info = res.skuCore?.sku2info ?? {}
  const row = (skuId: string, sku: string, image: string): Sku => {
    const entry = info[skuId] ?? {}
    return {
      skuId: skuId === '0' ? '' : skuId, sku, priceTitle: entry.price?.priceTitle ?? '', price: entry.price?.priceText ?? '',
      promoTitle: entry.subPrice?.priceTitle ?? '', promoPrice: entry.subPrice?.priceText ?? '',
      stock: entry.quantity === undefined ? '' : String(entry.quantity), stockText: entry.quantityText ?? '', image,
    }
  }
  const skus = (res.skuBase?.skus ?? []).map((sku) => {
    const path = sku.propPath.split(';')
    const parts = path.map(key => names.get(key) ?? key)
    const named = parts.filter(part => !part.startsWith('其它'))
    return row(sku.skuId, (named.length > 0 ? named : parts).join(' / '), path.map(key => images.get(key)).find(image => image !== undefined) ?? '')
  })
  const price = res.componentsVO?.priceVO?.extraPrice ?? res.componentsVO?.priceVO?.price ?? {}
  return {
    title: res.item?.title ?? '', shop: res.seller?.shopName ?? '', shopId: res.seller?.shopId === undefined ? '' : String(res.seller.shopId),
    sellCount: res.item?.vagueSellCount ?? '', priceTitle: price.priceTitle ?? '', price: price.priceText ?? '', priceDesc: price.priceDesc ?? '',
    riskDegraded: res.feature?.pcIdentityRisk === 'true',
    mainImages: (res.item?.images ?? []).map(absolute),
    video: res.item?.videos?.find(video => video.url !== undefined && video.url !== '')?.url ?? '',
    skus: skus.length > 0 ? skus : [row('0', '', '')],
  }
}

/**
 * The description's long images, in layout order, from the body of `mtop.taobao.detail.getdesc`
 * (JSON or JSONP).
 * @param body - the response body.
 * @returns the image addresses.
 */
export function descImages(body: string): string[] {
  const text = body.trim()
  const json = text.startsWith('{') ? text : text.slice(text.indexOf('(') + 1, text.lastIndexOf(')'))
  const components = (JSON.parse(json) as { data?: { components?: DescComponents } }).data?.components ?? {}
  return (components.layout ?? []).flatMap(({ ID }) => {
    const url = components.componentData?.[ID]?.model?.picUrl
    return url === undefined || url === '' ? [] : [absolute(url)]
  })
}

/** The description's layout and its components. */
interface DescComponents {
  readonly layout?: readonly { readonly ID: string }[]
  readonly componentData?: Readonly<Record<string, { readonly model?: { readonly picUrl?: string } }>>
}

function absolute(url: string): string {
  return url.startsWith('//') ? `https:${url}` : url
}

/** Platform risk control showed; the run stops at once. */
export class RiskStop extends SkillError {
  /** @param what - what was being read when it showed. */
  constructor(what: string) {
    super(`读取${what}时平台出现风控（滑块或身份验证），已立即停止，没有尝试验证、重试或换号；已读到的部分都已保存。今天不要再用这个买家号。`, EXIT.stopped)
    this.name = 'RiskStop'
  }
}

/** Pacing between API calls: about 28 calls in a burst, then about 14 a minute, so 4.5–6 s each. */
export interface Pace {
  readonly sleep: (ms: number) => Promise<void>
  readonly random: () => number
}

/** The answer an mtop call gives the skill: its return code, data, and whether a verification frame is up. */
interface MtopAnswer {
  readonly ret: string
  readonly data: unknown
  readonly punish: boolean
}

/**
 * Call an mtop API through the page's own `lib.mtop.request`, which signs it. A slider leaves the call
 * unanswered, so it gives up after 20 s.
 */
function mtopExpression(api: string, version: string, data: object): string {
  return `(async () => {
  const req = window.lib.mtop.request({ api: ${JSON.stringify(api)}, v: ${JSON.stringify(version)}, data: ${JSON.stringify(JSON.stringify(data))}, type: 'GET', dataType: 'jsonp', ecode: 0 }).catch(e => e)
  const r = await Promise.race([req, new Promise(res => setTimeout(() => res({ ret: ['TIMEOUT'] }), 20000))])
  const punish = [...document.querySelectorAll('iframe')].some(f => /punish|_____tmd_____/.test(f.src))
  return (r && r.data && Array.isArray(r.ret)) ? { ret: String(r.ret[0]), data: r.data, punish } : { ret: String((r && r.ret) || r), data: null, punish }
})()`
}

/** Return codes of risk control: a slider, a verification, or a call the slider left unanswered. */
const RISK_RET = /^(?:FAIL_SYS_USER_VALIDATE|RGV587|TIMEOUT)/u

/**
 * Make one paced mtop call. A transient failure is retried once; risk control stops the run.
 * @param page - the item tab.
 * @param pace - pacing.
 * @param what - what is being read, for the message.
 * @param api - the API.
 * @param version - its version.
 * @param data - its parameters.
 * @returns the answer's data.
 * @throws RiskStop on risk control, and Error for another failure that a retry did not fix.
 */
export async function mtop<T>(page: Page, pace: Pace, what: string, api: string, version: string, data: object): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    await pace.sleep(4500 + pace.random() * 1500)
    const answer = await page.evaluate<MtopAnswer>(mtopExpression(api, version, data))
    if (RISK_RET.test(answer.ret) || answer.punish) throw new RiskStop(what)
    if (answer.ret.startsWith('SUCCESS')) return answer.data as T
    if (attempt === 1) throw new Error(`${api} 返回 ${answer.ret}`)
  }
}

/** One 问大家 question with its top answers. */
export interface Question {
  readonly questionId: string
  readonly question: string
  readonly date: string
  readonly answerCount: number
  /** The top answers the list gives, usually up to three, as 「answer（user·tags）」. */
  readonly answers: readonly string[]
}

/** One review. */
export interface Review {
  /** `all` (the main list), `tag:<impression tag>` (pulled by a negative tag), or `append` (the follow-up tab). */
  readonly source: string
  /** 好评, 中评, 差评, or the platform's code. */
  readonly rateType: string
  readonly date: string
  readonly user: string
  readonly sku: string
  readonly content: string
  readonly append: string
  readonly appendDays: string
  readonly reply: string
  readonly media: string
  readonly repurchase: string
  readonly id: string
}

/** An impression tag from the first review page; negative tags are pulled one by one. */
export interface ImpressionTag {
  readonly tag: string
  readonly count: string
  readonly labelId: string
  readonly negative: boolean
}

/** What was read of an item so far; the collectors add to it, so a stop keeps everything before it. */
export interface Collected {
  questions: Question[]
  reviews: Review[]
  tags: ImpressionTag[]
  /** The API calls made, each paced. */
  calls: number
}

/** How much to read. */
export interface Limits {
  readonly questions: number
  readonly reviews: number
  readonly appends: number
  /** Reviews per negative impression tag. */
  readonly perTag: number
}

/** The 问大家 list API's answer. */
interface QuestionPage {
  readonly hasNext?: string | boolean
  readonly questionList?: readonly {
    readonly questionId?: string | number
    readonly questionTitle?: string
    readonly gmtCreate?: string
    readonly answerCount?: string | number
    readonly topAnswerList?: readonly {
      readonly answerTitle?: string
      readonly answerUserInfo?: { readonly userNick?: string; readonly userTags?: readonly { readonly text?: string }[] }
    }[]
  }[]
}

/**
 * Read 问大家, 20 questions a call, up to a limit. This API's allowance is tighter than reviews'.
 * @param page - the item tab.
 * @param pace - pacing.
 * @param itemId - the item.
 * @param limit - the most questions.
 * @param into - where the questions go.
 */
export async function readQuestions(page: Page, pace: Pace, itemId: string, limit: number, into: Collected): Promise<void> {
  for (let pageNo = 1; into.questions.length < limit; pageNo++) {
    into.calls++
    const answer = await mtop<QuestionPage>(page, pace, '问大家', 'mtop.taobao.wdj.list.merge.search', '1.0', {
      itemId, pageSize: 20, page: pageNo, type: 'mix_group', tagId: '', extraInfo: '{"searchText":""}', ecode: 0, biz: 'pc',
    })
    const list = answer.questionList ?? []
    for (const question of list) {
      if (into.questions.length >= limit) break
      into.questions.push({
        questionId: String(question.questionId ?? ''), question: question.questionTitle ?? '', date: question.gmtCreate ?? '',
        answerCount: Number(question.answerCount ?? 0),
        answers: (question.topAnswerList ?? []).map((top) => {
          const tags = (top.answerUserInfo?.userTags ?? []).map(tag => tag.text ?? '').filter(text => text !== '').join('/')
          return `${top.answerTitle ?? ''}（${top.answerUserInfo?.userNick ?? ''}${tags === '' ? '' : `·${tags}`}）`
        }),
      })
    }
    if (String(answer.hasNext) !== 'true' || list.length === 0) return
  }
}

/** The review list API's answer. */
interface ReviewPage {
  readonly hasNext?: string | boolean
  readonly rateList?: readonly RawReview[]
  readonly imprNewItemVOS?: readonly RawTag[]
}

/** One review as the API gives it. */
interface RawReview {
  readonly id?: string | number
  readonly rateType?: string | number
  readonly feedbackDate?: string
  readonly userNick?: string
  readonly skuValueStr?: string
  readonly feedback?: string
  readonly reply?: string
  readonly rateResourceList?: readonly { readonly url?: string; readonly picUrl?: string; readonly videoUrl?: string }[]
  readonly appendedFeed?: { readonly appendedFeedback?: string; readonly intervalDay?: string | number; readonly reply?: string }
  readonly extraInfoMap?: { readonly repurchaseCountOneTip?: string }
}

/** One impression tag as the API gives it. */
interface RawTag {
  readonly title?: string
  readonly count?: string | number
  readonly labelId?: string | number
  readonly extraInfo?: { readonly labelType?: string; readonly gray?: string | boolean }
}

const RATE_TYPE: Readonly<Record<string, string>> = { 1: '好评', 0: '中评', '-1': '差评' }

/** A review row from the API's review. */
export function reviewRow(raw: RawReview, source: string): Review {
  const media = (raw.rateResourceList ?? []).map(item => item.url ?? item.picUrl ?? item.videoUrl ?? '').filter(url => url !== '')
  const rateType = raw.rateType === undefined ? '' : String(raw.rateType)
  return {
    source, rateType: RATE_TYPE[rateType] ?? rateType, date: raw.feedbackDate ?? '', user: raw.userNick ?? '',
    sku: (raw.skuValueStr ?? '').split('；').filter(part => part.trim() !== '' && !part.startsWith('其它')).join('；'),
    content: raw.feedback ?? '', append: raw.appendedFeed?.appendedFeedback ?? '',
    appendDays: raw.appendedFeed?.intervalDay === undefined ? '' : String(raw.appendedFeed.intervalDay),
    reply: raw.reply !== undefined && raw.reply !== '' ? raw.reply : raw.appendedFeed?.reply ?? '',
    media: media.join(';'), repurchase: raw.extraInfoMap?.repurchaseCountOneTip ?? '', id: raw.id === undefined ? '' : String(raw.id),
  }
}

/**
 * The impression tags of the first review page. A negative tag's label id ends in -13 or it is gray;
 * the page hides their counts.
 * @param tags - the API's tags.
 * @returns the impression tags.
 */
export function impressionTags(tags: readonly RawTag[]): ImpressionTag[] {
  return tags.filter(tag => tag.extraInfo?.labelType === 'impr').map((tag) => {
    const labelId = tag.labelId === undefined ? '' : String(tag.labelId)
    return {
      tag: tag.title ?? '', count: tag.count === undefined ? '' : String(tag.count), labelId,
      negative: labelId.endsWith('-13') || String(tag.extraInfo?.gray) === 'true',
    }
  })
}

/**
 * Read reviews: the main list in the platform's default order (content first), every negative
 * impression tag, and the follow-up tab. Each source keeps its label, so samples pulled by negative
 * tags are not counted as part of the main list.
 * @param page - the item tab.
 * @param pace - pacing.
 * @param itemId - the item.
 * @param limits - how much to read.
 * @param into - where the reviews and tags go.
 */
export async function readReviews(page: Page, pace: Pace, itemId: string, limits: Limits, into: Collected): Promise<void> {
  const seen = new Set<string>()
  const pages = async (label: string, source: string, limit: number, filter: object): Promise<void> => {
    let taken = 0
    // The main list's first page is read even when no reviews are kept from it: the impression tags come with it.
    for (let pageNo = 1; taken < limit || (source === 'all' && pageNo === 1); pageNo++) {
      into.calls++
      const answer = await mtop<ReviewPage>(page, pace, label, 'mtop.taobao.rate.detaillist.get', '6.0', {
        showTrueCount: false, auctionNumId: itemId, pageNo, pageSize: 50, orderType: '', searchImpr: '-8', expression: '', skuVids: '',
        rateSrc: 'pc_rate_list', rateType: '', foldFlag: '0', ...filter,
      })
      if (source === 'all' && pageNo === 1) into.tags = impressionTags(answer.imprNewItemVOS ?? [])
      const list = answer.rateList ?? []
      for (const raw of list) {
        const row = reviewRow(raw, source)
        if (taken >= limit || seen.has(`${source}:${row.id}`)) continue
        seen.add(`${source}:${row.id}`)
        into.reviews.push(row)
        taken++
      }
      if (String(answer.hasNext) !== 'true' || list.length === 0) return
    }
  }
  await pages('评价', 'all', limits.reviews, {})
  for (const tag of into.tags.filter(item => item.negative)) {
    await pages(`评价标签「${tag.tag}」`, `tag:${tag.tag}`, limits.perTag, { expression: tag.labelId })
  }
  if (limits.appends > 0) await pages('追评', 'append', limits.appends, { rateType: '2' })
}

/** An item page that was read: the item and its description images. */
export interface OpenedItem {
  readonly item: ItemPage
  readonly descImages: readonly string[]
}

/**
 * Open the item page and read what it rendered, and the description it fetches for itself.
 * @param page - a buyer account's tab.
 * @param itemId - the item.
 * @returns the item and its description images.
 * @throws SkillError stopped when DSH refused the page (out of pages or risk control), or the page
 *   shows risk control; signed-out on a sign-in page; failed for a page that is not a standard item
 *   page or has no SKU data.
 */
export async function openItem(page: Page, itemId: string): Promise<OpenedItem> {
  let desc: string | undefined
  // The description request names its item in its address, so a late answer for an earlier item is not taken.
  const stopReading = page.onResponse(url => url.includes('mtop.taobao.detail.getdesc') && url.includes(itemId), (body) => { desc ??= body })
  try {
    return await readItemPage(page, itemId, () => desc)
  } finally {
    stopReading()
  }
}

async function readItemPage(page: Page, itemId: string, desc: () => string | undefined): Promise<OpenedItem> {
  try {
    await page.goto(itemUrl(itemId))
  } catch (error) {
    if (error instanceof SkillError && error.message.includes('ERR_BLOCKED_BY_CLIENT')) {
      throw new SkillError(`DSH 没有放行商品 ${itemId} 的页面：这个买家号今天的页数已用完，或刚出现风控正在冷却。已停止。`, EXIT.stopped)
    }
    throw error
  }
  const href = await page.evaluate<string>('location.href')
  if (/login\.(?:taobao|tmall)\.com/u.test(href)) signedOut('淘宝买家号')
  if (/punish|_____tmd_____/u.test(href) || await page.evaluate<boolean>(SLIDER)) {
    throw new RiskStop(`商品 ${itemId} 的页面`)
  }
  const res = await page.evaluate<RenderedItem | null>(RENDERED)
  if (res === null) throw new SkillError(`商品 ${itemId} 没有标准详情页（天猫国际等商品电脑端不支持），跳过。`)
  if (Object.keys(res.skuCore?.sku2info ?? {}).length === 0) {
    throw new SkillError(`商品 ${itemId} 的详情页没有 SKU 数据（商品可能已下架，或买家号看到的是未登录的门禁页，可到 DSH 设置 → 电商账号检查），跳过。`)
  }
  // The page fetches its description on its own; a replay is refused, so wait for that one.
  await page.waitFor(() => desc() !== undefined, 15_000)
  const body = desc()
  return { item: parseItem(res), descImages: body === undefined ? [] : readableDescImages(body) }
}

/** The description images, or none when the body is not the JSON or JSONP the page usually gets. */
function readableDescImages(body: string): string[] {
  try {
    return descImages(body)
  } catch {
    // An error page or a cut-short body: the description is missing, the rest of the item is still read.
    return []
  }
}
