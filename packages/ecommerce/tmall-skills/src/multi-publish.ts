/**
 * One material folder published to several stores: the plan of the stores, the content the user
 * confirmed on the first store's card that the later drafts take, and each store's result, read from
 * the publish skills' record files and from what the model marked for steps that write no record.
 */

import type { MerchantPlatform } from './account.ts'
import { beijingTime } from './dates.ts'
import type { Answers, Draft, SourcedValue } from './draft.ts'
import type { PublishRecord } from './publish-common.ts'

/** A platform's name for the user, its publish skill, and its directory. */
export interface PlatformSkill {
  readonly name: string
  readonly skill: string
  readonly dir: string
}

/** Each platform's publish skill and the directory its rules and record file go to by default. */
export const PLATFORM_SKILLS: Readonly<Record<MerchantPlatform, PlatformSkill>> = {
  tmall: { name: '天猫', skill: 'tmall-publish', dir: '天猫发品' },
  pinduoduo: { name: '拼多多', skill: 'pdd-publish', dir: '拼多多发品' },
  doudian: { name: '抖店', skill: 'doudian-publish', dir: '抖店发品' },
}

/** One store of the plan. */
export interface PlanTarget {
  /** The e-commerce account id. */
  readonly account: string
  readonly platform: MerchantPlatform
  readonly store: string
  /** The record file the platform's publish script writes, absolute. */
  readonly records: string
}

/** What the model marked for a store whose step wrote no record. */
export interface PlanMark {
  readonly account: string
  /** `failed`: it stopped before a save; `pending`: it waits for the user; `cancelled`: the user cancelled it. */
  readonly status: 'failed' | 'pending' | 'cancelled'
  readonly note: string
  readonly at: string
}

/** A value the user confirmed on a store's card, which the later drafts take. */
export interface SharedValue {
  readonly value: string | readonly string[]
  /** The store whose card it was confirmed on. */
  readonly store: string
  readonly confirmedAt: string
}

/** A multi-store publish, as its plan file keeps it. */
export interface PublishPlan {
  readonly createdAt: string
  readonly folder: string
  readonly targets: readonly PlanTarget[]
  readonly marks: readonly PlanMark[]
  /** Field label → the confirmed value. */
  readonly shared: Readonly<Record<string, SharedValue>>
}

/** A store's result in the summary. */
export type Result = '成功' | '失败' | '待确认' | '未执行'

/** A store's result and what to tell the user about it. */
export interface Outcome {
  readonly result: Result
  readonly note: string
  /** The item or draft, as 商品 ID / 草稿 ID text. */
  readonly ids?: string
  /** Whether anything happened for the store since the plan began. */
  readonly started: boolean
}

/**
 * The ids a record names.
 * @param record - the record.
 * @returns their text, or undefined without any.
 */
function idsOf(record: PublishRecord): string | undefined {
  const ids = [
    ...record.draftId === undefined ? [] : [`草稿 ID ${record.draftId}`], ...record.itemId === undefined ? [] : [`商品 ID ${record.itemId}`],
  ]
  return ids.length === 0 ? undefined : ids.join('，')
}

/**
 * What a record means for the store.
 * @param record - the record.
 * @returns the outcome.
 */
function recordOutcome(record: PublishRecord): Outcome {
  const ids = idsOf(record)
  const base = { started: true, ...ids === undefined ? {} : { ids } }
  switch (record.status) {
    case 'saved': return { ...base, result: '成功', note: '已存进仓库/草稿箱，没有上架' }
    case 'exists': return { ...base, result: '成功', note: `店里已有这件商品，没有重复保存${record.message === undefined ? '' : `（${record.message}）`}` }
    case 'failed': return { ...base, result: '失败', note: `没有保存：${record.message ?? '平台没有给出原因'}` }
    case 'on-sale': return { ...base, result: '失败', note: '商品被放到了出售中，请立即到后台下架' }
    case 'not-draft': return { ...base, result: '失败', note: '商品离开了草稿箱（比如进了审核），请到后台查看' }
    case 'unknown':
    case 'submitting': return { ...base, result: '待确认', note: '保存结果不明：请到后台仓库/草稿箱确认，不要重试' }
  }
}

/**
 * A store's result: the latest of its records and marks since the plan began.
 * @param plan - the plan.
 * @param target - the store.
 * @param records - every record of the target's platform.
 * @returns the outcome; 未执行 when nothing happened yet.
 */
export function outcomeOf(plan: PublishPlan, target: PlanTarget, records: readonly PublishRecord[]): Outcome {
  const events = [
    ...records.filter(record => record.store === target.store && record.at >= plan.createdAt)
      .map(record => ({ at: record.at, outcome: () => recordOutcome(record) })),
    ...plan.marks.filter(mark => mark.account === target.account).map(mark => ({ at: mark.at, outcome: (): Outcome => markOutcome(mark) })),
  ].sort((a, b) => a.at.localeCompare(b.at))
  return events.at(-1)?.outcome() ?? { result: '未执行', note: '还没有开始', started: false }
}

/** What a mark means for the store. */
function markOutcome(mark: PlanMark): Outcome {
  switch (mark.status) {
    case 'failed': return { result: '失败', note: mark.note, started: true }
    case 'pending': return { result: '待确认', note: mark.note, started: true }
    case 'cancelled': return { result: '未执行', note: `用户取消：${mark.note}`, started: true }
  }
}

/**
 * The store to work on next: the first one nothing happened for yet. A store that failed, waits, or was
 * cancelled is never handed out again.
 * @param plan - the plan.
 * @param records - record file → its records.
 * @returns the store and its place, or undefined when every store was dealt with.
 */
export function nextTarget(
  plan: PublishPlan, records: ReadonlyMap<string, readonly PublishRecord[]>,
): { readonly target: PlanTarget; readonly index: number } | undefined {
  const index = plan.targets.findIndex(target => !outcomeOf(plan, target, records.get(target.records) ?? []).started)
  return index < 0 ? undefined : { target: plan.targets[index] as PlanTarget, index }
}

/**
 * The values a confirmed draft adds to the shared content: those the model wrote, which the user just
 * confirmed, and those taken from an earlier card.
 * @param shared - the shared content so far.
 * @param draft - the draft the user confirmed.
 * @param store - the store whose card it was.
 * @param at - when.
 * @returns the shared content and the labels it took.
 */
export function confirmShared(
  shared: PublishPlan['shared'], draft: Pick<Draft, 'values'>, store: string, at: string,
): { readonly shared: Record<string, SharedValue>; readonly labels: readonly string[] } {
  const next: Record<string, SharedValue> = { ...shared }
  const labels: string[] = []
  for (const [label, entry] of Object.entries(draft.values)) {
    if (entry.source !== '模型生成') continue
    next[label] = { value: entry.value, store, confirmedAt: at }
    labels.push(label)
  }
  return { shared: next, labels }
}

/** Two values compared as the user reads them. */
const same = (a: SourcedValue['value'], b: SourcedValue['value']): boolean => [a].flat().join('\n') === [b].flat().join('\n')

/**
 * Apply the shared content under the model's answers: a value the answers leave out or repeat counts as
 * the user's; one the answers changed for this store stays the model's, for this store's card.
 * @param answers - the model's answers for this store.
 * @param shared - the shared content.
 * @returns the answers and what to tell the user.
 */
export function withShared(answers: Answers, shared: PublishPlan['shared']): { readonly answers: Answers; readonly notes: readonly string[] } {
  const values: Record<string, SourcedValue> = { ...answers.values }
  const taken: string[] = []
  const changed: string[] = []
  for (const [label, entry] of Object.entries(shared)) {
    const given = values[label]
    if (given !== undefined && !same(given.value, entry.value)) { changed.push(`${label}（${entry.store} 确认的是「${[entry.value].flat().join('、')}」）`); continue }
    values[label] = { value: entry.value, source: '用户确认' }
    taken.push(`${label}（${entry.store}，${beijingTime(new Date(entry.confirmedAt))} 北京时间）`)
  }
  return {
    answers: { ...answers, values },
    notes: [
      ...taken.length === 0 ? [] : [`共用内容已在前面的确认卡片确认，自动带上：${taken.join('、')}`],
      ...changed.length === 0 ? [] : [`这家店改了共用内容，要在本店卡片里确认：${changed.join('、')}`],
    ],
  }
}

/**
 * The summary of every store.
 * @param plan - the plan.
 * @param records - record file → its records.
 * @returns Markdown.
 */
export function summaryText(plan: PublishPlan, records: ReadonlyMap<string, readonly PublishRecord[]>): string {
  const outcomes = plan.targets.map(target => ({ target, outcome: outcomeOf(plan, target, records.get(target.records) ?? []) }))
  const count = (result: Result) => outcomes.filter(({ outcome }) => outcome.result === result).length
  const lines = [
    `多店发品汇总（素材 ${plan.folder}，${String(plan.targets.length)} 家店）：成功 ${String(count('成功'))}、失败 ${String(count('失败'))}、待确认 ${String(count('待确认'))}、未执行 ${String(count('未执行'))}`,
    '', '| 平台 | 店铺 | 结果 | 商品/草稿 | 说明 |', '|---|---|---|---|---|',
    ...outcomes.map(({ target, outcome }) => `| ${PLATFORM_SKILLS[target.platform].name} | ${target.store} | ${outcome.result} | ${outcome.ids ?? ''} | ${outcome.note} |`),
  ]
  if (count('失败') > 0) lines.push('', '失败的店铺不会自动重试；要不要重发、怎么改，由用户决定。')
  if (count('待确认') > 0) lines.push('', '待确认的店铺：结果不明的请用户到后台仓库/草稿箱确认，等用户答复的请用户先答复。')
  return lines.join('\n')
}

/**
 * Read a plan file.
 * @param text - the file's text.
 * @returns the plan.
 * @throws Error when the file is not a plan file.
 */
export function parsePlan(text: string): PublishPlan {
  const plan = JSON.parse(text) as Partial<PublishPlan>
  if (typeof plan.createdAt !== 'string' || typeof plan.folder !== 'string' || !Array.isArray(plan.targets)) {
    throw new Error('不是多店发品计划文件（缺 createdAt、folder 或 targets）')
  }
  return { createdAt: plan.createdAt, folder: plan.folder, targets: plan.targets, marks: plan.marks ?? [], shared: plan.shared ?? {} }
}
