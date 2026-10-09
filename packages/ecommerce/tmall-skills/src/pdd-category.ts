/**
 * Pinduoduo categories and their field rules, read the way the seller app's new-item pages read them:
 * categories by product name (`search/categories/v2`), by the main image and title
 * (`category/predict/list`, which needs an edit session), or one level at a time (`categories?parentId=`);
 * a category's fields from its property template (`draco-ms/mms/template/mall`) and its publish limits
 * (`query/rules/limit/new`). The fields are written as the field rules `ecommerce-product-draft` checks.
 */

import { EXIT, SkillError } from './errors.ts'
import { pddCall } from './pdd.ts'
import type { Page } from './page.ts'
import type { FieldRule, PublishRules } from './publish-rules.ts'

/** A category the store may publish in, or may not. */
export interface PddCategory {
  /** The leaf category's id. */
  readonly id: string
  readonly path: readonly string[]
  /** The store may publish in it; a category it lacks the qualification for is not. */
  readonly usable: boolean
}

/** A category line as search and prediction answer it: up to four levels. */
interface CategoryLine {
  readonly cat_id_1?: number | null | undefined
  readonly cat_id_2?: number | null | undefined
  readonly cat_id_3?: number | null | undefined
  readonly cat_id_4?: number | null | undefined
  readonly cat_name_1?: string | null | undefined
  readonly cat_name_2?: string | null | undefined
  readonly cat_name_3?: string | null | undefined
  readonly cat_name_4?: string | null | undefined
  readonly optional?: boolean
  readonly cat_qualification_detail?: { readonly inValid?: boolean } | null
}

/**
 * Read a category line.
 * @param line - one entry of a search or prediction answer.
 * @returns the category, its deepest level as its id; nothing for a line without one.
 */
export function categoryOfLine(line: CategoryLine): PddCategory | undefined {
  const ids = [line.cat_id_1, line.cat_id_2, line.cat_id_3, line.cat_id_4]
  const names = [line.cat_name_1, line.cat_name_2, line.cat_name_3, line.cat_name_4]
  const depth = ids.findLastIndex(id => typeof id === 'number' && id > 0)
  if (depth < 0) return undefined
  return {
    id: String(ids[depth]), path: names.slice(0, depth + 1).map(name => name ?? ''),
    usable: line.optional !== false && line.cat_qualification_detail?.inValid !== true,
  }
}

/**
 * Categories for a product name, as the category page's search finds them.
 * @param page - a seller page.
 * @param keyword - the product name.
 * @returns the categories, best first.
 */
export async function searchCategories(page: Page, keyword: string): Promise<PddCategory[]> {
  const found = await pddCall<{ cat_info_v2_lists?: readonly CategoryLine[] | null }>(page, 'GET', `/vodka/v2/mms/search/categories/v2?keyword=${encodeURIComponent(keyword)}`)
  return (found.cat_info_v2_lists ?? []).flatMap(line => categoryOfLine(line) ?? [])
}

/**
 * Categories Pinduoduo predicts for an item from its main image and title.
 * @param page - a seller page.
 * @param goodsId - the item id of an edit session.
 * @param imageUrl - the main image, uploaded.
 * @param title - the title.
 * @returns the categories, best first.
 */
export async function predictCategories(page: Page, goodsId: number, imageUrl: string, title: string): Promise<PddCategory[]> {
  const found = await pddCall<readonly CategoryLine[] | null>(page, 'POST', '/vodka/v2/mms/category/predict/list', { goodsId, imageUrl, source: 0, goodsName: title })
  return (found ?? []).flatMap(line => categoryOfLine(line) ?? [])
}

/** One level of the category tree. */
export interface PddChild {
  readonly id: string
  readonly name: string
  readonly leaf: boolean
}

/**
 * The categories under one category.
 * @param page - a seller page.
 * @param parentId - the parent, `0` for the top level.
 * @returns the children.
 */
export async function childCategories(page: Page, parentId: string): Promise<PddChild[]> {
  const children = await pddCall<readonly { id: number; cat_name: string; leaf?: number | null }[] | null>(page, 'GET', `/vodka/v2/mms/categories?parentId=${encodeURIComponent(parentId)}`)
  return (children ?? []).map(child => ({ id: String(child.id), name: child.cat_name, leaf: child.leaf === 1 }))
}

/**
 * A category's path, by its id.
 * @param page - a seller page.
 * @param catId - the category.
 * @returns the category; whether the store holds the category's qualification is not known here, so it reads usable.
 * @throws SkillError usage when Pinduoduo has no such category.
 */
export async function categoryById(page: Page, catId: string): Promise<PddCategory> {
  type Names = { cat_id_1_name?: string; cat_id_2_name?: string; cat_id_3_name?: string; cat_id_4_name?: string }
  type Detail = CategoryLine & Names & { id?: number }
  const detail = await pddCall<Detail | null>(
    page, 'GET', `/vodka/v2/mms/category/detail?catId=${encodeURIComponent(catId)}`,
  )
  if (detail?.id === undefined) throw new SkillError(`拼多多没有类目 ${catId}。`, EXIT.usage)
  return categoryOfLine({ optional: true,
    cat_id_1: detail.cat_id_1, cat_id_2: detail.cat_id_2, cat_id_3: detail.cat_id_3, cat_id_4: detail.cat_id_4,
    cat_name_1: detail.cat_id_1_name, cat_name_2: detail.cat_id_2_name, cat_name_3: detail.cat_id_3_name, cat_name_4: detail.cat_id_4_name,
  }) ?? { id: catId, path: [], usable: true }
}

/** An edit session: the item and commit ids a new item gets before anything is saved. */
export interface EditSession {
  readonly goodsId: number
  readonly commitId: number
}

/**
 * Start an edit session, as the category page does on opening; a session is not a draft until it is
 * saved. Pinduoduo refuses sessions started too often (「操作过于频繁」), so only a save and a prediction
 * start one.
 * @param page - a seller page.
 * @returns its ids.
 */
export async function createSession(page: Page): Promise<EditSession> {
  const created = await pddCall<{ goods_id: number; goods_commit_id: number }>(page, 'POST', '/glide/v2/mms/edit/commit/create_new', {})
  return { goodsId: created.goods_id, commitId: created.goods_commit_id }
}

/**
 * Put an edit session in a category, as choosing it on the category page does.
 * @param page - a seller page.
 * @param session - the session.
 * @param catId - the category.
 */
export async function setCategory(page: Page, session: EditSession, catId: string): Promise<void> {
  await pddCall(page, 'POST', '/glide/mms/goodsCommit/action/update_goods_commit_info', {
    cat_id: Number(catId), goods_commit_id: session.commitId, goods_id: session.goodsId, gallery: [], goods_name: '',
  })
}

/** A property of a category's template. */
export interface TemplateProperty {
  /** The template's own id for it (`template_pid`). */
  readonly id: number
  readonly ref_pid: number
  readonly pid: number
  readonly name_alias: string
  readonly required: boolean
  /** `1` chooses from the values, `0` is free text, `5` a date. */
  readonly control_type: number
  /** How many values may be chosen; `0` for free text. */
  readonly choose_max_num: number
  readonly value_unit?: string
  readonly values?: { readonly content?: readonly { readonly vid: number; readonly value: string }[] } | null
}

/** A category's property template, as `template/mall` answers it. */
export interface Template {
  readonly id: number
  readonly modules: readonly { readonly id: number; readonly propertys?: readonly TemplateProperty[] | null }[]
}

/**
 * Read a category's property template.
 * @param page - a seller page.
 * @param catId - the category.
 * @returns the template.
 */
export function readTemplate(page: Page, catId: string): Promise<Template> {
  return pddCall<Template>(page, 'GET', `/draco-ms/mms/template/mall?catId=${encodeURIComponent(catId)}`)
}

/** The publish limits `rules/limit/new` answers that the form uses. */
export interface Limits {
  /** The ship-within choices, in seconds. */
  readonly shipment_limit_second?: readonly number[] | null
  readonly goods_title_length_limit?: number | null
}

/**
 * Read a category's publish limits for an ordinary item.
 * @param page - a seller page.
 * @param catId - the category.
 * @returns the limits.
 */
export function readLimits(page: Page, catId: string): Promise<Limits> {
  return pddCall<Limits>(page, 'POST', '/glide/v2/mms/query/rules/limit/new', { cat_id: Number(catId), goods_type: 1 })
}

/** The key a template property is checked under. */
export const propertyKey = (property: Pick<TemplateProperty, 'ref_pid'>): string => `p-${String(property.ref_pid)}`

/** The fields every Pinduoduo item has besides its category's properties. */
const SINGLE_PRICE: FieldRule = { key: 'singlePriceDelta', label: '单买价比拼单价高（元）', uiType: 'input', required: true, visible: true }
const MARKET_PRICE: FieldRule = { key: 'marketPrice', label: '参考价（元）', uiType: 'input', required: true, visible: true }

/**
 * Write a category's template and limits as field rules: title, carousel and detail images, the
 * category's properties, SKUs and their stock, ship-within time, the single-buy markup over the group
 * price, and the reference price.
 * @param catId - the category.
 * @param path - its path.
 * @param template - its property template.
 * @param limits - its publish limits.
 * @returns the rules.
 */
export function pddRules(catId: string, path: readonly string[], template: Template, limits: Limits): PublishRules {
  const properties = template.modules.flatMap(module => module.propertys ?? []).map((property): FieldRule => {
    const options = property.values?.content?.map(value => ({ value: value.vid, text: value.value }))
    const uiType = property.control_type === 1 ? property.choose_max_num > 1 ? 'checkbox' : 'select' : property.control_type === 5 ? 'date' : 'input'
    return {
      key: propertyKey(property), label: property.name_alias, uiType, required: property.required, propGroup: 'goods_properties', visible: true,
      ...options === undefined || property.control_type !== 1 ? {} : { options },
    }
  })
  const shipment = (limits.shipment_limit_second ?? [172_800]).map(seconds => ({ value: seconds, text: `${String(seconds / 3600)}小时` }))
  return {
    catId, categoryPath: path.join(' > '),
    fields: [
      { key: 'title', label: '商品标题', uiType: 'input', required: true, visible: true, maxLength: limits.goods_title_length_limit ?? 60 },
      { key: 'mainImagesGroup', label: '商品轮播图', uiType: 'image', required: true, visible: true },
      { key: 'descRepublicOfSell', label: '商品详情', uiType: 'image', required: true, visible: true },
      ...properties,
      { key: 'sku', label: '商品规格', uiType: 'sku', required: true, visible: true },
      { key: 'quantity', label: '库存', uiType: 'input', required: true, visible: true },
      { key: 'shipment', label: '发货时间', uiType: 'radio', required: true, visible: true, options: shipment },
      SINGLE_PRICE, MARKET_PRICE,
    ],
  }
}
