/**
 * What the 草稿箱 publish scripts (Pinduoduo, Douyin shop) share around their platform's own pages: the
 * command line, the duplicate check's report, and reading the field rules a save needs.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import type { EcommercePlatform, MerchantBrowser } from './account.ts'
import { runCli, withMerchantPage, type Deps } from './cli.ts'
import { beijingTime } from './dates.ts'
import { EXIT, SkillError } from './errors.ts'
import type { Page } from './page.ts'
import { parseRulesFile } from './product-draft-cli.ts'
import {
  categoriesText, DRAFT_USAGE, parseCategoryOptions, parsePublishOptions, readRecords, rememberedCategory, sameProduct, titleOf, unsettled,
  type CandidateCategory, type DraftCategorySource, type DraftFile, type PublishOptions, type PublishRecord,
} from './publish-common.ts'
import type { PublishRules } from './publish-rules.ts'

/** A product the store already has, as a platform's duplicate check finds it. */
export interface FoundProduct {
  readonly id: string
  /** How it was found, for the user. */
  readonly how: string
}

/** A category's field rules as a platform reads them for `rules`. */
export interface ReadRules {
  readonly rules: PublishRules
  /** More the platform keeps in the rules file beside the rules. */
  readonly extra?: object
  /** How many choices to list per field; all when absent. */
  readonly shownOptions?: number
}

/** One platform's side of a 草稿箱 publish script. */
export interface DraftStore {
  /** The directory the rules and the record file go to by default. */
  readonly out: string
  /** What the store's ids are called in a report, such as 商品 ID. */
  readonly idLabel: string
  /** The line pointing the user to the 草稿箱. */
  readonly draftLink: string
  /** Opens the merchant back office the commands work in. */
  readonly open: (page: Page) => Promise<void>
  /** The same product already in the store, if any. */
  readonly alreadySaved: (page: Page, records: readonly PublishRecord[], title: string) => Promise<FoundProduct | undefined>
  /** The platform's name, key and category lookups, for `resolve` and `children`. */
  readonly finder: CategoryFinder
  /** `rules`: reads a category's field rules. */
  readonly rules: (page: Page, catId: string) => Promise<ReadRules>
  readonly save: (page: Page, account: MerchantBrowser, draft: DraftFile, options: PublishOptions, deps: Pick<Deps, 'now' | 'stderr'>) => Promise<string>
}

/**
 * Run one command of a 草稿箱 publish script.
 * @param argv - the arguments after the script.
 * @param deps - the outside world.
 * @param store - the platform's side.
 * @returns the exit status.
 */
export function runDraftStore(argv: readonly string[], deps: Deps, store: DraftStore): Promise<number> {
  return runCli(deps, async () => {
    const command = argv[0]
    if (command === 'check' || command === 'save') {
      const options = parsePublishOptions(argv, store.out, DRAFT_USAGE)
      const draft = JSON.parse(await readFile(options.draft, 'utf8').catch((error: unknown) => {
        throw new SkillError(`读不到商品草稿 ${options.draft}：${(error as Error).message}`, EXIT.usage)
      })) as DraftFile
      return (await withMerchantPage(options, deps, async (page, account) => {
        await store.open(page)
        return options.command === 'check' ? checkStore(page, account, draft, options, store) : store.save(page, account, draft, options, deps)
      })).result
    }
    if (command === 'resolve' || command === 'children' || command === 'rules') {
      const options = parseCategoryOptions(argv, store.out)
      return (await withMerchantPage(options, deps, async (page, account) => {
        await store.open(page)
        switch (options.command) {
          case 'resolve': return resolveDraftCategory(page, options.source, deps, store.finder)
          case 'children': return childrenText(await store.finder.children(page, options.parent), store.finder.noChildren(options.parent))
          case 'rules': return writeRules(await store.rules(page, options.catId), options, deps, account, store)
        }
      })).result
    }
    throw new SkillError(`缺少或认不出子命令：${command ?? '（无）'}\n${DRAFT_USAGE}`, EXIT.usage)
  })
}

/** `rules`: saves the rules read, beside the platform key and store a save checks, and lists them. */
async function writeRules(
  read: ReadRules, options: { catId: string; out: string }, deps: Pick<Deps, 'now'>, account: MerchantBrowser, store: DraftStore,
): Promise<string> {
  const out = resolve(options.out)
  await mkdir(out, { recursive: true })
  const path = join(out, `字段规则_${options.catId}.json`)
  const file = { platform: store.finder.platform, store: account.store, readAt: deps.now().toISOString(), ...read.rules, ...read.extra }
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`)
  return rulesText(read.rules, path, read.shownOptions)
}

/** `check`: whether the store has the draft's product, changing nothing. */
async function checkStore(
  page: Page, account: MerchantBrowser, draft: DraftFile, options: PublishOptions, store: DraftStore,
): Promise<string> {
  const title = titleOf(draft)
  if (title === '') throw new SkillError('商品草稿还没有商品标题，没法查重；请先补上标题重新生成草稿。', EXIT.usage)
  const records = sameProduct(await readRecords(join(resolve(options.out), '发品记录.json')), account.store, draft)
  const found = await store.alreadySaved(page, records, title)
  if (found !== undefined) return `店铺 ${account.store} 里已有「${title}」：${store.idLabel} ${found.id}（${found.how}）。\n${store.draftLink}`
  const open = unsettled(records)
  return [
    `店铺 ${account.store} 的草稿箱和商品列表里都没有「${title}」，DSH 也没有存过它。`,
    ...open === undefined ? [] : [`注意：${beijingTime(new Date(open.at))}（北京时间）那次保存结果不明，店里暂时查不到；再存前要请用户到${store.finder.name}后台确认没有这件商品。`],
  ].join('\n')
}

/**
 * Read the field rules a save checks the draft against, refusing another platform's.
 * @param path - the rules file.
 * @param store - the platform's side.
 * @returns the rules.
 * @throws SkillError usage for another platform's rules.
 */
export async function readStoreRules(path: string, store: DraftStore): Promise<PublishRules> {
  const text = await readFile(path, 'utf8')
  if ((JSON.parse(text) as { platform?: string }).platform !== store.finder.platform) {
    throw new SkillError(`${path} 不是${store.finder.name}的字段规则，请用本技能的 rules 命令重新读取。`, EXIT.usage)
  }
  return parseRulesFile(text)
}

/**
 * The lines `rules` prints: the category, its required fields with their choices, and the saved file.
 * @param rules - the rules read.
 * @param path - where they were saved.
 * @param shownOptions - how many choices to list per field.
 * @returns the text.
 */
export function rulesText(rules: PublishRules, path: string, shownOptions = Number.POSITIVE_INFINITY): string {
  const shown = (count: number) => count > shownOptions ? `（共 ${String(count)} 项，前 ${String(shownOptions)} 项）` : ''
  const required = rules.fields.filter(field => field.required).map(field => `- ${field.label}${field.options === undefined
    ? '' : `，可选${shown(field.options.length)}：${field.options.slice(0, shownOptions).map(option => option.text).join('、')}`}`)
  return [`类目：${rules.categoryPath}（${rules.catId}），共 ${String(rules.fields.length)} 个字段。`, '', `必填字段（${String(required.length)}）：`, ...required, '', `已保存：${path}`].join('\n')
}

/** One platform's category lookups, for `resolve`. */
export interface CategoryFinder {
  /** The platform's name for the user, such as 抖店. */
  readonly name: string
  /** The platform the company's remembered categories are kept under. */
  readonly platform: EcommercePlatform
  /** What a category the store cannot use is marked with, such as 未开通. */
  readonly unusable: string
  readonly search: (page: Page, keyword: string) => Promise<readonly CandidateCategory[]>
  readonly byId: (page: Page, id: string) => Promise<CandidateCategory>
  /** The platform's categories for a main image and a title. */
  readonly predict: (page: Page, image: Uint8Array, name: string, title: string) => Promise<readonly CandidateCategory[]>
  /** One level of categories under a parent (`0` for the top). */
  readonly children: (page: Page, parent: string) => Promise<readonly { id: string; name: string; leaf: boolean }[]>
  /** What `children` says when a parent has none. */
  readonly noChildren: (parent: string) => string
}

/**
 * Answer `resolve`: the candidate categories from the one source given.
 * @param page - the merchant back office.
 * @param source - where to look.
 * @param deps - the outside world, for the company's memory.
 * @param finder - the platform's lookups.
 * @returns the lines for the model.
 */
export async function resolveDraftCategory(
  page: Page, source: DraftCategorySource, deps: Pick<Deps, 'memory'>, finder: CategoryFinder,
): Promise<string> {
  const text = (categories: readonly CandidateCategory[], reason: string) => categoriesText(categories, reason, finder.unusable)
  switch (source.kind) {
    case 'keyword': return text(await finder.search(page, source.keyword), `${finder.name}类目搜索「${source.keyword}」`)
    case 'id': return text([await finder.byId(page, source.id)], '用户指定的类目')
    case 'line': {
      const remembered = rememberedCategory(await deps.memory(), source.line, finder.platform)
      if (typeof remembered === 'string') return remembered
      return text([await finder.byId(page, remembered.catId)], `记住的产品线「${source.line}」类目（${beijingTime(new Date(remembered.updatedAt))} 北京时间保存）`)
    }
    case 'image': {
      const bytes = await readFile(source.image).catch((error: unknown) => {
        throw new SkillError(`读不到主图 ${source.image}：${(error as Error).message}`, EXIT.usage)
      })
      return text(await finder.predict(page, bytes, basename(source.image), source.title), `${finder.name}按主图和标题推荐`)
    }
  }
}

/**
 * Answer `children`: one level of categories under a parent.
 * @param children - the categories found.
 * @param none - what to say when there are none.
 * @returns the lines for the model.
 */
export function childrenText(children: readonly { id: string; name: string; leaf: boolean }[], none: string): string {
  if (children.length === 0) return none
  return children.map(child => `- ${child.name}（${child.id}）${child.leaf ? '，可发布' : ''}`).join('\n')
}
