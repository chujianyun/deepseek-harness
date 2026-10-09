/**
 * The 「多店铺发品」 script: keeps the plan of one material folder published to several stores, hands out
 * the stores one at a time, keeps the content the user confirmed on the first card for the later
 * drafts, and sums up each store's result. It saves nothing to any store; each store's own publish
 * skill does, and its record file is where the result is read from.
 *
 * Commands:
 * - `plan --folder <dir> --account <id> [--account <id> …] [--replace]` writes the plan.
 * - `next` names the store to work on next, or says every store was dealt with.
 * - `confirm --draft <商品草稿 json> --account <id>` keeps the values the user just confirmed on that store's card.
 * - `mark --account <id> --status failed|pending|cancelled --note <说明>` records a step that wrote no record.
 * - `summary` sums up the results and saves them.
 */

import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { MERCHANT_PLATFORMS, runDshEcommerce, type MerchantPlatform } from './account.ts'
import { fileSafe, realDeps, type Deps } from './cli.ts'
import { beijingTime } from './dates.ts'
import type { Draft } from './draft.ts'
import { EXIT, SkillError } from './errors.ts'
import {
  confirmShared, nextTarget, outcomeOf, parsePlan, PLATFORM_SKILLS, summaryText, type PlanMark, type PlanTarget, type PublishPlan,
} from './multi-publish.ts'
import { readRecords, type PublishRecord } from './publish-common.ts'

const USAGE = [
  '用法：',
  '  plan --folder <素材文件夹> --account <电商账号 id> [--account <电商账号 id> …] [--replace] [--plan <计划文件>]',
  '  next [--plan <计划文件>]',
  '  confirm --account <电商账号 id> --draft <商品草稿 json> [--plan <计划文件>]',
  '  mark --account <电商账号 id> --status failed|pending|cancelled --note <说明> [--plan <计划文件>]',
  '  summary [--plan <计划文件>]',
].join('\n')

/** The plan file, by default. */
const PLAN = '多店发品/发品计划.json'

const STATUSES: readonly PlanMark['status'][] = ['failed', 'pending', 'cancelled']

/** A command line, read. */
export type MultiPublishOptions =
  | { readonly command: 'plan'; readonly plan: string; readonly folder: string; readonly accounts: readonly string[]; readonly replace: boolean }
  | { readonly command: 'next' | 'summary'; readonly plan: string }
  | { readonly command: 'confirm'; readonly plan: string; readonly account: string; readonly draft: string }
  | { readonly command: 'mark'; readonly plan: string; readonly account: string; readonly status: PlanMark['status']; readonly note: string }

/**
 * Read the command line.
 * @param argv - the arguments after the script.
 * @returns the options.
 * @throws SkillError usage for a wrong command line.
 */
export function parseMultiPublishOptions(argv: readonly string[]): MultiPublishOptions {
  let parsed: ReturnType<typeof parse>
  const parse = (args: string[]) => parseArgs({
    args, allowPositionals: true,
    options: {
      plan: { type: 'string' }, folder: { type: 'string' }, account: { type: 'string', multiple: true }, replace: { type: 'boolean' },
      draft: { type: 'string' }, status: { type: 'string' }, note: { type: 'string' },
    },
  })
  try {
    parsed = parse([...argv])
  } catch (error) {
    throw new SkillError(`${(error as Error).message}\n${USAGE}`, EXIT.usage)
  }
  const { values, positionals } = parsed
  const command = positionals[0]
  const plan = values.plan ?? PLAN
  const given = (value: string | undefined, name: string): string => {
    if (value === undefined || value === '') throw new SkillError(`缺少 ${name}。\n${USAGE}`, EXIT.usage)
    return value
  }
  const accounts = values.account ?? []
  switch (command) {
    case 'plan':
      if (accounts.length === 0) throw new SkillError(`缺少 --account。\n${USAGE}`, EXIT.usage)
      return { command, plan, folder: given(values.folder, '--folder'), accounts, replace: values.replace === true }
    case 'next':
    case 'summary': return { command, plan }
    case 'confirm': return { command, plan, account: given(accounts[0], '--account'), draft: given(values.draft, '--draft') }
    case 'mark': {
      const status = given(values.status, '--status') as PlanMark['status']
      if (!STATUSES.includes(status)) throw new SkillError(`--status 应是 ${STATUSES.join('/')} 之一。\n${USAGE}`, EXIT.usage)
      return { command, plan, account: given(accounts[0], '--account'), status, note: given(values.note, '--note') }
    }
    default: throw new SkillError(`缺少或认不出子命令：${command ?? '（无）'}\n${USAGE}`, EXIT.usage)
  }
}

/** An account as `dsh-ecommerce accounts` lists it. */
export interface ListedAccount {
  readonly id: string
  readonly platform: string
  readonly kind: string
  readonly store?: string
  readonly account: string
  readonly status: string
}

/** What this script reaches outside itself; tests replace it. */
export interface MultiPublishDeps extends Pick<Deps, 'now' | 'stdout' | 'stderr'> {
  /** The company's e-commerce accounts. */
  readonly accounts: () => Promise<readonly ListedAccount[]>
  /** The working directory, which the publish skills' record files are under. */
  readonly cwd: () => string
}

/**
 * The company's e-commerce accounts, from `dsh-ecommerce accounts`.
 * @param run - runs `dsh-ecommerce`.
 * @returns the accounts.
 * @throws SkillError with what DSH said when it cannot list them.
 */
export async function listAccounts(run = runDshEcommerce): Promise<readonly ListedAccount[]> {
  const { code, stdout, stderr } = await run(['accounts'])
  if (code === 127) throw new SkillError(`找不到 dsh-ecommerce 命令：多店发品只能在已登录用户中心的 DSH 桌面版里运行。${stderr.trim()}`)
  if (code !== 0) throw new SkillError(`读不到电商账号：${stderr.trim()}`)
  return JSON.parse(stdout) as ListedAccount[]
}

const realMultiDeps: MultiPublishDeps = {
  now: realDeps.now, stdout: realDeps.stdout, stderr: realDeps.stderr, accounts: () => listAccounts(), cwd: () => process.cwd(),
}

/**
 * Read the plan file.
 * @param path - the file.
 * @returns the plan.
 * @throws SkillError usage when it is missing or not a plan.
 */
async function readPlan(path: string): Promise<PublishPlan> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    throw new SkillError(`读不到发品计划 ${path}（${(error as Error).message}）：先用 plan 建计划。`, EXIT.usage)
  }
  try {
    return parsePlan(text)
  } catch (error) {
    throw new SkillError(`发品计划 ${path} 有误：${(error as Error).message}`, EXIT.usage)
  }
}

async function writePlan(path: string, plan: PublishPlan): Promise<void> {
  await mkdir(resolve(path, '..'), { recursive: true })
  await writeFile(path, `${JSON.stringify(plan, null, 2)}\n`)
}

/** Every target's record file, read. */
async function allRecords(plan: PublishPlan): Promise<Map<string, readonly PublishRecord[]>> {
  const records = new Map<string, readonly PublishRecord[]>()
  for (const target of plan.targets) if (!records.has(target.records)) records.set(target.records, await readRecords(target.records))
  return records
}

/** The plan's store for an account. */
function targetOf(plan: PublishPlan, account: string): PlanTarget {
  const target = plan.targets.find(item => item.account === account)
  if (target === undefined) throw new SkillError(`账号 ${account} 不在这次的发品计划里。`, EXIT.usage)
  return target
}

/** Where a store's draft and rules go, so stores never share a file. */
const draftDir = (target: PlanTarget) => join('发品草稿', `${PLATFORM_SKILLS[target.platform].name}-${fileSafe(target.store)}`)
const rulesDir = (target: PlanTarget) => join(PLATFORM_SKILLS[target.platform].dir, fileSafe(target.store))

/**
 * A word for a bash command line, quoted when it holds anything but plain characters.
 * @param word - the word.
 * @returns the word, safe to paste.
 */
export function shellWord(word: string): string {
  return /^[\p{L}\p{N}_./:@%+=-]+$/u.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`
}

async function plan(options: Extract<MultiPublishOptions, { command: 'plan' }>, deps: MultiPublishDeps): Promise<string> {
  const path = resolve(options.plan)
  const cwd = deps.cwd()
  const exists = await access(path).then(() => true, () => false)
  if (exists && !options.replace) {
    throw new SkillError(`已有发品计划 ${path}：继续它用 next；用户明确要重新开始一次多店发品时才加 --replace。`, EXIT.usage)
  }
  const folder = resolve(options.folder)
  if (!await access(folder).then(() => true, () => false)) throw new SkillError(`素材文件夹 ${folder} 不存在。`, EXIT.usage)
  const listed = await deps.accounts()
  const targets: PlanTarget[] = []
  for (const id of options.accounts) {
    const account = listed.find(item => item.id === id)
    if (account === undefined) throw new SkillError(`没有电商账号 ${id}：用 dsh-ecommerce accounts 查账号 id。`, EXIT.usage)
    if (account.kind !== 'merchant' || !Object.hasOwn(MERCHANT_PLATFORMS, account.platform)) {
      throw new SkillError(`账号 ${id}（${account.store ?? account.account}，平台 ${account.platform}，类型 ${account.kind}）不能发品：只支持天猫、拼多多、抖店的商家账号。`, EXIT.usage)
    }
    if (targets.some(target => target.account === id)) throw new SkillError(`账号 ${id} 重复了。`, EXIT.usage)
    const platform = account.platform as MerchantPlatform
    targets.push({ account: id, platform, store: account.store ?? account.account, records: resolve(cwd, PLATFORM_SKILLS[platform].dir, '发品记录.json') })
  }
  await writePlan(path, { createdAt: deps.now().toISOString(), folder, targets, marks: [], shared: {}, confirmed: [] })
  return [
    `已建多店发品计划（${String(targets.length)} 家店）：${path}`,
    ...targets.map((target, at) => `${String(at + 1)}. ${PLATFORM_SKILLS[target.platform].name}「${target.store}」（账号 ${target.account}）—— 用 ${PLATFORM_SKILLS[target.platform].skill} 技能`),
    '按顺序一家一家来：先运行 next。',
  ].join('\n')
}

async function next(path: string): Promise<string> {
  const current = await readPlan(path)
  const found = nextTarget(current, await allRecords(current))
  if (found === undefined) return '这次计划里的每家店都处理过了（成功、失败、待确认或已取消），不再继续。运行 summary 汇总给用户。'
  const { target, index } = found
  const { name, skill, dir } = PLATFORM_SKILLS[target.platform]
  const shared = Object.entries(current.shared)
  const first = current.confirmed.length === 0
  const rules = shellWord(rulesDir(target))
  const drafts = shellWord(draftDir(target))
  return [
    `下一家：第 ${String(index + 1)}/${String(current.targets.length)} 家，${name}「${target.store}」（账号 ${target.account}），用 ${skill} 技能。`,
    `- 字段规则写到 ${rulesDir(target)}（${skill === 'tmall-publish' ? 'tmall-publish-category' : skill} 的 rules 加 --out ${rules}）。`,
    `- 商品草稿写到 ${draftDir(target)}（product-draft draft 加 --out ${drafts} --store ${shellWord(target.store)} --plan ${shellWord(path)}）。`,
    `- 保存时不加 --out，保存记录留在 ${dir}/发品记录.json，汇总从那里读结果。`,
    first
      ? '- 这是第一张确认卡片：用户一键认可后、保存前，运行 confirm 记下用户认可的内容，后面的店自动带上。'
      : `- 共用内容已在前面的卡片确认（${shared.length === 0 ? '没有模型生成的标题或卖点' : shared.map(([label, entry]) => `${label}：${entry.store}`).join('、')}），草稿里标「已确认」；这家店的卡片仍要用户一键认可才保存，认可后同样运行 confirm。`,
  ].join('\n')
}

async function confirm(options: Extract<MultiPublishOptions, { command: 'confirm' }>, deps: MultiPublishDeps): Promise<string> {
  const path = resolve(options.plan)
  const current = await readPlan(path)
  const target = targetOf(current, options.account)
  if (outcomeOf(current, target, await readRecords(target.records)).started) {
    throw new SkillError(`「${target.store}」已经处理过了（保存、失败、等待或取消），不能再确认它的卡片。`, EXIT.usage)
  }
  const expected = resolve(deps.cwd(), draftDir(target))
  if (resolve(deps.cwd(), options.draft, '..') !== expected) {
    throw new SkillError(`「${target.store}」的商品草稿应在 ${expected}，不是 ${resolve(deps.cwd(), options.draft)}。`, EXIT.usage)
  }
  let draft: Pick<Draft, 'values'>
  try {
    draft = JSON.parse(await readFile(resolve(deps.cwd(), options.draft), 'utf8')) as Pick<Draft, 'values'>
  } catch (error) {
    throw new SkillError(`读不到商品草稿 ${options.draft}：${(error as Error).message}`, EXIT.usage)
  }
  const { shared, labels } = confirmShared(current.shared, draft, target.store, deps.now().toISOString())
  await writePlan(path, { ...current, shared, confirmed: [...current.confirmed, target.account] })
  if (labels.length === 0) return `已记下「${target.store}」的卡片已确认；没有新的共用内容（标题、卖点、导购标题已共用或不是模型生成的）。`
  return `已记下「${target.store}」卡片里用户认可的共用内容：${labels.join('、')}。后面的店生成草稿时加 --plan 自动带上。`
}

async function mark(options: Extract<MultiPublishOptions, { command: 'mark' }>, deps: MultiPublishDeps): Promise<string> {
  const path = resolve(options.plan)
  const current = await readPlan(path)
  const target = targetOf(current, options.account)
  const entry: PlanMark = { account: target.account, status: options.status, note: options.note, at: deps.now().toISOString() }
  const updated = { ...current, marks: [...current.marks, entry] }
  await writePlan(path, updated)
  const outcome = outcomeOf(updated, target, [])
  return `已记下「${target.store}」：${outcome.result}（${outcome.note}）。这家店不再自动处理，继续运行 next。`
}

async function summary(path: string, deps: MultiPublishDeps): Promise<string> {
  const current = await readPlan(path)
  const text = summaryText(current, await allRecords(current))
  const file = join(resolve(path, '..'), '发品汇总.md')
  await writeFile(file, `# 多店发品汇总\n\n${beijingTime(deps.now())}（北京时间）\n\n${text}\n`)
  return `${text}\n\n已保存：${file}`
}

/**
 * Run one command.
 * @param argv - the arguments after the script.
 * @param deps - the outside world.
 * @returns the exit status.
 */
export async function main(argv: readonly string[], deps: MultiPublishDeps = realMultiDeps): Promise<number> {
  try {
    const options = parseMultiPublishOptions(argv)
    const path = resolve(options.plan)
    const result = options.command === 'plan' ? await plan(options, deps)
      : options.command === 'next' ? await next(path)
        : options.command === 'confirm' ? await confirm(options, deps)
          : options.command === 'mark' ? await mark(options, deps)
            : await summary(path, deps)
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
