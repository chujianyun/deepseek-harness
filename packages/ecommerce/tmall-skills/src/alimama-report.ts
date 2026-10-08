/**
 * The 「万相台营销场景报表」 script: one day's figures per marketing scene, read from Alimama's report
 * API with a Tmall merchant account, written as CSV and a short Markdown summary.
 */

import { ensureReady, num, openReport, queryScenes, REPORT_COLUMNS, reportRows, SCENE_FIELDS } from './alimama.ts'
import { beijingTime, fileSafe, realDeps, runReport, withMerchantPage, writeFiles, type Deps, type Options } from './cli.ts'
import { toCsv } from './sheet.ts'

/**
 * Make the report.
 * @param options - account, day, and output directory.
 * @param deps - the outside world.
 * @returns the summary and where the files are.
 * @throws SkillError when the account cannot be used or the day's figures are not ready; nothing is written then.
 */
export async function alimamaReport(options: Options, deps: Deps): Promise<string> {
  const { account, result: scenes } = await withMerchantPage(options, deps, async (page) => {
    const template = await openReport(page, options.date)
    return queryScenes(page, template, options.date, SCENE_FIELDS)
  })
  ensureReady(scenes, options.date)
  const rows = reportRows(scenes, options.date)
  const charge = scenes.reduce((sum, scene) => sum + num(scene.charge), 0)
  const amount = scenes.reduce((sum, scene) => sum + num(scene.alipayInshopAmt), 0)
  const summary = [
    `# 万相台营销场景报表 · ${account.store} · ${options.date}`,
    '',
    `取数时间 ${beijingTime(deps.now())}（北京时间），账号 ${account.account}。`,
    '',
    '| 场景 | 花费 | 点击量 | 总成交金额 | 总成交笔数 | 投入产出比 |',
    '|---|---:|---:|---:|---:|---:|',
    ...rows.map(row => `| ${String(row[2])} | ${String(row[3])} | ${String(row[5])} | ${String(row[8])} | ${String(row[9])} | ${String(row[11])} |`),
    `| 合计 | ${charge.toFixed(2)} | | ${amount.toFixed(2)} | | ${charge === 0 ? '' : (amount / charge).toFixed(2)} |`,
    '',
    '成交数据按万相台的归因口径统计，之后几天可能还会小幅增加。',
  ].join('\n')
  const base = `万相台营销场景报表_${fileSafe(account.store)}_${options.date}`
  const [csv, md] = await writeFiles(options.out, base, [['csv', toCsv([[...REPORT_COLUMNS], ...rows])], ['md', `${summary}\n`]]) as [string, string]
  return `${summary}\n\n已保存：\n- ${csv}\n- ${md}`
}

/**
 * Run the script.
 * @param argv - the arguments after the script.
 * @param deps - the outside world.
 * @returns the exit status.
 */
export function main(argv: readonly string[], deps: Deps = realDeps): Promise<number> {
  return runReport(argv, deps, alimamaReport)
}
