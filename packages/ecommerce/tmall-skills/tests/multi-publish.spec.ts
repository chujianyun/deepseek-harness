import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EXIT } from '../src/errors.ts'
import { listAccounts, main, parseMultiPublishOptions, type ListedAccount, type MultiPublishDeps } from '../src/multi-publish-cli.ts'
import { confirmShared, nextTarget, outcomeOf, parsePlan, summaryText, withShared, type PlanTarget, type PublishPlan } from '../src/multi-publish.ts'
import { main as draftMain } from '../src/product-draft-cli.ts'
import type { PublishRecord } from '../src/publish-common.ts'
import { png } from './images.ts'
import { fakeDeps, FakePage, tempDir } from './support.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function folder(): Promise<string> {
  const { dir, cleanup } = await tempDir()
  cleanups.push(cleanup)
  return dir
}

const ACCOUNTS: ListedAccount[] = [
  { id: 'tm', platform: 'tmall', kind: 'merchant', store: '名流旗舰店', account: 'mingliu:运营', status: 'signed-in' },
  { id: 'pdd', platform: 'pinduoduo', kind: 'merchant', store: '名流保健用品官方旗舰店', account: 'pdd:运营', status: 'signed-in' },
  { id: 'dy', platform: 'doudian', kind: 'merchant', account: 'dy:运营', status: 'signed-in' },
  { id: 'tm2', platform: 'tmall', kind: 'merchant', store: '名流二店', account: 'mingliu2:运营', status: 'signed-in' },
  { id: 'tb', platform: 'taobao', kind: 'merchant', store: '名流淘宝店', account: 'tb:运营', status: 'signed-in' },
  { id: 'buyer', platform: 'tmall', kind: 'buyer', account: 'tb_buyer_1', status: 'signed-in' },
]

/** Deps in a working directory, recording output; the clock moves a minute per call. */
function deps(cwd: string, overrides: Partial<MultiPublishDeps> = {}): MultiPublishDeps & { out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  let minute = 0
  return {
    accounts: () => Promise.resolve(ACCOUNTS),
    cwd: () => cwd,
    now: () => new Date(Date.UTC(2026, 9, 8, 3, minute++)),
    stdout: (text) => { out.push(text) },
    stderr: (text) => { err.push(text) },
    out, err, ...overrides,
  }
}

const target = (overrides: Partial<PlanTarget> = {}): PlanTarget => ({ account: 'tm', platform: 'tmall', store: '名流旗舰店', records: '/w/天猫发品/发品记录.json', ...overrides })

const PLAN: PublishPlan = { createdAt: '2026-10-08T03:00:00.000Z', folder: '/w/素材', targets: [target()], marks: [], shared: {} }

const record = (status: PublishRecord['status'], at: string, more: Partial<PublishRecord> = {}): PublishRecord => ({
  store: '名流旗舰店', title: '名流水多多', catId: '1', status, at, ...more,
})

describe('multi-publish command line', () => {
  it('reads each command', () => {
    expect(parseMultiPublishOptions(['plan', '--folder', 'f', '--account', 'a', '--account', 'b'])).toEqual({
      command: 'plan', plan: '多店发品/发品计划.json', folder: 'f', accounts: ['a', 'b'], replace: false,
    })
    expect(parseMultiPublishOptions(['plan', '--folder', 'f', '--account', 'a', '--replace', '--plan', 'p.json'])).toMatchObject({ plan: 'p.json', replace: true })
    expect(parseMultiPublishOptions(['next'])).toEqual({ command: 'next', plan: '多店发品/发品计划.json' })
    expect(parseMultiPublishOptions(['summary', '--plan', 'p'])).toEqual({ command: 'summary', plan: 'p' })
    expect(parseMultiPublishOptions(['confirm', '--account', 'a', '--draft', 'd'])).toMatchObject({ command: 'confirm', account: 'a', draft: 'd' })
    expect(parseMultiPublishOptions(['mark', '--account', 'a', '--status', 'pending', '--note', '等用户补参考价'])).toMatchObject({
      command: 'mark', account: 'a', status: 'pending', note: '等用户补参考价',
    })
    for (const argv of [
      [], ['publish'], ['next', '--bogus'], ['plan', '--folder', 'f'], ['plan', '--account', 'a'], ['plan', '--account', 'a', '--folder', ''],
      ['confirm', '--account', 'a'], ['confirm', '--draft', 'd'], ['mark', '--account', 'a', '--note', 'x'],
      ['mark', '--account', 'a', '--status', 'saved', '--note', 'x'], ['mark', '--account', 'a', '--status', 'failed'],
    ]) {
      expect(() => parseMultiPublishOptions(argv), argv.join(' ')).toThrow(expect.objectContaining({ exitCode: EXIT.usage }) as Error)
    }
  })

  it('lists the accounts through dsh-ecommerce', async () => {
    const answer = (code: number, stdout = '', stderr = '') => () => Promise.resolve({ code, stdout, stderr })
    expect(await listAccounts(answer(0, JSON.stringify(ACCOUNTS)))).toEqual(ACCOUNTS)
    await expect(listAccounts(answer(127, '', 'not found'))).rejects.toThrow('找不到 dsh-ecommerce 命令：多店发品只能在已登录用户中心的 DSH 桌面版里运行。not found')
    await expect(listAccounts(answer(1, '', 'signed out of the hub\n'))).rejects.toThrow('读不到电商账号：signed out of the hub')
  })
})

describe('results', () => {
  it('reads each record and mark since the plan began, the latest winning', () => {
    const at = (status: PublishRecord['status'], more: Partial<PublishRecord> = {}) => outcomeOf(PLAN, target(), [record(status, '2026-10-08T03:05:00.000Z', more)])
    expect(at('saved', { itemId: '1088' })).toEqual({ result: '成功', note: '已存进仓库/草稿箱，没有上架', ids: '商品 ID 1088', started: true })
    expect(at('exists', { draftId: '2031', message: '草稿箱里已有同名草稿' })).toMatchObject({ result: '成功', ids: '草稿 ID 2031', note: '店里已有这件商品，没有重复保存（草稿箱里已有同名草稿）' })
    expect(at('exists').note).toBe('店里已有这件商品，没有重复保存')
    expect(at('failed', { message: '标题含违禁词' })).toMatchObject({ result: '失败', note: '没有保存：标题含违禁词' })
    expect(at('failed').note).toBe('没有保存：平台没有给出原因')
    expect(at('on-sale', { draftId: '2', itemId: '3' })).toMatchObject({ result: '失败', ids: '草稿 ID 2，商品 ID 3', note: '商品被放到了出售中，请立即到后台下架' })
    expect(at('not-draft').result).toBe('失败')
    expect(at('unknown').result).toBe('待确认')
    expect(at('submitting')).toMatchObject({ result: '待确认', note: '保存结果不明：请到后台仓库/草稿箱确认，不要重试' })
    // A record from before the plan, or of another store, is not this plan's.
    expect(outcomeOf(PLAN, target(), [record('saved', '2026-10-07T03:00:00.000Z'), record('saved', '2026-10-08T03:05:00.000Z', { store: '别家店' })]))
      .toEqual({ result: '未执行', note: '还没有开始', started: false })
    const marked: PublishPlan = { ...PLAN, marks: [
      { account: 'tm', status: 'failed', note: '账号要重新登录', at: '2026-10-08T03:06:00.000Z' },
      { account: 'other', status: 'cancelled', note: 'x', at: '2026-10-08T03:09:00.000Z' },
    ] }
    expect(outcomeOf(marked, target(), [record('submitting', '2026-10-08T03:05:00.000Z')])).toEqual({ result: '失败', note: '账号要重新登录', started: true })
    expect(outcomeOf(marked, target(), [record('saved', '2026-10-08T03:07:00.000Z')]).result).toBe('成功')
    const later = (status: 'pending' | 'cancelled') => outcomeOf({ ...PLAN, marks: [{ account: 'tm', status, note: '缺参考价', at: '2026-10-08T03:06:00.000Z' }] }, target(), [])
    expect(later('pending')).toEqual({ result: '待确认', note: '缺参考价', started: true })
    expect(later('cancelled')).toEqual({ result: '未执行', note: '用户取消：缺参考价', started: true })
  })

  it('hands out a store without records first, and reads a plan without marks or shared content', () => {
    expect(nextTarget(PLAN, new Map())).toEqual({ target: target(), index: 0 })
    expect(summaryText(PLAN, new Map())).toContain('| 天猫 | 名流旗舰店 | 未执行 |  | 还没有开始 |')
    const { marks: _marks, shared: _shared, ...bare } = PLAN
    expect(parsePlan(JSON.stringify(bare))).toEqual(PLAN)
  })

  it('sums up every store, and says what follows a failure or an unknown result', () => {
    const plan: PublishPlan = { ...PLAN, targets: [
      target(), target({ account: 'pdd', platform: 'pinduoduo', store: '拼', records: '/w/拼多多发品/发品记录.json' }),
      target({ account: 'dy', platform: 'doudian', store: '抖', records: '/w/抖店发品/发品记录.json' }),
    ] }
    const records = new Map([
      ['/w/天猫发品/发品记录.json', [record('saved', '2026-10-08T03:05:00.000Z', { itemId: '1088' })]],
      ['/w/拼多多发品/发品记录.json', [record('failed', '2026-10-08T03:06:00.000Z', { store: '拼', message: '标题含违禁词' })]],
    ])
    expect(summaryText(plan, records)).toBe([
      '多店发品汇总（素材 /w/素材，3 家店）：成功 1、失败 1、待确认 0、未执行 1', '',
      '| 平台 | 店铺 | 结果 | 商品/草稿 | 说明 |', '|---|---|---|---|---|',
      '| 天猫 | 名流旗舰店 | 成功 | 商品 ID 1088 | 已存进仓库/草稿箱，没有上架 |',
      '| 拼多多 | 拼 | 失败 |  | 没有保存：标题含违禁词 |',
      '| 抖店 | 抖 | 未执行 |  | 还没有开始 |', '',
      '失败的店铺不会自动重试；要不要重发、怎么改，由用户决定。',
    ].join('\n'))
    expect(summaryText(plan, new Map([['/w/天猫发品/发品记录.json', [record('unknown', '2026-10-08T03:05:00.000Z')]]])))
      .toContain('待确认的店铺：结果不明的请用户到后台仓库/草稿箱确认，等用户答复的请用户先答复。')
  })
})

describe('shared content', () => {
  it('keeps the values the model wrote once the user confirmed them', () => {
    const draft = { values: {
      商品标题: { value: '名流水多多', source: '模型生成' as const }, 卖点: { value: ['润滑', '超薄'], source: '模型生成' as const },
      品牌: { value: '名流', source: '店铺资料' as const }, 导购标题: { value: '水多多', source: '用户确认' as const },
    } }
    const before = { 导购标题: { value: '水多多', store: '名流旗舰店', confirmedAt: 't0' } }
    expect(confirmShared(before, draft, '拼', 't1')).toEqual({
      shared: { ...before, 商品标题: { value: '名流水多多', store: '拼', confirmedAt: 't1' }, 卖点: { value: ['润滑', '超薄'], store: '拼', confirmedAt: 't1' } },
      labels: ['商品标题', '卖点'],
    })
  })

  it('takes a shared value the answers leave out or repeat, and leaves one they changed to this store\'s card', () => {
    const shared = {
      商品标题: { value: '名流水多多', store: '名流旗舰店', confirmedAt: '2026-10-08T03:00:00.000Z' },
      卖点: { value: ['润滑', '超薄'], store: '名流旗舰店', confirmedAt: '2026-10-08T03:00:00.000Z' },
      导购标题: { value: '水多多', store: '名流旗舰店', confirmedAt: '2026-10-08T03:00:00.000Z' },
    }
    const applied = withShared({ columns: { 到手价: 'price' }, values: {
      卖点: { value: ['润滑', '超薄'], source: '模型生成' }, 导购标题: { value: '名流水多多', source: '模型生成' }, 品牌: { value: '名流', source: '店铺资料' },
    } }, shared)
    expect(applied.answers).toEqual({ columns: { 到手价: 'price' }, values: {
      商品标题: { value: '名流水多多', source: '用户确认' }, 卖点: { value: ['润滑', '超薄'], source: '用户确认' },
      导购标题: { value: '名流水多多', source: '模型生成' }, 品牌: { value: '名流', source: '店铺资料' },
    } })
    expect(applied.notes).toEqual([
      '共用内容已在前面的确认卡片确认，自动带上：商品标题（名流旗舰店，2026-10-08 11:00 北京时间）、卖点（名流旗舰店，2026-10-08 11:00 北京时间）',
      '这家店改了共用内容，要在本店卡片里确认：导购标题（名流旗舰店 确认的是「水多多」）',
    ])
    expect(withShared({}, {})).toEqual({ answers: { values: {} }, notes: [] })
  })

  it('marks the shared values confirmed in a draft built with --plan', async () => {
    const root = await folder()
    await mkdir(join(root, '素材'))
    await writeFile(join(root, '素材', '主图-1.png'), png(120, 120))
    await writeFile(join(root, '素材', 'sku.csv'), '上架名称,到手价\n尝鲜装,42.9\n')
    await writeFile(join(root, 'plan.json'), JSON.stringify({ ...PLAN, shared: { 商品标题: { value: '名流水多多', store: '名流旗舰店', confirmedAt: '2026-10-08T03:00:00.000Z' } } }))
    await writeFile(join(root, 'rules.json'), JSON.stringify({ catId: '1', fields: [{ key: 'title', label: '商品标题', uiType: 'input', required: true, visible: true }] }))
    const out = fakeDeps(new FakePage([]))
    const argv = ['draft', '--folder', join(root, '素材'), '--rules', join(root, 'rules.json'), '--plan', join(root, 'plan.json'), '--out', join(root, 'o')]
    expect(await draftMain(argv, out)).toBe(0)
    expect(out.out.join('')).toContain('已确认（1）：\n- 商品标题（title）：名流水多多〔用户确认〕')
    expect(out.out.join('')).toContain('- 共用内容已在前面的确认卡片确认，自动带上：商品标题（名流旗舰店，2026-10-08 11:00 北京时间）')
    await writeFile(join(root, 'plan.json'), '{}')
    const bad = fakeDeps(new FakePage([]))
    expect(await draftMain(argv, bad)).toBe(EXIT.usage)
    expect(bad.err.join('')).toContain('有误：不是多店发品计划文件（缺 createdAt、folder 或 targets）')
    const missing = fakeDeps(new FakePage([]))
    expect(await draftMain([...argv.slice(0, 5), '--plan', join(root, 'none.json')], missing)).toBe(EXIT.usage)
    expect(missing.err.join('')).toContain('读不到发品计划文件')
  })
})

describe('multi-publish script', () => {
  async function workspace() {
    const cwd = await folder()
    await mkdir(join(cwd, '素材'))
    return { cwd, plan: join(cwd, '多店发品', '发品计划.json'), materials: join(cwd, '素材') }
  }
  const run = async (d: ReturnType<typeof deps>, argv: string[]) => {
    const code = await main(argv, d)
    return { code, out: d.out.splice(0).join(''), err: d.err.splice(0).join('') }
  }

  it('plans the stores, hands them out one at a time, and sums up their results', async () => {
    const { cwd, plan, materials } = await workspace()
    const d = deps(cwd)
    const planned = await run(d, ['plan', '--folder', materials, '--account', 'tm', '--account', 'pdd', '--account', 'dy', '--plan', plan])
    expect(planned.code).toBe(0)
    expect(planned.out).toBe([
      `已建多店发品计划（3 家店）：${plan}`,
      '1. 天猫「名流旗舰店」（账号 tm）—— 用 tmall-publish 技能',
      '2. 拼多多「名流保健用品官方旗舰店」（账号 pdd）—— 用 pdd-publish 技能',
      '3. 抖店「dy:运营」（账号 dy）—— 用 doudian-publish 技能',
      '按顺序一家一家来：先运行 next。', '',
    ].join('\n'))
    const saved = JSON.parse(await readFile(plan, 'utf8')) as PublishPlan
    expect(saved).toEqual({
      createdAt: '2026-10-08T03:00:00.000Z', folder: materials, marks: [], shared: {},
      targets: [
        { account: 'tm', platform: 'tmall', store: '名流旗舰店', records: join(cwd, '天猫发品', '发品记录.json') },
        { account: 'pdd', platform: 'pinduoduo', store: '名流保健用品官方旗舰店', records: join(cwd, '拼多多发品', '发品记录.json') },
        { account: 'dy', platform: 'doudian', store: 'dy:运营', records: join(cwd, '抖店发品', '发品记录.json') },
      ],
    })

    const first = await run(d, ['next', '--plan', plan])
    expect(first.out).toBe([
      '下一家：第 1/3 家，天猫「名流旗舰店」（账号 tm），用 tmall-publish 技能。',
      `- 字段规则写到 ${join('天猫发品', '名流旗舰店')}（tmall-publish-category 的 rules 加 --out ${join('天猫发品', '名流旗舰店')}）。`,
      `- 商品草稿写到 ${join('发品草稿', '名流旗舰店')}（product-draft draft 加 --out ${join('发品草稿', '名流旗舰店')} --store 名流旗舰店 --plan ${plan}）。`,
      '- 保存时不加 --out，保存记录留在 天猫发品/发品记录.json，汇总从那里读结果。',
      '- 这是第一张确认卡片：用户一键认可后、保存前，运行 confirm 记下用户认可的内容，后面的店自动带上。', '',
    ].join('\n'))

    // The user confirms the first card; the shared content is kept, and the Tmall store saves.
    const draft = join(cwd, '发品草稿', '名流旗舰店', '商品草稿.json')
    await mkdir(join(draft, '..'), { recursive: true })
    await writeFile(draft, JSON.stringify({ values: { 商品标题: { value: '名流水多多', source: '模型生成' } } }))
    expect((await run(d, ['confirm', '--account', 'tm', '--draft', draft, '--plan', plan])).out)
      .toBe('已记下「名流旗舰店」卡片里用户认可的共用内容：商品标题。后面的店生成草稿时加 --plan 自动带上。\n')
    await mkdir(join(cwd, '天猫发品'))
    await writeFile(join(cwd, '天猫发品', '发品记录.json'), JSON.stringify([
      record('submitting', '2026-10-08T03:05:00.000Z'), record('saved', '2026-10-08T03:06:00.000Z', { itemId: '1088' }),
    ]))

    const second = await run(d, ['next', '--plan', plan])
    expect(second.out).toContain('下一家：第 2/3 家，拼多多「名流保健用品官方旗舰店」（账号 pdd），用 pdd-publish 技能。')
    expect(second.out).toContain(`（pdd-publish 的 rules 加 --out ${join('拼多多发品', '名流保健用品官方旗舰店')}）`)
    expect(second.out).toContain('- 共用内容已在前面的卡片确认（商品标题：名流旗舰店），草稿里标「已确认」；这家店的卡片仍要用户一键认可才保存。')

    // Pinduoduo stops before a save: it is marked and never handed out again; the Douyin shop is next.
    expect((await run(d, ['mark', '--account', 'pdd', '--status', 'failed', '--note', '账号需要重新登录', '--plan', plan])).out)
      .toBe('已记下「名流保健用品官方旗舰店」：失败（账号需要重新登录）。这家店不再自动处理，继续运行 next。\n')
    expect((await run(d, ['next', '--plan', plan])).out).toContain('下一家：第 3/3 家，抖店「dy:运营」（账号 dy）')
    expect((await run(d, ['mark', '--account', 'dy', '--status', 'cancelled', '--note', '用户在卡片里取消', '--plan', plan])).code).toBe(0)
    expect((await run(d, ['next', '--plan', plan])).out).toBe('这次计划里的每家店都处理过了（成功、失败、待确认或已取消），不再继续。运行 summary 汇总给用户。\n')

    // A second Tmall store shares the platform's record file, which only names the first store.
    const second2 = await run(d, ['plan', '--folder', materials, '--account', 'tm', '--account', 'tm2', '--plan', join(cwd, 'two.json')])
    expect(second2.code).toBe(0)
    expect((await run(d, ['next', '--plan', join(cwd, 'two.json')])).out).toContain('下一家：第 2/2 家，天猫「名流二店」')
    const summed = await run(d, ['summary', '--plan', plan])
    expect(summed.out).toContain('多店发品汇总（素材 ')
    expect(summed.out).toContain('3 家店）：成功 1、失败 1、待确认 0、未执行 1')
    expect(summed.out).toContain('| 拼多多 | 名流保健用品官方旗舰店 | 失败 |  | 账号需要重新登录 |')
    expect(summed.out).toContain('| 抖店 | dy:运营 | 未执行 |  | 用户取消：用户在卡片里取消 |')
    expect(summed.out).toContain(`已保存：${join(cwd, '多店发品', '发品汇总.md')}`)
    expect(await readFile(join(cwd, '多店发品', '发品汇总.md'), 'utf8')).toMatch(/^# 多店发品汇总\n\n2026-10-08 11:\d\d（北京时间）\n\n多店发品汇总/u)
  })

  it('refuses a second plan unless asked to replace it, and accounts that cannot publish', async () => {
    const { cwd, plan, materials } = await workspace()
    const d = deps(cwd)
    const make = (...accounts: string[]) => ['plan', '--folder', materials, ...accounts.flatMap(id => ['--account', id]), '--plan', plan]
    expect((await run(d, make('tm'))).code).toBe(0)
    const again = await run(d, make('pdd'))
    expect([again.code, again.err]).toEqual([EXIT.usage, `已有发品计划 ${plan}：继续它用 next；用户明确要重新开始一次多店发品时才加 --replace。\n`])
    expect((await run(d, [...make('pdd'), '--replace'])).code).toBe(0)
    expect((JSON.parse(await readFile(plan, 'utf8')) as PublishPlan).targets.map(item => item.account)).toEqual(['pdd'])
    const replace = (...accounts: string[]) => [...make(...accounts), '--replace']
    expect((await run(d, replace('nobody'))).err).toBe('没有电商账号 nobody：用 dsh-ecommerce accounts 查账号 id。\n')
    expect((await run(d, replace('tb'))).err).toBe('账号 tb（名流淘宝店，平台 taobao，类型 merchant）不能发品：只支持天猫、拼多多、抖店的商家账号。\n')
    expect((await run(d, replace('buyer'))).err).toContain('账号 buyer（tb_buyer_1，平台 tmall，类型 buyer）不能发品')
    expect((await run(d, replace('tm', 'tm'))).err).toBe('账号 tm 重复了。\n')
    expect((await run(d, ['plan', '--folder', join(cwd, 'none'), '--account', 'tm', '--plan', plan, '--replace'])).err).toBe(`素材文件夹 ${join(cwd, 'none')} 不存在。\n`)
  })

  it('refuses a missing or damaged plan, an account outside it, and an unreadable draft', async () => {
    const { cwd, plan, materials } = await workspace()
    const d = deps(cwd)
    const missing = await run(d, ['next', '--plan', plan])
    expect([missing.code, missing.err]).toEqual([EXIT.usage, expect.stringContaining(`读不到发品计划 ${plan}（`) as string])
    expect(missing.err).toContain('先用 plan 建计划。')
    await mkdir(join(plan, '..'), { recursive: true })
    await writeFile(plan, '{"targets":[]}')
    expect((await run(d, ['summary', '--plan', plan])).err).toBe(`发品计划 ${plan} 有误：不是多店发品计划文件（缺 createdAt、folder 或 targets）\n`)
    expect((await run(d, ['plan', '--folder', materials, '--account', 'tm', '--plan', plan, '--replace'])).code).toBe(0)
    expect((await run(d, ['mark', '--account', 'pdd', '--status', 'failed', '--note', 'x', '--plan', plan])).err).toBe('账号 pdd 不在这次的发品计划里。\n')
    expect((await run(d, ['confirm', '--account', 'tm', '--draft', join(cwd, 'none.json'), '--plan', plan])).err).toContain('读不到商品草稿 ')
    await writeFile(join(cwd, 'draft.json'), JSON.stringify({ values: { 品牌: { value: '名流', source: '店铺资料' } } }))
    expect((await run(d, ['confirm', '--account', 'tm', '--draft', join(cwd, 'draft.json'), '--plan', plan])).out).toBe('「名流旗舰店」的草稿里没有模型生成的值，共用内容没有变化。\n')
    expect((await run(d, ['mark', '--account', 'tm', '--status', 'pending', '--note', '缺参考价', '--plan', plan])).out).toContain('已记下「名流旗舰店」：待确认（缺参考价）')
    const odd = deps(cwd, { now: () => { throw new Error('clock') } })
    expect(await run(odd, ['mark', '--account', 'tm', '--status', 'pending', '--note', 'x', '--plan', plan])).toEqual({ code: EXIT.failed, out: '', err: '失败：clock\n' })
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- a non-Error rejection is the scenario under test.
    const bad = deps(cwd, { accounts: () => Promise.reject('down') })
    expect((await run(bad, ['plan', '--folder', materials, '--account', 'tm', '--plan', plan, '--replace'])).err).toBe('失败：down\n')
    expect((await run(d, ['bogus'])).code).toBe(EXIT.usage)
  })

  it('lists the accounts with dsh-ecommerce by default', async () => {
    const { plan, materials } = await workspace()
    const real = await main(['plan', '--folder', materials, '--account', 'tm', '--plan', plan], undefined)
    expect(real).toBe(EXIT.failed)
  })
})
