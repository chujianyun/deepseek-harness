/**
 * Business Advisor (生意参谋) 「店铺经营核心日报」: the self-service data template's own export, which
 * covers the last 30 days with a date column and unrounded values. The skill calls the APIs the
 * template page calls — find the template, ask for the export, wait for its download address — and
 * downloads the file from that signed address.
 */

import { EXIT, SkillError } from './errors.ts'
import { fetchJson, signedOut, sleep, type Page } from './page.ts'

/** The self-service data page whose APIs the skill calls. */
export const DATAFETCH_URL = 'https://sycm.taobao.com/lyone/auto_analysis/datafetch/create?insertType=sycm&layoutHide=1&useDebug=false&activeKey=template'

/** The template the skill exports. */
export const TEMPLATE_NAME = '店铺经营核心日报'

/** The answer every self-service data API gives. */
interface LyoneAnswer<T> {
  readonly success?: boolean
  readonly message?: string
  readonly data?: T
}

/**
 * Open the self-service data page.
 * @param page - the tab.
 * @throws SkillError signed-out when the page is sent to the sign-in page.
 */
export async function openDatafetch(page: Page): Promise<void> {
  await page.goto(DATAFETCH_URL)
  const { hostname, pathname } = new URL(await page.evaluate<string>('location.href'))
  if (/login/iu.test(hostname + pathname)) signedOut('生意参谋')
}

/**
 * The id of the 「店铺经营核心日报」 template.
 * @param page - the self-service data tab.
 * @returns the template id.
 * @throws SkillError when the store cannot see the template.
 */
export async function templateId(page: Page): Promise<number> {
  const answer = await page.evaluate<LyoneAnswer<{ id: number; templateName: string }[]>>(fetchJson('https://sycm.taobao.com/lyone/fetchData/template/list.json'))
  const template = answer.data?.find(item => item.templateName === TEMPLATE_NAME)
  if (template === undefined) {
    throw new SkillError(`生意参谋自助取数里没有「${TEMPLATE_NAME}」模板：请确认店铺有自助取数权限，或模板名是否被平台修改。`)
  }
  return template.id
}

/**
 * Ask for the template's export and wait for its download address.
 * @param page - the self-service data tab.
 * @param id - the template id.
 * @param timeoutMs - the longest wait.
 * @param pollMs - time between looks.
 * @returns the signed download address of the .xlsx file.
 * @throws SkillError when the export is refused or not ready in time.
 */
export async function exportUrl(page: Page, id: number, timeoutMs = 120_000, pollMs = 2000): Promise<string> {
  const started = await page.evaluate<LyoneAnswer<boolean>>(fetchJson(`https://sycm.taobao.com/lyone/fetchData/download.json?templateId=${String(id)}`))
  if (started.data !== true) throw new SkillError(`生意参谋拒绝了「${TEMPLATE_NAME}」的导出：${started.message ?? '没有说明原因'}`)
  const deadline = Date.now() + timeoutMs
  let last = ''
  for (;;) {
    const answer = await page.evaluate<LyoneAnswer<{ status?: string; url?: string; message?: string }>>(
      fetchJson(`https://sycm.taobao.com/lyone/fetchData/queryDownloadUrl.json?templateId=${String(id)}`))
    if (answer.data?.url !== undefined && answer.data.url !== '') return answer.data.url
    last = answer.data?.message ?? answer.message ?? ''
    if (Date.now() >= deadline) throw new SkillError(`生意参谋「${TEMPLATE_NAME}」的导出 ${String(timeoutMs / 1000)} 秒内没有生成：${last}`)
    await sleep(pollMs)
  }
}

/**
 * Download the exported file.
 * @param url - its signed address.
 * @param fetchFile - fetches it.
 * @returns the file's bytes.
 * @throws SkillError when the download fails or is not an .xlsx (zip) file.
 */
export async function download(url: string, fetchFile: typeof fetch = fetch): Promise<Uint8Array> {
  const response = await fetchFile(url)
  if (!response.ok) throw new SkillError(`下载「${TEMPLATE_NAME}」失败：HTTP ${String(response.status)}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4B) throw new SkillError(`下载到的「${TEMPLATE_NAME}」不是 xlsx 文件。`)
  return bytes
}

/**
 * The day Business Advisor says its store-source figures are updated through, when it answers.
 * @param page - a Business Advisor tab.
 * @returns `YYYY-MM-DD`, or undefined when it does not say.
 */
export async function updatedThrough(page: Page): Promise<string | undefined> {
  const code = 'flow_monitor_shopsource_construction_v4'
  let answer: { data?: Record<string, { updateDay?: string }> }
  try {
    answer = await page.evaluate(fetchJson(`https://sycm.taobao.com/oneauth/api/commDateByLocation.json?locationCodes=${code}`))
  } catch {
    // A failed request or a non-JSON answer: the update day only explains a missing row, and the file's own date column decides.
    return undefined
  }
  return answer.data?.[code]?.updateDay
}

/** The names a date column has in the export. */
const DATE_COLUMN = /^(?:统计日期|日期|时间)$/u

/**
 * The export's row for one day, as column name → text.
 * @param rows - the sheet; the header is the first row with a date column.
 * @param date - the day.
 * @param through - the day Business Advisor says it is updated through, for the message.
 * @returns the row.
 * @throws SkillError not-ready when the file has no row for the day or Business Advisor says it is updated
 *   through an earlier day, usage for a day older than the export, and failed when the file has no date column.
 */
export function dayRow(rows: readonly (readonly string[])[], date: string, through?: string): Record<string, string> {
  const headerAt = rows.findIndex(row => row.some(cell => DATE_COLUMN.test(cell)))
  if (headerAt < 0) throw new SkillError(`「${TEMPLATE_NAME}」文件里找不到日期列，平台可能改了导出格式。`)
  const header = rows[headerAt] as readonly string[]
  const dateAt = header.findIndex(cell => DATE_COLUMN.test(cell))
  const days = rows.slice(headerAt + 1).filter(row => (row[dateAt] ?? '') !== '')
  const wanted = date.replaceAll('-', '')
  const row = days.find(cells => (cells[dateAt] as string).replace(/\D/gu, '') === wanted)
  const dates = days.map(cells => cells[dateAt] as string)
  const oldest = dates[dates.length - 1]?.replace(/\D/gu, '')
  if (row === undefined && oldest !== undefined && wanted < oldest) {
    throw new SkillError(`「${TEMPLATE_NAME}」只导出最近 30 天（${dates[dates.length - 1] as string} 起），没有 ${date} 的数据。`, EXIT.usage)
  }
  if (row === undefined || (through !== undefined && through < date)) {
    const covered = dates.length === 0 ? '文件里没有任何日期' : `文件覆盖 ${dates[dates.length - 1] as string} ~ ${dates[0] as string}`
    const updated = through === undefined ? '' : `，生意参谋显示数据更新到 ${through}`
    throw new SkillError(`生意参谋「${TEMPLATE_NAME}」还没有 ${date} 的数据（${covered}${updated}），数据未就绪，没有生成报表，请稍后再试。`, EXIT.notReady)
  }
  return Object.fromEntries(header.flatMap((name, index) => name === '' ? [] : [[name, row[index] ?? '']]))
}

/** Export columns of advertising spend, and the Alimama scene each one equals. */
export const SPEND_COLUMNS = [
  { column: '关键词推广花费', sceneId: 371, scene: '关键词推广' },
  { column: '精准人群推广花费', sceneId: 372, scene: '人群推广' },
  { column: '全站推广花费', sceneId: 436, scene: '货品全站推广' },
] as const

/** One spend compared between the export and Alimama. */
export interface SpendCheck {
  readonly scene: string
  readonly sycm: number
  readonly alimama: number
  readonly matches: boolean
}

/**
 * Compare the export's spend with Alimama's, scene by scene. Both are unrounded, so only a cent of
 * floating-point difference is allowed.
 * @param row - the export's row for the day.
 * @param alimama - Alimama spend by scene id; a scene Alimama does not list spent nothing.
 * @returns one comparison per spend column the export has.
 */
export function compareSpend(row: Readonly<Record<string, string>>, alimama: ReadonlyMap<number, number>): SpendCheck[] {
  return SPEND_COLUMNS.filter(({ column }) => (row[column] ?? '') !== '').map(({ column, sceneId, scene }) => {
    const value = number(row[column] as string)
    const sycm = Number.isNaN(value) ? 0 : value
    const other = alimama.get(sceneId) ?? 0
    return { scene, sycm, alimama: other, matches: Math.abs(sycm - other) <= 0.02 }
  })
}

/**
 * A number the export wrote as text, such as `13,140.01` or `12.96%`.
 * @param text - the cell.
 * @returns the number, or NaN when the cell is not a number.
 */
export function number(text: string): number {
  return Number(text.replaceAll(',', '').replace(/%$/u, ''))
}
