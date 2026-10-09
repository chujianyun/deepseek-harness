/**
 * The 「天猫发品存仓库」 script: saves a product draft the user confirmed to the store's warehouse, never on
 * sale, and records each attempt so a draft is never saved twice.
 *
 * Commands:
 * - `check --account <id> --draft <商品草稿 json>` looks for the item in the warehouse and in the record, changing nothing.
 * - `save --account <id> --draft <商品草稿 json> --rules <字段规则 json> [--confirmed] [--stock <n>] [--unknown-checked]` saves it.
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import type { MerchantBrowser } from './account.ts'
import { realDeps, withMerchantPage, type Deps } from './cli.ts'
import { beijingTime } from './dates.ts'
import type { FieldCheck } from './draft.ts'
import { EXIT, SkillError } from './errors.ts'
import { fitImage, readImage } from './images.ts'
import type { Page } from './page.ts'
import { isSignIn, openManager } from './publish-category.ts'
import { parseRulesFile } from './product-draft-cli.ts'
import {
  blockers, codesOf, parsePublishOptions, readRecords, sameProduct, titleOf, unsettled, writeRecord, type DraftFile, type PublishOptions,
  type PublishRecord,
} from './publish-common.ts'
import { publishUrl } from './publish-rules.ts'
import {
  buildForm, ensureFolder, folderImages, listed, MANAGER_ROWS, readBase, submit, uploadImage, type PageBase, type Uploaded,
} from './publish-submit.ts'
import { signedOut } from './page.ts'

/** Links to an item that is in the warehouse. */
const links = (itemId: string) => [
  `- 编辑：https://sell.publish.tmall.com/tmall/publish.htm?id=${itemId}`,
  '- 仓库：https://qn.taobao.com/home.htm/sell-manage-tm/in_stock',
].join('\n')

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
  const record = { store: account.store, title, catId: rules.catId, codes: codesOf(draft) }
  const found = await alreadySaved(page, records, title)
  if (found !== undefined) {
    await writeRecord(recordPath, { ...record, status: 'exists', itemId: found.itemId, at: deps.now().toISOString(), message: found.how })
    return `没有重复保存：店铺 ${account.store} 里已有「${title}」，商品 ID ${found.itemId}（${found.how}）。\n${links(found.itemId)}`
  }
  const open = unsettled(records)
  if (open !== undefined && !options.unknownChecked) {
    throw new SkillError([
      `没有保存：${beijingTime(new Date(open.at))}（北京时间）那次提交结果不明，店里暂时查不到它，可能还在处理。`,
      '请用户到千牛「仓库中」和「出售中」确认没有这件商品；用户确认没有后，才能加 --unknown-checked 再保存。',
    ].join('\n'), EXIT.usage)
  }
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
