/**
 * The 「生意参谋店铺经营核心日报」 script: Business Advisor's own export of the 「店铺经营核心日报」
 * template with a Tmall merchant account, the requested day's row as CSV, and a short Markdown summary
 * whose advertising spend is checked against Alimama's.
 */

import { openReport, queryScenes, sceneSpend } from './alimama.ts'
import { fileSafe, realDeps, runReport, withMerchantPage, writeFiles, type Deps, type Options } from './cli.ts'
import { beijingTime } from './dates.ts'
import type { Page } from './page.ts'
import { readFirstSheet, toCsv } from './sheet.ts'
import { compareSpend, dayRow, download, exportUrl, openDatafetch, templateId, updatedThrough, type SpendCheck } from './sycm.ts'

/** The figures the summary lists, when the export has them. */
const HEADLINE = [
  '支付金额', '访客数', '浏览量', '支付买家数', '支付转化率', '客单价', '加购人数', '商品收藏买家数', '支付新买家数', '支付老买家数',
  '成功退款金额', '关键词推广花费', '精准人群推广花费', '全站推广花费', '淘宝客佣金', '描述相符评分', '物流服务评分', '服务态度评分',
]

/**
 * Make the report.
 * @param options - account, day, and output directory.
 * @param deps - the outside world.
 * @returns the summary and where the files are.
 * @throws SkillError when the account cannot be used or the export has no row for the day; nothing is written then.
 */
export async function sycmReport(options: Options, deps: Deps): Promise<string> {
  const { account, result } = await withMerchantPage(options, deps, async (page) => {
    await openDatafetch(page)
    const through = await updatedThrough(page)
    const xlsx = await download(await exportUrl(page, await templateId(page)), deps.fetchFile)
    const row = dayRow(readFirstSheet(xlsx), options.date, through)
    return { xlsx, row, check: await alimamaSpendCheck(page, row, options.date) }
  })
  const { xlsx, row, check } = result
  const summary = [
    `# 生意参谋店铺经营核心日报 · ${account.store} · ${options.date}`,
    '',
    `取数时间 ${beijingTime(deps.now())}（北京时间），账号 ${account.account}。`,
    '',
    checkText(check),
    '',
    '| 指标 | 数值 |',
    '|---|---:|',
    ...HEADLINE.filter(name => name in row).map(name => `| ${name} | ${row[name] as string} |`),
  ].join('\n')
  const base = `生意参谋店铺经营核心日报_${fileSafe(account.store)}_${options.date}`
  const [csv, xlsxPath, md] = await writeFiles(options.out, base, [
    ['csv', toCsv([['指标', '数值'], ...Object.entries(row)])],
    ['xlsx', xlsx],
    ['md', `${summary}\n`],
  ]) as [string, string, string]
  return `${summary}\n\n已保存：\n- ${csv}（${options.date} 全部 ${String(Object.keys(row).length)} 项指标）\n- ${xlsxPath}（生意参谋导出的原始文件，最近 30 天）\n- ${md}`
}

/**
 * Compare the day's advertising spend with Alimama's in the same browser.
 * @returns the comparisons, or why Alimama could not be asked.
 */
async function alimamaSpendCheck(page: Page, row: Readonly<Record<string, string>>, date: string): Promise<readonly SpendCheck[] | string> {
  try {
    const template = await openReport(page, date)
    return compareSpend(row, sceneSpend(await queryScenes(page, template, date, ['charge'])))
  } catch (error) {
    // Page and connection failures are Errors; the reason is what the summary shows.
    return (error as Error).message
  }
}

/** The cross-check line of the summary. */
function checkText(check: readonly SpendCheck[] | string): string {
  if (typeof check === 'string') return `⚠️ 未能与万相台交叉校验推广花费：${check}`
  const mismatches = check.filter(item => !item.matches)
  if (check.length === 0) return '⚠️ 导出文件里没有推广花费列，未能与万相台交叉校验。'
  if (mismatches.length === 0) return `✅ 推广花费与万相台一致（${check.map(item => `${item.scene} ${item.sycm.toFixed(2)}`).join('，')}）。`
  return `❌ 推广花费与万相台不一致，请人工核对：${mismatches.map(item => `${item.scene} 生意参谋 ${item.sycm.toFixed(2)}，万相台 ${item.alimama.toFixed(2)}`).join('；')}。`
}

/**
 * Run the script.
 * @param argv - the arguments after the script.
 * @param deps - the outside world.
 * @returns the exit status.
 */
export function main(argv: readonly string[], deps: Deps = realDeps): Promise<number> {
  return runReport(argv, deps, sycmReport)
}
