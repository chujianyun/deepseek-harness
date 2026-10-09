/**
 * What the publish scripts share: their `check` and `save` command line, the draft file they read, what
 * stops a save, and the record file of each attempt that keeps a draft from being saved twice.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { MERCHANT_PLATFORMS, type CategoryMemory, type EcommercePlatform, type PublishMemory } from './account.ts'
import type { Draft, FieldCheck } from './draft.ts'
import { EXIT, SkillError } from './errors.ts'
import type { PublishRules } from './publish-rules.ts'

/** The usage of the Tmall publish script. */
export const USAGE = [
  '用法：',
  '  check --account <电商账号 id> --draft <商品草稿 json> [--out 目录]',
  '  save --account <电商账号 id> --draft <商品草稿 json> --rules <字段规则 json> [--confirmed] [--stock <每个 SKU 的库存>] [--unknown-checked] [--out 目录]',
].join('\n')

/** A command line, read. */
export interface PublishOptions {
  readonly command: 'check' | 'save'
  readonly account: string
  readonly draft: string
  readonly rules?: string
  readonly confirmed: boolean
  readonly stock?: number
  /** The user found in the store's backend that an attempt whose result was unknown saved nothing. */
  readonly unknownChecked: boolean
  readonly out: string
}

/**
 * Read a `check` or `save` command line.
 * @param argv - the arguments after the script.
 * @param out - the default directory of the record file.
 * @param usage - the script's usage text, shown with a wrong command line.
 * @returns the options.
 * @throws SkillError usage for a wrong command line.
 */
export function parsePublishOptions(argv: readonly string[], out = '天猫发品', usage = USAGE): PublishOptions {
  let parsed: ReturnType<typeof parse>
  const parse = (args: string[]) => parseArgs({
    args, allowPositionals: true,
    options: {
      account: { type: 'string' }, draft: { type: 'string' }, rules: { type: 'string' }, confirmed: { type: 'boolean' },
      stock: { type: 'string' }, 'unknown-checked': { type: 'boolean' }, out: { type: 'string' },
    },
  })
  try {
    parsed = parse([...argv])
  } catch (error) {
    throw new SkillError(`${(error as Error).message}\n${usage}`, EXIT.usage)
  }
  const { values, positionals } = parsed
  const command = positionals[0]
  if (command !== 'check' && command !== 'save') throw new SkillError(`缺少或认不出子命令：${command ?? '（无）'}\n${usage}`, EXIT.usage)
  if (values.account === undefined || values.account === '') throw new SkillError(`缺少 --account。\n${usage}`, EXIT.usage)
  if (values.draft === undefined || values.draft === '') throw new SkillError(`缺少 --draft。\n${usage}`, EXIT.usage)
  if (command === 'save' && (values.rules === undefined || values.rules === '')) throw new SkillError(`save 需要 --rules。\n${usage}`, EXIT.usage)
  if (values.stock !== undefined && !/^[1-9]\d{0,8}$/u.test(values.stock)) throw new SkillError(`--stock 应是正整数。\n${usage}`, EXIT.usage)
  return {
    command, account: values.account, draft: values.draft, confirmed: values.confirmed === true,
    unknownChecked: values['unknown-checked'] === true, out: values.out ?? out,
    ...values.rules === undefined ? {} : { rules: values.rules }, ...values.stock === undefined ? {} : { stock: Number(values.stock) },
  }
}

/** A saved draft as `product-draft draft --rules` writes it. */
export interface DraftFile extends Draft {
  readonly catId?: string
  readonly checks?: readonly FieldCheck[]
}

/** One attempt to save an item, as recorded. */
export interface PublishRecord {
  readonly store: string
  /** The e-commerce account that saved, which tells apart stores of the same name. */
  readonly account?: string
  readonly title: string
  readonly catId: string
  /** The draft's SKU codes, sorted, which name the product when its title changed. */
  readonly codes?: readonly string[]
  /**
   * `submitting` until the answer came; `unknown` when it never did or the store did not show the item;
   * `on-sale` when the platform put the item on sale instead of keeping it; `not-draft` when it left the
   * 草稿箱 another way, such as into review; `exists` when a save found the same product already in the
   * store and saved nothing.
   */
  readonly status: 'submitting' | 'saved' | 'failed' | 'unknown' | 'on-sale' | 'not-draft' | 'exists'
  /** The item: Tmall's item id, or Pinduoduo's goods id. */
  readonly itemId?: string
  /** Pinduoduo's draft (goods commit) id. */
  readonly draftId?: string
  readonly at: string
  readonly message?: string
}

/**
 * Why a draft cannot be saved yet, or nothing.
 * @param draft - the draft with its field check.
 * @param rules - the category's rules.
 * @param options - whether the user confirmed and the stock for SKUs without one.
 * @returns the reasons, each a line for the model.
 */
export function blockers(draft: DraftFile, rules: PublishRules, options: Pick<PublishOptions, 'confirmed' | 'stock'>): string[] {
  const reasons: string[] = []
  if (draft.checks === undefined || draft.catId !== rules.catId) {
    return [`商品草稿没有按类目 ${rules.catId} 的字段规则检查过，请用 product-draft draft --rules 重新生成。`]
  }
  for (const item of draft.missing) reasons.push(`缺失：${item}`)
  for (const item of draft.problems) reasons.push(`问题：${item}`)
  for (const check of draft.checks) {
    const conditional = check.note?.includes('页面有显示/必填条件') === true
    // The quantity is the SKU stocks' sum; a missing stock gets its own line below.
    if (check.status === '缺失' && check.required && !conditional && check.key !== 'quantity') reasons.push(`缺失：${check.label}`)
    if (check.status === '不符合') reasons.push(`不符合：${check.label}${check.note === undefined ? '' : `（${check.note}）`}`)
    if (check.status === '待店铺确认') reasons.push(`声明还没有确认：${check.value ?? check.label}`)
  }
  if (options.stock === undefined && draft.skus.some(sku => sku.stock === undefined)) reasons.push('缺失：每个 SKU 的库存（用 --stock 给出）')
  if (!options.confirmed && draft.checks.some(check => check.status === '待确认')) reasons.push('还有模型生成的值待用户确认：用户在确认卡片里认可后才能加 --confirmed')
  return reasons
}

/**
 * Read the record file of a store's attempts.
 * @param path - the file.
 * @returns its records; none when it is missing or damaged.
 */
export async function readRecords(path: string): Promise<PublishRecord[]> {
  try {
    const records = JSON.parse(await readFile(path, 'utf8')) as unknown
    return Array.isArray(records) ? records as PublishRecord[] : []
  } catch {
    // No attempt was made yet, or the file was damaged: the store is asked either way.
    return []
  }
}

/**
 * Append an attempt's step to the record file, which keeps every step.
 * @param path - the file.
 * @param record - the step.
 */
export async function writeRecord(path: string, record: PublishRecord): Promise<void> {
  const records = await readRecords(path)
  await mkdir(resolve(path, '..'), { recursive: true })
  await writeFile(path, `${JSON.stringify([...records, record], null, 2)}\n`)
}

/**
 * The draft's title, which names the item in the store and the record.
 * @param draft - the draft.
 * @returns the title, empty when it has none.
 */
export function titleOf(draft: DraftFile): string {
  const value = draft.values['商品标题']?.value
  return typeof value === 'string' ? value : (value ?? []).join('')
}

/**
 * The draft's SKU codes, which name the product however its title changes.
 * @param draft - the draft.
 * @returns the codes, sorted.
 */
export function codesOf(draft: DraftFile): string[] {
  return draft.skus.flatMap(sku => sku.code === undefined ? [] : [sku.code]).sort()
}

/**
 * The records of the same product in the same store: the same title, or the same SKU codes.
 * @param records - every record.
 * @param store - the store.
 * @param draft - the draft.
 * @returns the product's records, oldest first.
 */
export function sameProduct(records: readonly PublishRecord[], store: string, draft: DraftFile): PublishRecord[] {
  const title = titleOf(draft)
  const codes = codesOf(draft).join('\n')
  return records.filter(record => record.store === store && (record.title === title || (codes !== '' && record.codes?.join('\n') === codes)))
}

/**
 * An earlier attempt for the same product whose result nobody knows, which a save must not repeat unchecked.
 * @param records - the product's records.
 * @returns the last record when it ended unknown or stopped while submitting.
 */
export function unsettled(records: readonly PublishRecord[]): PublishRecord | undefined {
  const last = records.at(-1)
  return last !== undefined && (last.status === 'unknown' || last.status === 'submitting') ? last : undefined
}

/**
 * The longest start every code shares, such as mldx238 for mldx238a … mldx238f; the item's own code.
 * @param codes - the SKU codes.
 * @returns the shared start, empty when there is none.
 */
export function commonPrefix(codes: readonly string[]): string {
  if (codes.length === 0) return ''
  let prefix = codes[0] as string
  for (const code of codes) while (!code.startsWith(prefix)) prefix = prefix.slice(0, -1)
  return prefix
}

/** A category a resolve names, and whether the store may publish in it. */
export interface CandidateCategory {
  readonly id: string
  readonly path: readonly string[]
  readonly usable: boolean
}

/**
 * The categories a resolve found, for the model: the usable ones numbered with the reason, then up to
 * five the store may not use.
 * @param categories - the categories, best first.
 * @param reason - where they came from.
 * @param why - why the store may not use the others, such as 缺资质.
 * @returns the text.
 */
export function categoriesText(categories: readonly CandidateCategory[], reason: string, why: string): string {
  if (categories.length === 0) return `没有找到类目（${reason}）。`
  const usable = categories.filter(category => category.usable)
  const lines = usable.map((category, at) => `${String(at + 1)}. ${category.path.join(' > ')}（类目 id ${category.id}）—— ${reason}`)
  const refused = categories.filter(category => !category.usable).map(category => category.path.join(' > '))
  const more = refused.length > 5 ? ` 等 ${String(refused.length)} 个` : ''
  return [
    lines.length === 0 ? '这家店都不能用这些类目。' : lines.join('\n'),
    ...refused.length === 0 ? [] : [`这家店不能用（${why}）：${refused.slice(0, 5).join('；')}${more}`],
  ].join('\n')
}

/** The platforms' names for the user. */
const PLATFORM_NAMES: Readonly<Record<string, string>> = { ...MERCHANT_PLATFORMS, taobao: '淘宝' } satisfies Record<EcommercePlatform, string>

/**
 * The category the company remembered for a product line on one platform. A line remembered only on
 * other platforms gives none: another platform's category id never stands in.
 * @param memory - the company's publishing memory.
 * @param line - the product line.
 * @param platform - the platform being published to.
 * @returns the category, or what to tell the model when there is none.
 */
export function rememberedCategory(memory: PublishMemory, line: string, platform: EcommercePlatform): CategoryMemory | string {
  const byPlatform = memory.categories[line] ?? {}
  const entry = byPlatform[platform]
  if (entry !== undefined) return entry
  // A platform name saved before platforms were kept apart is shown as it was saved.
  const others = Object.keys(byPlatform).map(other => PLATFORM_NAMES[other] ?? other)
  const name = PLATFORM_NAMES[platform] as string
  return others.length === 0
    ? `DSH 里还没有记住产品线「${line}」的类目。`
    : `DSH 记住了产品线「${line}」在${others.join('、')}的类目，还没有记住${name}的；按商品名或主图找${name}类目，用户确认后再记下。`
}
