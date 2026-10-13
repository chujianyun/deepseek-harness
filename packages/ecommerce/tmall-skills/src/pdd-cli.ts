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

import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { takeOverMerchant } from './account.ts'
import { realDeps, type Deps } from './cli.ts'
import { beijingTime } from './dates.ts'
import type { FieldCheck } from './draft.ts'
import { EXIT, SkillError } from './errors.ts'
import { readImage } from './images.ts'
import type { Page } from './page.ts'
import type { PublishRules } from './publish-rules.ts'
import {
  categoryById, childCategories, createSession, MEDICAL_DEVICE_IMAGE, pddRules, predictCategories, readLimits, readTemplate,
  searchCategories, setCategory,
} from './pdd-category.ts'
import {
  buildGoods, carouselFiles, certificateFile, extraPrices, fileWhiteImage, listDrafts, listGoods, readSession, saveDraft, specIdFor,
  uploadPddImage, type DraftRow,
} from './pdd-publish.ts'
import { openPdd, PDD_GOODS_URL, PddRefusal } from './pdd.ts'
import { readStoreRules, runDraftStore, type CategoryFinder, type DraftStore } from './draft-store-cli.ts'
import {
  saveBlockers, saveContext, unready, unsettled, writeRecord,
  type DraftCategorySource, type DraftFile, type PublishRecord,
} from './publish-common.ts'

/** The directory the rules and the record file go to by default. */
const OUT = '拼多多发品'

/** The real outside world, taking over Pinduoduo merchant accounts. */
export const pddDeps: Deps = { ...realDeps, takeOver: accountId => takeOverMerchant(accountId, undefined, 'pinduoduo') }

/** Where a `resolve` looks. */
export type PddSource = DraftCategorySource

/** Pinduoduo's category lookups. */
const FINDER: CategoryFinder = {
  name: '拼多多', platform: 'pinduoduo', unusable: '缺资质', search: searchCategories, byId: categoryById,
  children: childCategories, noChildren: parent => `类目 ${parent} 下面没有子类目。`,
  predict: async (page, image, name, title) => {
    const url = await uploadPddImage(page, image, name)
    const session = await createSession(page)
    return predictCategories(page, session.goodsId, url, title)
  },
}

/** `rules`: the category's field rules, written to a file. */
const readRules: DraftStore['rules'] = async (page, catId) => {
  const category = await categoryById(page, catId)
  return { rules: pddRules(catId, category.path, await readTemplate(page, catId), await readLimits(page, catId)) }
}

/** Links to the 草稿箱. */
const DRAFT_LINK = `- 草稿箱：${PDD_GOODS_URL}（商品列表 →「草稿箱」）`

/**
 * The same product already in the store: a draft or an item an earlier attempt saved, a draft with the
 * same title, or an item with the same title on sale or not.
 */
async function alreadySaved(
  page: Page, records: readonly PublishRecord[], title: string,
): Promise<{ id: string; how: string; draft: boolean } | undefined> {
  const drafts = await listDrafts(page)
  for (const record of [...records].reverse()) {
    if (record.draftId !== undefined && drafts.some(row => row.draftId === record.draftId)) {
      return { id: record.draftId, how: `${beijingTime(new Date(record.at))}（北京时间）DSH 存过，仍在草稿箱`, draft: true }
    }
  }
  const draft = drafts.find(row => row.title === title)
  if (draft !== undefined) return { id: draft.draftId, how: '草稿箱里已有同名草稿', draft: true }
  const goodsIds = new Set(records.flatMap(record => record.itemId === undefined ? [] : [record.itemId]))
  for (const keyword of new Set([title, ...records.map(record => record.title)])) {
    const item = (await listGoods(page, keyword)).find(row => row.title === title || goodsIds.has(row.goodsId))
    if (item !== undefined) return { id: item.goodsId, how: '商品列表里已有这件商品', draft: false }
  }
  return undefined
}

const save: DraftStore['save'] = async (page, account, draft, options, deps) => {
  const rules = await readStoreRules(options.rules as string, STORE)
  const checks = (draft.checks ?? []) as FieldCheck[]
  const prices = extraPrices(checks, draft.skus.map(sku => sku.price))
  const reasons = [...saveBlockers(draft, rules, options, prices), ...certificateProblems(draft, rules, checks)]
  if (reasons.length > 0 || 'problems' in prices) throw unready(reasons, '草稿箱')
  const { title, recordPath, records, record } = await saveContext(options, account, draft, rules.catId)
  const found = await alreadySaved(page, records, title)
  if (found !== undefined) {
    const id = found.draft ? { draftId: found.id } : { itemId: found.id }
    await writeRecord(recordPath, { ...record, ...id, status: 'exists', at: deps.now().toISOString(), message: found.how })
    return `没有重复保存：店铺 ${account.store} 里已有「${title}」，ID ${found.id}（${found.how}）。\n${DRAFT_LINK}`
  }
  const open = unsettled(records)
  if (open !== undefined && !options.unknownChecked) {
    throw new SkillError([
      `没有保存：${beijingTime(new Date(open.at))}（北京时间）那次保存结果不明，店里暂时查不到它。`,
      '请用户到拼多多后台的草稿箱和商品列表确认没有这件商品；用户确认没有后，才能加 --unknown-checked 再保存。',
    ].join('\n'), EXIT.usage)
  }
  const progress = (step: string) => { deps.stderr(`[${beijingTime(deps.now())}] ${step}\n`) }
  await writeRecord(recordPath, { ...record, status: 'submitting', at: deps.now().toISOString() })
  let form: Record<string, unknown>
  let session: Awaited<ReturnType<typeof createSession>>
  try {
    progress('新建编辑并选类目')
    session = await createSession(page)
    await setCategory(page, session, rules.catId)
    const template = await readTemplate(page, rules.catId)
    const images = await uploadAll(page, draft, checks, progress)
    const specs: Record<string, number> = {}
    for (const sku of draft.skus) specs[sku.name] = await specIdFor(page, rules.catId, sku.name)
    const detail = await readSession(page, session)
    const white = draft.images.white[0]
    if (white !== undefined) {
      progress('登记白底图')
      await fileWhiteImage(page, session.goodsId, detail.cat_ids, images[white] as string)
    }
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

/**
 * Why the registration certificate cannot be saved: rules that ask for it with a draft checked without it,
 * a path that is not one of the material folder's images, or an image also sorted into the carousel or the detail.
 */
function certificateProblems(draft: DraftFile, rules: PublishRules, checks: readonly FieldCheck[]): string[] {
  const asked = rules.fields.some(field => field.key === MEDICAL_DEVICE_IMAGE.key)
  if (asked && !checks.some(check => check.key === MEDICAL_DEVICE_IMAGE.key)) {
    return ['草稿不是按这份字段规则检查的（没有医疗器械注册证/器械备案凭证一项），请用这份字段规则重新整理素材']
  }
  const file = certificateFile(checks)
  if (file === undefined) return []
  if (!Object.values(draft.images).some(files => files.includes(file))) {
    return [`${MEDICAL_DEVICE_IMAGE.label}写的「${file}」不是素材文件夹里的图片，请写素材里注册证图片的路径`]
  }
  if ([...draft.images.main, ...draft.images.main34, ...draft.images.detail].includes(file)) {
    return [`注册证图片「${file}」也归在了轮播图或详情图里，请在答案的 images 里把它改成 other`]
  }
  return []
}

/**
 * Upload every image the form uses: up to 10 carousel images, the white-background image, the detail
 * images, the registration certificate image, and the SKU images.
 */
async function uploadAll(
  page: Page, draft: DraftFile, checks: readonly FieldCheck[], progress: (step: string) => void,
): Promise<Record<string, string>> {
  const skuImages = draft.skus.flatMap(sku => sku.image === undefined ? [] : [sku.image])
  const certificate = certificateFile(checks)
  const files = new Set([
    ...carouselFiles(draft), ...draft.images.white.slice(0, 1), ...draft.images.detail,
    ...certificate === undefined ? [] : [certificate], ...skuImages,
  ])
  progress(`上传 ${String(files.size)} 张图片`)
  const images: Record<string, string> = {}
  for (const file of files) {
    const bytes = await readFile(join(draft.folder, file))
    // The name carries the real format, whatever the file was called.
    images[file] = await uploadPddImage(page, bytes, `${basename(file).replace(/\.[^.]+$/u, '')}.${readImage(bytes).format === 'png' ? 'png' : 'jpg'}`)
  }
  return images
}

/** The 拼多多 side of the 草稿箱 publish script. */
const STORE: DraftStore = {
  out: OUT, idLabel: 'ID', draftLink: DRAFT_LINK,
  open: async (page) => { await openPdd(page) },
  alreadySaved, finder: FINDER, rules: readRules, save,
}

/**
 * Run one command.
 * @param argv - the arguments after the script.
 * @param deps - the outside world.
 * @returns the exit status.
 */
export function main(argv: readonly string[], deps: Deps = pddDeps): Promise<number> {
  return runDraftStore(argv, deps, STORE)
}
