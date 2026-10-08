/**
 * Saving a confirmed product draft to a Pinduoduo store's 草稿箱, the way the new-item page's 「保存草稿」
 * does: in an edit session in the category, the images go to Pinduoduo's image store
 * (`galerie/business/get_signature`, then `file.pinduoduo.com/v3/store_image`), each SKU name becomes a
 * 套餐 spec value (`query/spec/by/name`), and the session's own values with the draft set in are saved
 * with `goodsCommit/action/edit`. A saved session is a draft, listed by `query/commit/list`; nothing is
 * submitted for review or put on sale.
 */

import { EXIT, SkillError } from './errors.ts'
import type { FieldCheck } from './draft.ts'
import { propertyKey, type EditSession, type Template, type TemplateProperty } from './pdd-category.ts'
import { pddCall } from './pdd.ts'
import type { Page } from './page.ts'
import { commonPrefix, titleOf, type DraftFile } from './publish-common.ts'
import type { PublishRules } from './publish-rules.ts'
import { within } from './publish-submit.ts'

/** The fields of an edit session's detail that its save form carries as they are, unless the draft sets them. */
export const SESSION_FIELDS = [
  'goods_id', 'goods_commit_check', 'reject_reason', 'reject_status', 'check_status', 'goods_name', 'goods_desc', 'warm_tips', 'cat_id', 'cats',
  'image_url', 'oversea_goods', 'is_draft', 'goods_name_prefix', 'name_prefix', 'size_spec_id', 'is_gold_price_matched', 'instruction_vo',
  'third_type', 'cat_ids', 'bad_fruit_claim', 'tiny_name', 'size_parent_spec_id', 'is_shop', 'goods_type', 'invoice_status', 'privacy_delivery',
  'invoice_mode', 'zhi_huan_bu_xiu', 'quan_guo_lian_bao', 'second_hand', 'is_two_num_group', 'is_pre_sale', 'pre_sale_time', 'country_id',
  'origin_country_id', 'warehouse', 'customs', 'is_customs', 'shipment_limit_second', 'delivery_type', 'cost_template_id', 'is_all_weight_same',
  'groups', 'is_folt', 'is_refundable', 'thawed_refund', 'damage_claim', 'lack_of_weight_claim', 'goods_certificate', 'goods_pattern', 'customizable',
  'local_service_id_list', 'shop_group_id', 'schedule_sale', 'card_verification_list', 'is_spring_festival_open_tag', 'transport_type_list',
  'is_refundable_fifteen_day', 'is_warranty_one_year', 'medical_device_confirm', 'extend_warranty_dto', 'is_refundable_thirty_day',
  'invoice_mode_sub_type', 'is_certificate_provide', 'is_customized', 'same_city_template_id', 'allergy_refund', 'is_wp_service', 'quality_package',
  'is_size_change_casually', 'red_butt_no_worry', 'quality_certificate_id_list', 'goods_srv_templates', 'is_only_for_remote_area',
  'elec_goods_attributes', 'delivery_one_day', 'is_sku_shipment', 'mai_jia_zi_ti', 'shang_men_an_zhuang', 'song_huo_an_zhuang', 'song_huo_ru_hu',
  'qualification_id_list', 'market_price', 'out_goods_sn', 'two_pieces_discount', 'is_size_spec_sync_detail', 'gold_price_template_id',
  'processing_charges', 'processing_charges_type', 'is_sku_pre_sale', 'is_group_pre_sale', 'goods_property_group', 'jing_fang_info', 'is_goods_copy',
] as const

/** Pinduoduo's 套餐 spec, the sale property every SKU name is a value of. */
export const PACKAGE_SPEC = { id: 20_711, name: '套餐' } as const

/**
 * Upload one image to Pinduoduo's image store.
 * @param page - a seller page.
 * @param bytes - the image file.
 * @param name - its file name.
 * @returns the image's address.
 * @throws SkillError failed with the store's message when it refuses.
 */
export async function uploadPddImage(page: Page, bytes: Uint8Array, name: string): Promise<string> {
  const { signature } = await pddCall<{ signature: string }>(page, 'POST', '/galerie/business/get_signature', { bucket_tag: 'mms-goods-image' })
  const answer = await within(page.evaluate<{ url?: string; error_msg?: string }>(`(async () => {
  const bytes = Uint8Array.from(atob(${JSON.stringify(Buffer.from(bytes).toString('base64'))}), c => c.charCodeAt(0))
  const form = new FormData()
  form.append('upload_sign', ${JSON.stringify(signature)})
  form.append('image', new Blob([bytes]), ${JSON.stringify(name)})
  const r = await fetch('https://file.pinduoduo.com/v3/store_image', { method: 'POST', body: form })
  try { return await r.json() } catch (e) { return { error_msg: 'HTTP ' + r.status } }
})()`), 120_000, `上传图片 ${name}`)
  if (answer.url === undefined) throw new SkillError(`上传图片 ${name} 失败（${answer.error_msg ?? '无应答'}）。`, EXIT.failed)
  return answer.url
}

/**
 * The 套餐 spec value of a SKU name, made when Pinduoduo has none.
 * @param page - a seller page.
 * @param catId - the category.
 * @param name - the SKU name.
 * @returns the spec value's id.
 */
export function specIdFor(page: Page, catId: string, name: string): Promise<number> {
  return pddCall<number>(page, 'POST', '/glide/v2/mms/query/spec/by/name', { parent_id: PACKAGE_SPEC.id, name, cat_id: Number(catId) })
}

/**
 * Read an edit session's values.
 * @param page - a seller page.
 * @param session - the session.
 * @returns its detail.
 */
export function readSession(page: Page, session: EditSession): Promise<Record<string, unknown>> {
  return pddCall<Record<string, unknown>>(page, 'POST', '/glide/v2/mms/query/commit/detail', { goods_commit_id: session.commitId })
}

/**
 * Save the form, as 「保存草稿」 does.
 * @param page - a seller page.
 * @param form - the form.
 * @throws PddRefusal with Pinduoduo's message when it refuses; SkillError failed when no answer came in time.
 */
export async function saveDraft(page: Page, form: Readonly<Record<string, unknown>>): Promise<void> {
  await within(pddCall(page, 'POST', '/glide/mms/goodsCommit/action/edit', form), 180_000, '保存草稿')
}

/** A draft in the 草稿箱. */
export interface DraftRow {
  readonly draftId: string
  readonly goodsId: string
  readonly title: string
}

/**
 * Every draft in the store's 草稿箱.
 * @param page - a seller page.
 * @returns the drafts, newest first.
 */
export async function listDrafts(page: Page): Promise<DraftRow[]> {
  const rows: DraftRow[] = []
  for (let start = 0; start < 1000; start += 50) {
    const found = await pddCall<{ total: number; list?: readonly { id: number; goods_id: number; goods_name: string }[] | null }>(
      page, 'POST', '/glide/v2/mms/query/commit/list', { start, length: 50 },
    )
    for (const row of found.list ?? []) rows.push({ draftId: String(row.id), goodsId: String(row.goods_id), title: row.goods_name })
    if (start + 50 >= found.total) break
  }
  return rows
}

/**
 * The store's items whose titles carry words, on sale or not.
 * @param page - a seller page.
 * @param keyword - the words.
 * @returns the items.
 */
export async function listGoods(page: Page, keyword: string): Promise<{ goodsId: string; title: string }[]> {
  const found = await pddCall<{ goods_list?: readonly { id: number; goods_name: string }[] | null }>(
    page, 'POST', '/vodka/v2/mms/query/display/mall/goodsList', { page: 1, size: 50, keywords: [keyword] },
  )
  return (found.goods_list ?? []).map(item => ({ goodsId: String(item.id), title: item.goods_name }))
}

/** The prices a draft gives besides its SKU prices: how much more buying alone costs, and the reference price. */
export interface ExtraPrices {
  readonly singleDelta: number
  readonly market: number
}

const numberOf = (check: FieldCheck | undefined): number => Number((check?.filled?.join('') ?? '').replace(/[元¥￥\s]/gu, ''))

/**
 * Read the extra prices from the checks, or say why they cannot be used.
 * @param checks - the draft's checks.
 * @param skuPrices - the SKUs' group prices, in yuan.
 * @returns the prices, or the problems.
 */
export function extraPrices(checks: readonly FieldCheck[], skuPrices: readonly number[]): ExtraPrices | { readonly problems: string[] } {
  const singleDelta = numberOf(checks.find(check => check.key === 'singlePriceDelta'))
  const market = numberOf(checks.find(check => check.key === 'marketPrice'))
  const problems: string[] = []
  if (!(singleDelta > 0)) problems.push('单买价比拼单价高（元）应是大于 0 的数')
  const highest = Math.max(...skuPrices) + (singleDelta > 0 ? singleDelta : 0)
  if (!(market > highest)) problems.push(`参考价（元）应高于最高的单买价 ${highest.toFixed(2)}`)
  return problems.length > 0 ? { problems } : { singleDelta, market }
}

/**
 * A shelf life written as a number of days, from 「5年」「18个月」「30天」 or a bare number of days.
 * @param text - the value.
 * @returns the days, or the text when it is none of these.
 */
export function shelfDays(text: string): string {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(年|个月|月|天|日)?\s*$/u.exec(text)
  if (match === null) return text
  const amount = Number(match[1])
  const days = match[2] === '年' ? amount * 365 : match[2] === '个月' || match[2] === '月' ? amount * 30 : amount
  return String(Math.round(days))
}

/**
 * The category properties the form submits: a chosen value by its id, free text as its value.
 * @param template - the category's template.
 * @param checks - the draft's checks.
 * @returns the form's `goods_properties`.
 */
export function goodsProperties(template: Template, checks: readonly FieldCheck[]): object[] {
  const entries: object[] = []
  for (const module of template.modules) {
    for (const property of module.propertys ?? []) {
      const values = checks.find(check => check.key === propertyKey(property))?.filled
      if (values === undefined || values.length === 0) continue
      const base = { template_pid: property.id, template_module_id: module.id, ref_pid: property.ref_pid, pid: property.pid }
      entries.push(...propertyEntries(property, values, base))
    }
  }
  return entries
}

function propertyEntries(property: TemplateProperty, values: readonly string[], base: object): object[] {
  const unit = property.value_unit ?? ''
  if (property.control_type !== 1) {
    const value = unit === '天' ? shelfDays(values.join('')) : values.join('')
    return [{ ...base, vid: 0, value, value_unit: unit }]
  }
  const options = property.values?.content ?? []
  return values.flatMap((text) => {
    const option = options.find(item => item.value === text)
    return option === undefined ? [] : [{ ...base, vid: option.vid, value: '', value_unit: unit, content: option.value }]
  })
}

/** What goes into the form besides the session's own values. */
export interface GoodsInput {
  readonly draft: DraftFile
  readonly checks: readonly FieldCheck[]
  readonly rules: PublishRules
  readonly template: Template
  readonly session: EditSession
  /** Each draft image's address, by its path under the material folder. */
  readonly images: Readonly<Record<string, string>>
  /** Each SKU name's 套餐 spec value id. */
  readonly specs: Readonly<Record<string, number>>
  readonly prices: ExtraPrices
  /** The stock of SKUs the table gives none. */
  readonly stock: number
}

const cents = (yuan: number): number => Math.round(yuan * 100)

/**
 * Build the form `goodsCommit/action/edit` saves: the session's values with the draft set in.
 * @param detail - the session's detail.
 * @param input - the draft and what was uploaded and made for it.
 * @returns the form.
 */
export function buildGoods(detail: Readonly<Record<string, unknown>>, input: GoodsInput): Record<string, unknown> {
  const { draft, checks, session, images, specs, prices } = input
  const form: Record<string, unknown> = Object.fromEntries(SESSION_FIELDS.map(field => [field, detail[field]]))
  const title = titleOf(draft)
  const main = draft.images.main.slice(0, 10).map(file => images[file] as string)
  const shipmentText = checks.find(check => check.key === 'shipment')?.filled?.[0]
  const shipment = input.rules.fields.find(field => field.key === 'shipment')?.options?.find(option => option.text === shipmentText)?.value
  const code = commonPrefix(draft.skus.flatMap(sku => sku.code === undefined ? [] : [sku.code]))
  Object.assign(form, {
    goods_commit_id: String(session.commitId), goods_id: session.goodsId, cat_id: Number(input.rules.catId),
    goods_name: title, goods_desc: title, pre_sale_time: '', country_id: '0', is_auto_save: false,
    gallery: [
      ...main.map(url => ({ url, type: 1, file_id: null })),
      ...draft.images.detail.map(file => ({ url: images[file] as string, type: 2, file_id: null })),
    ],
    goods_properties: goodsProperties(input.template, checks),
    skus: draft.skus.map(sku => ({
      id: 0, limit_quantity: 0, out_sku_sn: sku.code ?? '', is_onsale: 1,
      multi_price_in_yuan: sku.price.toFixed(2), price_in_yuan: (sku.price + prices.singleDelta).toFixed(2),
      multi_price: cents(sku.price), price: cents(sku.price + prices.singleDelta), quantity_delta: sku.stock ?? input.stock,
      thumb_url: sku.image === undefined ? main[0] : images[sku.image], weight: 0,
      spec: [{ parent_id: PACKAGE_SPEC.id, parent_name: PACKAGE_SPEC.name, spec_id: specs[sku.name], spec_name: sku.name, is_custom: 0 }],
    })),
    market_price: cents(prices.market), market_price_in_yuan: prices.market.toFixed(2),
    ...shipment === undefined ? {} : { shipment_limit_second: shipment },
    ...code === '' ? {} : { out_goods_sn: code },
  })
  return form
}
