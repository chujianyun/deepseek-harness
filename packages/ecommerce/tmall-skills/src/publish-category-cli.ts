/**
 * The 「天猫发品类目与字段规则」 script: the categories a store may publish in, the category a product
 * belongs to, and a category's publish form fields, all read live with the store's merchant account.
 * Nothing is published or changed.
 *
 * Commands:
 * - `categories` lists the store's publishable categories, cached per store for 7 days.
 * - `resolve` finds the category from `--cat <id>`, `--item <own item link or id>`, `--own <title words>`, `--keyword <product name>`,
 *   or `--line <product line>`, whose category the company remembered.
 * - `rules --cat <id>` saves the category's field rules.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import type { MerchantBrowser } from './account.ts'
import { fileSafe, realDeps, withMerchantPage, type Deps } from './cli.ts'
import { beijingTime } from './dates.ts'
import { EXIT, SkillError } from './errors.ts'
import type { Page } from './page.ts'
import {
  openEntry, resolveCategory, storeCategories,
  type Candidate, type CategorySource, type Resolution, type ResolveContext, type TmallCategory,
} from './publish-category.ts'
import { readRules, type FieldRule, type PublishRules } from './publish-rules.ts'

/** How long a store's category list is reused before it is read again. */
export const CACHE_DAYS = 7

const USAGE = [
  '用法：',
  '  categories --account <电商账号 id> [--refresh] [--out 目录]',
  '  resolve --account <电商账号 id> (--cat <类目 id> | --item <本店商品链接或 id> | --own <本店商品标题关键词> | --keyword <商品名> | --line <产品线>) [--out 目录]',
  '  rules --account <电商账号 id> --cat <类目 id> [--out 目录]',
].join('\n')

/** A command line, read. */
export interface PublishCategoryOptions {
  readonly command: 'categories' | 'resolve' | 'rules'
  readonly account: string
  readonly out: string
  readonly refresh: boolean
  readonly source?: CategorySource
  readonly catId?: string
}

/**
 * Read the command line.
 * @param argv - the arguments after the script.
 * @returns the options.
 * @throws SkillError usage for a wrong command line.
 */
export function parsePublishCategoryOptions(argv: readonly string[]): PublishCategoryOptions {
  let parsed: ReturnType<typeof parse>
  const parse = (args: string[]) => parseArgs({
    args, allowPositionals: true,
    options: {
      account: { type: 'string' }, out: { type: 'string' }, refresh: { type: 'boolean' },
      cat: { type: 'string' }, item: { type: 'string' }, own: { type: 'string' }, keyword: { type: 'string' }, line: { type: 'string' },
    },
  })
  try {
    parsed = parse([...argv])
  } catch (error) {
    throw new SkillError(`${(error as Error).message}\n${USAGE}`, EXIT.usage)
  }
  const { values, positionals } = parsed
  const command = positionals[0]
  if (command !== 'categories' && command !== 'resolve' && command !== 'rules') throw new SkillError(`缺少或认不出子命令：${command ?? '（无）'}\n${USAGE}`, EXIT.usage)
  if (values.account === undefined || values.account === '') throw new SkillError(`缺少 --account。\n${USAGE}`, EXIT.usage)
  const base: PublishCategoryOptions = { command, account: values.account, out: values.out ?? '天猫发品', refresh: values.refresh === true }
  if (command === 'categories') return base
  if (command === 'rules') {
    if (values.cat === undefined || !/^\d+$/u.test(values.cat)) throw new SkillError(`rules 需要 --cat <类目 id>（数字）。\n${USAGE}`, EXIT.usage)
    return { ...base, catId: values.cat }
  }
  const given = (['cat', 'item', 'own', 'keyword', 'line'] as const).filter(name => values[name] !== undefined && values[name] !== '')
  if (given.length !== 1) throw new SkillError(`resolve 需要且只能给 --cat、--item、--own、--keyword、--line 其中一个。\n${USAGE}`, EXIT.usage)
  const name = given[0] as 'cat' | 'item' | 'own' | 'keyword' | 'line'
  const value = values[name] as string
  const source: CategorySource = name === 'cat' ? { kind: 'id', id: value } : name === 'item' ? { kind: 'item', input: value }
    : name === 'line' ? { kind: 'line', line: value } : { kind: name, keyword: value }
  return { ...base, source }
}

/** A store's category list as cached. */
interface CategoryCache {
  readonly store: string
  readonly fetchedAt: string
  readonly categories: readonly TmallCategory[]
}

/**
 * The store's publishable categories: the cache while it is fresh and holds every wanted category, read
 * from Tmall otherwise, so a category authorized since the cache was written is found.
 * @param page - a tab of the account.
 * @param account - the account, whose store names the cache.
 * @param options - output directory and whether to refresh.
 * @param now - the moment.
 * @param wanted - category ids the caller looks for.
 * @returns the categories and whether they came from the cache.
 * @throws SkillError failed when Tmall lists no category the store may publish in; nothing is cached then.
 */
async function categoriesOf(
  page: Page, account: MerchantBrowser, options: PublishCategoryOptions, now: Date, wanted: readonly string[] = [],
): Promise<{ readonly categories: readonly TmallCategory[]; readonly fetchedAt: string; readonly cached: boolean }> {
  const path = resolve(options.out, `类目缓存_${fileSafe(account.store)}.json`)
  if (!options.refresh) {
    const cache = await readCache(path)
    if (cache !== undefined && now.getTime() - Date.parse(cache.fetchedAt) < CACHE_DAYS * 86_400_000
      && wanted.every(id => cache.categories.some(c => c.id === id))) {
      return { categories: cache.categories, fetchedAt: cache.fetchedAt, cached: true }
    }
  }
  await openEntry(page)
  const categories = await storeCategories(page)
  if (categories.length === 0) throw new SkillError('天猫没有列出这家店可以发布的任何类目，请确认店铺的类目授权。', EXIT.failed)
  const fetchedAt = now.toISOString()
  await mkdir(resolve(options.out), { recursive: true })
  await writeFile(path, `${JSON.stringify({ store: account.store, fetchedAt, categories } satisfies CategoryCache, null, 2)}\n`)
  return { categories, fetchedAt, cached: false }
}

/**
 * Read a cache file that may be missing or unreadable.
 * @param path - the file.
 * @returns the cache, or undefined.
 */
async function readCache(path: string): Promise<CategoryCache | undefined> {
  try {
    const cache = JSON.parse(await readFile(path, 'utf8')) as CategoryCache
    return Array.isArray(cache.categories) && typeof cache.fetchedAt === 'string' ? cache : undefined
  } catch {
    // A missing or damaged cache is read again from Tmall.
    return undefined
  }
}

/**
 * Describe a resolution for the model.
 * @param resolution - what the source offered.
 * @returns Markdown.
 */
export function resolutionText(resolution: Resolution): string {
  const lines = resolution.candidates.length === 0
    ? ['没有找到这家店可以使用的类目。']
    : resolution.candidates.map((c, i) => `${String(i + 1)}. ${c.category.path.join(' > ')}（类目 id ${c.category.id}）—— ${c.reason}${c.category.tips === undefined ? '' : `；提示：${c.category.tips}`}`)
  return [...lines, ...resolution.note === undefined ? [] : ['', resolution.note]].join('\n')
}

/**
 * Summarize a category's field rules for the model.
 * @param rules - the rules.
 * @returns Markdown.
 */
export function rulesText(rules: PublishRules): string {
  const describe = (f: FieldRule): string => {
    const options = f.options === undefined ? '' : `，可选 ${String(f.options.length)} 项${f.allowsCustom === true ? '（可自定义）' : ''}：${f.options.slice(0, 6).map(o => o.text).join('、')}${f.options.length > 6 ? '…' : ''}`
    const shown = !f.visible ? '，条件显示' : f.conditions === undefined ? '' : '，受条件影响'
    return `- ${f.label}（${f.key}，${f.uiType}${f.readonly === true ? '，只读' : ''}${shown}）${options}`
  }
  const visible = rules.fields.filter(f => f.required && f.visible && f.declaration !== true)
  const declarations = rules.fields.filter(f => f.declaration === true)
  const conditional = rules.fields.filter(f => f.required && !f.visible && f.declaration !== true)
  return [
    `类目：${rules.categoryPath}（${rules.catId}），共 ${String(rules.fields.length)} 个字段。`,
    '',
    `必填字段（${String(visible.length)}）：`,
    ...visible.map(describe),
    '',
    `需要店铺确认的声明（${String(declarations.length)}）：`,
    ...declarations.map(f => `- ${f.label === f.key ? '' : `${f.label}：`}${f.options?.[0]?.text ?? f.key}（${f.key}）`),
    ...conditional.length === 0 ? [] : ['', `满足条件才出现的必填字段（${String(conditional.length)}）：`, ...conditional.map(describe)],
  ].join('\n')
}

/**
 * Run one command.
 * @param argv - the arguments after the script.
 * @param deps - the outside world.
 * @returns the exit status.
 */
export async function main(argv: readonly string[], deps: Deps = realDeps): Promise<number> {
  try {
    const options = parsePublishCategoryOptions(argv)
    const { result } = await withMerchantPage(options, deps, (page, account) => run(page, account, options, deps))
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

/**
 * The store's categories for resolving.
 * @returns the context.
 */
function context(page: Page, account: MerchantBrowser, options: PublishCategoryOptions, deps: Deps): ResolveContext {
  return { categories: async wanted => (await categoriesOf(page, account, options, deps.now(), wanted)).categories, memory: deps.memory }
}

/**
 * Do the command's work in the account's tab.
 * @returns the text to print.
 */
async function run(page: Page, account: MerchantBrowser, options: PublishCategoryOptions, deps: Deps): Promise<string> {
  const header = `店铺 ${account.store}（账号 ${account.account}），${beijingTime(deps.now())}（北京时间）。`
  switch (options.command) {
    case 'categories': {
      const { categories, fetchedAt, cached } = await categoriesOf(page, account, options, deps.now())
      const list = categories.map(c => `- ${c.path.join(' > ')}（${c.id}）${c.tips === undefined ? '' : ` —— ${c.tips}`}`)
      return [header, `这家店可以发布的类目共 ${String(categories.length)} 个（${cached ? `用 ${beijingTime(new Date(fetchedAt))} 的缓存` : '刚从天猫读取'}）：`, ...list].join('\n')
    }
    case 'resolve': {
      const resolution = await resolveCategory(page, options.source as CategorySource, context(page, account, options, deps))
      return `${header}\n${resolutionText(resolution)}`
    }
    case 'rules': {
      const catId = options.catId as string
      const resolution = await resolveCategory(page, { kind: 'id', id: catId }, context(page, account, options, deps))
      const { category } = resolution.candidates[0] as Candidate
      const read = await readRules(page, catId)
      const rules = { ...read, categoryPath: read.categoryPath === '' ? category.path.join(' > ') : read.categoryPath }
      const base = `字段规则_${catId}`
      const dir = resolve(options.out)
      await mkdir(dir, { recursive: true })
      const json = resolve(dir, `${base}.json`)
      await writeFile(json, `${JSON.stringify({ store: account.store, readAt: deps.now().toISOString(), ...rules }, null, 2)}\n`)
      return `${header}\n${rulesText(rules)}\n\n已保存：${json}`
    }
  }
}
