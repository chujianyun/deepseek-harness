import type { RenderedItem } from '../src/item.ts'
import { FakePage, on, type Route } from './support.ts'

/** An item page's server-rendered data: two SKU dimensions, one with images and a placeholder dimension. */
export const RENDERED_ITEM: RenderedItem = {
  item: { title: '名流 超薄避孕套', vagueSellCount: '1万+', images: ['//img.alicdn.com/a.jpg', 'https://img.alicdn.com/b.png'], videos: [{}, { url: 'https://cloud.video/v.mp4' }] },
  seller: { shopName: '名流旗舰店', shopId: 123 },
  componentsVO: { priceVO: { extraPrice: { priceTitle: '券后', priceText: '39.9', priceDesc: '起' }, price: { priceText: '59' } } },
  skuBase: {
    props: [
      { pid: 1, name: '规格', values: [{ vid: 11, name: '【10只】超薄 ', image: '//img.alicdn.com/s10.jpg' }, { vid: 12, name: '共20只' }] },
      { pid: 2, name: '其它规格', values: [{ vid: 21, name: '其它规格' }] },
    ],
    skus: [{ skuId: 's10', propPath: '1:11;2:21' }, { skuId: 's20', propPath: '1:12;2:21' }, { skuId: 'sx', propPath: '2:21' }],
  },
  skuCore: { sku2info: {
    s10: { price: { priceTitle: '价格', priceText: '29.9' }, subPrice: { priceTitle: '券后', priceText: '19.9' }, quantity: 200, quantityText: '有货' },
    s20: { price: { priceText: '49.9' }, quantity: '0', quantityText: '无货' },
  } },
}

/** `mtop.taobao.detail.getdesc` as JSONP. */
export const DESC_BODY = `mtopjsonp3(${JSON.stringify({ data: { components: {
  layout: [{ ID: 'd1' }, { ID: 'text' }, { ID: 'd2' }],
  componentData: { d1: { model: { picUrl: '//img.alicdn.com/d1.jpg' } }, text: { model: {} }, d2: { model: { picUrl: 'https://img.alicdn.com/d2.jpg' } } },
} } })})`

/** The description request of an item, which names the item in its data. */
export function descUrl(itemId: string): string {
  return `https://h5api.m.taobao.com/h5/mtop.taobao.detail.getdesc/7.0/?jsv=2.7.2&data=%7B%22id%22%3A%22${itemId}%22%7D`
}

/** A 问大家 page. */
export function questionPage(from: number, count: number, hasNext: boolean): object {
  return {
    hasNext: String(hasNext),
    questionList: Array.from({ length: count }, (_, index) => ({
      questionId: from + index, questionTitle: from + index === 1 ? '会不会破？' : `尺寸大小合适吗 ${String(from + index)}`, gmtCreate: '2026-09-01 10:00:00',
      answerCount: from + index === 1 ? 12 : 1,
      topAnswerList: [{ answerTitle: '不会破', answerUserInfo: { userNick: 'a**1', userTags: [{ text: '已购' }, {}] } }, { answerTitle: '还行' }, { answerUserInfo: { userNick: 'b**2' } }],
    })),
  }
}

/** A review as the API gives it. */
export function rawReview(id: number, overrides: object = {}): object {
  return {
    id, rateType: 1, feedbackDate: '2026年9月3日', userNick: 'u**1', skuValueStr: '规格:【10只】超薄；其它规格:其它规格', feedback: `很薄很润滑，回购了 ${String(id)}`,
    rateResourceList: [{ url: 'https://img/r.jpg' }, { picUrl: 'https://img/p.jpg' }, {}], extraInfoMap: { repurchaseCountOneTip: '回购2次' }, ...overrides,
  }
}

/** The first review page with its impression tags. */
export const TAGS = [
  { title: '很薄', count: 30, labelId: '1-11', extraInfo: { labelType: 'impr' } },
  { title: '容易破', labelId: '2-13', extraInfo: { labelType: 'impr', gray: 'true' } },
  { title: '全部', extraInfo: { labelType: 'tab' } },
]

/**
 * A fake item tab: the item page renders the item and fetches its description; mtop calls are
 * answered by `mtop` routes in order.
 */
export function itemPage(mtop: Route[], rendered: unknown = RENDERED_ITEM, desc: string | null = DESC_BODY): FakePage {
  return new FakePage([
    on('__ICE_APP_CONTEXT__', () => rendered),
    on('#nocaptcha', false),
    ...mtop,
  ], (url, page) => {
    const id = /id=(\d+)/u.exec(url)?.[1] ?? ''
    if (desc !== null) page.respond(descUrl(id), desc)
  })
}

/** Answer an mtop call. */
export function mtopAnswer(api: string, answer: object | ((expression: string) => object)): Route {
  return expression => expression.includes(`api: "${api}"`)
    ? { ret: 'SUCCESS::调用成功', data: typeof answer === 'function' ? (answer as (expression: string) => object)(expression) : answer, punish: false }
    : undefined
}

/** The JSON data an mtop expression sends. */
export function mtopData(expression: string): Record<string, unknown> {
  const literal = /data: ("(?:[^"\\]|\\.)*")/u.exec(expression)?.[1] as string
  return JSON.parse(JSON.parse(literal) as string) as Record<string, unknown>
}
