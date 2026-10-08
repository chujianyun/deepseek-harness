/**
 * The product draft built from a material inventory and the model's answers: images by kind, SKUs
 * from the SKU table, and the item's values, each with where it came from. A draft is checked against a
 * category's field rules (from `tmall-publish-category`): which required fields are filled, which wait
 * for the user, which are missing, and which values break the platform's rules. Nothing is taken from
 * elsewhere to fill a missing material.
 */

import type { PublishMemory } from './account.ts'
import { beijingTime } from './dates.ts'
import type { FieldRule, PublishRules } from './publish-rules.ts'
import { KIND_LABEL, SKU_FIELD_LABEL, type ImageEntry, type ImageKind, type Inventory, type SkuField, type TableEntry } from './materials.ts'

/** Where a value came from. */
export type Source = '素材原值' | '店铺资料' | '沿用旧商品' | '模型生成' | '发品规则' | '店铺确认'

/** The sources the model may give for a value. */
export const ANSWER_SOURCES: readonly Source[] = ['素材原值', '店铺资料', '沿用旧商品', '模型生成']

/** A value and where it came from. */
export interface SourcedValue {
  readonly value: string | readonly string[]
  readonly source: Source
}

/** The model's answers about a folder, as the skill writes them to a JSON file. */
export interface Answers {
  /** Table header → SKU field, or `ignore`; overrides the suggested fields. */
  readonly columns?: Readonly<Record<string, SkuField | 'ignore'>>
  /** Image path → kind; settles images the rules left undecided or sorted wrongly. */
  readonly images?: Readonly<Record<string, ImageKind>>
  /** SKU image path → the SKU's index or name, when file numbers do not match the SKUs. */
  readonly skuImages?: Readonly<Record<string, string>>
  /** Field label → value, such as 商品标题 or 产地. */
  readonly values?: Readonly<Record<string, SourcedValue>>
}

/** One SKU of the draft. */
export interface DraftSku {
  readonly index: string
  readonly name: string
  readonly code?: string
  readonly count?: number
  readonly price: number
  readonly stock?: number
  /** The SKU image, a path under the folder. */
  readonly image?: string
}

/** A platform-independent product draft. */
export interface Draft {
  readonly folder: string
  /** Image paths by kind, in name order. */
  readonly images: Readonly<Record<ImageKind, readonly string[]>>
  /** The table the SKUs came from, as `file` or `file#sheet`. */
  readonly skuTable?: string
  readonly skus: readonly DraftSku[]
  readonly values: Readonly<Record<string, SourcedValue>>
  /** What the user must supply. */
  readonly missing: readonly string[]
  /** Values that broke a rule, and other things the user must fix. */
  readonly problems: readonly string[]
  /** Things worth a look that do not stop the draft. */
  readonly notes: readonly string[]
}

/** The values a draft always needs, which the model writes when the materials do not have them. */
export const GENERATED_LABELS = ['商品标题', '商品卖点', '导购标题'] as const

/**
 * Read the model's answers file.
 * @param text - the file's text.
 * @returns the answers.
 * @throws Error naming the first entry that is not as described.
 */
export function parseAnswers(text: string): Answers {
  const json: unknown = JSON.parse(text)
  const record = (value: unknown, name: string): Record<string, unknown> => {
    if (value === undefined) return {}
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} 应是对象`)
    return value as Record<string, unknown>
  }
  const root = record(json, '答案文件')
  const fields = [...Object.keys(SKU_FIELD_LABEL), 'ignore']
  for (const [header, field] of Object.entries(record(root.columns, 'columns'))) {
    if (typeof field !== 'string' || !fields.includes(field)) throw new Error(`columns.${header} 应是 ${fields.join('/')} 之一`)
  }
  for (const [file, kind] of Object.entries(record(root.images, 'images'))) {
    if (typeof kind !== 'string' || !Object.hasOwn(KIND_LABEL, kind)) throw new Error(`images.${file} 应是 ${Object.keys(KIND_LABEL).join('/')} 之一`)
  }
  for (const [file, sku] of Object.entries(record(root.skuImages, 'skuImages'))) {
    if (typeof sku !== 'string') throw new Error(`skuImages.${file} 应是 SKU 序号或名称`)
  }
  for (const [label, entry] of Object.entries(record(root.values, 'values'))) {
    const { value, source } = record(entry, `values.${label}`)
    const items: unknown[] = Array.isArray(value) ? value : [value]
    const text = items.length > 0 && items.every(item => typeof item === 'string' && item.trim() !== '')
    if (!text) throw new Error(`values.${label}.value 应是非空文字或非空文字列表`)
    if (!ANSWER_SOURCES.includes(source as Source)) throw new Error(`values.${label}.source 应是 ${ANSWER_SOURCES.join('/')} 之一`)
  }
  return root
}

/**
 * A number in a cell, such as `42.9`, `¥42.90`, or `1,000`.
 * @param cell - the cell text.
 * @returns the number, or undefined when the cell holds none.
 */
export function numberIn(cell: string): number | undefined {
  const text = cell.normalize('NFKC').replace(/[¥￥元,\s]/gu, '')
  return /^\d+(?:\.\d+)?$/u.test(text) ? Number(text) : undefined
}

/**
 * The table the SKUs are in: the one whose columns name the most SKU fields, needing a name and a price.
 * @param tables - the folder's tables.
 * @param columns - the model's header → field overrides.
 * @returns the table and each column's field, or undefined.
 */
function skuTableOf(tables: readonly TableEntry[], columns: Answers['columns']): { table: TableEntry; fields: (SkuField | undefined)[] } | undefined {
  const scored = tables.map((table) => {
    const fields = table.columns.map((column) => {
      const field = columns?.[column.header] ?? column.field
      return field === 'ignore' ? undefined : field
    })
    return { table, fields, score: new Set(fields.filter(field => field !== undefined)).size }
  }).filter(({ fields }) => fields.includes('name') && fields.includes('price'))
  return scored.sort((a, b) => b.score - a.score)[0]
}

/**
 * Build the draft.
 * @param inventory - what the folder holds.
 * @param answers - the model's answers.
 * @returns the draft.
 */
export function buildDraft(inventory: Inventory, answers: Answers): Draft {
  const missing: string[] = []
  const problems: string[] = []
  const notes: string[] = []
  const images = sortImages(inventory.images, answers.images ?? {}, problems)
  for (const image of inventory.images) for (const warning of image.warnings) notes.push(`${image.file}：${warning}`)
  for (const { file, error } of inventory.unreadable) notes.push(`${file} 读不出来：${error}`)
  if (images.unknown.length > 0) problems.push(`有 ${String(images.unknown.length)} 张图片还没归类：${images.unknown.join('、')}`)

  const found = skuTableOf(inventory.tables, answers.columns)
  const skus = found === undefined ? [] : readSkus(found.table, found.fields, problems, notes)
  if (found === undefined) missing.push('SKU 表（需要至少有 SKU 名称和价格两列）')
  matchSkuImages(skus, images.sku, answers.skuImages ?? {}, missing, problems)

  const values: Record<string, SourcedValue> = {}
  for (const [label, entry] of Object.entries(answers.values ?? {})) values[label] = entry
  for (const label of GENERATED_LABELS) if (values[label] === undefined) missing.push(`${label}（由模型根据素材生成，标「待确认」）`)
  return {
    folder: inventory.folder, images,
    ...found === undefined ? {} : { skuTable: found.table.sheet === '' ? found.table.file : `${found.table.file}#${found.table.sheet}` },
    skus: skus.map(({ sku }) => sku), values, missing, problems, notes,
  }
}

/** Group images by kind, the model's answers first. */
function sortImages(
  entries: readonly ImageEntry[], answers: Readonly<Record<string, ImageKind>>, problems: string[],
): Record<ImageKind, string[]> {
  const images = Object.fromEntries(Object.keys(KIND_LABEL).map(kind => [kind, [] as string[]])) as Record<ImageKind, string[]>
  for (const entry of entries) images[answers[entry.file] ?? entry.kind].push(entry.file)
  for (const file of Object.keys(answers)) if (!entries.some(entry => entry.file === file)) problems.push(`答案里的图片 ${file} 不在素材文件夹里`)
  return images
}

/** Read the SKU rows, checking each value by rule. */
function readSkus(
  table: TableEntry, fields: readonly (SkuField | undefined)[], problems: string[], notes: string[],
): { sku: DraftSku; row: number }[] {
  const column = (field: SkuField): number => fields.indexOf(field)
  const header = (field: SkuField): string => (table.columns[column(field)] as { header: string }).header
  const skus: { sku: DraftSku; row: number }[] = []
  table.rows.forEach((cells, at) => {
    const row = at + 2
    const cell = (field: SkuField): string | undefined => column(field) < 0 ? undefined : cells[column(field)]
    const name = cells[column('name')] as string
    const priceText = cells[column('price')] as string
    const price = numberIn(priceText)
    if (name === '') { problems.push(`SKU 表第 ${String(row)} 行没有 ${header('name')}`); return }
    if (price === undefined || price <= 0) { problems.push(`SKU「${name}」的${header('price')}「${priceText}」不是有效价格`); return }
    const whole = (field: SkuField): number | undefined => {
      const text = cell(field)
      if (text === undefined || text === '') return undefined
      const value = numberIn(text)
      if (value === undefined || !Number.isInteger(value)) problems.push(`SKU「${name}」的${header(field)}「${text}」不是整数`)
      return value
    }
    const count = whole('count')
    const stock = whole('stock')
    const unit = numberIn(cell('unitPrice') ?? '')
    if (unit !== undefined && count !== undefined && count > 0 && Math.abs(price / count - unit) > 0.01) {
      notes.push(`SKU「${name}」：${header('price')} ${String(price)} ÷ ${header('count')} ${String(count)} ≠ ${header('unitPrice')} ${String(unit)}，请核对`)
    }
    const code = cell('code')
    skus.push({ row, sku: {
      index: cell('index') || String(at + 1), name, price,
      ...code === undefined || code === '' ? {} : { code }, ...count === undefined ? {} : { count }, ...stock === undefined ? {} : { stock },
    } })
  })
  for (const field of ['name', 'code'] as const) {
    const seen = new Set<string>()
    for (const { sku } of skus) {
      const value = sku[field]
      if (value !== undefined && seen.has(value)) problems.push(`${SKU_FIELD_LABEL[field]}「${value}」重复`)
      if (value !== undefined) seen.add(value)
    }
  }
  return skus
}

/** The first number in a name, such as 3 in `sku3`, `SKU-03`, or `sku3_800x800`. */
function numberOf(name: string): string | undefined {
  return /\d+/u.exec(name)?.[0].replace(/^0+(?=\d)/u, '')
}

/**
 * Give each SKU its image: by the model's answer, else by the number in the file name matching the number
 * in the SKU's index (its row in the table when there is no index column). An image goes to one SKU only.
 */
function matchSkuImages(
  skus: { sku: DraftSku }[], files: readonly string[], answers: Readonly<Record<string, string>>, missing: string[], problems: string[],
): void {
  const used = new Set<string>()
  for (const entry of skus) {
    const number = numberOf(entry.sku.index)
    const free = files.filter(file => !used.has(file))
    const answered = free.find(file => answers[file] === entry.sku.index || answers[file] === entry.sku.name)
    const numbered = free.find(file => answers[file] === undefined && number !== undefined && numberOf(file.split('/').at(-1) as string) === number)
    const image = answered ?? numbered
    if (image === undefined) missing.push(`SKU「${entry.sku.name}」的 SKU 图`)
    else { used.add(image); entry.sku = { ...entry.sku, image } }
  }
  const unused = files.filter(file => !used.has(file))
  if (unused.length > 0 && skus.length > 0) problems.push(`这些 SKU 图对不上任何 SKU：${unused.join('、')}`)
}

/** The status of one form field in a check. */
export type FieldStatus = '已填' | '已确认' | '待确认' | '待店铺确认' | '缺失' | '不符合'

/** One form field as the draft fills it. */
export interface FieldCheck {
  readonly key: string
  readonly label: string
  readonly required: boolean
  readonly status: FieldStatus
  /** What goes in, for the user to read. */
  readonly value?: string
  /** The values to submit, options written as the platform lists them; for fields filled from a value. */
  readonly filled?: readonly string[]
  readonly source?: Source
  readonly note?: string
}

/**
 * A text compared the way the platform's options are: full-width forms folded, spaces dropped, 「其它」 read as 「其他」.
 * @param text - the text.
 * @returns the comparable text.
 */
export function optionKey(text: string): string {
  return text.normalize('NFKC').replace(/\s+/gu, '').replaceAll('其它', '其他')
}

/** Image fields and the kind that fills each, with the most images the platform takes. */
const IMAGE_FIELDS: Readonly<Record<string, readonly [ImageKind, number]>> = {
  mainImagesGroup: ['main', 5], threeToFourImages: ['main34', 5], yinHeWhiteBgImage: ['white', 1], guideImageGroup: ['transparent', 1], descRepublicOfSell: ['detail', 50],
}

/** Form fields filled from a value of the draft, by its label. */
const VALUE_FIELDS: Readonly<Record<string, string>> = { title: '商品标题', tmSubTitle: '商品卖点', shopping_title: '导购标题', outerId: '商家编码' }

/** Fields the draft does not fill: the category line and the SKU properties the SKU table fills. */
const SKIPPED: ReadonlySet<string> = new Set(['category', 'p-1627207'])

/**
 * A title's width as Tmall counts it: a Chinese character counts 2.
 * @param title - the title.
 * @returns the width.
 */
export function titleWidth(title: string): number {
  let width = 0
  for (const char of title) width += char.charCodeAt(0) > 0xff ? 2 : 1
  return width
}

/**
 * Check a draft against a category's field rules.
 * @param draft - the draft.
 * @param rules - the category's rules.
 * @param confirmed - declarations the store already confirmed for this category; one whose text changed since is asked again.
 * @returns every required field and every field the draft fills, in the form's order.
 */
export function checkDraft(draft: Draft, rules: PublishRules, confirmed: Confirmed = {}): FieldCheck[] {
  const checks: FieldCheck[] = []
  for (const field of rules.fields) {
    if (SKIPPED.has(field.key) || (!field.visible && draft.values[field.label] === undefined)) continue
    const check = checkField(field, draft, confirmed)
    if (!field.required && check.status === '缺失') continue
    checks.push(check.status === '缺失' && field.conditions !== undefined
      ? { ...check, note: [check.note, '页面有显示/必填条件，条件不成立时不需要'].filter(Boolean).join('；') }
      : check)
  }
  return checks
}

function checkField(field: FieldRule, draft: Draft, confirmed: Confirmed): FieldCheck {
  const base = { key: field.key, label: field.label, required: field.required }
  const image = IMAGE_FIELDS[field.key]
  if (image !== undefined) {
    const [kind, most] = image
    const files = draft.images[kind]
    if (files.length === 0) return { ...base, status: '缺失', note: `素材里没有${KIND_LABEL[kind]}` }
    return {
      ...base, status: '已填', source: '素材原值', value: `${String(Math.min(files.length, most))} 张`,
      ...files.length > most ? { note: `有 ${String(files.length)} 张，平台最多 ${String(most)} 张，只用前 ${String(most)} 张` } : {},
    }
  }
  if (field.declaration === true) {
    const text = field.options?.[0]?.text ?? field.label
    const remembered = confirmed[field.key]
    if (remembered?.text === text) {
      return { ...base, status: '已确认', source: '店铺确认', value: text, note: `店铺已于 ${beijingTime(new Date(remembered.confirmedAt))}（北京时间）确认` }
    }
    return { ...base, status: '待店铺确认', value: text, ...remembered === undefined ? {} : { note: '声明文字已变，需要重新确认' } }
  }
  switch (field.key) {
    case 'shelfTime': return { ...base, status: '已填', source: '发品规则', value: '放入仓库' }
    case 'sku':
      return draft.skus.length === 0 ? { ...base, status: '缺失', note: '没有 SKU' } : { ...base, status: '已填', source: '素材原值', value: `${String(draft.skus.length)} 个 SKU` }
    case 'price': return checkPrice(base, draft)
    case 'quantity': {
      if (draft.skus.length > 0 && draft.skus.every(sku => sku.stock !== undefined)) {
        return { ...base, status: '已填', source: '素材原值', value: String(draft.skus.reduce((sum, sku) => sum + (sku.stock as number), 0)) }
      }
      return fromValue(base, field, draft.values[field.label] ?? draft.values['库存'], '每个 SKU 的库存')
    }
  }
  const saleProp = field.key.startsWith('p-') && field.propGroup === undefined
  return fromValue(base, field, draft.values[VALUE_FIELDS[field.key] ?? field.label] ?? findByKey(draft.values, field.label), saleProp ? '销售属性的值（SKU 表只填颜色分类）' : undefined)
}

/** A value whose label matches the field's once compared like options. */
function findByKey(values: Readonly<Record<string, SourcedValue>>, label: string): SourcedValue | undefined {
  return Object.entries(values).find(([key]) => optionKey(key) === optionKey(label))?.[1]
}

/** The 一口价: the given one, else the lowest SKU price; it must equal one SKU's price. */
function checkPrice(base: Pick<FieldCheck, 'key' | 'label' | 'required'>, draft: Draft): FieldCheck {
  const given = draft.values['一口价']
  const prices = draft.skus.map(sku => sku.price)
  if (given === undefined && prices.length === 0) return { ...base, status: '缺失', note: '没有 SKU 价格' }
  const price = given === undefined ? Math.min(...prices) : numberIn(String(given.value))
  const source = given?.source ?? '素材原值'
  if (price === undefined) return { ...base, status: '不符合', source, value: String(given?.value), note: '一口价不是数字' }
  if (prices.length > 0 && !prices.includes(price)) {
    return { ...base, status: '不符合', source, value: String(price), note: `一口价必须等于某个 SKU 的价格（${prices.join('、')}）` }
  }
  return { ...base, status: source === '模型生成' ? '待确认' : '已填', source, value: String(price), ...given === undefined ? { note: '取最低的 SKU 价格' } : {} }
}

/** A field filled from a sourced value, its options normalized. */
function fromValue(base: Pick<FieldCheck, 'key' | 'label' | 'required'>, field: FieldRule, entry: SourcedValue | undefined, needed?: string): FieldCheck {
  if (entry === undefined) return { ...base, status: '缺失', ...needed === undefined ? {} : { note: `需要${needed}` } }
  const status: FieldStatus = entry.source === '模型生成' ? '待确认' : '已填'
  const values = (typeof entry.value === 'string' ? [entry.value] : entry.value).map(value => value.replace(/\s+/gu, ' ').trim())
  const notes: string[] = []
  const normalized = values.map((value) => {
    if (field.options === undefined) return value
    const option = field.options.find(o => optionKey(o.text) === optionKey(value))
    if (option !== undefined) {
      if (option.text !== value) notes.push(`「${value}」已按平台可选值写成「${option.text}」`)
      return option.text
    }
    notes.push(field.allowsCustom === true ? `「${value}」不在可选值里，作为自定义值` : `「${value}」不在可选值里`)
    return value
  })
  const options = field.options ?? []
  const refused = field.options !== undefined && field.allowsCustom !== true
    && normalized.some(value => !options.some(o => o.text === value))
  const width = titleWidth(normalized.join(''))
  const tooWide = field.maxLength !== undefined && width > field.maxLength
  if (tooWide) notes.push(`宽度 ${String(width)}，天猫最多 ${String(field.maxLength)}（汉字算 2）`)
  return {
    ...base, status: refused || tooWide ? '不符合' : status, source: entry.source, value: normalized.join('、'), filled: normalized,
    ...notes.length === 0 ? {} : { note: notes.join('；') },
  }
}

/** Declarations the store confirmed for one category: declaration key → the text it confirmed and when. */
export type Confirmed = Readonly<Record<string, { readonly text: string; readonly confirmedAt: string }>>

/** The answers with the company's memory for one store applied, and what came from the memory. */
export interface Remembered {
  readonly answers: Answers
  /** Declarations the store confirmed for the category, empty without one. */
  readonly confirmed: Confirmed
  readonly notes: readonly string[]
}

/**
 * Apply what the company remembered for a store under the model's answers: the store's values and the
 * remembered table headers fill what the answers leave out, and the store's confirmed declarations for
 * the category are passed on. The answers win where both have an entry. With rules, only values of
 * fields the category's form shows are taken, so a value remembered for another category stays out.
 * @param answers - the model's answers.
 * @param memory - the company's publishing memory.
 * @param store - the store the item is for.
 * @param rules - the category's rules, when they are checked.
 * @returns the merged answers, the confirmed declarations, and what was taken from the memory.
 */
export function withMemory(answers: Answers, memory: PublishMemory, store: string, rules?: PublishRules): Remembered {
  const notes: string[] = []
  const saved = memory.stores[store]
  const shown = rules === undefined ? undefined : new Set(rules.fields.filter(field => field.visible).map(field => optionKey(field.label)))
  const values: Record<string, SourcedValue> = {}
  for (const [label, value] of Object.entries(saved?.values ?? {})) {
    if (answers.values?.[label] === undefined && (shown === undefined || shown.has(optionKey(label)))) values[label] = { value, source: '店铺资料' }
  }
  const fromStore = Object.keys(values)
  if (saved === undefined) notes.push(`DSH 里还没有「${store}」的店铺资料`)
  else if (fromStore.length > 0) notes.push(`店铺资料取自 DSH 记忆（${beijingTime(new Date(saved.updatedAt))} 北京时间保存）：${fromStore.join('、')}`)
  const columns: Record<string, SkuField | 'ignore'> = {}
  for (const [header, { field }] of Object.entries(memory.columns)) columns[header] = field as SkuField | 'ignore'
  const confirmed = rules === undefined ? {} : memory.declarations[store]?.[rules.catId] ?? {}
  return {
    answers: { ...answers, columns: { ...columns, ...answers.columns }, values: { ...values, ...answers.values } },
    confirmed, notes,
  }
}
