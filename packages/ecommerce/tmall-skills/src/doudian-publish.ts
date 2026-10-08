/**
 * Saving a confirmed product draft to a Douyin shop's 草稿箱, the way the new-item page's 「保存草稿」 does:
 * the images go to the shop's material store (`/product/img/batchupload`), the draft's values are set
 * into the page's own form store, and the page's own draft save (`addWithSchema?check_status=1`) sends
 * them, with 商品状态 下架. The page refuses any other submit while DSH holds it, and the form is checked
 * to be 下架 before the save; nothing is submitted for review or put on sale.
 */

import type { FieldCheck } from './draft.ts'
import { doudianCall, FIND_STORE, GUARD } from './doudian.ts'
import { libraryText, propertyKey, qualificationKey, type DoudianForm } from './doudian-category.ts'
import { EXIT, SkillError } from './errors.ts'
import type { Page } from './page.ts'
import { titleOf, type DraftFile } from './publish-common.ts'
import type { PublishRules } from './publish-rules.ts'
import { within } from './publish-submit.ts'

/**
 * Upload one image to the shop's material store, through the page's signed request.
 * @param page - a seller page.
 * @param bytes - the image file.
 * @param name - its file name.
 * @returns the image's address.
 * @throws SkillError failed with the store's message when it refuses.
 */
export async function uploadDoudianImage(page: Page, bytes: Uint8Array, name: string): Promise<string> {
  const answer = await within(page.evaluate<{ code?: number; msg?: string; data?: readonly string[] }>(`new Promise((resolve) => {
  const bytes = Uint8Array.from(atob(${JSON.stringify(Buffer.from(bytes).toString('base64'))}), c => c.charCodeAt(0))
  const form = new FormData()
  form.append('image', new Blob([bytes]), ${JSON.stringify(name)})
  form.append('extra', JSON.stringify({ request_source: 'pc' }))
  const x = new XMLHttpRequest()
  x.open('POST', '/product/img/batchupload?appid=1&_bid=ffa_goods')
  x.withCredentials = true
  x.onload = () => { try { resolve(JSON.parse(x.responseText)) } catch (e) { resolve({ msg: 'HTTP ' + x.status }) } }
  x.onerror = () => resolve({ msg: 'network error' })
  x.send(form)
})`), 120_000, `上传图片 ${name}`)
  const url = answer.data?.[0]
  if (answer.code !== 0 || url === undefined) throw new SkillError(`上传图片 ${name} 失败（${answer.msg ?? '无应答'}）。`, EXIT.failed)
  return url
}

/** The weight and reference price a draft gives besides its SKUs; each is optional. */
export interface Extras {
  readonly weightGrams?: number
  readonly referencePrice?: number
  /** The kind of the reference price's proof, as the form's option value. */
  readonly proofType?: string
  /** The proof image, a path under the material folder. */
  readonly proofFile?: string
}

const textOf = (checks: readonly FieldCheck[], key: string): string | undefined => checks.find(check => check.key === key)?.filled?.join('').trim() || undefined
const numberIn = (text: string | undefined): number | undefined => text === undefined ? undefined : Number(text.replace(/[元克gG¥￥\s]/gu, ''))

/**
 * Read the weight and the reference price from the checks, or say why they cannot be used: a weight
 * must be above 0, and a reference price must not be below the highest SKU price nor reach ten times it,
 * and needs the kind and image of its proof.
 * @param checks - the draft's checks.
 * @param skuPrices - the SKUs' prices, in yuan.
 * @param rules - the category's rules, which list the proof kinds.
 * @returns the values, or the problems.
 */
export function extras(
  checks: readonly FieldCheck[], skuPrices: readonly number[], rules: PublishRules,
): Extras | { readonly problems: string[] } {
  const weightGrams = numberIn(textOf(checks, 'weight'))
  const referencePrice = numberIn(textOf(checks, 'referencePrice'))
  const proofText = textOf(checks, 'referenceProofType')
  const proofType = rules.fields.find(field => field.key === 'referenceProofType')?.options?.find(option => option.text === proofText)?.value
  const proofFile = textOf(checks, 'referenceProof')
  const highest = Math.max(...skuPrices)
  const problems: string[] = []
  if (weightGrams !== undefined && !(weightGrams > 0)) problems.push('商品重量（克）应是大于 0 的数')
  if (referencePrice !== undefined) {
    if (!(referencePrice >= highest && referencePrice < highest * 10)) problems.push(`参考价（元）应不低于最高售价 ${highest.toFixed(2)}，且低于它的 10 倍`)
    if (proofType === undefined || proofFile === undefined) problems.push('设置参考价时，抖店要求同时给出参考价凭证类型和凭证图（素材文件）；不设参考价就把它去掉')
  }
  if (problems.length > 0) return { problems }
  return {
    ...weightGrams === undefined ? {} : { weightGrams }, ...referencePrice === undefined ? {} : { referencePrice },
    ...proofType === undefined ? {} : { proofType: String(proofType) }, ...proofFile === undefined ? {} : { proofFile },
  }
}

/** What goes into the form. */
export interface ValuesInput {
  readonly draft: DraftFile
  readonly checks: readonly FieldCheck[]
  readonly rules: PublishRules
  readonly form: DoudianForm
  /** Each draft image's address, by its path under the material folder. */
  readonly images: Readonly<Record<string, string>>
  readonly extras: Extras
  /** The stock of SKUs the table gives none. */
  readonly stock: number
  /** A number the spec and SKU ids start from, such as the time in microseconds. */
  readonly idBase: number
}

const filledOf = (checks: readonly FieldCheck[], key: string): readonly string[] | undefined =>
  checks.find(check => check.key === key)?.filled

/**
 * The form values to set, in two passes by form field. The first sets images, title, category
 * properties, qualifications, the 规格 spec with one value per SKU, the SKUs, the detail, freight,
 * shipping time, whether there is a reference price, and 商品状态 下架; the second sets the fields the
 * page opens only after the first: the weight and the reference price with its proof.
 * @param input - the draft and what was uploaded for it.
 * @returns the two passes.
 */
export function formValues(input: ValuesInput): { readonly first: Record<string, unknown>; readonly second: Record<string, unknown> } {
  const { draft, checks, rules, form, images, extras: given, idBase } = input
  const main = draft.images.main.slice(0, 5).map(file => images[file] as string)
  const properties: Record<string, object[]> = {}
  for (const property of form.properties) {
    const values = filledOf(checks, propertyKey(property.id))
    if (values === undefined || values.length === 0) continue
    properties[property.id] = values.map((text) => {
      const option = property.options?.find(item => item.value_name === text)
      const brand = option?.additions?.brand_cn_name
      return { diy_type: 0, measure_info: null, tags: brand === undefined ? null : { brand_cn_name: brand }, value_id: option?.value_id ?? '', value_name: text }
    })
  }
  const qualifications: Record<string, object> = {}
  for (const item of form.qualifications) {
    const chosen = filledOf(checks, qualificationKey(item.id))?.[0]
    const option = item.options.find(entry => libraryText(item, entry) === chosen)
    if (option === undefined) continue
    qualifications[item.id] = { select_attachments: [{
      quality_attachment_id: option.value, quality_attachments: option.urls.map(url => ({ media_type: 1, url })),
      quality_content_name: option.label, quality_key: item.id, quality_name: item.label,
    }] }
  }
  const choice = (key: string) => rules.fields.find(field => field.key === key)?.options
    ?.find(option => option.text === filledOf(checks, key)?.[0])?.value
  const specId = String(idBase)
  const valueIds = draft.skus.map((_sku, at) => String(idBase + at + 1))
  const freight = choice('freight')
  const delivery = choice('delivery')
  const first = {
    pic: main.map(url => ({ url })),
    title: titleOf(draft),
    category_properties: properties,
    qualification: qualifications,
    spec_detail: [{
      id: specId, name: '规格',
      spec_values: draft.skus.map((sku, at) => ({
        id: valueIds[at], img_url: sku.image === undefined ? main[0] : images[sku.image], name: sku.name,
      })),
    }],
    sku_detail: draft.skus.map((sku, at) => ({
      id: valueIds[at], code: sku.code ?? '', price: sku.price.toFixed(2), sku_status: true, spec_detail_ids: [valueIds[at]],
      stock_info: { stock_inc_num: 0, stock_num: sku.stock ?? input.stock, use_cargo_stock: false },
    })),
    description: `<p>${draft.images.detail.map(file => `<img src="${images[file] as string}" style="max-width:100%;"/>`).join('')}</p>`,
    ...freight === undefined ? {} : { freight_id: String(freight) },
    ...delivery === undefined ? {} : { delivery_delay_day: String(delivery) },
    reference_price_enable: given.referencePrice !== undefined,
    start_sale_type: '1',
  }
  const second = {
    ...given.weightGrams === undefined ? {} : { weight_unit: '1', weight_value: String(given.weightGrams) },
    ...given.referencePrice === undefined ? {} : {
      reference_price: given.referencePrice.toFixed(2), reference_price_certificate_type: given.proofType,
      reference_price_certificate_urls: [images[given.proofFile as string]],
    },
  }
  return { first, second }
}

/**
 * Sets the first pass into the page's form store, lets the page open the fields it depends on, sets the
 * second pass (a weight only where the freight template shows the field), checks the form is 下架 and
 * holds the reference price that was set, and runs the page's own draft save. Answers `{ product_id }`,
 * `{ refused }` with the page's error, `{ notOffSale }`, `{ needsWeight }` when the freight template asks
 * for a weight the draft lacks, `{ dropped }` naming a value the form left out, or `{ notReady }` when the
 * form could not be set; in all but the first nothing is sent.
 */
const SAVE = (first: Readonly<Record<string, unknown>>, second: Readonly<Record<string, unknown>>) => `(async () => {
  const s = window.__dshGoodsStore
  const second = ${JSON.stringify(second)}
  let model
  try {
    for (const [key, value] of Object.entries(${JSON.stringify(first)})) s.form.node(key).setValue(value)
    await new Promise(resolve => setTimeout(resolve, 4000))
    const weightShown = (() => { const n = s.form.node('weight_unit'); return !!n && n.state.visible !== false && 'weight_unit' in s.formatSchemaData().model })()
    for (const [key, value] of Object.entries(second)) if (!key.startsWith('weight') || weightShown) s.form.node(key).setValue(value)
    await new Promise(resolve => setTimeout(resolve, 1500))
    model = s.formatSchemaData().model
    if (!model.start_sale_type || model.start_sale_type.value !== '1') return { notOffSale: true }
    if (weightShown && !('weight_value' in second)) return { needsWeight: true }
  } catch (e) { return { notReady: String((e && e.message) || e) } }
  // A weight the freight template does not ask for stays out of the form; a reference price may not.
  const dropped = Object.keys(second).filter(key => key.startsWith('reference_price')).find(key => !model[key] || model[key].value == null || model[key].value === '')
  if (dropped) return { dropped }
  try { return await s.publishStore.saveGoods({ showLoading: false }) } catch (e) { return { refused: String((e && (e.message || e.msg)) || e) } }
})()`

/**
 * Save the draft in the new-item page opened in its category.
 * @param page - the new-item page.
 * @param values - the two passes of form values.
 * @returns the saved product's id.
 * @throws NotSent when the form cannot be set, is not 下架, left out the reference price, or the freight
 *   template asks for a weight the draft lacks; DraftRefused when Douyin shop refuses the draft; SkillError failed when
 *   no answer comes in time.
 */
export async function saveDraft(page: Page, values: ReturnType<typeof formValues>): Promise<string> {
  if (!await page.evaluate<boolean>(FIND_STORE)) throw new SkillError('抖店发品页没有给出表单，页面可能已改版。', EXIT.failed)
  await page.evaluate<boolean>(GUARD)
  type Answer = { product_id?: string; refused?: string; notOffSale?: boolean; needsWeight?: boolean; dropped?: string; notReady?: string }
  const answer = await within(page.evaluate<Answer>(
    SAVE(values.first, values.second),
  ), 180_000, '保存草稿')
  if (answer.notOffSale === true) throw new NotSent('表单的商品状态不是「下架」，没有保存。', EXIT.failed)
  if (answer.needsWeight === true) throw new NotSent('选的运费模板要按重量计费，需要商品重量（克）；没有保存。请用户补上重量后再存。', EXIT.usage)
  if (answer.dropped !== undefined) throw new NotSent(`抖店发品页没有接受 ${answer.dropped} 的值，没有保存。`, EXIT.failed)
  if (answer.notReady !== undefined) throw new NotSent(`抖店发品页的表单写不进去（${answer.notReady}），没有保存。`, EXIT.failed)
  if (answer.product_id === undefined) throw new DraftRefused(`抖店没有保存草稿，原因：${answer.refused ?? '无应答'}`, EXIT.failed)
  return answer.product_id
}

/** Douyin shop answered the draft save and refused it. */
export class DraftRefused extends SkillError {}

/** The form was not ready to save, so nothing was sent. */
export class NotSent extends SkillError {}

/** A product of the shop as its lists show it. */
export interface ShopProduct {
  readonly productId: string
  readonly title: string
  /** `1` while it is a draft. */
  readonly draftStatus: number
  /** `0` on sale, `1` off sale. */
  readonly status: number
}

interface ListRow { readonly product_id: string; readonly name: string; readonly draft_status?: number; readonly status?: number }

const rowOf = (row: ListRow): ShopProduct => ({
  productId: row.product_id, title: row.name, draftStatus: row.draft_status ?? 0, status: row.status ?? 0,
})

/**
 * The drafts in the 草稿箱, newest first.
 * @param page - a seller page.
 * @param most - how many to read; a page of 50 at a time.
 * @returns the drafts.
 */
export async function listDrafts(page: Page, most = 1000): Promise<ShopProduct[]> {
  const rows: ShopProduct[] = []
  for (let at = 0; at * 50 < most; at++) {
    const data = await doudianCall<readonly ListRow[] | null>(
      page, 'GET', `/product/tproduct/list?page=${String(at)}&pageSize=50&is_drafting=1&draft_time_sort=desc&order_field=draft_time&not_for_sale_search_type=1&tab=draft`,
    )
    rows.push(...(data ?? []).map(rowOf))
    if ((data ?? []).length < 50) break
  }
  return rows
}

/**
 * The shop's products, drafts included, whose id or title matches.
 * @param page - a seller page.
 * @param query - a product id or title words.
 * @returns the products.
 */
export async function findProducts(page: Page, query: string): Promise<ShopProduct[]> {
  const data = await doudianCall<readonly ListRow[] | null>(page, 'GET', `/product/tproduct/list?page=0&pageSize=50&product_id_and_name=${encodeURIComponent(query)}`)
  return (data ?? []).map(rowOf)
}

/**
 * The shop's products on sale whose id or title matches.
 * @param page - a seller page.
 * @param query - a product id or title words.
 * @returns the products on sale.
 */
export async function onSale(page: Page, query: string): Promise<ShopProduct[]> {
  const data = await doudianCall<readonly ListRow[] | null>(page, 'GET', `/product/tproduct/list?page=0&pageSize=50&status=0&check_status=3&product_id_and_name=${encodeURIComponent(query)}`)
  return (data ?? []).map(rowOf)
}
