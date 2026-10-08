/**
 * The 「单品全量采集和报告」 script: for each Tmall or Taobao item asked for, a buyer account that DSH
 * picks opens the item page once and reads its images, SKUs and prices, description, 问大家, and
 * reviews, then writes them with a fact-layer report. Each item page counts toward the buyer
 * account's pages for today; when none are left, or risk control shows, the run stops and keeps
 * everything read before.
 */

import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { takeOverBuyer, type BuyerBrowser } from './account.ts'
import { fileSafe, writeFiles } from './cli.ts'
import { EXIT, SkillError } from './errors.ts'
import { factsReport, isNegative, itemFacts } from './item-facts.ts'
import { itemIdOf, itemUrl, openItem, readQuestions, readReviews, type Collected, type ItemPage, type Limits, type Pace } from './item.ts'
import { openPage, sleep, type Page } from './page.ts'
import { toCsv } from './sheet.ts'

/** What the script reaches outside itself; tests replace it. */
export interface ItemDeps {
  readonly takeOver: () => Promise<BuyerBrowser>
  readonly openPage: (cdpUrl: string) => Promise<Page>
  readonly fetchFile: typeof fetch
  readonly pace: Pace
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
}

/** The real outside world. */
export const realItemDeps: ItemDeps = {
  takeOver: () => takeOverBuyer(),
  openPage: cdpUrl => openPage(cdpUrl),
  fetchFile: fetch,
  pace: { sleep, random: Math.random },
  stdout: (text) => { process.stdout.write(text) },
  stderr: (text) => { process.stderr.write(text) },
}

/** A run's options. */
export interface ItemOptions {
  /** Item ids, in the order asked. */
  readonly items: readonly string[]
  readonly limits: Limits
  readonly out: string
}

const USAGE = '用法：<商品链接或 id>… [--questions 100] [--reviews 200] [--appends 100] [--per-tag 100] [--out 天猫报表]'

/**
 * Read the command line.
 * @param argv - the arguments after the script.
 * @returns the options.
 * @throws SkillError usage for a wrong command line.
 */
export function parseItemOptions(argv: readonly string[]): ItemOptions {
  let parsed: { values: Record<string, string | undefined>; positionals: string[] }
  try {
    parsed = parseArgs({
      args: [...argv], allowPositionals: true,
      options: { questions: { type: 'string' }, reviews: { type: 'string' }, appends: { type: 'string' }, 'per-tag': { type: 'string' }, out: { type: 'string' } },
    })
  } catch (error) {
    throw new SkillError(`${(error as Error).message}\n${USAGE}`, EXIT.usage)
  }
  if (parsed.positionals.length === 0) throw new SkillError(`缺少商品链接或 id。\n${USAGE}`, EXIT.usage)
  const count = (name: string, fallback: number): number => {
    const value = parsed.values[name]
    if (value === undefined) return fallback
    if (!/^\d+$/u.test(value)) throw new SkillError(`--${name} 要非负整数，收到「${value}」。\n${USAGE}`, EXIT.usage)
    return Number(value)
  }
  return {
    items: [...new Set(parsed.positionals.map(itemIdOf))],
    limits: { questions: count('questions', 100), reviews: count('reviews', 200), appends: count('appends', 100), perTag: count('per-tag', 100) },
    out: parsed.values.out ?? '天猫报表',
  }
}

/** One item's outcome. */
interface ItemOutcome {
  readonly itemId: string
  /** The summary line. */
  readonly line: string
  /** Where its files are, when any were written. */
  readonly dir?: string
}

/**
 * Run the script.
 * @param argv - the arguments after the script.
 * @param deps - the outside world.
 * @returns the exit status: 0 when every item was read, 4 when risk control or the page limit stopped
 *   the run (what was read is saved), and the stop's status otherwise.
 */
export async function main(argv: readonly string[], deps: ItemDeps = realItemDeps): Promise<number> {
  let options: ItemOptions
  let buyer: BuyerBrowser
  let page: Page
  try {
    options = parseItemOptions(argv)
    buyer = await deps.takeOver()
    page = await deps.openPage(buyer.cdpUrl)
  } catch (error) {
    return fail(deps, error)
  }
  const outcomes: ItemOutcome[] = []
  let stop: SkillError | undefined
  try {
    for (const [index, itemId] of options.items.entries()) {
      if (index >= buyer.pagesLeft) {
        stop = new SkillError(`买家号 ${buyer.account} 今天只剩 ${String(buyer.pagesLeft)} 个页面，每个商品要打开 1 个页面，商品 ${options.items.slice(index).join('、')} 没有采集，已提前停止。`, EXIT.stopped)
        break
      }
      const outcome = await collect(page, deps, itemId, options)
      outcomes.push(outcome.result)
      if (outcome.stop !== undefined) {
        stop = outcome.stop
        if (index + 1 < options.items.length) stop = new SkillError(`${stop.message}\n商品 ${options.items.slice(index + 1).join('、')} 没有采集。`, stop.exitCode)
        break
      }
    }
  } catch (error) {
    // collect() turns every stop it knows into its result, so what reaches here is an unexpected Error.
    stop = new SkillError(`失败：${(error as Error).message}`)
  } finally {
    await page.close().catch(() => { /* The tab is gone with its browser; nothing is left to close. */ })
  }
  deps.stdout([
    `# 单品采集 · 买家号 ${buyer.account}（DSH 自动挑选，今天开始时剩 ${String(buyer.pagesLeft)} 页）`,
    '',
    ...outcomes.flatMap(outcome => [outcome.line, ...outcome.dir === undefined ? [] : [`  文件：${outcome.dir}（报告.md、facts.json、skus.csv、questions.csv、reviews.csv、reviews_negative.csv、item.json、images/）`]]),
    '',
  ].join('\n'))
  if (stop === undefined) return 0
  deps.stderr(`${stop.message}\n`)
  return stop.exitCode
}

/** Read one item and write its files; a stop after the page opened still writes what was read. */
async function collect(
  page: Page, deps: ItemDeps, itemId: string, options: ItemOptions,
): Promise<{ readonly result: ItemOutcome; readonly stop?: SkillError }> {
  let opened: { readonly item: ItemPage; readonly descImages: readonly string[] }
  try {
    opened = await openItem(page, itemId)
  } catch (error) {
    if (!(error instanceof SkillError)) throw error
    // A page that is not a standard item page only skips this item; other stops end the run.
    if (error.exitCode === EXIT.failed) return { result: { itemId, line: `- ${itemId}：${error.message}` } }
    return { result: { itemId, line: `- ${itemId}：未采集（${error.message.split('\n')[0] as string}）` }, stop: error }
  }
  const dir = join(options.out, `单品_${itemId}`)
  const saved = await saveImages(deps.fetchFile, dir, opened.item, opened.descImages)
  const collected: Collected = { questions: [], reviews: [], tags: [], calls: 0 }
  let stop: SkillError | undefined
  try {
    await readQuestions(page, deps.pace, itemId, options.limits.questions, collected)
    await readReviews(page, deps.pace, itemId, options.limits, collected)
  } catch (error) {
    stop = error instanceof SkillError ? error : new SkillError(`读取商品 ${itemId} 时失败：${(error as Error).message}；已读到的部分已保存。`)
  }
  const facts = itemFacts({
    itemId, url: itemUrl(itemId), item: opened.item, descImages: opened.descImages, savedImages: saved,
    tags: collected.tags, reviews: collected.reviews, questions: collected.questions,
  })
  const notes = stop === undefined ? [] : [`⚠️ 采集中途停止，以下只基于已读到的部分：${stop.message}`]
  const negative = collected.reviews.filter(isNegative)
  const [report] = await writeFiles(dir, '报告', [['md', factsReport(facts, notes)]])
  await writeFiles(dir, 'facts', [['json', `${JSON.stringify(facts, null, 1)}\n`]])
  await writeFiles(dir, 'item', [['json', `${JSON.stringify({ itemId, url: itemUrl(itemId), ...opened.item, descImages: opened.descImages, impressionTags: collected.tags }, null, 1)}\n`]])
  await writeFiles(dir, 'skus', [['csv', toCsv([SKU_COLUMNS.map(([title]) => title), ...opened.item.skus.map(sku => SKU_COLUMNS.map(([, key]) => sku[key]))])]])
  await writeFiles(dir, 'questions', [['csv', toCsv([['问题ID', '日期', '问题', '回答数', '置顶回答'], ...collected.questions.map(question => [question.questionId, question.date, question.question, String(question.answerCount), question.answers.join(' | ')])])]])
  await writeFiles(dir, 'reviews', [['csv', reviewsCsv(collected.reviews)]])
  await writeFiles(dir, 'reviews_negative', [['csv', reviewsCsv(negative)]])
  const line = `- ${itemId} ${opened.item.title}：主图 ${String(opened.item.mainImages.length)}、详情图 ${String(opened.descImages.length)}（保存图片 ${String(saved)} 张），SKU ${String(opened.item.skus.length)}，`
    + `问大家 ${String(collected.questions.length)}，评价 ${String(collected.reviews.length)}（主列表 ${String(collected.reviews.filter(review => review.source === 'all').length)}，负面标签 ${String(facts.reviews.tagRows)}，追评 ${String(facts.reviews.appends.sample)}；中差评视图 ${String(negative.length)}），`
    + `接口调用 ${String(collected.calls)} 次${opened.item.riskDegraded ? '；⚠️ 平台降级（活动价和销量可能缺失）' : ''}${stop === undefined ? '' : '；⚠️ 中途停止，只保存了已读到的部分'}。报告：${report as string}`
  return { result: { itemId, line, dir: resolve(dir) }, ...stop === undefined ? {} : { stop } }
}

const SKU_COLUMNS: readonly (readonly [string, 'skuId' | 'sku' | 'priceTitle' | 'price' | 'promoTitle' | 'promoPrice' | 'stock' | 'stockText' | 'image'])[] = [
  ['SKU ID', 'skuId'], ['SKU', 'sku'], ['价格标题', 'priceTitle'], ['价格', 'price'], ['活动标题', 'promoTitle'], ['活动价', 'promoPrice'],
  ['库存', 'stock'], ['库存说明', 'stockText'], ['图片', 'image'],
]

function reviewsCsv(reviews: Collected['reviews']): string {
  return toCsv([
    ['来源', '评价类型', '日期', '用户', 'SKU', '内容', '追评', '追评间隔天数', '商家回复', '图片视频', '回购', '评价ID'],
    ...reviews.map(review => [
      review.source, review.rateType, review.date, review.user, review.sku, review.content, review.append, review.appendDays,
      review.reply, review.media, review.repurchase, review.id,
    ]),
  ])
}

/**
 * Download the item's images into `images/`: main images, SKU option images, and description images.
 * A failed download is skipped.
 * @returns how many were saved.
 */
async function saveImages(fetchFile: typeof fetch, dir: string, item: ItemPage, desc: readonly string[]): Promise<number> {
  const wanted: (readonly [string, string])[] = [
    ...item.mainImages.map((url, index) => [`main_${pad(index)}`, url] as const),
    ...item.skus.flatMap((sku, index) => sku.image === '' ? [] : [[`sku_${pad(index)}_${fileSafe(sku.sku).slice(0, 40)}`, sku.image] as const]),
    ...desc.map((url, index) => [`desc_${pad(index)}`, url] as const),
  ]
  let saved = 0
  for (const [name, url] of wanted) {
    try {
      const response = await fetchFile(url.startsWith('//') ? `https:${url}` : url, { headers: { referer: 'https://detail.tmall.com/' } })
      if (!response.ok) continue
      await writeFiles(join(dir, 'images'), name, [[extension(url), new Uint8Array(await response.arrayBuffer())]])
      saved++
    } catch {
      // A network failure for one image skips it; the count tells the user how many were saved.
    }
  }
  return saved
}

function pad(index: number): string {
  return String(index + 1).padStart(2, '0')
}

function extension(url: string): string {
  return /\.(jpe?g|png|webp|gif)(?:_|$|\?)/iu.exec(url)?.[1]?.toLowerCase() ?? 'jpg'
}

function fail(deps: ItemDeps, error: unknown): number {
  if (error instanceof SkillError) {
    deps.stderr(`${error.message}\n`)
    return error.exitCode
  }
  // Failures before the run are the Errors of parsing, DSH, and the DevTools connection.
  deps.stderr(`失败：${(error as Error).message}\n`)
  return EXIT.failed
}
