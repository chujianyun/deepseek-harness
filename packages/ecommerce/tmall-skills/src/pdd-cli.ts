/**
 * The 「拼多多发品存草稿」 script: finds a new item's Pinduoduo category, writes that category's field
 * rules for `ecommerce-product-draft`, and saves a draft the user confirmed to the store's 草稿箱 — never
 * submitted for review, never on sale — recording each attempt so a draft is never saved twice.
 *
 * Commands:
 * - `resolve --account <id> (--keyword <商品名> | --line <产品线> | --cat <类目 id> | --image <主图> --title <标题>)` names candidate categories.
 * - `children --account <id> [--parent <类目 id>]` lists one level of the category tree.
 * - `rules --account <id> --cat <类目 id>` saves `字段规则_<类目 id>.json`.
 * - `check --account <id> --draft <商品草稿 json>` looks for the item in the 草稿箱 and the goods list, changing nothing.
 * - `save --account <id> --draft <商品草稿 json> --rules <字段规则 json> [--confirmed] [--stock <n>] [--unknown-checked]` saves the draft.
 */

import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { takeOverMerchant, type MerchantBrowser } from './account.ts'
import { realDeps, withMerchantPage, type Deps } from './cli.ts'
import { beijingTime } from './dates.ts'
import type { FieldCheck } from './draft.ts'
import { EXIT, SkillError } from './errors.ts'
import { readImage } from './images.ts'
import type { Page } from './page.ts'
import {
  categoryById, childCategories, createSession, pddRules, predictCategories, readLimits, readTemplate, searchCategories, setCategory,
} from './pdd-category.ts'
import {
  buildGoods, extraPrices, listDrafts, listGoods, readSession, saveDraft, specIdFor, uploadPddImage, type DraftRow,
} from './pdd-publish.ts'
import { openPdd, PDD_GOODS_URL, PddRefusal } from './pdd.ts'
import { parseRulesFile } from './product-draft-cli.ts'
import {
  blockers, categoriesText as listCategories, codesOf, parsePublishOptions, readRecords, sameProduct, titleOf, unsettled, writeRecord,
  type CandidateCategory, type DraftFile, type PublishOptions,
  type PublishRecord,
} from './publish-common.ts'

const USAGE = [
  '用法：',
  '  resolve --account <电商账号 id> (--keyword <商品名> | --line <产品线> | --cat <类目 id> | --image <主图文件> --title <标题>)',
  '  children --account <电商账号 id> [--parent <类目 id，默认顶层>]',
  '  rules --account <电商账号 id> --cat <类目 id> [--out 目录]',
  '  check --account <电商账号 id> --draft <商品草稿 json> [--out 目录]',
  '  save --account <电商账号 id> --draft <商品草稿 json> --rules <字段规则 json> [--confirmed] [--stock <每个 SKU 的库存>] [--unknown-checked] [--out 目录]',
].join('\n')

/** The directory the rules and the record file go to by default. */
const OUT = '拼多多发品'

/** The real outside world, taking over Pinduoduo merchant accounts. */
export const pddDeps: Deps = { ...realDeps, takeOver: accountId => takeOverMerchant(accountId, undefined, 'pinduoduo') }

/** Where a `resolve` looks. */
export type PddSource =
  | { readonly kind: 'keyword'; readonly keyword: string }
  | { readonly kind: 'line'; readonly line: string }
  | { readonly kind: 'id'; readonly id: string }
  | { readonly kind: 'image'; readonly image: string; readonly title: string }

/** A category command line, read. */
export type CategoryOptions =
  | { readonly command: 'resolve'; readonly account: string; readonly source: PddSource }
  | { readonly command: 'children'; readonly account: string; readonly parent: string }
  | { readonly command: 'rules'; readonly account: string; readonly catId: string; readonly out: string }

/**
 * Read a `resolve`, `children`, or `rules` command line.
 * @param argv - the arguments after the script.
 * @returns the options.
 * @throws SkillError usage for a wrong command line.
 */
export function parseCategoryOptions(argv: readonly string[]): CategoryOptions {
  let parsed: ReturnType<typeof parse>
  const parse = (args: string[]) => parseArgs({
    args, allowPositionals: true,
    options: {
      account: { type: 'string' }, keyword: { type: 'string' }, line: { type: 'string' }, cat: { type: 'string' }, image: { type: 'string' },
      title: { type: 'string' }, parent: { type: 'string' }, out: { type: 'string' },
    },
  })
  try {
    parsed = parse([...argv])
  } catch (error) {
    throw new SkillError(`${(error as Error).message}\n${USAGE}`, EXIT.usage)
  }
  const { values, positionals } = parsed
  const command = positionals[0]
  if (values.account === undefined || values.account === '') throw new SkillError(`缺少 --account。\n${USAGE}`, EXIT.usage)
  const id = (value: string | undefined, name: string) => {
    if (value === undefined || !/^\d+$/u.test(value)) throw new SkillError(`${name} 应是数字类目 id。\n${USAGE}`, EXIT.usage)
    return value
  }
  if (command === 'children') return { command, account: values.account, parent: values.parent === undefined ? '0' : id(values.parent, '--parent') }
  if (command === 'rules') return { command, account: values.account, catId: id(values.cat, '--cat'), out: values.out ?? OUT }
  const given = (['keyword', 'line', 'cat', 'image'] as const).filter(name => values[name] !== undefined && values[name] !== '')
  if (given.length !== 1) throw new SkillError(`resolve 需要且只能给一个来源：--keyword、--line、--cat 或 --image。\n${USAGE}`, EXIT.usage)
  const source: PddSource = given[0] === 'keyword' ? { kind: 'keyword', keyword: values.keyword as string }
    : given[0] === 'line' ? { kind: 'line', line: values.line as string }
      : given[0] === 'cat' ? { kind: 'id', id: id(values.cat, '--cat') }
        : { kind: 'image', image: values.image as string, title: values.title ?? '' }
  return { command: 'resolve', account: values.account, source }
}

/** The category lines for the model. */
const categoriesText = (categories: readonly CandidateCategory[], reason: string): string => listCategories(categories, reason, '缺资质')

async function resolveCategory(page: Page, source: PddSource, deps: Deps): Promise<string> {
  switch (source.kind) {
    case 'keyword': return categoriesText(await searchCategories(page, source.keyword), `拼多多类目搜索「${source.keyword}」`)
    case 'id': return categoriesText([await categoryById(page, source.id)], '用户指定的类目')
    case 'line': {
      const remembered = (await deps.memory()).categories[source.line]
      if (remembered === undefined) return `DSH 里还没有记住产品线「${source.line}」的类目。`
      if (remembered.platform !== 'pinduoduo') return `记住的产品线「${source.line}」类目在 ${remembered.platform}（${remembered.catId}），不是拼多多的。`
      return categoriesText([await categoryById(page, remembered.catId)], `记住的产品线「${source.line}」类目（${beijingTime(new Date(remembered.updatedAt))} 北京时间保存）`)
    }
    case 'image': {
      const bytes = await readFile(source.image).catch((error: unknown) => {
        throw new SkillError(`读不到主图 ${source.image}：${(error as Error).message}`, EXIT.usage)
      })
      const url = await uploadPddImage(page, bytes, basename(source.image))
      const session = await createSession(page)
      return categoriesText(await predictCategories(page, session.goodsId, url, source.title), '拼多多按主图和标题推荐')
    }
  }
}

async function categoryCommand(page: Page, options: CategoryOptions, deps: Deps, account: MerchantBrowser): Promise<string> {
  switch (options.command) {
    case 'resolve': return resolveCategory(page, options.source, deps)
    case 'children': {
      const children = await childCategories(page, options.parent)
      if (children.length === 0) return `类目 ${options.parent} 下面没有子类目。`
      return children.map(child => `- ${child.name}（${child.id}）${child.leaf ? '，可发布' : ''}`).join('\n')
    }
    case 'rules': {
      const category = await categoryById(page, options.catId)
      const rules = pddRules(options.catId, category.path, await readTemplate(page, options.catId), await readLimits(page, options.catId))
      const out = resolve(options.out)
      await mkdir(out, { recursive: true })
      const path = join(out, `字段规则_${options.catId}.json`)
      await writeFile(path, `${JSON.stringify({ platform: 'pinduoduo', store: account.store, readAt: deps.now().toISOString(), ...rules }, null, 2)}\n`)
      const required = rules.fields.filter(field => field.required).map(field => `- ${field.label}${field.options === undefined ? '' : `，可选：${field.options.map(option => option.text).join('、')}`}`)
      return [`类目：${rules.categoryPath}（${rules.catId}），共 ${String(rules.fields.length)} 个字段。`, '', `必填字段（${String(required.length)}）：`, ...required, '', `已保存：${path}`].join('\n')
    }
  }
}

/** Links to the 草稿箱. */
const DRAFT_LINK = `- 草稿箱：${PDD_GOODS_URL}（商品列表 →「草稿箱」）`

/**
 * The same product already in the store: a draft or an item an earlier attempt saved, a draft with the
 * same title, or an item with the same title on sale or not.
 */
async function alreadySaved(
  page: Page, records: readonly PublishRecord[], title: string,
): Promise<{ id: string; how: string } | undefined> {
  const drafts = await listDrafts(page)
  for (const record of [...records].reverse()) {
    if (record.draftId !== undefined && drafts.some(row => row.draftId === record.draftId)) {
      return { id: record.draftId, how: `${beijingTime(new Date(record.at))}（北京时间）DSH 存过，仍在草稿箱` }
    }
  }
  const draft = drafts.find(row => row.title === title)
  if (draft !== undefined) return { id: draft.draftId, how: '草稿箱里已有同名草稿' }
  const goodsIds = new Set(records.flatMap(record => record.itemId === undefined ? [] : [record.itemId]))
  for (const keyword of new Set([title, ...records.map(record => record.title)])) {
    const item = (await listGoods(page, keyword)).find(row => row.title === title || goodsIds.has(row.goodsId))
    if (item !== undefined) return { id: item.goodsId, how: '商品列表里已有这件商品' }
  }
  return undefined
}

async function check(page: Page, account: MerchantBrowser, draft: DraftFile, options: PublishOptions): Promise<string> {
  const title = titleOf(draft)
  if (title === '') throw new SkillError('商品草稿还没有商品标题，没法查重；请先补上标题重新生成草稿。', EXIT.usage)
  const records = sameProduct(await readRecords(join(resolve(options.out), '发品记录.json')), account.store, draft)
  const found = await alreadySaved(page, records, title)
  if (found !== undefined) return `店铺 ${account.store} 里已有「${title}」：ID ${found.id}（${found.how}）。\n${DRAFT_LINK}`
  const open = unsettled(records)
  return [
    `店铺 ${account.store} 的草稿箱和商品列表里都没有「${title}」，DSH 也没有存过它。`,
    ...open === undefined ? [] : [`注意：${beijingTime(new Date(open.at))}（北京时间）那次保存结果不明，店里暂时查不到；再存前要请用户到拼多多后台确认没有这件商品。`],
  ].join('\n')
}

async function save(page: Page, account: MerchantBrowser, draft: DraftFile, options: PublishOptions, deps: Pick<Deps, 'now' | 'stderr'>): Promise<string> {
  const text = await readFile(options.rules as string, 'utf8')
  if ((JSON.parse(text) as { platform?: string }).platform !== 'pinduoduo') {
    throw new SkillError(`${options.rules as string} 不是拼多多的字段规则，请用本技能的 rules 命令重新读取。`, EXIT.usage)
  }
  const rules = parseRulesFile(text)
  const checks = (draft.checks ?? []) as FieldCheck[]
  const prices = extraPrices(checks, draft.skus.map(sku => sku.price))
  const reasons = [...blockers(draft, rules, options), ...'problems' in prices ? prices.problems.map(problem => `不符合：${problem}`) : []]
  if (reasons.length > 0 || 'problems' in prices) throw new SkillError(`还不能保存到草稿箱：\n${reasons.map(reason => `- ${reason}`).join('\n')}`, EXIT.usage)
  const title = titleOf(draft)
  const recordPath = join(resolve(options.out), '发品记录.json')
  const records = sameProduct(await readRecords(recordPath), account.store, draft)
  const found = await alreadySaved(page, records, title)
  if (found !== undefined) return `没有重复保存：店铺 ${account.store} 里已有「${title}」，ID ${found.id}（${found.how}）。\n${DRAFT_LINK}`
  const open = unsettled(records)
  if (open !== undefined && !options.unknownChecked) {
    throw new SkillError([
      `没有保存：${beijingTime(new Date(open.at))}（北京时间）那次保存结果不明，店里暂时查不到它。`,
      '请用户到拼多多后台的草稿箱和商品列表确认没有这件商品；用户确认没有后，才能加 --unknown-checked 再保存。',
    ].join('\n'), EXIT.usage)
  }
  const record = { store: account.store, title, catId: rules.catId, codes: codesOf(draft) }
  const progress = (step: string) => { deps.stderr(`[${beijingTime(deps.now())}] ${step}\n`) }
  await writeRecord(recordPath, { ...record, status: 'submitting', at: deps.now().toISOString() })
  let form: Record<string, unknown>
  let session: Awaited<ReturnType<typeof createSession>>
  try {
    progress('新建编辑并选类目')
    session = await createSession(page)
    await setCategory(page, session, rules.catId)
    const template = await readTemplate(page, rules.catId)
    const images = await uploadAll(page, draft, progress)
    const specs: Record<string, number> = {}
    for (const sku of draft.skus) specs[sku.name] = await specIdFor(page, rules.catId, sku.name)
    const detail = await readSession(page, session)
    form = buildGoods(detail, { draft, checks, rules, template, session, images, specs, prices, stock: options.stock ?? 0 })
  } catch (error) {
    // Nothing was saved yet.
    await writeRecord(recordPath, { ...record, status: 'failed', at: deps.now().toISOString(), message: (error as Error).message })
    throw error
  }
  const ids = { draftId: String(session.commitId), itemId: String(session.goodsId) }
  progress('保存到草稿箱')
  try {
    await saveDraft(page, form)
  } catch (error) {
    const refused = error instanceof PddRefusal
    await writeRecord(recordPath, { ...record, ...ids, status: refused ? 'failed' : 'unknown', at: deps.now().toISOString(), message: (error as Error).message })
    if (refused) throw error
    throw new SkillError(`保存后没有拿到拼多多的答复（${(error as Error).message}），结果不明。不要重试，先运行 check 查店里。`, EXIT.failed)
  }
  let listed: boolean
  try {
    listed = await draftListed(page, ids.draftId)
  } catch (error) {
    // The save was answered; only the lookup failed.
    await writeRecord(recordPath, { ...record, ...ids, status: 'unknown', at: deps.now().toISOString(), message: (error as Error).message })
    throw new SkillError(`拼多多答复已保存（草稿 ID ${ids.draftId}），但核验草稿箱时出错（${(error as Error).message}）。不要重试，稍后运行 check 查店里。`, EXIT.failed)
  }
  await writeRecord(recordPath, { ...record, ...ids, status: listed ? 'saved' : 'unknown', at: deps.now().toISOString() })
  if (!listed) throw new SkillError(`拼多多答复已保存（草稿 ID ${ids.draftId}），但草稿箱里暂时查不到它。不要重试，稍后运行 check 查店里。`, EXIT.failed)
  return [
    `已保存到店铺 ${account.store} 的草稿箱（没有提交上架）：草稿 ID ${ids.draftId}，商品 ID ${ids.itemId}，标题「${title}」。`,
    DRAFT_LINK,
    '请到拼多多后台草稿箱确认后再由用户自己提交发布。',
  ].join('\n')
}

/** Whether the 草稿箱's newest page lists a draft, which takes a few seconds after the save. */
async function draftListed(page: Page, draftId: string): Promise<boolean> {
  return page.waitFor(async () => (await listDrafts(page, 50)).some((row: DraftRow) => row.draftId === draftId), 30_000)
}

/** Upload every image the form uses: up to 10 carousel images, the detail images, and the SKU images. */
async function uploadAll(page: Page, draft: DraftFile, progress: (step: string) => void): Promise<Record<string, string>> {
  const skuImages = draft.skus.flatMap(sku => sku.image === undefined ? [] : [sku.image])
  const files = new Set([...draft.images.main.slice(0, 10), ...draft.images.detail, ...skuImages])
  progress(`上传 ${String(files.size)} 张图片`)
  const images: Record<string, string> = {}
  for (const file of files) {
    const bytes = await readFile(join(draft.folder, file))
    // The name carries the real format, whatever the file was called.
    images[file] = await uploadPddImage(page, bytes, `${basename(file).replace(/\.[^.]+$/u, '')}.${readImage(bytes).format === 'png' ? 'png' : 'jpg'}`)
  }
  return images
}

/**
 * Run one command.
 * @param argv - the arguments after the script.
 * @param deps - the outside world.
 * @returns the exit status.
 */
export async function main(argv: readonly string[], deps: Deps = pddDeps): Promise<number> {
  try {
    const command = argv[0]
    let result: string
    if (command === 'check' || command === 'save') {
      const options = parsePublishOptions(argv, OUT, USAGE)
      const draft = JSON.parse(await readFile(options.draft, 'utf8').catch((error: unknown) => {
        throw new SkillError(`读不到商品草稿 ${options.draft}：${(error as Error).message}`, EXIT.usage)
      })) as DraftFile
      ;({ result } = await withMerchantPage(options, deps, async (page, account) => {
        await openPdd(page)
        return options.command === 'check' ? check(page, account, draft, options) : save(page, account, draft, options, deps)
      }))
    } else if (command === 'resolve' || command === 'children' || command === 'rules') {
      const options = parseCategoryOptions(argv)
      ;({ result } = await withMerchantPage(options, deps, async (page, account) => {
        await openPdd(page)
        return categoryCommand(page, options, deps, account)
      }))
    } else {
      throw new SkillError(`缺少或认不出子命令：${command ?? '（无）'}\n${USAGE}`, EXIT.usage)
    }
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
