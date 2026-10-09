/**
 * Saving a confirmed product draft to a Tmall store's warehouse, the way Tmall's AI publishing page
 * saves its own form: in the publish page, the images go to a DSH folder of the store's image space
 * (`stream-upload.taobao.com/api/upload.api`; an image already there with the same MD5 is reused), the
 * form is the page's own values and defaults with the draft's values set, and the page's own request
 * helper, which adds the headers Tmall's gateway requires, sends it to `submit.htm` with the shelf time
 * 放入仓库, so nothing goes on sale. The item is then looked up in the warehouse; only an item found
 * there counts as saved.
 */

import type { Draft, FieldCheck } from './draft.ts'
import { EXIT, SkillError } from './errors.ts'
import { commonPrefix } from './publish-common.ts'
import { ownItems, type OwnItem } from './publish-category.ts'
import type { FieldRule, PublishRules } from './publish-rules.ts'
import type { Page } from './page.ts'

/** The image space folder DSH puts the images of the items it publishes in. */
export const FOLDER_NAME = 'DSH发品'

/** An image in the store's image space. */
export interface Uploaded {
  /** The picture's id in the image space. */
  readonly id: string
  readonly url: string
  readonly width: number
  readonly height: number
  readonly size: number
}

/** What the publish page holds before anything is filled in. */
export interface PageBase {
  /** The page's global values: the item id it reserved, its trace, and the rest it submits as they are. */
  readonly global: Readonly<Record<string, unknown>>
  /**
   * Each field's value as the page opened, by field name, such as the store's default ship-from place;
   * layout blocks and dialogs left out.
   */
  readonly defaults: Readonly<Record<string, unknown>>
  /** The SKU table's measurement column, such as 规格数量 with its unit, when the category has one. */
  readonly measurement?: { readonly name: string; readonly unit: { readonly value: string | number; readonly text: string } }
}

/** Reads the page's global values, field defaults, and SKU measurement column. */
export const READ_BASE = `(() => {
  const j = window.Json2
  if (!j || !j.components || !j.models || !j.models.global) return null
  const defaults = {}
  let measurement
  for (const c of Object.values(j.components)) {
    const p = c.props || {}
    if (p.name && p.value !== undefined && p.value !== null && !['block', 'feedbackDialog', 'tmSkuCheck'].includes(c.type)) defaults[p.name] = p.value
    if (p.name === 'sku' && p.attributes) {
      for (const a of Object.values(p.attributes)) {
        const unit = a.uiType === 'skuMeasurement' && (a.structItems || []).find(item => item.isUnit)
        if (unit && unit.dataSource && unit.dataSource[0]) measurement = { name: a.name, unit: unit.dataSource[0] }
      }
    }
  }
  return { global: j.models.global.value, defaults, measurement }
})()`

/**
 * Read the publish page's starting values.
 * @param page - the publish page of the category.
 * @returns the values.
 * @throws SkillError failed when the page carries no form.
 */
export async function readBase(page: Page): Promise<PageBase> {
  const read: { base: PageBase | null } = { base: null }
  await page.waitFor(async () => (read.base = await page.evaluate<PageBase | null>(READ_BASE)) !== null, 20_000)
  if (read.base === null) throw new SkillError('天猫发布页没有给出表单，页面可能已改版。', EXIT.failed)
  return read.base
}

/**
 * Wait for a call in the page, but not forever.
 * @param work - the call.
 * @param ms - how long it may take.
 * @param what - the step, for the message.
 * @returns what the call answered.
 * @throws SkillError failed when it takes longer.
 */
export function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { reject(new SkillError(`${what}超过 ${String(Math.round(ms / 1000))} 秒没有结果。`, EXIT.failed)) }, ms)
  })
  return Promise.race([work, late]).finally(() => { clearTimeout(timer) })
}

/** Calls the page's signed mtop with an API and data, answering `{ data }` or `{ ret }` on failure. */
function mtopCall(api: string, data: object): string {
  return `(async () => {
  const r = await window.lib.mtop.request({ api: ${JSON.stringify(api)}, v: '1.0', data: ${JSON.stringify(data)} }).catch(e => e)
  return r && r.data ? { data: r.data } : { ret: String((r && r.ret) || r) }
})()`
}

/**
 * The DSH folder of the store's image space, made when missing.
 * @param page - a seller page with the signed mtop, such as the publish page.
 * @returns the folder id.
 * @throws SkillError failed when the image space cannot be read or the folder cannot be made.
 */
export async function ensureFolder(page: Page): Promise<string> {
  const listed = await within(page.evaluate<{ data?: { dirs?: { children?: readonly { id: string; name: string }[] } }; ret?: string }>(
    mtopCall('mtop.taobao.picturecenter.console.dir.query', {}),
  ), 60_000, '读取图片空间')
  if (listed.data === undefined) throw new SkillError(`读取图片空间失败（${listed.ret ?? ''}）。`, EXIT.failed)
  const found = listed.data.dirs?.children?.find(dir => dir.name === FOLDER_NAME)
  if (found !== undefined) return found.id
  const added = await within(page.evaluate<{ data?: { jsPictureCategoryDO?: { pictureCategoryId?: string } }; ret?: string }>(
    mtopCall('mtop.taobao.picturecenter.console.dir.add', { dirId: '0', name: FOLDER_NAME }),
  ), 60_000, '新建图片空间文件夹')
  const id = added.data?.jsPictureCategoryDO?.pictureCategoryId
  if (id === undefined) throw new SkillError(`在图片空间新建「${FOLDER_NAME}」文件夹失败（${added.ret ?? '无应答'}）。`, EXIT.failed)
  return id
}

/** A file of the image space as `file.query` lists it. */
interface PictureFile {
  readonly md5: string
  readonly pictureId: string
  readonly fullUrl: string
  /** Its size, such as 800x800. */
  readonly pixel: string
  /** Its bytes, as text. */
  readonly sizes: string
}

/**
 * The images already in a folder of the store's image space, by MD5.
 * @param page - a seller page with the signed mtop.
 * @param folderId - the folder.
 * @returns each image by the MD5 of its file.
 */
export async function folderImages(page: Page, folderId: string): Promise<Map<string, Uploaded>> {
  const images = new Map<string, Uploaded>()
  for (let at = 1; at <= 20; at++) {
    const answer = await within(page.evaluate<{ data?: { fileModule?: readonly PictureFile[] } }>(
      mtopCall('mtop.taobao.picturecenter.console.file.query', { page: at, deleted: 0, status: 0, ignoreCat: 0, clientType: 0, catId: folderId, type: 1 }),
    ), 60_000, '读取图片空间里的图片')
    const files = answer.data?.fileModule ?? []
    for (const file of files) {
      const [width = 0, height = 0] = file.pixel.split('x').map(Number)
      images.set(file.md5, { id: file.pictureId, url: file.fullUrl, width, height, size: Number(file.sizes) })
    }
    if (files.length === 0) break
  }
  return images
}

/**
 * Upload one image to a folder of the store's image space.
 * @param page - the publish page.
 * @param bytes - the image file.
 * @param name - its file name.
 * @param folderId - the folder.
 * @returns where the image now is and its size.
 * @throws SkillError failed with the platform's message when the upload is refused.
 */
export async function uploadImage(page: Page, bytes: Uint8Array, name: string, folderId: string): Promise<Uploaded> {
  const answer = await within(page.evaluate<{ object?: { fileId: string; url: string; pix: string; size: string }; message?: string; status?: number }>(`(async () => {
  const bytes = Uint8Array.from(atob(${JSON.stringify(Buffer.from(bytes).toString('base64'))}), c => c.charCodeAt(0))
  const token = (document.cookie.match(/_tb_token_=([^;]+)/) || [])[1] || ''
  const form = new FormData()
  form.append('water', 'false')
  form.append('name', ${JSON.stringify(name)})
  form.append('_tb_token_', token)
  form.append('file', new Blob([bytes]), ${JSON.stringify(name)})
  const r = await fetch('https://stream-upload.taobao.com/api/upload.api?_input_charset=utf-8&appkey=tu&folderId=' + ${JSON.stringify(folderId)}
    + '&picCompress=false&watermark=false', { method: 'POST', body: form, credentials: 'include' })
  try { return await r.json() } catch (e) { return { message: 'HTTP ' + r.status } }
})()`), 120_000, `上传图片 ${name}`)
  if (answer.object === undefined) throw new SkillError(`上传图片 ${name} 失败（${answer.message ?? '无应答'}）。`, EXIT.failed)
  const [width = 0, height = 0] = answer.object.pix.split('x').map(Number)
  return { id: answer.object.fileId, url: answer.object.url, width, height, size: Number(answer.object.size) }
}

/** What goes into the form besides the page's own values. */
export interface FormInput {
  readonly draft: Draft
  readonly checks: readonly FieldCheck[]
  readonly rules: PublishRules
  /** Each draft image, by its path under the material folder. */
  readonly images: Readonly<Record<string, Uploaded>>
  /** The stock of each SKU, by SKU index, for SKUs whose table has none. */
  readonly stock: number
}

const pix = (image: Uploaded) => ({ url: image.url, pix: `${String(image.width)}x${String(image.height)}`, width: image.width, height: image.height, size: image.size })

/**
 * The value a category property or other option field submits for a check's values.
 * @param field - the field's rule.
 * @param values - the values to submit.
 * @returns the form value: an option `{ value, text }`, a custom value with its text as value, or plain text.
 */
export function optionValue(field: FieldRule, values: readonly string[]): unknown {
  const one = (text: string) => {
    const option = field.options?.find(o => o.text === text)
    return option === undefined ? { value: text, text } : { value: option.value, text: option.text }
  }
  if (field.options === undefined) return values.join('')
  return field.uiType.toLowerCase().includes('checkbox') ? values.map(one) : one(values[0] as string)
}

/**
 * Build the form `submit.htm` saves: the page's defaults and global values, with the draft set into them.
 * @param base - the page's starting values.
 * @param input - the draft, its checks, rules, uploaded images, and stock.
 * @returns the form values.
 */
export function buildForm(base: PageBase, input: FormInput): Record<string, unknown> {
  const { draft, checks, rules, images } = input
  const form: Record<string, unknown> = { ...base.defaults, ...base.global }
  const uploaded = (file: string) => images[file] as Uploaded
  const value = (key: string) => checks.find(check => check.key === key)?.filled
  const text = (key: string) => value(key)?.join('')
  if (text('title') !== undefined) form.title = { title: [text('title')] }
  if (text('shopping_title') !== undefined) form.shopping_title = { title: [text('shopping_title')] }
  if (text('tmSubTitle') !== undefined) form.tmSubTitle = text('tmSubTitle')
  form.mainImagesGroup = { images: draft.images.main.slice(0, 5).map(file => ({ url: uploaded(file).url })) }
  if (draft.images.main34.length > 0) form.threeToFourImages = draft.images.main34.slice(0, 5).map(file => pix(uploaded(file)))
  if (draft.images.white.length > 0) form.yinHeWhiteBgImage = [pix(uploaded(draft.images.white[0] as string))]
  if (draft.images.transparent.length > 0) form.guideImageGroup = { whiteBgImage: [pix(uploaded(draft.images.transparent[0] as string))] }
  for (const field of rules.fields) {
    const filled = value(field.key)
    if (field.propGroup === undefined || filled === undefined || field.propGroup === 'enhancedPageTemplate') continue
    form[field.propGroup] = { ...form[field.propGroup] as object, [field.key]: optionValue(field, filled) }
  }
  for (const field of rules.fields.filter(rule => rule.declaration === true)) {
    const check = checks.find(item => item.key === field.key)
    if (check?.status === '已确认') form[field.key] = [{ value: String(field.options?.[0]?.value ?? '1') }]
  }
  const delivery = rules.fields.find(field => field.key === 'tmDeliveryTime')
  const deliveryText = text('tmDeliveryTime')
  const deliveryOption = delivery?.options?.find(option => option.text === deliveryText)
  if (deliveryOption !== undefined) form.tmDeliveryTime = { type: String(deliveryOption.value), value: null, setBySku: false }
  if (text('auctionPoint') !== undefined) form.auctionPoint = text('auctionPoint')
  const colors = draft.skus.map((sku, at) => ({
    text: sku.name, value: -(at + 1), name: 'p-1627207', label: '颜色分类',
    ...sku.image === undefined ? {} : { img: uploaded(sku.image).url, pix: `${String(uploaded(sku.image).width)}x${String(uploaded(sku.image).height)}` },
  }))
  form.saleProp = { 'p-1627207': colors.map(({ name: _name, label: _label, ...color }) => color) }
  form.sku = draft.skus.map((sku, at) => ({
    cspuId: null, skuId: null, skuStatus: 1, action: { selected: true },
    skuPrice: sku.price.toFixed(2), skuStock: String(sku.stock ?? input.stock),
    skuQuality: { value: 'mainSku', text: '单品' }, props: [colors[at]], salePropKey: `1627207-${String(colors[at]?.value)}`,
    ...sku.code === undefined ? {} : { skuOuterId: sku.code },
    ...base.measurement === undefined || sku.count === undefined ? {} : {
      [base.measurement.name]: {
        text: `${String(sku.count)}${base.measurement.unit.text}`, isEmptyItem: false,
        structItems: { 'ts-1': String(sku.count), 'ts-2': base.measurement.unit },
      },
    },
  }))
  form.price = Number(text('price') ?? Math.min(...draft.skus.map(sku => sku.price)))
  form.quantity = String(draft.skus.reduce((sum, sku) => sum + (sku.stock ?? input.stock), 0))
  const outerId = text('outerId') ?? commonPrefix(draft.skus.flatMap(sku => sku.code === undefined ? [] : [sku.code]))
  if (outerId !== '') form.outerId = outerId
  form.shelfTime = { ...base.defaults.shelfTime as object, type: 2 }
  form.descRepublicOfSell = description(base, draft.images.detail.map(uploaded))
  return form
}

/**
 * The detail editor's value with the detail images, as the editor commits them: one picture module
 * each, at the image's own size, both as the editor's module tree (`templateContent`) and as its image
 * list (`detailParam`), with the editor settings the page rendered it with.
 */
function description(base: PageBase, details: readonly Uploaded[]): unknown {
  const value = base.defaults.descRepublicOfSell as
    { descPageCommitParam?: Record<string, unknown>; descPageRenderParam?: Record<string, unknown> } | undefined
  const render = value?.descPageRenderParam ?? {}
  const stamp = String(Date.now())
  const suffix = (at: number) => at === 0 ? '' : `-${String(at)}`
  const groupId = (at: number) => `group${stamp}${suffix(at)}`
  const groups = details.map((image, at) => ({
    type: 'group', hide: false, bizCode: 0, propertyPanelVisible: true, level: 1, position: 'middle', groupName: '模块', scenario: 'wde', bizName: '图文模块',
    boxStyle: { 'background-color': '#ffffff', width: image.width, height: image.height }, groupId: groupId(at), id: groupId(at),
    components: [{
      type: 'component', level: 2, sellerEditable: true, componentName: '图片组件', clipType: 'rect', componentType: 'pic', isEdit: false, selected: false,
      boxStyle: { rotate: 0, 'z-index': 0, top: 0, left: 0, width: image.width, height: image.height, 'background-image': image.url },
      imgStyle: { top: 0, left: 0, width: image.width, height: image.height },
      picMeta: { width: image.width, height: image.height, size: image.size, id: Number(image.id) },
      componentId: `component${stamp}${suffix(at)}`, groupId: groupId(at),
    }],
  }))
  const params = details.map((image, at) => ({
    groupId: groupId(at), width: image.width, height: image.height, size: image.size, imageUrls: [image.url],
    splitHeight: 1240, originImg: false, imageIds: [-1],
  }))
  return {
    descPageCommitParam: {
      ...value?.descPageCommitParam, opt: 2, changed: true, editType: 'lite', bseller: false,
      catId: render.catId, descDomain: render.descDomain, descVersion: render.descVersion,
      detailHeight: details.reduce((sum, image) => sum + image.height, 0),
      templateContent: JSON.stringify({ groups, sellergroups: [] }),
      detailParam: JSON.stringify({ params }),
    },
  }
}

/** What `submit.htm` answered. */
export type SubmitAnswer = { readonly itemId: string; readonly auctionStatus: string } | { readonly errors: readonly string[] }

/**
 * Read `submit.htm`'s answer: a success address naming the saved item, or the form's error messages.
 * @param answer - the parsed answer.
 * @returns the saved item, or the errors.
 */
export function readSubmitAnswer(answer: unknown): SubmitAnswer {
  const models = (answer as { models?: Record<string, unknown> } | null)?.models ?? {}
  const success = (models.globalMessage as { successUrl?: string } | undefined)?.successUrl
  const itemId = success === undefined ? undefined : /primaryId=(\d+)/u.exec(success)?.[1]
  if (itemId !== undefined) return { itemId, auctionStatus: /auctionStatus=(-?\d+)/u.exec(success as string)?.[1] ?? '' }
  const errors: string[] = []
  const visit = (node: unknown, key: string): void => {
    if (typeof node === 'string' && (key === 'msg' || key === 'message') && node !== '') errors.push(node.replace(/<[^>]+>/gu, ''))
    else if (node !== null && typeof node === 'object') for (const [name, child] of Object.entries(node)) visit(child, name)
  }
  visit(models, '')
  return { errors: errors.length === 0 ? [JSON.stringify(answer).slice(0, 300)] : [...new Set(errors)] }
}

/**
 * Save the form with `submit.htm`, as the publish page does.
 * @param page - the publish page.
 * @param base - the page's starting values.
 * @param form - the form values.
 * @returns the saved item, or the errors; an answer that cannot be read is an error naming it.
 */
export async function submit(page: Page, base: PageBase, form: Readonly<Record<string, unknown>>): Promise<SubmitAnswer> {
  const id = String(base.global.id)
  const body = new URLSearchParams({
    catId: String(base.global.catId), itemId: id, jsonBody: JSON.stringify(form), copyItemMode: '0',
    globalExtendInfo: JSON.stringify({ startTraceId: base.global.gpfRenderTrace, fromAIPublish: 'true', id, noIcmp: 'true' }),
  }).toString()
  const answer = await within(page.evaluate<unknown>(`(async () => {
  const app = window.GlobalStore && window.GlobalStore.app
  if (!app || typeof app.request !== 'function') return { models: { globalMessage: { message: '发布页没有提交用的请求方法，页面可能已改版' } } }
  const data = Object.fromEntries(new URLSearchParams(${JSON.stringify(body)}))
  try { return await app.request({ url: '/tmall/submit.htm', method: 'POST', data }) } catch (e) { return { models: { globalMessage: { message: String((e && e.message) || e) } } } }
})()`), 180_000, '提交到天猫')
  return readSubmitAnswer(answer)
}

/** The item manager's tabs: every item, items on sale, and the warehouse. */
export type ManagerTab = 'all' | 'on_sale' | 'in_stock'

/** The most rows the item manager answers for one query. */
export const MANAGER_ROWS = 20

/**
 * Look for the store's items in one tab of the item manager.
 * @param page - the item manager tab.
 * @param filter - `queryItemId` or `queryTitle`.
 * @param tab - where to look.
 * @returns the matching items, at most {@link MANAGER_ROWS}.
 */
export function listed(page: Page, filter: Readonly<Record<string, string>>, tab: ManagerTab): Promise<OwnItem[]> {
  return ownItems(page, filter, MANAGER_ROWS, tab)
}
