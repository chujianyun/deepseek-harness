/**
 * Douyin shop categories and their field rules. Categories come from the category search
 * (`searchCategoryN`), the store's own category tree (`categoryOptionsN?display_all=0`, only the categories
 * the store opened), a category's path (`getCategoryDetail`), or Douyin's prediction from the main image
 * and title (`predictCategoryN`, an asynchronous task the same call reports on). A category's fields
 * are read from the new-item page's own form once the page loaded the category: category properties,
 * the qualifications with the store's qualification library, freight templates, and shipping times.
 */

import { doudianCall, FIND_STORE } from './doudian.ts'
import { EXIT, SkillError } from './errors.ts'
import type { Page } from './page.ts'
import type { FieldRule, PublishRules } from './publish-rules.ts'

/** A category, and whether the store may publish in it. */
export interface DoudianCategory {
  readonly id: string
  readonly path: readonly string[]
  /** Its top-level category is one the store opened. */
  readonly usable: boolean
}

/** A category line as search, detail, and prediction answer it. */
interface CategoryLine {
  readonly first_cid?: number | null
  readonly second_cid?: number | null
  readonly third_cid?: number | null
  readonly fourth_cid?: number | null
  readonly first_name?: string | null
  readonly second_name?: string | null
  readonly third_name?: string | null
  readonly fourth_name?: string | null
  readonly first_cname?: string | null
  readonly second_cname?: string | null
  readonly third_cname?: string | null
  readonly fourth_cname?: string | null
}

/**
 * Read a category line.
 * @param line - one entry of a search, detail, or prediction answer.
 * @param opened - the top-level categories the store opened.
 * @returns the category, its deepest level as its id; nothing for a line without one.
 */
export function categoryOfLine(line: CategoryLine, opened: ReadonlySet<string>): DoudianCategory | undefined {
  const ids = [line.first_cid, line.second_cid, line.third_cid, line.fourth_cid]
  const names = [
    line.first_name ?? line.first_cname, line.second_name ?? line.second_cname,
    line.third_name ?? line.third_cname, line.fourth_name ?? line.fourth_cname,
  ]
  const depth = ids.findLastIndex(id => typeof id === 'number' && id > 0)
  if (depth < 0) return undefined
  return { id: String(ids[depth]), path: names.slice(0, depth + 1).map(name => name ?? ''), usable: opened.has(String(ids[0])) }
}

/** One level of the store's category tree. */
export interface DoudianChild {
  readonly id: string
  readonly name: string
  readonly leaf: boolean
}

/**
 * The categories the store opened under one category.
 * @param page - a seller page.
 * @param parentId - the parent, `0` for the top level.
 * @returns the children.
 */
export async function childCategories(page: Page, parentId: string): Promise<DoudianChild[]> {
  const data = await doudianCall<readonly { id: number; name: string; is_leaf: boolean }[] | null>(
    page, 'GET', `/product/tproduct/categoryOptionsN?cid=${encodeURIComponent(parentId)}&display_all=0`,
  )
  return (data ?? []).map(child => ({ id: String(child.id), name: child.name, leaf: child.is_leaf }))
}

/**
 * The top-level categories the store opened.
 * @param page - a seller page.
 * @returns their ids.
 */
export async function openedTops(page: Page): Promise<Set<string>> {
  return new Set((await childCategories(page, '0')).map(child => child.id))
}

/**
 * Categories for a product name.
 * @param page - a seller page.
 * @param keyword - the product name.
 * @returns the categories, best first.
 */
export async function searchCategories(page: Page, keyword: string): Promise<DoudianCategory[]> {
  const opened = await openedTops(page)
  const data = await doudianCall<readonly CategoryLine[] | null>(page, 'GET', `/product/tproduct/searchCategoryN?key=${encodeURIComponent(keyword)}`)
  return (data ?? []).flatMap(line => categoryOfLine(line, opened) ?? [])
}

/**
 * A category by its id.
 * @param page - a seller page.
 * @param catId - the category.
 * @returns the category.
 * @throws SkillError usage when Douyin shop has no such category.
 */
export async function categoryById(page: Page, catId: string): Promise<DoudianCategory> {
  const opened = await openedTops(page)
  const data = await doudianCall<readonly CategoryLine[] | null>(page, 'GET', `/product/tproduct/getCategoryDetail?category_leaf_ids=${encodeURIComponent(catId)}`)
  const found = data?.[0] === undefined ? undefined : categoryOfLine(data[0], opened)
  if (found === undefined) throw new SkillError(`抖店没有类目 ${catId}。`, EXIT.usage)
  return found
}

/** A prediction task's state. */
interface Prediction {
  readonly candidate_category_details?: readonly CategoryLine[] | null
  readonly async_task_id?: string
  readonly async_task_status?: string
}

/**
 * Categories Douyin shop predicts from the main image and title.
 * @param page - the new-item page, whose form store names the publish session.
 * @param imageUrl - the main image, uploaded.
 * @param title - the title.
 * @returns the categories, best first.
 * @throws SkillError failed when the prediction does not finish in time.
 */
export async function predictCategories(page: Page, imageUrl: string, title: string): Promise<DoudianCategory[]> {
  const opened = await openedTops(page)
  await page.evaluate<boolean>(FIND_STORE)
  const publishId = await page.evaluate<string | null>('window.__dshGoodsStore ? String(window.__dshGoodsStore.publishId ?? "") : null')
  const body = { scene: 'predict_by_title_and_img', pic: [{ url: imageUrl }], title, publish_id: publishId ?? '', is_auction_or_mass: false }
  let found = await doudianCall<Prediction>(page, 'POST', '/product/tproduct/predictCategoryN', body)
  const taskId = found.async_task_id
  if (taskId !== undefined && taskId !== '' && found.candidate_category_details == null) {
    // The same call with the task id answers the task's state, and its candidates once it is done.
    const done = await page.waitFor(async () => {
      found = await doudianCall<Prediction>(page, 'POST', '/product/tproduct/predictCategoryN', { ...body, async_task_id: taskId })
      return found.candidate_category_details != null || found.async_task_status === 'failed'
    }, 32_000)
    if (!done) throw new SkillError('抖店按主图和标题推荐类目超时，请改用 --keyword。', EXIT.failed)
  }
  return (found.candidate_category_details ?? []).flatMap(line => categoryOfLine(line, opened) ?? [])
}

/** A choice of the new-item form. */
interface Choice {
  readonly label: string
  readonly value: string
}

/** A value a category property offers. */
interface PropertyOption {
  readonly value_id: string
  readonly value_name: string
  readonly additions?: { readonly brand_cn_name?: string } | null
}

/** A category property as the new-item form lists it. */
export interface FormProperty {
  readonly id: string
  readonly label: string
  readonly required: boolean
  readonly options?: readonly PropertyOption[]
  readonly additions?: { readonly ui_type?: string } | null
}

/** A qualification the category asks for, with the store's qualification library for it. */
export interface FormQualification {
  readonly id: string
  readonly label: string
  readonly required: boolean
  readonly options: readonly { readonly value: string; readonly label: string; readonly urls: readonly string[] }[]
}

/** What the new-item form of a category holds. */
export interface DoudianForm {
  readonly properties: readonly FormProperty[]
  readonly qualifications: readonly FormQualification[]
  readonly freight: readonly Choice[]
  readonly delivery: readonly Choice[]
  /** The kinds of proof a reference price may have. */
  readonly proofTypes: readonly Choice[]
}

/**
 * Reads the category's form from the new-item page's store: the category properties, the qualifications
 * with their library options, and the freight and shipping-time choices.
 */
export const READ_FORM = `(() => {
  const s = window.__dshGoodsStore
  if (!s) return null
  const extra = key => s.form.node(key).extra || {}
  // Copied through JSON: the store's arrays are observable proxies.
  return JSON.parse(JSON.stringify({
    properties: (extra('category_properties').items || []).map(p => ({
      id: String(p.id), label: p.label, required: !!p.required, options: Array.isArray(p.options) ? p.options : undefined, additions: p.additions && { ui_type: p.additions.ui_type },
    })),
    qualifications: (extra('qualification').items || []).map(q => ({
      id: String(q.id), label: q.label, required: !!q.required,
      options: ((q.items && q.items[0] && q.items[0].options) || []).map(o => ({ value: String(o.value), label: o.label, urls: ((o.additions && o.additions.quality_attachments) || []).map(a => a.url) })),
    })),
    freight: Array.isArray(extra('freight_id').options) ? extra('freight_id').options : [],
    delivery: Array.isArray(extra('delivery_delay_day').options) ? extra('delivery_delay_day').options : [],
    proofTypes: Array.isArray(extra('reference_price_certificate_type').options) ? extra('reference_price_certificate_type').options : [],
  }))
})()`

/**
 * Read a category's form from the new-item page opened in that category, once the page loaded it and
 * the store's qualification library.
 * @param page - the new-item page in the category.
 * @returns the form.
 * @throws SkillError failed when the page holds no form.
 */
export async function readForm(page: Page): Promise<DoudianForm> {
  const read: { form: DoudianForm | null } = { form: null }
  await page.waitFor(async () => {
    read.form = await page.evaluate<DoudianForm | null>(READ_FORM)
    const { form } = read
    return form !== null && form.properties.length > 0 && form.qualifications.every(item => !item.required || item.options.length > 0)
  }, 30_000)
  if (read.form === null) throw new SkillError('抖店发品页没有给出表单，页面可能已改版。', EXIT.failed)
  return read.form
}

/** The key a category property is checked under. */
export const propertyKey = (id: string): string => `p-${id}`

/** The key a qualification is checked under. */
export const qualificationKey = (id: string): string => `q-${id}`

/**
 * Write a category's form as field rules: title, main and detail images, the category properties,
 * the qualifications chosen from the store's library, SKUs and their stock, the freight template, the
 * shipping time, the weight (which only a template charging by weight asks for), and the reference
 * price with the kind and image of its proof (Douyin shop takes a reference price only with a proof).
 * @param catId - the category.
 * @param path - its path.
 * @param form - its form.
 * @returns the rules.
 */
export function doudianRules(catId: string, path: readonly string[], form: DoudianForm): PublishRules {
  const properties = form.properties.map((property): FieldRule => {
    const options = property.options?.map(option => ({ value: option.value_id, text: option.value_name }))
    const multi = property.additions?.ui_type?.includes('multi') === true
    return {
      key: propertyKey(property.id), label: property.label, uiType: options === undefined ? 'input' : multi ? 'checkbox' : 'select',
      required: property.required, propGroup: 'category_properties', visible: true, ...options === undefined ? {} : { options },
    }
  })
  const qualifications = form.qualifications.filter(item => item.required || item.options.length > 0).map((item): FieldRule => ({
    key: qualificationKey(item.id), label: `资质：${item.label}`, uiType: 'select', required: item.required, propGroup: 'qualification', visible: true,
    options: item.options.map(option => ({ value: option.value, text: option.label })),
  }))
  const choices = (items: readonly Choice[]) => items.map(item => ({ value: item.value, text: item.label }))
  return {
    catId, categoryPath: path.join(' > '),
    fields: [
      { key: 'title', label: '商品标题', uiType: 'input', required: true, visible: true, maxLength: 120 },
      { key: 'mainImagesGroup', label: '主图', uiType: 'image', required: true, visible: true },
      { key: 'descRepublicOfSell', label: '商品详情', uiType: 'image', required: true, visible: true },
      ...properties, ...qualifications,
      { key: 'sku', label: '商品规格', uiType: 'sku', required: true, visible: true },
      { key: 'quantity', label: '库存', uiType: 'input', required: true, visible: true },
      { key: 'freight', label: '运费模板', uiType: 'select', required: true, visible: true, options: choices(form.freight) },
      { key: 'delivery', label: '现货发货时间', uiType: 'radio', required: true, visible: true, options: choices(form.delivery) },
      { key: 'weight', label: '商品重量（克）', uiType: 'input', required: false, visible: true },
      { key: 'referencePrice', label: '参考价（元）', uiType: 'input', required: false, visible: true },
      { key: 'referenceProofType', label: '参考价凭证类型', uiType: 'select', required: false, visible: true, options: choices(form.proofTypes) },
      { key: 'referenceProof', label: '参考价凭证图（素材文件）', uiType: 'input', required: false, visible: true },
    ],
  }
}
