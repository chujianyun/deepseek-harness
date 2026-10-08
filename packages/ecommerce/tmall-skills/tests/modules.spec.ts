import { describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { ensureReady, isSignIn, num, openReport, queryScenes, REPORT_COLUMNS, reportRows, reportUrl, sceneSpend, type SceneFigures } from '../src/alimama.ts'
import { beijingDate, pastDate } from '../src/dates.ts'
import { EXIT, SkillError } from '../src/errors.ts'
import { readFirstSheet, toCsv } from '../src/sheet.ts'
import { compareSpend, dayRow, download, exportUrl, number, openDatafetch, templateId, TEMPLATE_NAME, updatedThrough } from '../src/sycm.ts'
import { FakePage, on, postedBody, SCENES_1006, sendsTemplate, TEMPLATE } from './support.ts'

const NOW = new Date('2026-10-08T03:00:00Z')

async function stopped(work: Promise<unknown> | (() => unknown)): Promise<SkillError> {
  try {
    await (typeof work === 'function' ? work() : work)
  } catch (error) {
    expect(error).toBeInstanceOf(SkillError)
    return error as SkillError
  }
  throw new Error('expected a SkillError')
}

describe('dates', () => {
  it('reads the date in Beijing, whatever the computer zone', () => {
    expect(beijingDate(new Date('2026-10-07T16:30:00Z'))).toBe('2026-10-08')
    expect(beijingDate(new Date('2026-10-07T15:30:00Z'), 1)).toBe('2026-10-06')
  })

  it('accepts only real past days', async () => {
    expect(pastDate('2026-10-07', NOW)).toBe('2026-10-07')
    expect((await stopped(() => pastDate('2026-10-08', NOW))).message).toContain('还没有结束')
    expect((await stopped(() => pastDate('2026-02-30', NOW))).exitCode).toBe(EXIT.usage)
    expect((await stopped(() => pastDate('20261007', NOW))).message).toContain('YYYY-MM-DD')
    expect((await stopped(() => pastDate('2026-13-01', NOW))).exitCode).toBe(EXIT.usage)
  })
})

describe('sheet', () => {
  it('reads inline, shared, rich, and plain cells by their column', () => {
    const xlsx = zipSync({
      'xl/sharedStrings.xml': strToU8('<sst><si><t>访客数</t></si><si><r><t>支付</t></r><r><t xml:space="preserve">金额</t></r></si></sst>'),
      'xl/worksheets/sheet2.xml': strToU8('<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>other</t></is></c></row></sheetData></worksheet>'),
      'xl/worksheets/sheet1.xml': strToU8([
        '<worksheet><sheetData>',
        '<row r="1"><c r="A1" t="inlineStr"><is><t>统计日期</t></is></c><c r="B1" t="s"><v>0</v></c><c r="D1" t="s"><v>1</v></c><c r="E1" t="s"><v>9</v></c></row>',
        '<row r="2"><c r="A2" t="inlineStr"><is><t>2026-10-06</t></is></c><c r="B2"><v>6787</v></c><c r="C2"/><c r="D2" t="str"><v>a &amp; b &lt;c&gt; &#20013;&#x6587;</v></c></row>',
        '<row r="3"><c t="inlineStr"><is><t> x </t></is></c><c><v>1</v></c></row>',
        '</sheetData></worksheet>',
      ].join('')),
    })
    expect(readFirstSheet(xlsx)).toEqual([
      ['统计日期', '访客数', '', '支付金额', ''],
      ['2026-10-06', '6787', '', 'a & b <c> 中文'],
      ['x', '1'],
    ])
  })

  it('refuses a file with no worksheet', () => {
    expect(() => readFirstSheet(zipSync({ 'a.txt': strToU8('a') }))).toThrow('没有工作表')
  })

  it('writes CSV that Excel opens as UTF-8', () => {
    expect(toCsv([['a', 'b,c'], ['"q"', 'line\nbreak']])).toBe('﻿a,"b,c"\r\n"""q""","line\nbreak"\r\n')
  })
})

describe('alimama', () => {
  it('captures the report page scene query and queries the day with it', async () => {
    const page = new FakePage([on('/report/query.json', { data: { list: SCENES_1006 }, info: { ok: true } })], (url, self) => {
      self.send({ url: 'https://one.alimama.com/member/checkAccess.json', method: 'POST', body: '{}' })
      self.send({ url: 'https://one.alimama.com/report/query.json', method: 'POST', body: JSON.stringify({ ...TEMPLATE, queryDomains: ['account'] }) })
      self.send({ url: 'https://one.alimama.com/report/query.json', method: 'POST', body: 'a=b' })
      self.send({ url: 'https://one.alimama.com/report/query.json', method: 'POST', body: '{"cut' })
      self.send({ url: 'https://one.alimama.com/report/query.json', method: 'GET' })
      sendsTemplate(url, self)
    })
    const template = await openReport(page, '2026-10-06')
    expect(page.visited).toEqual([reportUrl('2026-10-06')])
    expect(template).toEqual(TEMPLATE)
    const scenes = await queryScenes(page, template, '2026-10-05', ['charge'])
    expect(scenes).toHaveLength(2)
    const query = page.evaluated.at(-1) as string
    expect(query).toContain('https://one.alimama.com/report/query.json?csrfId=csrf-1&bizCode=universalBP')
    expect(postedBody(query)).toMatchObject({ startTime: '2026-10-05', endTime: '2026-10-05', queryFieldIn: ['charge'], pageSize: 100, loginPointId: 'point-1' })
  })

  it('enters the back office once when the sign-in screen offers it', async () => {
    let entered = false
    const page = new FakePage([on('进入后台', () => { entered = true; return true })], (url, self) => {
      if (!entered) self.href = 'https://one.alimama.com/index.html#!/login'
      else sendsTemplate(url, self)
    })
    expect(await openReport(page, '2026-10-06')).toEqual(TEMPLATE)
    expect(page.visited).toHaveLength(2)
  })

  it('is signed out without the enter button or when entering does not help', async () => {
    const toLogin = (_url: string, self: FakePage): void => { self.href = 'https://one.alimama.com/index.html#!/login' }
    expect((await stopped(openReport(new FakePage([on('进入后台', false)], toLogin), '2026-10-06'))).exitCode).toBe(EXIT.signedOut)
    expect((await stopped(openReport(new FakePage([on('进入后台', true)], toLogin), '2026-10-06'))).exitCode).toBe(EXIT.signedOut)
  })

  it('is signed out when the report page goes to a sign-in host', async () => {
    expect(isSignIn('https://login.taobao.com/member/login.jhtml')).toBe(true)
    expect(isSignIn('https://one.alimama.com/index.html#!/report/account')).toBe(false)
    const toHost = (_url: string, self: FakePage): void => { self.href = 'https://login.taobao.com/member/login.jhtml' }
    expect((await stopped(openReport(new FakePage([on('进入后台', false)], toHost), '2026-10-06'))).exitCode).toBe(EXIT.signedOut)
  })

  it('fails when the report page sends no scene query', async () => {
    expect((await stopped(openReport(new FakePage([]), '2026-10-06'))).message).toContain('没有正常加载')
  })

  it('reports an API refusal and reads a missing list as no scenes', async () => {
    const refused = new FakePage([on('query.json', { info: { ok: false, message: '无权限' } })])
    expect((await stopped(queryScenes(refused, {}, '2026-10-06', ['charge']))).message).toContain('无权限')
    const silent = new FakePage([on('query.json', { info: { ok: false, message: null } })])
    expect((await stopped(queryScenes(silent, {}, '2026-10-06', ['charge']))).message).toContain('没有说明原因')
    const empty = new FakePage([on('query.json', {})])
    expect(await queryScenes(empty, {}, '2026-10-06', ['charge'])).toEqual([])
    expect(empty.evaluated.at(-1)).toContain('query.json?bizCode=universalBP')
  })

  it('stops before yesterday\'s de-duplicated figures are ready, and takes zero buyers on earlier days as final', async () => {
    expect((await stopped(() => { ensureReady([], '2026-10-07', '2026-10-07') })).exitCode).toBe(EXIT.notReady)
    const zeros = SCENES_1006.map(scene => ({ ...scene, alipayInshopUv: 0 }))
    expect((await stopped(() => { ensureReady(zeros, '2026-10-07', '2026-10-07') })).message).toContain('上午 10 点')
    expect(() => { ensureReady(SCENES_1006, '2026-10-07', '2026-10-07') }).not.toThrow()
    expect(() => { ensureReady(zeros, '2026-10-05', '2026-10-07') }).not.toThrow()
    expect(() => { ensureReady([], '2026-10-05', '2026-10-07') }).not.toThrow()
  })

  it('recomputes rates from the raw figures, by scene id', () => {
    const rows = reportRows(SCENES_1006, '2026-10-06')
    expect(rows.map(row => Object.fromEntries(REPORT_COLUMNS.map((column, index) => [column, row[index]])))).toEqual([
      {
        日期: '2026-10-06', 场景ID: '371', 场景: '关键词推广', 花费: '650.00', 展现量: '3626', 点击量: '198', 点击率: '5.46%', 平均点击花费: '3.28',
        总成交金额: '615.87', 总成交笔数: '23', 成交人数: '22', 投入产出比: '0.95', 总成交成本: '28.26', 点击转化率: '11.62%', 总购物车数: '22',
        加购率: '11.11%', 加购成本: '29.55', 引导访问潜客占比: '77.64%', 人均成交金额: '27.99', 自然流量曝光量: '2931', 自然流量转化金额: '40.23',
      },
      {
        日期: '2026-10-06', 场景ID: '436', 场景: '货品全站推广', 花费: '10151.40', 展现量: '93003', 点击量: '6214', 点击率: '6.68%', 平均点击花费: '1.63',
        总成交金额: '25904.68', 总成交笔数: '638', 成交人数: '596', 投入产出比: '2.55', 总成交成本: '15.91', 点击转化率: '10.27%', 总购物车数: '427',
        加购率: '6.87%', 加购成本: '23.77', 引导访问潜客占比: '82.74%', 人均成交金额: '43.46', 自然流量曝光量: '90350', 自然流量转化金额: '607.35',
      },
    ])
  })

  it('leaves rates empty when their denominator is zero, and reads missing figures as zero', () => {
    const bare: SceneFigures = { sceneId: 372 }
    const [row] = reportRows([bare], '2026-10-06')
    expect(row).toEqual(['2026-10-06', '372', '', '0.00', '0', '0', '', '', '0.00', '0', '0', '', '', '', '0', '', '', '0.00%', '', '0', '0.00'])
    expect(num('12')).toBe(0)
    expect(num(Number.NaN)).toBe(0)
    expect(sceneSpend(SCENES_1006)).toEqual(new Map([[436, 10151.400000000018], [371, 650]]))
  })
})

describe('sycm', () => {
  const header = ['统计日期', '店铺名称', '访客数', '支付金额', '关键词推广花费', '精准人群推广花费', '全站推广花费', '']
  const rows = [
    ['店铺经营核心日报'],
    header,
    ['2026-10-07', '名流成人用品旗舰店', '7,001', '35,000.10', '0.00', '', '10,151.40', 'x'],
    ['2026-10-06', '名流成人用品旗舰店', '6,787', '34,000.20', '650.00', '', '10,151.40'],
    ['', ''],
    [],
  ]

  it('picks the row of the day under the header that has a date column', () => {
    expect(dayRow(rows, '2026-10-06')).toEqual({
      统计日期: '2026-10-06', 店铺名称: '名流成人用品旗舰店', 访客数: '6,787', 支付金额: '34,000.20', 关键词推广花费: '650.00', 精准人群推广花费: '', 全站推广花费: '10,151.40',
    })
  })

  it('refuses a day older than the export window as a usage error', async () => {
    const old = await stopped(() => dayRow(rows, '2026-08-01'))
    expect(old.exitCode).toBe(EXIT.usage)
    expect(old.message).toContain('只导出最近 30 天（2026-10-06 起）')
  })

  it('reads a short row as empty trailing cells', () => {
    expect(dayRow([['日期', 'a', 'b'], ['2026-10-06', '1']], '2026-10-06')).toEqual({ 日期: '2026-10-06', a: '1', b: '' })
  })

  it('stops as not ready when the file has no row for the day', async () => {
    const missing = await stopped(() => dayRow(rows, '2026-10-08', '2026-10-07'))
    expect(missing.exitCode).toBe(EXIT.notReady)
    expect(missing.message).toContain('文件覆盖 2026-10-06 ~ 2026-10-07，生意参谋显示数据更新到 2026-10-07')
    expect((await stopped(() => dayRow([header], '2026-10-08'))).message).toContain('文件里没有任何日期）')
    const stale = await stopped(() => dayRow(rows, '2026-10-07', '2026-10-06'))
    expect(stale.exitCode).toBe(EXIT.notReady)
    expect(stale.message).toContain('生意参谋显示数据更新到 2026-10-06')
    expect(dayRow(rows, '2026-10-07', '2026-10-07')['访客数']).toBe('7,001')
    expect((await stopped(() => dayRow([['a']], '2026-10-08'))).message).toContain('找不到日期列')
  })

  it('compares spend with Alimama to the cent', () => {
    const row = dayRow(rows, '2026-10-06')
    expect(compareSpend(row, new Map([[371, 650.004], [436, 10151.5]]))).toEqual([
      { scene: '关键词推广', sycm: 650, alimama: 650.004, matches: true },
      { scene: '货品全站推广', sycm: 10151.4, alimama: 10151.5, matches: false },
    ])
    expect(compareSpend({ 关键词推广花费: '1.00' }, new Map())).toEqual([{ scene: '关键词推广', sycm: 1, alimama: 0, matches: false }])
    expect(compareSpend({ 精准人群推广花费: '-' }, new Map())).toEqual([{ scene: '人群推广', sycm: 0, alimama: 0, matches: true }])
    expect(number('12.96%')).toBe(12.96)
  })

  it('finds the template, waits for its export, and downloads it', async () => {
    let polls = 0
    const page = new FakePage([
      on('template/list.json', { data: [{ id: 3, templateName: '商品经营投产比核心日报' }, { id: 210, templateName: TEMPLATE_NAME }] }),
      on('download.json?templateId=210', { data: true }),
      on('queryDownloadUrl.json?templateId=210', () => ++polls < 2 ? { data: { status: '2', message: '下载任务已提交' } } : { data: { status: '1', url: 'https://oss/x.xlsx' } }),
    ])
    expect(await templateId(page)).toBe(210)
    expect(await exportUrl(page, 210, 5000, 1)).toBe('https://oss/x.xlsx')
    expect(polls).toBe(2)
  })

  it('explains a missing template, a refused export, and an export that never finishes', async () => {
    expect((await stopped(templateId(new FakePage([on('template/list.json', { data: [] })])))).message).toContain('自助取数权限')
    expect((await stopped(templateId(new FakePage([on('template/list.json', {})])))).message).toContain(TEMPLATE_NAME)
    expect((await stopped(exportUrl(new FakePage([on('download.json', { data: false, message: '额度不足' })]), 1))).message).toContain('额度不足')
    expect((await stopped(exportUrl(new FakePage([on('download.json', {})]), 1))).message).toContain('没有说明原因')
    const slow = new FakePage([on('download.json?', { data: true }), on('queryDownloadUrl.json', { data: { status: '2', url: '', message: '处理中' } })])
    expect((await stopped(exportUrl(slow, 1, 0, 1))).message).toContain('处理中')
    const bare = new FakePage([on('download.json?', { data: true }), on('queryDownloadUrl.json', { message: '稍后' })])
    expect((await stopped(exportUrl(bare, 1, 0, 1))).message).toContain('稍后')
    const silent = new FakePage([on('download.json?', { data: true }), on('queryDownloadUrl.json', {})])
    expect((await stopped(exportUrl(silent, 1, 0, 1))).message).toContain('没有生成')
  })

  it('downloads only a zip file', async () => {
    const zip = new Uint8Array([0x50, 0x4B, 3, 4])
    expect(await download('u', () => Promise.resolve(new Response(zip)))).toEqual(zip)
    expect((await stopped(download('u', () => Promise.resolve(new Response('<html>'))))).message).toContain('不是 xlsx')
    expect((await stopped(download('u', () => Promise.resolve(new Response('', { status: 403 }))))).message).toContain('HTTP 403')
  })

  it('reads the update day, or none when Business Advisor does not answer', async () => {
    const code = 'flow_monitor_shopsource_construction_v4'
    expect(await updatedThrough(new FakePage([on('commDateByLocation', { data: { [code]: { updateDay: '2026-10-07' } } })]))).toBe('2026-10-07')
    expect(await updatedThrough(new FakePage([on('commDateByLocation', {})]))).toBeUndefined()
    expect(await updatedThrough(new FakePage([on('commDateByLocation', new Error('Unexpected token <'))]))).toBeUndefined()
  })

  it('is signed out when the self-service page goes to the sign-in page', async () => {
    const signedIn = new FakePage([])
    await openDatafetch(signedIn)
    expect(signedIn.visited).toHaveLength(1)
    const toLogin = new FakePage([], (_url, self) => { self.href = 'https://login.taobao.com/member/login.jhtml' })
    expect((await stopped(openDatafetch(toLogin))).exitCode).toBe(EXIT.signedOut)
  })
})
