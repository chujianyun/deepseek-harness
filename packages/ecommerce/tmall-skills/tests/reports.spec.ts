import { chmod, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runDshEcommerce, takeOverMerchant, type EcommerceCommandResult } from '../src/account.ts'
import { main as alimamaMain } from '../src/alimama-report.ts'
import { fileSafe, parseOptions, realDeps, runReport, writeFiles } from '../src/cli.ts'
import { EXIT, SkillError } from '../src/errors.ts'
import { main as sycmMain } from '../src/sycm-report.ts'
import { TEMPLATE_NAME } from '../src/sycm.ts'
import { fakeDeps, FakePage, on, SCENES_1006, sendsTemplate, tempDir, xlsxOf, type Route } from './support.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function outDir(): Promise<string> {
  const { dir, cleanup } = await tempDir()
  cleanups.push(cleanup)
  return dir
}

const MERCHANT = { id: 'a1', platform: 'tmall', kind: 'merchant', store: '名流旗舰店', account: '名流:小美', cdpUrl: 'http://127.0.0.1:9' }

function ran(result: Partial<EcommerceCommandResult>): () => Promise<EcommerceCommandResult> {
  return () => Promise.resolve({ code: 0, stdout: '', stderr: '', ...result })
}

describe('takeOverMerchant', () => {
  it('hands over a Tmall merchant account browser', async () => {
    const args: unknown[] = []
    const run = (given: readonly string[]): Promise<EcommerceCommandResult> => {
      args.push(given)
      return ran({ stdout: JSON.stringify(MERCHANT) })()
    }
    expect(await takeOverMerchant('a1', run)).toEqual({ id: 'a1', store: '名流旗舰店', account: '名流:小美', cdpUrl: 'http://127.0.0.1:9' })
    expect(args).toEqual([['browser', 'a1']])
    const { store: _store, ...withoutStore } = MERCHANT
    expect((await takeOverMerchant('a1', ran({ stdout: JSON.stringify(withoutStore) }))).store).toBe('名流:小美')
  })

  it('passes on what DSH says, as signed out when the account is', async () => {
    const out = 'DSH: the tmall account "名流旗舰店" is signed out. Stop, and ask the user to sign in again.'
    await expect(takeOverMerchant('a1', ran({ code: 1, stderr: `${out}\n` }))).rejects.toMatchObject({ message: out, exitCode: EXIT.signedOut })
    await expect(takeOverMerchant('a1', ran({ code: 1, stderr: 'DSH: in use' }))).rejects.toMatchObject({ exitCode: EXIT.failed })
    const hub = 'DSH: DSH is signed out of the user center, so there are no e-commerce accounts.'
    await expect(takeOverMerchant('a1', ran({ code: 1, stderr: hub }))).rejects.toMatchObject({ exitCode: EXIT.failed })
    await expect(takeOverMerchant('a1', ran({ code: 127, stderr: 'spawn dsh-ecommerce ENOENT' }))).rejects.toThrow('只能在已登录用户中心的 DSH 桌面版里运行')
  })

  it('refuses an account that is not a Tmall merchant account', async () => {
    await expect(takeOverMerchant('b1', ran({ stdout: JSON.stringify({ ...MERCHANT, platform: 'taobao', kind: 'buyer' }) })))
      .rejects.toMatchObject({ exitCode: EXIT.usage, message: expect.stringContaining('平台 taobao，类型 buyer') as unknown as string })
  })

  it('runs the dsh-ecommerce on PATH and reports how it ended', async () => {
    const dir = await outDir()
    await writeFile(join(dir, 'dsh-ecommerce'), '#!/bin/sh\nif [ "$1" = ok ]; then echo "{}"; exit 0; fi\necho "no: $1" >&2\nexit 3\n')
    await chmod(join(dir, 'dsh-ecommerce'), 0o755)
    const path = process.env.PATH
    process.env.PATH = `${dir}:${path ?? ''}`
    try {
      expect(await runDshEcommerce(['ok'])).toEqual({ code: 0, stdout: '{}\n', stderr: '' })
      expect(await runDshEcommerce(['x'])).toEqual({ code: 3, stdout: '', stderr: 'no: x\n' })
      process.env.PATH = dir.replace(/[^/]+$/u, 'nowhere')
      expect((await runDshEcommerce(['ok'])).code).toBe(127)
    } finally {
      process.env.PATH = path
    }
  })
})

describe('the command line', () => {
  const now = new Date('2026-10-08T03:00:00Z')

  it('defaults to yesterday in Beijing and a 天猫报表 folder', () => {
    expect(parseOptions(['--account', 'a1'], now)).toEqual({ account: 'a1', date: '2026-10-07', out: '天猫报表' })
    expect(parseOptions(['--account', 'a1', '--date', '2026-10-01', '--out', 'r'], now)).toEqual({ account: 'a1', date: '2026-10-01', out: 'r' })
  })

  it('refuses a missing account or an unknown option with the usage', () => {
    expect(() => parseOptions([], now)).toThrow('缺少 --account')
    expect(() => parseOptions(['--account', ''], now)).toThrow('缺少 --account')
    expect(() => parseOptions(['--account', 'a', '--bogus'], now)).toThrow('用法')
  })

  it('turns a run outcome into output and an exit status', async () => {
    const deps = fakeDeps(new FakePage([]))
    expect(await runReport(['--account', 'a'], deps, () => Promise.resolve('done'))).toBe(0)
    expect(await runReport(['--account', 'a'], deps, () => Promise.reject(new SkillError('稍后', EXIT.notReady)))).toBe(EXIT.notReady)
    expect(await runReport(['--account', 'a'], deps, () => Promise.reject(new Error('socket hang up')))).toBe(EXIT.failed)
    expect(await runReport(['--account', 'a'], deps, () => Promise.reject(new Error('x', { cause: 1 })).catch(() => { throw 'odd' }))).toBe(EXIT.failed)
    expect(deps.out).toEqual(['done\n'])
    expect(deps.err).toEqual(['稍后\n', '失败：socket hang up\n', '失败：odd\n'])
  })

  it('names files safely and writes them side by side', async () => {
    expect(fileSafe('名流:小美 旗舰店/主')).toBe('名流_小美_旗舰店_主')
    const dir = await outDir()
    const [a, b] = await writeFiles(join(dir, 'new'), 'r', [['csv', 'x'], ['bin', new Uint8Array([1])]])
    expect(a).toBe(join(dir, 'new', 'r.csv'))
    expect(await readFile(b as string)).toEqual(Buffer.from([1]))
  })

  it('uses the real outside world by default', async () => {
    expect(realDeps.now()).toBeInstanceOf(Date)
    expect(realDeps.fetchFile).toBe(fetch)
    realDeps.stdout('')
    realDeps.stderr('')
    await expect(realDeps.openPage('http://127.0.0.1:9')).rejects.toThrow()
    const path = process.env.PATH
    process.env.PATH = '/nowhere'
    try {
      await expect(realDeps.takeOver('a1')).rejects.toThrow('找不到 dsh-ecommerce 命令')
    } finally {
      process.env.PATH = path
    }
  })
})

describe('the Alimama scene report', () => {
  it('writes CSV and a summary of the day and prints where they are', async () => {
    const out = await outDir()
    const page = new FakePage([on('query.json', { data: { list: SCENES_1006 }, info: { ok: true } })], sendsTemplate)
    const deps = fakeDeps(page)
    expect(await alimamaMain(['--account', 'a1', '--date', '2026-10-06', '--out', out], deps)).toBe(0)
    expect(page.closed).toBe(true)
    const base = join(out, '万相台营销场景报表_名流旗舰店（主账号）_2026-10-06')
    const csv = await readFile(`${base}.csv`, 'utf8')
    expect(csv.split('\r\n')[0]).toBe('﻿日期,场景ID,场景,花费,展现量,点击量,点击率,平均点击花费,总成交金额,总成交笔数,成交人数,投入产出比,总成交成本,点击转化率,总购物车数,加购率,加购成本,引导访问潜客占比,人均成交金额,自然流量曝光量,自然流量转化金额')
    expect(csv.split('\r\n')[2]).toBe('2026-10-06,436,货品全站推广,10151.40,93003,6214,6.68%,1.63,25904.68,638,596,2.55,15.91,10.27%,427,6.87%,23.77,82.74%,43.46,90350,607.35')
    const summary = deps.out.join('')
    expect(summary).toContain('# 万相台营销场景报表 · 名流旗舰店（主账号） · 2026-10-06')
    expect(summary).toContain('取数时间 2026-10-08 11:00（北京时间），账号 名流成人用品旗舰店:小美。')
    expect(summary).toContain('| 关键词推广 | 650.00 | 198 | 615.87 | 23 | 0.95 |')
    expect(summary).toContain('| 合计 | 10801.40 | | 26520.55 | | 2.46 |')
    expect(summary).toContain(`- ${base}.csv\n- ${base}.md`)
    expect(await readFile(`${base}.md`, 'utf8')).toContain('| 货品全站推广 | 10151.40 |')
    expect(summary).not.toContain('自然流量曝光量都是 0')
  })

  it('writes nothing when the figures are not ready, and closes the tab', async () => {
    const out = await outDir()
    const zeros = SCENES_1006.map(scene => ({ ...scene, alipayInshopUv: 0, charge: 0, alipayInshopAmt: 0 }))
    const page = new FakePage([on('query.json', { data: { list: zeros }, info: { ok: true } })], sendsTemplate)
    const deps = fakeDeps(page)
    expect(await alimamaMain(['--account', 'a1', '--out', join(out, 'r')], deps)).toBe(EXIT.notReady)
    expect(deps.err.join('')).toContain('2026-10-07 各场景的成交人数都是 0')
    expect(page.closed).toBe(true)
    await expect(readFile(join(out, 'r'))).rejects.toThrow()
  })

  it('warns while Alimama has not computed natural traffic', async () => {
    const out = await outDir()
    const pending = SCENES_1006.map(scene => ({ ...scene, orgNaturalPv: 0, naturalPayAmt: 0 }))
    const deps = fakeDeps(new FakePage([on('query.json', { data: { list: pending }, info: { ok: true } })], sendsTemplate))
    expect(await alimamaMain(['--account', 'a1', '--date', '2026-10-06', '--out', out], deps)).toBe(0)
    expect(deps.out.join('')).toContain('⚠️ 各场景的自然流量曝光量都是 0')
  })

  it('writes an empty total ROI when nothing was spent', async () => {
    const out = await outDir()
    const free = [{ ...SCENES_1006[1], charge: 0 }]
    const deps = fakeDeps(new FakePage([on('query.json', { data: { list: free }, info: { ok: true } })], sendsTemplate))
    expect(await alimamaMain(['--account', 'a1', '--out', out], deps)).toBe(0)
    expect(deps.out.join('')).toContain('| 合计 | 0.00 | | 615.87 | |  |')
  })
})

describe('the Business Advisor core daily report', () => {
  const header = ['统计日期', '店铺名称', '访客数', '支付金额', '支付买家数', '支付转化率', '关键词推广花费', '精准人群推广花费', '全站推广花费']
  const xlsx = xlsxOf([header, ['2026-10-07', '名流成人用品旗舰店', '7,001', '35,000.10', '700', '10.00%', '0.00', '0.00', '9,999.99'],
    ['2026-10-06', '名流成人用品旗舰店', '6,787', '34,000.20', '681', '10.03%', '650.00', '0.00', '10,151.40']])

  function sycmPage(alimama: Route): FakePage {
    return new FakePage([
      on('commDateByLocation', { data: { flow_monitor_shopsource_construction_v4: { updateDay: '2026-10-07' } } }),
      on('template/list.json', { data: [{ id: 210, templateName: TEMPLATE_NAME }] }),
      on('download.json?templateId=210', { data: true }),
      on('queryDownloadUrl.json', { data: { status: '1', url: 'https://oss/core.xlsx' } }),
      alimama,
    ], sendsTemplate)
  }

  async function run(page: FakePage, date = '2026-10-06'): Promise<{ code: number; out: string; err: string; dir: string }> {
    const dir = await outDir()
    const deps = fakeDeps(page, { fetchFile: () => Promise.resolve(new Response(xlsx)) })
    const code = await sycmMain(['--account', 'a1', '--date', date, '--out', dir], deps)
    return { code, out: deps.out.join(''), err: deps.err.join(''), dir }
  }

  it('saves the day, the export, and a summary whose spend matches Alimama', async () => {
    const { code, out, dir } = await run(sycmPage(on('query.json', { data: { list: SCENES_1006 }, info: { ok: true } })))
    expect(code).toBe(0)
    expect(out).toContain('✅ 推广花费与万相台一致（关键词推广 650.00，人群推广 0.00，货品全站推广 10151.40）。')
    expect(out).toContain('| 支付买家数 | 681 |')
    const base = join(dir, '生意参谋店铺经营核心日报_名流旗舰店（主账号）_2026-10-06')
    expect(out).toContain(`- ${base}.csv（2026-10-06 全部 9 项指标）\n- ${base}.xlsx（生意参谋导出的原始文件，最近 30 天）\n- ${base}.md`)
    expect((await readFile(`${base}.csv`, 'utf8')).split('\r\n').slice(0, 3)).toEqual(['﻿指标,数值', '统计日期,2026-10-06', '店铺名称,名流成人用品旗舰店'])
    expect(new Uint8Array(await readFile(`${base}.xlsx`))).toEqual(xlsx)
  })

  it('reports a spend that differs from Alimama', async () => {
    const { code, out } = await run(sycmPage(on('query.json', { data: { list: [{ ...SCENES_1006[0], charge: 10000 }, SCENES_1006[1]] }, info: { ok: true } })))
    expect(code).toBe(0)
    expect(out).toContain('❌ 推广花费与万相台不一致，请人工核对：货品全站推广 生意参谋 10151.40，万相台 10000.00。')
  })

  it('says when Alimama could not be asked, and still saves the unverified report', async () => {
    const refused = await run(sycmPage(on('query.json', { info: { ok: false, message: '系统繁忙' } })))
    expect(refused.out).toContain('⚠️ 未能与万相台交叉校验推广花费：万相台报表接口拒绝了查询：系统繁忙')
    const broken = await run(sycmPage(on('query.json', new Error('Unexpected token <'))))
    expect(broken.code).toBe(0)
    expect(broken.out).toContain('⚠️ 未能与万相台交叉校验推广花费：Unexpected token <')
    const odd = await run(sycmPage(() => undefined))
    expect(odd.out).toContain('⚠️ 未能与万相台交叉校验推广花费：no route for')
  })

  it('says when the export has no spend columns', async () => {
    const dir = await outDir()
    const bare = xlsxOf([['统计日期', '访客数'], ['2026-10-06', '1']])
    const deps = fakeDeps(sycmPage(on('query.json', { data: { list: [] }, info: { ok: true } })), { fetchFile: () => Promise.resolve(new Response(bare)) })
    expect(await sycmMain(['--account', 'a1', '--date', '2026-10-06', '--out', dir], deps)).toBe(0)
    expect(deps.out.join('')).toContain('⚠️ 导出文件里没有推广花费列')
  })

  it('writes nothing when Business Advisor has not reached the day', async () => {
    const page = sycmPage(on('query.json', { data: { list: SCENES_1006 }, info: { ok: true } }))
    const dir = await outDir()
    const deps = fakeDeps(page, { fetchFile: () => Promise.resolve(new Response(xlsxOf([header, ['2026-10-06', 'x']]))) })
    expect(await sycmMain(['--account', 'a1', '--date', '2026-10-07', '--out', join(dir, 'r')], deps)).toBe(EXIT.notReady)
    expect(deps.err.join('')).toContain('还没有 2026-10-07 的数据（文件覆盖 2026-10-06 ~ 2026-10-06，生意参谋显示数据更新到 2026-10-07）')
    await expect(readFile(join(dir, 'r'))).rejects.toThrow()
  })
})
