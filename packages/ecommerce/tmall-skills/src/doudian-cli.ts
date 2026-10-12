/**
 * The 「抖店发品存草稿」 script: finds a new item's Douyin shop category, writes that category's field
 * rules for `ecommerce-product-draft`, and saves a draft the user confirmed to the shop's 草稿箱 with
 * 商品状态 下架 — never submitted for review, never on sale — recording each attempt so a draft is never
 * saved twice.
 *
 * Commands:
 * - `resolve --account <id> (--keyword <商品名> | --line <产品线> | --cat <类目 id> | --image <主图> --title <标题>)` names candidate categories.
 * - `children --account <id> [--parent <类目 id>]` lists one level of the store's opened categories.
 * - `rules --account <id> --cat <类目 id>` saves `字段规则_<类目 id>.json`.
 * - `check --account <id> --draft <商品草稿 json>` looks for the item in the 草稿箱 and the product list, changing nothing.
 * - `save --account <id> --draft <商品草稿 json> --rules <字段规则 json> [--confirmed] [--stock <n>] [--unknown-checked]` saves the draft.
 */

import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { takeOverMerchant } from './account.ts'
import { realDeps, type Deps } from './cli.ts'
import { beijingTime } from './dates.ts'
import type { FieldCheck } from './draft.ts'
import { createUrl, DOUDIAN_CREATE_URL, DOUDIAN_DRAFTS_URL, FIND_STORE, openDoudian } from './doudian.ts'
import {
  categoryById, childCategories, doudianRules, libraryText, predictCategories, readForm, searchCategories,
} from './doudian-category.ts'
import {
  DraftRefused, extras, findProducts, formValues, listDrafts, NotSent, onSale, renderDetail, saveDraft, uploadDoudianImage,
  type DetailImage,
} from './doudian-publish.ts'
import { EXIT, SkillError } from './errors.ts'
import { readImage } from './images.ts'
import type { Page } from './page.ts'
import { readStoreRules, runDraftStore, type CategoryFinder, type DraftStore } from './draft-store-cli.ts'
import {
  saveBlockers, saveContext, unready, unsettled, writeRecord,
  type DraftCategorySource, type DraftFile, type PublishRecord,
} from './publish-common.ts'

/** The directory the rules and the record file go to by default. */
const OUT = '抖店发品'

/** The real outside world, taking over Douyin shop merchant accounts. */
export const doudianDeps: Deps = { ...realDeps, takeOver: accountId => takeOverMerchant(accountId, undefined, 'doudian') }

/** Where a `resolve` looks. */
export type DoudianSource = DraftCategorySource

/** The Douyin shop's category lookups. */
const FINDER: CategoryFinder = {
  name: '抖店', platform: 'doudian', unusable: '未开通', search: searchCategories, byId: categoryById,
  children: childCategories, noChildren: parent => `类目 ${parent} 下面没有这家店开通的子类目。`,
  predict: async (page, image, name, title) => {
    await openDoudian(page, DOUDIAN_CREATE_URL, FIND_STORE)
    return predictCategories(page, await uploadDoudianImage(page, image, name), title)
  },
}

/** `rules`: the category's field rules, written to a file. */
const readRules: DraftStore['rules'] = async (page, catId) => {
  const category = await categoryById(page, catId)
  if (!category.usable) throw new SkillError(`这家店没有开通类目 ${catId}（${category.path.join(' > ')}）。`, EXIT.usage)
  await openDoudian(page, createUrl(catId), FIND_STORE)
  const form = await readForm(page)
  // The library's entries are named by upload time; their images tell them apart.
  const images = Object.fromEntries(form.qualifications.flatMap(
    item => item.options.map(option => [libraryText(item, option), option.urls]),
  ))
  return { rules: doudianRules(catId, category.path, form), extra: { qualificationImages: images }, shownOptions: 6 }
}

/** Links to the 草稿箱. */
const DRAFT_LINK = `- 草稿箱：${DOUDIAN_DRAFTS_URL}`

/**
 * The same product already in the shop: a product an earlier attempt saved, or a draft or product with
 * the same title.
 */
async function alreadySaved(
  page: Page, records: readonly PublishRecord[], title: string,
): Promise<{ id: string; how: string } | undefined> {
  for (const record of [...records].reverse()) {
    if (record.itemId !== undefined && (await findProducts(page, record.itemId)).some(row => row.productId === record.itemId)) {
      return { id: record.itemId, how: `${beijingTime(new Date(record.at))}（北京时间）DSH 存过，仍在店里` }
    }
  }
  const same = (await findProducts(page, title)).find(row => row.title === title)
  if (same !== undefined) return { id: same.productId, how: same.draftStatus === 1 ? '草稿箱里已有同名草稿' : '商品列表里已有同名商品' }
  // The product search may leave out drafts, so the 草稿箱 is read as well.
  const draft = (await listDrafts(page)).find(row => row.title === title)
  if (draft !== undefined) return { id: draft.productId, how: '草稿箱里已有同名草稿' }
  return undefined
}

const save: DraftStore['save'] = async (page, account, draft, options, deps) => {
  const rules = await readStoreRules(options.rules as string, STORE)
  const checks = (draft.checks ?? []) as FieldCheck[]
  const given = extras(checks, draft.skus.map(sku => sku.price), rules)
  const reasons = saveBlockers(draft, rules, options, given)
  if (reasons.length > 0 || 'problems' in given) throw unready(reasons, '草稿箱')
  const { title, recordPath, records, record } = await saveContext(options, account, draft, rules.catId)
  const found = await alreadySaved(page, records, title)
  if (found !== undefined) {
    await writeRecord(recordPath, { ...record, status: 'exists', itemId: found.id, at: deps.now().toISOString(), message: found.how })
    return `没有重复保存：店铺 ${account.store} 里已有「${title}」，商品 ID ${found.id}（${found.how}）。\n${DRAFT_LINK}`
  }
  const open = unsettled(records)
  if (open !== undefined && !options.unknownChecked) {
    throw new SkillError([
      `没有保存：${beijingTime(new Date(open.at))}（北京时间）那次保存结果不明，店里暂时查不到它。`,
      '请用户到抖店后台的草稿箱和商品列表确认没有这件商品；用户确认没有后，才能加 --unknown-checked 再保存。',
    ].join('\n'), EXIT.usage)
  }
  const progress = (step: string) => { deps.stderr(`[${beijingTime(deps.now())}] ${step}\n`) }
  await writeRecord(recordPath, { ...record, status: 'submitting', at: deps.now().toISOString() })
  let values: ReturnType<typeof formValues>
  try {
    progress('打开抖店发品页')
    await openDoudian(page, createUrl(rules.catId), FIND_STORE)
    const form = await readForm(page)
    const { images, sizes } = await uploadAll(page, draft, given.proofFile, progress)
    const idBase = deps.now().getTime() * 1000
    progress('生成商品详情')
    const detailImages = draft.images.detail.map(file => ({ url: images[file] as string, ...sizes[file] as DetailSize }))
    const detail = await renderDetail(page, rules.catId, detailImages, detailImages.map(() => randomUUID()))
    values = formValues({ draft, checks, rules, form, images, extras: given, detail, stock: options.stock ?? 0, idBase })
  } catch (error) {
    // Nothing was saved yet.
    await writeRecord(recordPath, { ...record, status: 'failed', at: deps.now().toISOString(), message: (error as Error).message })
    throw error
  }
  progress('保存到草稿箱（商品状态：下架）')
  let productId: string
  try {
    productId = await saveDraft(page, values)
  } catch (error) {
    const refused = error instanceof DraftRefused || error instanceof NotSent
    await writeRecord(recordPath, { ...record, status: refused ? 'failed' : 'unknown', at: deps.now().toISOString(), message: (error as Error).message })
    if (refused) throw error
    throw new SkillError(`保存后没有拿到抖店的答复（${(error as Error).message}），结果不明。不要重试，先运行 check 查店里。`, EXIT.failed)
  }
  let state: Awaited<ReturnType<typeof draftState>>
  try {
    state = await draftState(page, productId)
  } catch (error) {
    // The save was answered; only the lookup failed.
    await writeRecord(recordPath, { ...record, itemId: productId, status: 'unknown', at: deps.now().toISOString(), message: (error as Error).message })
    throw new SkillError(`抖店答复已保存（商品 ID ${productId}），但核验时出错（${(error as Error).message}）。不要重试，稍后运行 check 查店里。`, EXIT.failed)
  }
  await writeRecord(recordPath, { ...record, itemId: productId, status: state, at: deps.now().toISOString() })
  if (state === 'on-sale') throw new SkillError(`抖店把商品 ID ${productId} 放到了「售卖中」！请用户立即到抖店后台下架它。`, EXIT.failed)
  if (state === 'not-draft') throw new SkillError(`抖店把商品 ID ${productId} 存成了草稿以外的状态！请用户立即到抖店后台查看它，确认没有提交审核或上架。`, EXIT.failed)
  if (state === 'unknown') throw new SkillError(`抖店答复已保存（商品 ID ${productId}），但草稿箱里暂时查不到它。不要重试，稍后运行 check 查店里。`, EXIT.failed)
  return [
    `已保存到店铺 ${account.store} 的草稿箱（商品状态：下架，没有提交审核）：商品 ID ${productId}，标题「${title}」。`,
    DRAFT_LINK,
    '请到抖店后台草稿箱确认后再由用户自己提交发布。',
  ].join('\n')
}

/** Where a saved product is: on sale, a draft, a product that is not a draft, or not listed yet. */
async function draftState(page: Page, productId: string): Promise<'saved' | 'on-sale' | 'not-draft' | 'unknown'> {
  if ((await onSale(page, productId)).some(row => row.productId === productId)) return 'on-sale'
  const listed = await page.waitFor(async () => (await listDrafts(page, 50)).some(row => row.productId === productId), 30_000)
  if (listed) return 'saved'
  return (await findProducts(page, productId)).some(row => row.productId === productId && row.draftStatus !== 1) ? 'not-draft' : 'unknown'
}

/** An uploaded image's size, in pixels. */
type DetailSize = Pick<DetailImage, 'width' | 'height'>

/** Upload every image the form uses: up to 5 main images, the detail images, the SKU images, and the reference price's proof. */
async function uploadAll(
  page: Page, draft: DraftFile, proof: string | undefined, progress: (step: string) => void,
): Promise<{ images: Record<string, string>; sizes: Record<string, DetailSize> }> {
  const skuImages = draft.skus.flatMap(sku => sku.image === undefined ? [] : [sku.image])
  const files = new Set([...draft.images.main.slice(0, 5), ...draft.images.detail, ...skuImages, ...proof === undefined ? [] : [proof]])
  progress(`上传 ${String(files.size)} 张图片`)
  const images: Record<string, string> = {}
  const sizes: Record<string, DetailSize> = {}
  for (const file of files) {
    const bytes = await readFile(join(draft.folder, file))
    const { format, width, height } = readImage(bytes)
    sizes[file] = { width, height }
    // The name carries the real format, whatever the file was called.
    images[file] = await uploadDoudianImage(page, bytes, `${basename(file).replace(/\.[^.]+$/u, '')}.${format === 'png' ? 'png' : 'jpg'}`)
  }
  return { images, sizes }
}

/** The 抖店 side of the 草稿箱 publish script. */
const STORE: DraftStore = {
  out: OUT, idLabel: '商品 ID', draftLink: DRAFT_LINK,
  open: async (page) => { await openDoudian(page, DOUDIAN_DRAFTS_URL) },
  alreadySaved, finder: FINDER, rules: readRules, save,
}

/**
 * Run one command.
 * @param argv - the arguments after the script.
 * @param deps - the outside world.
 * @returns the exit status.
 */
export function main(argv: readonly string[], deps: Deps = doudianDeps): Promise<number> {
  return runDraftStore(argv, deps, STORE)
}
