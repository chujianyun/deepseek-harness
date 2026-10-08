/**
 * The 「天猫发品存仓库」 script: saves a product draft the user confirmed to the store's warehouse, never on
 * sale, and records each attempt so a draft is never saved twice.
 *
 * Commands:
 * - `check --account <id> --draft <商品草稿 json>` looks for the item in the warehouse and in the record, changing nothing.
 * - `save --account <id> --draft <商品草稿 json> --rules <字段规则 json> [--confirmed] [--stock <n>] [--unknown-checked]` saves it.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import type { MerchantBrowser } from './account.ts'
import { realDeps, withMerchantPage, type Deps } from './cli.ts'
import { beijingTime } from './dates.ts'
import type { Draft, FieldCheck } from './draft.ts'
import { EXIT, SkillError } from './errors.ts'
import { fitImage, readImage } from './images.ts'
import type { Page } from './page.ts'
import { isSignIn, openManager } from './publish-category.ts'
import { parseRulesFile } from './product-draft-cli.ts'
import { publishUrl, type PublishRules } from './publish-rules.ts'
import {
  buildForm, ensureFolder, folderImages, listed, MANAGER_ROWS, readBase, submit, uploadImage, type PageBase, type Uploaded,
} from './publish-submit.ts'
import { signedOut } from './page.ts'

const USAGE = [
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
  /** The user found in Qianniu that an attempt whose result was unknown saved nothing. */
  readonly unknownChecked: boolean
  readonly out: string
}

/**
 * Read the command line.
 * @param argv - the arguments after the script.
 * @returns the options.
 * @throws SkillError usage for a wrong command line.
 */
export function parsePublishOptions(argv: readonly string[]): PublishOptions {
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
    throw new SkillError(`${(error as Error).message}\n${USAGE}`, EXIT.usage)
  }
  const { values, positionals } = parsed
  const command = positionals[0]
  if (command !== 'check' && command !== 'save') throw new SkillError(`缺少或认不出子命令：${command ?? '（无）'}\n${USAGE}`, EXIT.usage)
  if (values.account === undefined || values.account === '') throw new SkillError(`缺少 --account。\n${USAGE}`, EXIT.usage)
  if (values.draft === undefined || values.draft === '') throw new SkillError(`缺少 --draft。\n${USAGE}`, EXIT.usage)
  if (command === 'save' && (values.rules === undefined || values.rules === '')) throw new SkillError(`save 需要 --rules。\n${USAGE}`, EXIT.usage)
  if (values.stock !== undefined && !/^[1-9]\d{0,8}$/u.test(values.stock)) throw new SkillError(`--stock 应是正整数。\n${USAGE}`, EXIT.usage)
  return {
    command, account: values.account, draft: values.draft, confirmed: values.confirmed === true,
    unknownChecked: values['unknown-checked'] === true, out: values.out ?? '天猫发品',
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
  readonly title: string
  readonly catId: string
  /** The draft's SKU codes, sorted, which name the product when its title changed. */
  readonly codes?: readonly string[]
  /**
   * `submitting` until the answer came; `unknown` when it never did or the store did not show the item;
   * `on-sale` when Tmall put the item on sale instead of in the warehouse.
   */
  readonly status: 'submitting' | 'saved' | 'failed' | 'unknown' | 'on-sale'
  readonly itemId?: string
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

/** The record file of a store's attempts. */
async function readRecords(path: string): Promise<PublishRecord[]> {
  try {
    const records = JSON.parse(await readFile(path, 'utf8')) as unknown
    return Array.isArray(records) ? records as PublishRecord[] : []
  } catch {
    // No attempt was made yet, or the file was damaged: the warehouse is asked either way.
    return []
  }
}

/** Append an attempt's step to the record file, which keeps every step. */
async function writeRecord(path: string, record: PublishRecord): Promise<void> {
  const records = await readRecords(path)
  await mkdir(resolve(path, '..'), { recursive: true })
  await writeFile(path, `${JSON.stringify([...records, record], null, 2)}\n`)
}

/** The draft's title, which names the item in the warehouse and the record. */
function titleOf(draft: DraftFile): string {
  const value = draft.values['商品标题']?.value
  return typeof value === 'string' ? value : (value ?? []).join('')
}

/** Links to an item that is in the warehouse. */
const links = (itemId: string) => [
  `- 编辑：https://sell.publish.tmall.com/tmall/publish.htm?id=${itemId}`,
  '- 仓库：https://qn.taobao.com/home.htm/sell-manage-tm/in_stock',
].join('\n')

/** The draft's SKU codes, sorted. */
const codesOf = (draft: DraftFile): string[] => draft.skus.flatMap(sku => sku.code === undefined ? [] : [sku.code]).sort()

/** The records of the same product in the same store: the same title, or the same SKU codes. */
function sameProduct(records: readonly PublishRecord[], store: string, draft: DraftFile): PublishRecord[] {
  const title = titleOf(draft)
  const codes = codesOf(draft).join('\n')
  return records.filter(record => record.store === store && (record.title === title || (codes !== '' && record.codes?.join('\n') === codes)))
}

/**
 * The same product already in the store, on sale or in the warehouse: by the item an earlier attempt
 * saved, or by its title.
 * @param page - a tab of the account.
 * @param records - the earlier attempts for the same product.
 * @param title - the draft's title.
 * @returns the item id and how it was found, or undefined.
 * @throws SkillError failed when more items carry the title's words than the item manager answers.
 */
async function alreadySaved(
  page: Page, records: readonly PublishRecord[], title: string,
): Promise<{ itemId: string; how: string } | undefined> {
  await openManager(page)
  for (const record of records.filter(item => item.itemId !== undefined).reverse()) {
    if ((await listed(page, { queryItemId: record.itemId as string }, 'all')).length > 0) {
      return { itemId: record.itemId as string, how: `${beijingTime(new Date(record.at))}（北京时间）DSH 已存过，仍在店里` }
    }
  }
  const items = await listed(page, { queryTitle: title }, 'all')
  const same = items.find(item => item.title === title)
  if (same !== undefined) return { itemId: same.itemId, how: '店里已有同名商品' }
  if (items.length >= MANAGER_ROWS) {
    throw new SkillError(`店里标题含「${title}」的商品超过 ${String(MANAGER_ROWS)} 个，没法确认有没有同一商品；请用户到千牛按标题确认。`, EXIT.failed)
  }
  return undefined
}

/** An earlier attempt for the same product whose result nobody knows, which a save must not repeat unchecked. */
function unsettled(records: readonly PublishRecord[]): PublishRecord | undefined {
  const last = records.at(-1)
  return last !== undefined && (last.status === 'unknown' || last.status === 'submitting') ? last : undefined
}

/**
 * Run one command.
 * @param argv - the arguments after the script.
 * @param deps - the outside world.
 * @returns the exit status.
 */
export async function main(argv: readonly string[], deps: Deps = realDeps): Promise<number> {
  try {
    const options = parsePublishOptions(argv)
    const draft = JSON.parse(await readFile(options.draft, 'utf8').catch((error: unknown) => {
      throw new SkillError(`读不到商品草稿 ${options.draft}：${(error as Error).message}`, EXIT.usage)
    })) as DraftFile
    const { result } = await withMerchantPage(options, deps, (page, account) => options.command === 'check' ? check(page, account, draft, options) : save(page, account, draft, options, deps))
    deps.stdout(`${result}\n`)
    return 0
  } catch (error) {
    if (error instanceof SkillError) {
      deps.stderr(`${error.message}\n`)
      return error.exitCode
    }
    deps.stderr(`失败：${error instanceof Error ? error.message : String(error)}\n`)
    return EXIT.failed
  }
}

async function check(page: Page, account: MerchantBrowser, draft: DraftFile, options: PublishOptions): Promise<string> {
  const title = titleOf(draft)
  if (title === '') throw new SkillError('商品草稿还没有商品标题，没法到店里查重；请先补上标题重新生成草稿。', EXIT.usage)
  const records = sameProduct(await readRecords(join(resolve(options.out), '发品记录.json')), account.store, draft)
  const found = await alreadySaved(page, records, title)
  if (found !== undefined) return `店铺 ${account.store} 里已有「${title}」：商品 ID ${found.itemId}（${found.how}）。\n${links(found.itemId)}`
  const open = unsettled(records)
  return [
    `店铺 ${account.store} 的仓库和出售中都没有「${title}」，DSH 也没有存过它。`,
    ...open === undefined ? [] : [`注意：${beijingTime(new Date(open.at))}（北京时间）那次提交结果不明，店里暂时查不到；保存前要请用户到千牛确认没有这件商品。`],
  ].join('\n')
}

async function save(page: Page, account: MerchantBrowser, draft: DraftFile, options: PublishOptions, deps: Pick<Deps, 'now' | 'stderr'>): Promise<string> {
  const rules = parseRulesFile(await readFile(options.rules as string, 'utf8'))
  const reasons = blockers(draft, rules, options)
  if (reasons.length > 0) throw new SkillError(`还不能保存到仓库：\n${reasons.map(reason => `- ${reason}`).join('\n')}`, EXIT.usage)
  const title = titleOf(draft)
  const recordPath = join(resolve(options.out), '发品记录.json')
  const records = sameProduct(await readRecords(recordPath), account.store, draft)
  const found = await alreadySaved(page, records, title)
  if (found !== undefined) return `没有重复保存：店铺 ${account.store} 里已有「${title}」，商品 ID ${found.itemId}（${found.how}）。\n${links(found.itemId)}`
  const open = unsettled(records)
  if (open !== undefined && !options.unknownChecked) {
    throw new SkillError([
      `没有保存：${beijingTime(new Date(open.at))}（北京时间）那次提交结果不明，店里暂时查不到它，可能还在处理。`,
      '请用户到千牛「仓库中」和「出售中」确认没有这件商品；用户确认没有后，才能加 --unknown-checked 再保存。',
    ].join('\n'), EXIT.usage)
  }
  const record = { store: account.store, title, catId: rules.catId, codes: codesOf(draft) }
  const progress = (step: string) => { deps.stderr(`[${beijingTime(deps.now())}] ${step}\n`) }
  await writeRecord(recordPath, { ...record, status: 'submitting', at: deps.now().toISOString() })
  let base: PageBase
  let images: Record<string, Uploaded>
  try {
    progress('打开天猫发布页')
    await page.goto(publishUrl(rules.catId))
    if (isSignIn(await page.evaluate<string>('location.href'))) signedOut('天猫商家后台')
    base = await readBase(page)
    images = await uploadAll(page, draft, await ensureFolder(page), progress)
  } catch (error) {
    // Nothing was submitted yet.
    await writeRecord(recordPath, { ...record, status: 'failed', at: deps.now().toISOString(), message: (error as Error).message })
    throw error
  }
  progress('提交到天猫（放入仓库）')
  let answer
  try {
    const form = buildForm(base, { draft, checks: draft.checks as FieldCheck[], rules, images, stock: options.stock ?? 0 })
    answer = await submit(page, base, form)
  } catch (error) {
    await writeRecord(recordPath, { ...record, status: 'unknown', at: deps.now().toISOString(), message: (error as Error).message })
    throw new SkillError(`提交后没有拿到天猫的答复（${(error as Error).message}），结果不明。不要重试，先运行 check 查店里。`, EXIT.failed)
  }
  if ('errors' in answer) {
    await writeRecord(recordPath, { ...record, status: 'failed', at: deps.now().toISOString(), message: answer.errors.join('；') })
    throw new SkillError(`天猫没有保存，原因：\n${answer.errors.map(error => `- ${error}`).join('\n')}`, EXIT.failed)
  }
  await openManager(page)
  const saved = (await listed(page, { queryItemId: answer.itemId }, 'in_stock')).length > 0
  const onSale = !saved && (await listed(page, { queryItemId: answer.itemId }, 'on_sale')).length > 0
  await writeRecord(recordPath, { ...record, status: saved ? 'saved' : onSale ? 'on-sale' : 'unknown', itemId: answer.itemId, at: deps.now().toISOString() })
  if (onSale) {
    throw new SkillError(`天猫把商品 ID ${answer.itemId} 放到了「出售中」，没有放进仓库！请用户立即到千牛下架它。\n${links(answer.itemId)}`, EXIT.failed)
  }
  if (!saved) {
    throw new SkillError(`天猫答复已保存（商品 ID ${answer.itemId}），但仓库里暂时查不到它。不要重试，稍后运行 check 查店里。`, EXIT.failed)
  }
  return [
    `已保存到店铺 ${account.store} 的仓库（未上架）：商品 ID ${answer.itemId}，标题「${title}」。`,
    `图片 ${String(Object.keys(images).length)} 张已传到图片空间的「DSH发品」文件夹。`,
    links(answer.itemId),
    '请到千牛仓库确认后再上架。',
  ].join('\n')
}

/**
 * Upload every image the form uses, reusing those already in the folder; the white and transparent
 * images are cut to 800×800 when they are not.
 */
async function uploadAll(
  page: Page, draft: DraftFile, folderId: string, progress: (step: string) => void,
): Promise<Record<string, Uploaded>> {
  const files = [
    ...draft.images.main.slice(0, 5), ...draft.images.main34.slice(0, 5),
    ...draft.images.white.slice(0, 1), ...draft.images.transparent.slice(0, 1),
    ...draft.skus.flatMap(sku => sku.image === undefined ? [] : [sku.image]), ...draft.images.detail,
  ]
  const square = new Set([...draft.images.white.slice(0, 1), ...draft.images.transparent.slice(0, 1)])
  const existing = await folderImages(page, folderId)
  progress(`图片空间「DSH发品」已有 ${String(existing.size)} 张图，需要 ${String(new Set(files).size)} 张`)
  const images: Record<string, Uploaded> = {}
  for (const file of new Set(files)) {
    let bytes: Uint8Array = await readFile(join(draft.folder, file))
    const facts = readImage(bytes)
    // The name carries the real format, whatever the file was called.
    let name = `${basename(file).replace(/\.[^.]+$/u, '')}.${facts.format === 'png' ? 'png' : 'jpg'}`
    if (square.has(file) && (facts.width !== 800 || facts.height !== 800)) {
      bytes = fitImage(bytes, 800, 800)
      name = `${name.replace(/\.[^.]+$/u, '')}-800.png`
    }
    // An image uploaded before, such as by an earlier attempt, is reused rather than uploaded again.
    const reused = existing.get(createHash('md5').update(bytes).digest('hex'))
    if (reused === undefined) progress(`上传 ${file}`)
    images[file] = reused ?? await uploadImage(page, bytes, name, folderId)
  }
  return images
}
