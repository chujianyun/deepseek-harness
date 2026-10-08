/**
 * The 「商品素材整理」 script: takes stock of a material folder of any layout and builds a product draft
 * from it, checked against a category's field rules. It reads local files only.
 *
 * Commands:
 * - `inventory --folder <dir>` lists and sorts the folder's images, tables, documents, and videos.
 * - `draft --folder <dir> [--answers <json>] [--rules <字段规则 json>] [--store <店铺>]` builds the draft with the
 *   model's answers and, given rules, checks it field by field; with a store, the company's publishing
 *   memory for it (store information, table headers, confirmed declarations) fills what the answers leave out.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { realDeps, type Deps } from './cli.ts'
import { beijingTime } from './dates.ts'
import { buildDraft, checkDraft, parseAnswers, withMemory, type Answers, type Confirmed, type Draft, type FieldCheck, type FieldStatus } from './draft.ts'
import { EXIT, SkillError } from './errors.ts'
import { KIND_LABEL, SKU_FIELD_LABEL, takeInventory, type ImageKind, type Inventory } from './materials.ts'
import type { PublishRules } from './publish-rules.ts'

const USAGE = [
  '用法：',
  '  inventory --folder <素材文件夹> [--out 目录]',
  '  draft --folder <素材文件夹> [--answers <答案 json>] [--rules <字段规则 json>] [--store <店铺名>] [--out 目录]',
].join('\n')

/** A command line, read. */
export interface ProductDraftOptions {
  readonly command: 'inventory' | 'draft'
  readonly folder: string
  readonly out: string
  readonly answers?: string
  readonly rules?: string
  /** The store whose remembered information applies. */
  readonly store?: string
}

/**
 * Read the command line.
 * @param argv - the arguments after the script.
 * @returns the options.
 * @throws SkillError usage for a wrong command line.
 */
export function parseProductDraftOptions(argv: readonly string[]): ProductDraftOptions {
  let parsed: ReturnType<typeof parse>
  const parse = (args: string[]) => parseArgs({
    args, allowPositionals: true,
    options: { folder: { type: 'string' }, out: { type: 'string' }, answers: { type: 'string' }, rules: { type: 'string' }, store: { type: 'string' } },
  })
  try {
    parsed = parse([...argv])
  } catch (error) {
    throw new SkillError(`${(error as Error).message}\n${USAGE}`, EXIT.usage)
  }
  const { values, positionals } = parsed
  const command = positionals[0]
  if (command !== 'inventory' && command !== 'draft') throw new SkillError(`缺少或认不出子命令：${command ?? '（无）'}\n${USAGE}`, EXIT.usage)
  if (values.folder === undefined || values.folder === '') throw new SkillError(`缺少 --folder。\n${USAGE}`, EXIT.usage)
  return {
    command, folder: values.folder, out: values.out ?? '发品草稿',
    ...values.answers === undefined ? {} : { answers: values.answers }, ...values.rules === undefined ? {} : { rules: values.rules },
    ...values.store === undefined || values.store === '' ? {} : { store: values.store },
  }
}

const ORDER: readonly ImageKind[] = ['main', 'main34', 'white', 'transparent', 'detail', 'sku', 'other', 'unknown']

/**
 * Describe an inventory for the model.
 * @param inventory - what the folder holds.
 * @returns Markdown.
 */
export function inventoryText(inventory: Inventory): string {
  const { images, tables, documents, videos, others } = inventory
  const lines = [
    `素材文件夹 ${inventory.folder}：图片 ${String(images.length)} 张、表格 ${String(tables.length)} 张、文档 ${String(documents.length)} 个、视频 ${String(videos.length)} 个、其他文件 ${String(others.length)} 个。`,
    '', '图片归类：',
  ]
  for (const kind of ORDER) {
    const group = images.filter(image => image.kind === kind)
    if (group.length === 0) continue
    lines.push(`- ${KIND_LABEL[kind]}（${String(group.length)}）：`, ...group.map(image => `  - ${image.file} ← ${image.reason}`))
  }
  const warnings = images.flatMap(image => image.warnings.map(warning => `- ${image.file}：${warning}`))
  if (warnings.length > 0) lines.push('', '需要注意：', ...warnings)
  for (const table of tables) {
    lines.push('', `表格 ${table.file}${table.sheet === '' ? '' : `#${table.sheet}`}（${String(table.rows.length)} 行）：`, '| 列 | 对应字段 | 示例 |', '|---|---|---|')
    for (const column of table.columns) {
      lines.push(`| ${column.header} | ${column.field === undefined ? '未识别' : SKU_FIELD_LABEL[column.field]} | ${column.samples.join(' / ')} |`)
    }
  }
  if (documents.length > 0) lines.push('', `文档：${documents.join('、')}`)
  if (videos.length > 0) lines.push('', `视频：${videos.join('、')}`)
  if (others.length > 0) lines.push('', `其他文件：${others.join('、')}`)
  if (inventory.unreadable.length > 0) lines.push('', '读不出来的文件：', ...inventory.unreadable.map(({ file, error }) => `- ${file}：${error}`))
  return lines.join('\n')
}

const STATUS_ORDER: readonly FieldStatus[] = ['缺失', '不符合', '待店铺确认', '待确认', '已确认', '已填']

/**
 * Describe a draft and its field check for the model.
 * @param draft - the draft.
 * @param rules - the rules it was checked against, if any.
 * @param checks - the field check, if any.
 * @returns Markdown.
 */
export function draftText(draft: Draft, rules?: PublishRules, checks?: readonly FieldCheck[]): string {
  const counts = ORDER.filter(kind => kind !== 'other' && kind !== 'unknown').map(kind => `${KIND_LABEL[kind]} ${String(draft.images[kind].length)}`)
  const lines = [
    `商品草稿（素材 ${draft.folder}）`,
    `图片：${counts.join('、')}${draft.images.other.length === 0 ? '' : `（其他素材 ${String(draft.images.other.length)} 张不使用：${draft.images.other.join('、')}）`}`,
    '', `SKU（${String(draft.skus.length)}${draft.skuTable === undefined ? '' : `，来自 ${draft.skuTable}`}）：`,
  ]
  if (draft.skus.length > 0) {
    lines.push('| 序号 | SKU 名称 | 商家编码 | 只数 | 价格 | 库存 | SKU 图 |', '|---|---|---|---|---|---|---|')
    for (const sku of draft.skus) {
      lines.push(`| ${sku.index} | ${sku.name} | ${sku.code ?? ''} | ${sku.count === undefined ? '' : String(sku.count)} | ${String(sku.price)} | ${sku.stock === undefined ? '' : String(sku.stock)} | ${sku.image ?? '缺'} |`)
    }
  }
  const generated = Object.entries(draft.values).filter(([, entry]) => entry.source === '模型生成')
  if (generated.length > 0) lines.push('', '待确认（模型生成）：', ...generated.map(([label, entry]) => `- ${label}：${typeof entry.value === 'string' ? entry.value : entry.value.join('、')}`))
  if (rules !== undefined && checks !== undefined) {
    const tally = STATUS_ORDER.map(status => `${status} ${String(checks.filter(check => check.status === status).length)}`)
    lines.push('', `按类目 ${rules.categoryPath}（${rules.catId}）的字段规则检查：${tally.join('、')}`)
    for (const status of STATUS_ORDER) {
      const group = checks.filter(check => check.status === status)
      if (group.length === 0) continue
      lines.push('', `${status}（${String(group.length)}）：`, ...group.map(check => `- ${check.label === check.key ? check.key : `${check.label}（${check.key}）`}${check.value === undefined ? '' : `：${check.value}`}${check.source === undefined ? '' : `〔${check.source}〕`}${check.note === undefined ? '' : ` —— ${check.note}`}`))
    }
  }
  if (draft.missing.length > 0) lines.push('', '缺失（需要用户补充或模型生成，不拿别的素材顶替）：', ...draft.missing.map(item => `- ${item}`))
  if (draft.problems.length > 0) lines.push('', '问题：', ...draft.problems.map(item => `- ${item}`))
  if (draft.notes.length > 0) lines.push('', '提示：', ...draft.notes.map(item => `- ${item}`))
  return lines.join('\n')
}

/**
 * Read a JSON file the model or another skill wrote.
 * @param path - the file.
 * @param what - its name for messages.
 * @returns its text.
 * @throws SkillError usage when it cannot be read.
 */
async function readInput(path: string, what: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    throw new SkillError(`读不到${what} ${path}：${(error as Error).message}`, EXIT.usage)
  }
}

/**
 * Read a field-rules file saved by `tmall-publish-category`.
 * @param text - the file's text.
 * @returns the rules.
 * @throws Error when the file is not a rules file.
 */
export function parseRulesFile(text: string): PublishRules {
  const rules = JSON.parse(text) as Partial<PublishRules>
  if (typeof rules.catId !== 'string' || !Array.isArray(rules.fields)) throw new Error('不是字段规则文件（缺 catId 或 fields）')
  return { catId: rules.catId, categoryPath: rules.categoryPath ?? '', fields: rules.fields }
}

/**
 * Run one command.
 * @param argv - the arguments after the script.
 * @param deps - the outside world; only output and the clock are used.
 * @returns the exit status.
 */
export async function main(argv: readonly string[], deps: Pick<Deps, 'stdout' | 'stderr' | 'now' | 'memory'> = realDeps): Promise<number> {
  try {
    const options = parseProductDraftOptions(argv)
    const folder = resolve(options.folder)
    const inventory = await takeInventory(folder).catch((error: unknown) => {
      throw new SkillError(`读不到素材文件夹 ${folder}：${(error as Error).message}`, EXIT.usage)
    })
    const out = resolve(options.out)
    await mkdir(out, { recursive: true })
    const at = `${beijingTime(deps.now())}（北京时间）`
    if (options.command === 'inventory') {
      const path = resolve(out, '素材清点.json')
      await writeFile(path, `${JSON.stringify(inventory, null, 2)}\n`)
      deps.stdout(`${at}\n${inventoryText(inventory)}\n\n已保存：${path}\n`)
      return 0
    }
    let answers: Answers = {}
    if (options.answers !== undefined) {
      try {
        answers = parseAnswers(await readInput(options.answers, '答案文件'))
      } catch (error) {
        throw error instanceof SkillError ? error : new SkillError(`答案文件 ${options.answers} 有误：${(error as Error).message}`, EXIT.usage)
      }
    }
    let rules: PublishRules | undefined
    if (options.rules !== undefined) {
      try {
        rules = parseRulesFile(await readInput(options.rules, '字段规则文件'))
      } catch (error) {
        throw error instanceof SkillError ? error : new SkillError(`字段规则文件 ${options.rules} 有误：${(error as Error).message}`, EXIT.usage)
      }
    }
    let confirmed: Confirmed = {}
    const remembered: string[] = []
    if (options.store !== undefined) {
      const merged = withMemory(answers, await deps.memory(), options.store, rules)
      const headers = inventory.tables.flatMap(table => table.columns.map(column => column.header))
      const columns = merged.answers.columns as Readonly<Record<string, string>>
      const fromMemory = Object.keys(columns).filter(header => answers.columns?.[header] === undefined && headers.includes(header))
      if (fromMemory.length > 0) remembered.push(`列名对应取自 DSH 记忆：${fromMemory.map(header => `${header}→${columns[header] as string}`).join('、')}`)
      remembered.push(...merged.notes)
      answers = merged.answers
      confirmed = merged.confirmed
    }
    const built = buildDraft(inventory, answers)
    const draft = { ...built, notes: [...remembered, ...built.notes] }
    const checks = rules === undefined ? undefined : checkDraft(draft, rules, confirmed)
    const text = draftText(draft, rules, checks)
    const json = resolve(out, '商品草稿.json')
    const list = resolve(out, '待确认清单.md')
    await writeFile(json, `${JSON.stringify({ createdAt: deps.now().toISOString(), ...draft, ...rules === undefined ? {} : { catId: rules.catId, categoryPath: rules.categoryPath, checks } }, null, 2)}\n`)
    await writeFile(list, `# 待确认清单\n\n${text}\n`)
    deps.stdout(`${at}\n${text}\n\n已保存：${json}\n已保存：${list}\n`)
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
