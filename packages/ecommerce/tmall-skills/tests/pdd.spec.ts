import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { takeOverMerchant, type EcommerceCommandResult } from '../src/account.ts'
import type { FieldCheck } from '../src/draft.ts'
import { generatedLabels } from '../src/draft.ts'
import { EXIT, SkillError } from '../src/errors.ts'
import { main, parseCategoryOptions, pddDeps } from '../src/pdd-cli.ts'
import {
  categoryById, categoryOfLine, childCategories, createSession, pddRules, predictCategories, readLimits, readTemplate, searchCategories,
  setCategory,
  type Template,
} from '../src/pdd-category.ts'
import {
  buildGoods, extraPrices, goodsProperties, listDrafts, listGoods, PACKAGE_SPEC, readSession, saveDraft, SESSION_FIELDS, shelfDays,
  specIdFor, uploadPddImage,
} from '../src/pdd-publish.ts'
import { INSTALL, isPddSignIn, openPdd, PDD_GOODS_URL, pddCall, PddRefusal } from '../src/pdd.ts'
import { commonPrefix, type DraftFile, type PublishRecord } from '../src/publish-common.ts'
import type { PublishRules } from '../src/publish-rules.ts'
import { png } from './images.ts'
import { fakeDeps, FakePage, on, tempDir, type Route } from './support.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function folder(): Promise<string> {
  const { dir, cleanup } = await tempDir()
  cleanups.push(cleanup)
  return dir
}

async function stopped(work: Promise<unknown>): Promise<SkillError> {
  try {
    await work
  } catch (error) {
    expect(error).toBeInstanceOf(SkillError)
    return error as SkillError
  }
  throw new Error('expected a SkillError')
}

const ok = (result: unknown) => ({ success: true, error_code: 1_000_000, error_msg: null, result })

/** The 避孕套 (18770) template, trimmed to four of its properties. */
const TEMPLATE: Template = {
  id: 55_906,
  modules: [{
    id: 77_408,
    propertys: [
      { id: 510_122, ref_pid: 310, pid: 5, name_alias: '品牌', required: true, control_type: 1, choose_max_num: 1, values: { content: [{ vid: 3954, value: 'Personage/名流' }] } },
      { id: 510_123, ref_pid: 842, pid: 234, name_alias: '注册证号', required: true, control_type: 0, choose_max_num: 0 },
      { id: 510_125, ref_pid: 406, pid: 58, name_alias: '保质期', required: false, control_type: 0, choose_max_num: 0, value_unit: '天' },
      { id: 510_126, ref_pid: 405, pid: 57, name_alias: '生产日期', required: false, control_type: 5, choose_max_num: 0 },
      {
        id: 510_127, ref_pid: 660, pid: 78, name_alias: '特点', required: false, control_type: 1, choose_max_num: 2,
        values: { content: [{ vid: 56780, value: '超薄' }, { vid: 1855953, value: '含玻尿酸' }] },
      },
    ],
  }, { id: 2, propertys: null }],
}

const LIMITS = { shipment_limit_second: [86_400, 172_800], goods_title_length_limit: 60 }

/** Pinduoduo's merchant backend as the seller pages call it. */
class Mall {
  drafts: { draftId: string; goodsId: string; title: string }[] = [{ draftId: '201975839851', goodsId: '657749804806', title: '名流避孕套MO玻尿酸超薄' }]
  goods: { goodsId: string; title: string }[] = []
  readonly sessions: number[] = []
  readonly saves: Record<string, unknown>[] = []
  readonly uploads: string[] = []
  readonly calls: string[] = []
  /** What a save does: lists the draft, lists nothing, is refused, or never answers. */
  saving: 'drafts' | 'nowhere' | 'refused' | 'lost' = 'drafts'
  signedOut = false

  routes(): Route[] {
    return [
      (expression, page) => expression === 'location.href' ? page.href : undefined,
      expression => expression === INSTALL ? true : undefined,
      on('store_image', (expression: string) => {
        const name = JSON.parse(/form\.append\('image', new Blob\(\[bytes\]\), ("[^"]*")\)/u.exec(expression)?.[1] as string) as string
        this.uploads.push(name)
        return name === 'bad.png' ? { error_msg: '图片违规' } : { url: `https://pfs.pinduoduo.com/${name}`, width: 800, height: 800 }
      }),
      on('window.__dshPdd(', (expression: string) => {
        const [, method = '', path = '""', body = ''] = /^window\.__dshPdd\("(\w+)", ("(?:[^"\\]|\\.)*"), (.*)\)$/su.exec(expression) ?? []
        return this.answer(method, JSON.parse(path) as string, body === 'undefined' ? undefined : JSON.parse(body) as Record<string, unknown>)
      }),
    ]
  }

  answer(method: string, path: string, body?: Record<string, unknown>): unknown {
    this.calls.push(`${method} ${path.split('?')[0] as string}`)
    const route = path.split('?')[0] as string
    switch (route) {
      case '/vodka/v2/mms/search/categories/v2':
        return { success: true, errorCode: 1_000_000, result: { cat_info_v2_lists: [
          { optional: true, cat_name_1: '成人用品', cat_name_2: '计生用品', cat_name_3: '避孕套', cat_name_4: null, cat_id_1: 16237, cat_id_2: 18768, cat_id_3: 18770, cat_id_4: null },
          { optional: true, cat_name_1: '医疗器械', cat_name_2: '计划生育', cat_id_1: 18814, cat_id_2: 18887, cat_qualification_detail: { inValid: true } },
        ] } }
      case '/vodka/v2/mms/category/predict/list':
        return { success: true, errorCode: 1_000_000, result: [{ cat_name_1: '成人用品', cat_name_2: '计生用品', cat_name_3: '避孕套', cat_id_1: 16237, cat_id_2: 18768, cat_id_3: 18770, cat_id_4: 0 }] }
      case '/vodka/v2/mms/categories':
        return ok(path.endsWith('parentId=18768') ? [{ id: 18770, cat_name: '避孕套', leaf: 1 }, { id: 18769, cat_name: '试纸', leaf: 0 }] : [])
      case '/vodka/v2/mms/category/detail':
        return path.endsWith('catId=18770')
          ? { success: true, errorCode: 1_000_000, result: { id: 18770, cat_id_1: 16237, cat_id_2: 18768, cat_id_3: 18770, cat_id_4: 0, cat_id_1_name: '成人用品', cat_id_2_name: '计生用品', cat_id_3_name: '避孕套' } }
          : { success: true, errorCode: 1_000_000, result: null }
      case '/glide/v2/mms/edit/commit/create_new': {
        this.sessions.push(203_110_000 + this.sessions.length)
        return ok({ goods_commit_id: this.sessions.at(-1), goods_id: 1_013_940_000 + this.sessions.length })
      }
      case '/glide/mms/goodsCommit/action/update_goods_commit_info': return ok(true)
      case '/draco-ms/mms/template/mall': return ok(TEMPLATE)
      case '/glide/v2/mms/query/rules/limit/new': return ok(LIMITS)
      case '/galerie/business/get_signature': return ok({ signature: 'sig' })
      case '/glide/v2/mms/query/spec/by/name': return ok(31_406_958_000 + String(body?.name).length)
      case '/glide/v2/mms/query/commit/detail':
        return ok({ goods_id: 1, check_status: 9, cost_template_id: 544_142_245_494_784, groups: {}, mall_id: 7, galleries: [] })
      case '/glide/mms/goodsCommit/action/edit': {
        if (this.saving === 'refused') return { success: false, error_code: 2_000_000, error_msg: '价格参数不完整' }
        if (this.saving === 'lost') return new Error('Network Error')
        this.saves.push(body as Record<string, unknown>)
        if (this.saving === 'drafts') this.drafts.unshift({ draftId: String(body?.goods_commit_id), goodsId: String(body?.goods_id), title: String(body?.goods_name) })
        return ok(true)
      }
      case '/glide/v2/mms/query/commit/list': {
        const start = Number(body?.start)
        const list = this.drafts.slice(start, start + Number(body?.length))
        const rows = list.map(row => ({ id: Number(row.draftId), goods_id: Number(row.goodsId), goods_name: row.title }))
        return ok({ total: this.drafts.length, list: rows })
      }
      case '/vodka/v2/mms/query/display/mall/goodsList': {
        const keyword = (body?.keywords as string[])[0] as string
        const found = this.goods.filter(item => item.title.includes(keyword) || keyword.includes(item.title))
        return ok({ goods_list: found.map(item => ({ id: Number(item.goodsId), goods_name: item.title })) })
      }
      default: return { success: false, error_code: 50_000, error_msg: `no route ${route}` }
    }
  }

  page(): FakePage {
    return new FakePage(this.routes(), (_url, tab) => { if (this.signedOut) tab.href = 'https://mms.pinduoduo.com/login/?redirectUrl=x' })
  }
}

const filled = (key: string, label: string, values: readonly string[], status: FieldCheck['status'] = '已填'): FieldCheck => ({
  key, label, required: true, status, value: values.join('、'), filled: values,
})

const RULES: PublishRules = pddRules('18770', ['成人用品', '计生用品', '避孕套'], TEMPLATE, LIMITS)

const CHECKS: FieldCheck[] = [
  filled('title', '商品标题', ['名流水多多玻尿酸三合一避孕套'], '已确认'),
  filled('mainImagesGroup', '商品轮播图', ['2 张']),
  filled('descRepublicOfSell', '商品详情', ['1 张']),
  filled('p-310', '品牌', ['Personage/名流']),
  filled('p-842', '注册证号', ['皖械注准20182180006']),
  filled('p-406', '保质期', ['5年']),
  filled('p-660', '特点', ['超薄', '含玻尿酸', '其他']),
  filled('sku', '商品规格', ['2 个 SKU']),
  { key: 'quantity', label: '库存', required: true, status: '缺失', note: '需要每个 SKU 的库存' },
  filled('shipment', '发货时间', ['48小时']),
  filled('singlePriceDelta', '单买价比拼单价高（元）', ['5'], '已确认'),
  filled('marketPrice', '参考价（元）', ['99.9元'], '已确认'),
]

async function sampleDraft(overrides: Partial<DraftFile> = {}): Promise<{ dir: string; path: string; rules: string; out: string }> {
  const dir = await folder()
  for (const file of ['方图/1.png', '方图/2.png', '详情页/1.png', 'sku图/a.png']) {
    await mkdir(dirname(join(dir, file)), { recursive: true })
    await writeFile(join(dir, file), png(20, 20))
  }
  const draft: DraftFile = {
    folder: dir,
    images: { main: ['方图/1.png', '方图/2.png'], main34: [], white: [], transparent: [], detail: ['详情页/1.png'], sku: ['sku图/a.png'], other: [], unknown: [] },
    skus: [
      { index: 'SKU1', name: '1盒【到手18只】', code: 'mldx238a', count: 18, price: 42.9, image: 'sku图/a.png' },
      { index: 'SKU2', name: '2盒【到手40只】', code: 'mldx238b', count: 40, price: 69.9 },
    ],
    values: { 商品标题: { value: '名流水多多玻尿酸三合一避孕套', source: '模型生成' } },
    missing: [], problems: [], notes: [], catId: '18770', checks: CHECKS,
    ...overrides,
  }
  const path = join(dir, '商品草稿.json')
  await writeFile(path, JSON.stringify(draft))
  const rules = join(dir, '字段规则_18770.json')
  await writeFile(rules, JSON.stringify({ platform: 'pinduoduo', ...RULES }))
  return { dir, path, rules, out: join(dir, '拼多多发品') }
}

describe('Pinduoduo pages', () => {
  it('opens a seller page once its anti-content module is loaded, and stops on the sign-in page', async () => {
    const mall = new Mall()
    const page = mall.page()
    await openPdd(page)
    expect(page.visited).toEqual([PDD_GOODS_URL])
    mall.signedOut = true
    expect((await stopped(openPdd(mall.page()))).exitCode).toBe(EXIT.signedOut)
    expect((await stopped(openPdd(new FakePage([on('', false)]), 'https://mms.pinduoduo.com/x'))).message).toContain('打不开或已改版')
    expect(isPddSignIn('https://login.pinduoduo.com/')).toBe(true)
    expect(isPddSignIn(PDD_GOODS_URL)).toBe(false)
  })

  it('answers a call result and names a refusal in both spellings', async () => {
    const page = new FakePage([on('__dshPdd', (e: string) => e.includes('/a') ? ok(1)
      : e.includes('/b') ? { success: false, errorCode: 3, errorMsg: '参数不规范' }
        : e.includes('/c') ? { success: true, error_code: 54_001, error_msg: '操作太过频繁' } : null)])
    expect(await pddCall(page, 'GET', '/a')).toBe(1)
    expect(await stopped(pddCall(page, 'POST', '/b?x=1', {}))).toBeInstanceOf(PddRefusal)
    expect((await stopped(pddCall(page, 'POST', '/b', {}))).message).toBe('拼多多接口 /b 拒绝了请求（参数不规范）。')
    expect((await stopped(pddCall(page, 'GET', '/c'))).message).toContain('操作太过频繁')
    expect((await stopped(pddCall(page, 'GET', '/d'))).message).toContain('无应答')
  })
})

describe('Pinduoduo categories', () => {
  it('reads category lines, deepest level first', () => {
    expect(categoryOfLine({ cat_id_1: 1, cat_id_2: 2, cat_id_3: 0, cat_name_1: '甲', cat_name_2: null })).toEqual({ id: '2', path: ['甲', ''], usable: true })
    expect(categoryOfLine({ cat_id_1: 1, cat_name_1: '甲', optional: false }).usable).toBe(false)
  })

  it('searches, predicts, walks, and reads categories', async () => {
    const mall = new Mall()
    const page = mall.page()
    expect(await searchCategories(page, '避孕套')).toEqual([
      { id: '18770', path: ['成人用品', '计生用品', '避孕套'], usable: true }, { id: '18887', path: ['医疗器械', '计划生育'], usable: false },
    ])
    expect(await predictCategories(page, 1, 'u', 't')).toEqual([{ id: '18770', path: ['成人用品', '计生用品', '避孕套'], usable: true }])
    expect(await childCategories(page, '18768')).toEqual([{ id: '18770', name: '避孕套', leaf: true }, { id: '18769', name: '试纸', leaf: false }])
    expect(await childCategories(page, '1')).toEqual([])
    expect(await categoryById(page, '18770')).toEqual({ id: '18770', path: ['成人用品', '计生用品', '避孕套'], usable: true })
    expect((await stopped(categoryById(page, '1'))).exitCode).toBe(EXIT.usage)
    const session = await createSession(page)
    await setCategory(page, session, '18770')
    expect(await readTemplate(page, '18770')).toEqual(TEMPLATE)
    expect(await readLimits(page, '18770')).toEqual(LIMITS)
    const empty = new FakePage([on('__dshPdd', (e: string) => ok(e.includes('search') ? {} : null))])
    expect(await searchCategories(empty, 'x')).toEqual([])
    expect(await predictCategories(empty, 1, 'u', 't')).toEqual([])
    expect(await childCategories(empty, '0')).toEqual([])
  })

  it('writes the template and limits as field rules', () => {
    expect(RULES.categoryPath).toBe('成人用品 > 计生用品 > 避孕套')
    expect(RULES.fields.map(field => [field.key, field.label, field.uiType, field.required])).toEqual([
      ['title', '商品标题', 'input', true], ['mainImagesGroup', '商品轮播图', 'image', true], ['descRepublicOfSell', '商品详情', 'image', true],
      ['p-310', '品牌', 'select', true], ['p-842', '注册证号', 'input', true], ['p-406', '保质期', 'input', false], ['p-405', '生产日期', 'date', false],
      ['p-660', '特点', 'checkbox', false], ['sku', '商品规格', 'sku', true], ['quantity', '库存', 'input', true], ['shipment', '发货时间', 'radio', true],
      ['singlePriceDelta', '单买价比拼单价高（元）', 'input', true], ['marketPrice', '参考价（元）', 'input', true],
    ])
    expect(RULES.fields.find(field => field.key === 'shipment')?.options).toEqual([{ value: 86_400, text: '24小时' }, { value: 172_800, text: '48小时' }])
    expect(RULES.fields.find(field => field.key === 'p-310')?.options).toEqual([{ value: 3954, text: 'Personage/名流' }])
    const bare = pddRules('1', [], { id: 1, modules: [] }, {})
    expect(bare.fields.find(field => field.key === 'title')?.maxLength).toBe(60)
    expect(bare.fields.find(field => field.key === 'shipment')?.options).toEqual([{ value: 172_800, text: '48小时' }])
    expect(generatedLabels(RULES)).toEqual(['商品标题'])
    expect(generatedLabels()).toEqual(['商品标题', '商品卖点', '导购标题'])
    expect(generatedLabels({ catId: '1', categoryPath: '', fields: [{ key: 'tmSubTitle', label: 'x', uiType: 'input', required: false, visible: true }] })).toEqual(['商品标题', '商品卖点'])
  })
})

describe('Pinduoduo form', () => {
  it('reads prices, shelf lives, and properties', () => {
    expect(extraPrices(CHECKS, [42.9, 69.9])).toEqual({ singleDelta: 5, market: 99.9 })
    expect(extraPrices([], [10])).toEqual({ problems: ['单买价比拼单价高（元）应是大于 0 的数', '参考价（元）应高于最高的单买价 10.00'] })
    expect(extraPrices([filled('singlePriceDelta', 'x', ['2']), filled('marketPrice', 'x', ['12'])], [10])).toEqual({ problems: ['参考价（元）应高于最高的单买价 12.00'] })
    expect(['5年', '18个月', '6月', '30天', '90日', '200', '五年'].map(shelfDays)).toEqual(['1825', '540', '180', '30', '90', '200', '五年'])
    expect(goodsProperties(TEMPLATE, CHECKS)).toEqual([
      { template_pid: 510_122, template_module_id: 77_408, ref_pid: 310, pid: 5, vid: 3954, value: '', value_unit: '', content: 'Personage/名流' },
      { template_pid: 510_123, template_module_id: 77_408, ref_pid: 842, pid: 234, vid: 0, value: '皖械注准20182180006', value_unit: '' },
      { template_pid: 510_125, template_module_id: 77_408, ref_pid: 406, pid: 58, vid: 0, value: '1825', value_unit: '天' },
      { template_pid: 510_127, template_module_id: 77_408, ref_pid: 660, pid: 78, vid: 56780, value: '', value_unit: '', content: '超薄' },
      { template_pid: 510_127, template_module_id: 77_408, ref_pid: 660, pid: 78, vid: 1855953, value: '', value_unit: '', content: '含玻尿酸' },
    ])
    expect(goodsProperties(TEMPLATE, [{ key: 'p-310', label: '品牌', required: true, status: '缺失' }])).toEqual([])
    const valueless: Template = { id: 1, modules: [{ id: 2, propertys: [{ id: 3, ref_pid: 4, pid: 5, name_alias: '尺寸', required: false, control_type: 1, choose_max_num: 1, values: null }] }] }
    expect(goodsProperties(valueless, [filled('p-4', '尺寸', ['标准'])])).toEqual([])
    expect(commonPrefix([])).toBe('')
  })

  it('sets the draft into the session values, keeping only the fields the form carries', async () => {
    const { path } = await sampleDraft()
    const draft = JSON.parse(await readFile(path, 'utf8')) as DraftFile
    const images = { '方图/1.png': 'u1', '方图/2.png': 'u2', '详情页/1.png': 'd1', 'sku图/a.png': 's1' }
    const form = buildGoods({ goods_id: 1, check_status: 9, cost_template_id: 5, mall_id: 7, galleries: [] }, {
      draft, checks: CHECKS, rules: RULES, template: TEMPLATE, session: { goodsId: 99, commitId: 88 }, images,
      specs: { '1盒【到手18只】': 11, '2盒【到手40只】': 12 }, prices: { singleDelta: 5, market: 99.9 }, stock: 1000,
    })
    expect(form.mall_id).toBeUndefined()
    expect(Object.keys(form).filter(key => !(SESSION_FIELDS as readonly string[]).includes(key)).sort()).toEqual([
      'gallery', 'goods_commit_id', 'goods_properties', 'is_auto_save', 'market_price_in_yuan', 'skus',
    ])
    expect(form).toMatchObject({
      goods_commit_id: '88', goods_id: 99, cat_id: 18770, goods_name: '名流水多多玻尿酸三合一避孕套', goods_desc: '名流水多多玻尿酸三合一避孕套',
      check_status: 9, cost_template_id: 5, pre_sale_time: '', country_id: '0', is_auto_save: false, shipment_limit_second: 172_800, out_goods_sn: 'mldx238',
      market_price: 9990, market_price_in_yuan: '99.90',
      gallery: [{ url: 'u1', type: 1, file_id: null }, { url: 'u2', type: 1, file_id: null }, { url: 'd1', type: 2, file_id: null }],
    })
    expect(form.skus).toEqual([
      {
        id: 0, limit_quantity: 0, out_sku_sn: 'mldx238a', is_onsale: 1, multi_price_in_yuan: '42.90', price_in_yuan: '47.90', multi_price: 4290, price: 4790,
        quantity_delta: 1000, thumb_url: 's1', weight: 0, spec: [{ parent_id: PACKAGE_SPEC.id, parent_name: '套餐', spec_id: 11, spec_name: '1盒【到手18只】', is_custom: 0 }],
      },
      expect.objectContaining({ out_sku_sn: 'mldx238b', thumb_url: 'u1', multi_price: 6990, price: 7490, spec: [expect.objectContaining({ spec_id: 12 })] }),
    ])
    const bare = buildGoods({}, {
      draft: { ...draft, skus: [{ index: '1', name: 'a', price: 1, stock: 3 }] }, checks: [], rules: { ...RULES, fields: [] }, template: { id: 1, modules: [] },
      session: { goodsId: 1, commitId: 2 }, images, specs: { a: 1 }, prices: { singleDelta: 1, market: 9 }, stock: 0,
    })
    expect(bare).toMatchObject({ shipment_limit_second: undefined, out_goods_sn: undefined, skus: [expect.objectContaining({ out_sku_sn: '', quantity_delta: 3 })] })
  })

  it('uploads images, makes spec values, reads and saves sessions, and lists drafts and goods', async () => {
    const mall = new Mall()
    const page = mall.page()
    expect(await uploadPddImage(page, png(2, 2), 'a.png')).toBe('https://pfs.pinduoduo.com/a.png')
    expect((await stopped(uploadPddImage(page, png(2, 2), 'bad.png'))).message).toBe('上传图片 bad.png 失败（图片违规）。')
    expect((await stopped(uploadPddImage(new FakePage([on('__dshPdd', ok({ signature: 's' })), on('store_image', {})]), png(2, 2), 'c.png'))).message).toContain('（无应答）')
    expect(await specIdFor(page, '18770', 'abc')).toBe(31_406_958_003)
    expect(await readSession(page, { goodsId: 1, commitId: 2 })).toMatchObject({ check_status: 9 })
    await saveDraft(page, { goods_commit_id: '5', goods_id: 6, goods_name: 't' })
    expect(await listDrafts(page)).toContainEqual({ draftId: '5', goodsId: '6', title: 't' })
    mall.drafts = Array.from({ length: 120 }, (_, at) => ({ draftId: String(at), goodsId: String(at), title: `t${String(at)}` }))
    expect(await listDrafts(page)).toHaveLength(120)
    mall.goods = [{ goodsId: '7', title: '名流水多多' }]
    expect(await listGoods(page, '水多多')).toEqual([{ goodsId: '7', title: '名流水多多' }])
    expect(await listGoods(new FakePage([on('__dshPdd', ok({}))]), 'x')).toEqual([])
    expect(await listDrafts(new FakePage([on('__dshPdd', ok({ total: 0 }))]))).toEqual([])
  })
})

describe('pdd-publish script', () => {
  it('reads category command lines', () => {
    expect(parseCategoryOptions(['resolve', '--account', 'a', '--keyword', '避孕套'])).toEqual({ command: 'resolve', account: 'a', source: { kind: 'keyword', keyword: '避孕套' } })
    expect(parseCategoryOptions(['resolve', '--account', 'a', '--line', '水多多']).command).toBe('resolve')
    expect(parseCategoryOptions(['resolve', '--account', 'a', '--cat', '18770'])).toMatchObject({ source: { kind: 'id', id: '18770' } })
    expect(parseCategoryOptions(['resolve', '--account', 'a', '--image', 'a.png'])).toMatchObject({ source: { kind: 'image', image: 'a.png', title: '' } })
    expect(parseCategoryOptions(['resolve', '--account', 'a', '--image', 'a.png', '--title', 't'])).toMatchObject({ source: { title: 't' } })
    expect(parseCategoryOptions(['children', '--account', 'a'])).toEqual({ command: 'children', account: 'a', parent: '0' })
    expect(parseCategoryOptions(['children', '--account', 'a', '--parent', '18768'])).toMatchObject({ parent: '18768' })
    expect(parseCategoryOptions(['rules', '--account', 'a', '--cat', '1', '--out', 'o'])).toEqual({ command: 'rules', account: 'a', catId: '1', out: 'o' })
    expect(parseCategoryOptions(['rules', '--account', 'a', '--cat', '1'])).toMatchObject({ out: '拼多多发品' })
    for (const argv of [
      ['resolve', '--bogus'], ['resolve'], ['resolve', '--account', ''], ['resolve', '--account', 'a'], ['resolve', '--account', 'a', '--keyword', 'x', '--line', 'y'],
      ['resolve', '--account', 'a', '--cat', 'x'], ['rules', '--account', 'a'], ['children', '--account', 'a', '--parent', 'x'],
    ]) {
      expect(() => parseCategoryOptions(argv), argv.join(' ')).toThrow(expect.objectContaining({ exitCode: EXIT.usage }) as Error)
    }
  })

  it('takes over Pinduoduo merchant accounts only', async () => {
    const ran = (stdout: object) => (): Promise<EcommerceCommandResult> => Promise.resolve({ code: 0, stdout: JSON.stringify(stdout), stderr: '' })
    const pdd = { id: 'p', platform: 'pinduoduo', kind: 'merchant', store: '名流保健用品官方旗舰店', account: 'x', cdpUrl: 'http://127.0.0.1:9' }
    expect((await takeOverMerchant('p', ran(pdd), 'pinduoduo')).store).toBe('名流保健用品官方旗舰店')
    expect(await stopped(takeOverMerchant('p', ran({ ...pdd, platform: 'tmall' }), 'pinduoduo'))).toMatchObject({
      exitCode: EXIT.usage, message: '账号 p 不是拼多多商家账号（平台 tmall，类型 merchant），这个技能只能用拼多多商家账号。',
    })
    const path = process.env.PATH
    process.env.PATH = '/nowhere'
    try {
      await expect(pddDeps.takeOver('p')).rejects.toThrow('找不到 dsh-ecommerce 命令')
    } finally {
      process.env.PATH = path
    }
  })

  const run = async (mall: Mall, argv: string[], overrides = {}) => {
    const deps = fakeDeps(mall.page(), { takeOver: id => Promise.resolve({ id, store: '名流保健用品官方旗舰店', account: 'x', cdpUrl: 'http://127.0.0.1:9' }), ...overrides })
    const code = await main(argv, deps)
    return { code, out: deps.out.join(''), err: deps.err.join('') }
  }

  it('resolves categories, lists children, and saves a category\'s rules', async () => {
    const mall = new Mall()
    const dir = await folder()
    expect((await run(mall, ['resolve', '--account', 'a', '--keyword', '避孕套'])).out).toBe([
      '1. 成人用品 > 计生用品 > 避孕套（类目 id 18770）—— 拼多多类目搜索「避孕套」', '这家店不能用（缺资质）：医疗器械 > 计划生育', '',
    ].join('\n'))
    expect((await run(mall, ['resolve', '--account', 'a', '--cat', '18770'])).out).toContain('（类目 id 18770）—— 用户指定的类目')
    const memory = {
      stores: {}, columns: {}, declarations: {},
      categories: { 水多多: { platform: 'pinduoduo', catId: '18770', categoryPath: 'x', updatedAt: '2026-10-08T14:00:00Z' }, 天猫线: { platform: 'tmall', catId: '1', categoryPath: 'y', updatedAt: 't' } },
    }
    const remembered = { memory: () => Promise.resolve(memory) }
    expect((await run(mall, ['resolve', '--account', 'a', '--line', '水多多'], remembered)).out).toContain('记住的产品线「水多多」类目（2026-10-08 22:00 北京时间保存）')
    expect((await run(mall, ['resolve', '--account', 'a', '--line', '天猫线'], remembered)).out).toBe('记住的产品线「天猫线」类目在 tmall（1），不是拼多多的。\n')
    expect((await run(mall, ['resolve', '--account', 'a', '--line', '无'], remembered)).out).toBe('DSH 里还没有记住产品线「无」的类目。\n')
    const image = join(dir, 'main.png')
    await writeFile(image, png(4, 4))
    expect((await run(mall, ['resolve', '--account', 'a', '--image', image, '--title', 't'])).out).toContain('拼多多按主图和标题推荐')
    expect(mall.sessions).toHaveLength(1)
    expect((await run(mall, ['resolve', '--account', 'a', '--image', join(dir, 'none.png')])).code).toBe(EXIT.usage)
    expect((await run(new Mall(), ['resolve', '--account', 'a', '--keyword', '无'], {})).code).toBe(0)
    expect((await run(mall, ['children', '--account', 'a', '--parent', '18768'])).out).toBe('- 避孕套（18770），可发布\n- 试纸（18769）\n')
    expect((await run(mall, ['children', '--account', 'a', '--parent', '1'])).out).toBe('类目 1 下面没有子类目。\n')
    const rules = await run(mall, ['rules', '--account', 'a', '--cat', '18770', '--out', dir])
    expect(rules.out).toContain('类目：成人用品 > 计生用品 > 避孕套（18770），共 13 个字段。')
    expect(rules.out).toContain('- 发货时间，可选：24小时、48小时')
    expect(JSON.parse(await readFile(join(dir, '字段规则_18770.json'), 'utf8'))).toMatchObject({ platform: 'pinduoduo', store: '名流保健用品官方旗舰店', catId: '18770' })
    expect(mall.sessions).toHaveLength(1)
  })

  it('names categories the store may not use', async () => {
    const page = () => new FakePage([on('__dshPdd', (e: string) => e.includes('search')
      ? ok({ cat_info_v2_lists: [{ cat_id_1: 1, cat_name_1: '医疗', optional: false }] })
      : ok({ id: 9, cat_id_1: 9, cat_id_1_name: '医疗', optional: false, cat_qualification_detail: { inValid: true } })), on('', true)])
    const deps = () => fakeDeps(page())
    const search = deps()
    expect(await main(['resolve', '--account', 'a', '--keyword', 'x'], search)).toBe(0)
    expect(search.out.join('')).toBe('这家店都不能在这些类目发布。\n这家店不能用（缺资质）：医疗\n')
    const empty = fakeDeps(new FakePage([on('__dshPdd', ok({ cat_info_v2_lists: [] })), on('', true)]))
    expect(await main(['resolve', '--account', 'a', '--keyword', 'x'], empty)).toBe(0)
    expect(empty.out.join('')).toBe('没有找到类目（拼多多类目搜索「x」）。\n')
  })

  const records = async (out: string) => JSON.parse(await readFile(join(out, '发品记录.json'), 'utf8')) as PublishRecord[]
  const save = (setup: { path: string; rules: string; out: string }, ...more: string[]) => [
    'save', '--account', 'a', '--draft', setup.path, '--rules', setup.rules, '--confirmed', '--stock', '1000', '--out', setup.out, ...more,
  ]

  it('saves a confirmed draft to the 草稿箱 and refuses to save it twice', async () => {
    const mall = new Mall()
    const setup = await sampleDraft()
    const saved = await run(mall, save(setup))
    expect(saved.code).toBe(0)
    expect(saved.out).toBe([
      '已保存到店铺 名流保健用品官方旗舰店 的草稿箱（没有提交上架）：草稿 ID 203110000，商品 ID 1013940001，标题「名流水多多玻尿酸三合一避孕套」。',
      `- 草稿箱：${PDD_GOODS_URL}（商品列表 →「草稿箱」）`,
      '请到拼多多后台草稿箱确认后再由用户自己提交发布。', '',
    ].join('\n'))
    expect(saved.err).toBe(['[2026-10-08 11:00] 新建编辑并选类目', '[2026-10-08 11:00] 上传 4 张图片', '[2026-10-08 11:00] 保存到草稿箱', ''].join('\n'))
    expect(mall.uploads).toEqual(['1.png', '2.png', '1.png', 'a.png'])
    expect(mall.saves[0]).toMatchObject({ goods_name: '名流水多多玻尿酸三合一避孕套', cat_id: 18770, goods_commit_id: '203110000' })
    expect((await records(setup.out)).map(record => [record.status, record.draftId, record.itemId])).toEqual([
      ['submitting', undefined, undefined], ['saved', '203110000', '1013940001'],
    ])
    const again = await run(mall, save(setup))
    expect(again.out).toContain('没有重复保存：店铺 名流保健用品官方旗舰店 里已有「名流水多多玻尿酸三合一避孕套」，ID 203110000（2026-10-08 11:00（北京时间）DSH 存过，仍在草稿箱）。')
    expect(mall.saves).toHaveLength(1)
    const checked = await run(mall, ['check', '--account', 'a', '--draft', setup.path, '--out', setup.out])
    expect(checked.out).toContain('ID 203110000（2026-10-08 11:00（北京时间）DSH 存过，仍在草稿箱）')
  })

  it('finds the same product among drafts and goods by title, and says when there is none', async () => {
    const mall = new Mall()
    const setup = await sampleDraft()
    expect((await run(mall, ['check', '--account', 'a', '--draft', setup.path, '--out', setup.out])).out).toBe(
      '店铺 名流保健用品官方旗舰店 的草稿箱和商品列表里都没有「名流水多多玻尿酸三合一避孕套」，DSH 也没有存过它。\n',
    )
    mall.drafts.push({ draftId: '1', goodsId: '2', title: '名流水多多玻尿酸三合一避孕套' })
    expect((await run(mall, ['check', '--account', 'a', '--draft', setup.path, '--out', setup.out])).out).toContain('ID 1（草稿箱里已有同名草稿）')
    mall.drafts.pop()
    await mkdir(setup.out, { recursive: true })
    const earlier: PublishRecord = { store: '名流保健用品官方旗舰店', title: '旧标题', catId: '18770', codes: ['mldx238a', 'mldx238b'], status: 'saved', itemId: '77', draftId: '3', at: 't' }
    await writeFile(join(setup.out, '发品记录.json'), JSON.stringify([earlier]))
    mall.goods = [{ goodsId: '77', title: '旧标题' }]
    expect((await run(mall, ['check', '--account', 'a', '--draft', setup.path, '--out', setup.out])).out).toContain('ID 77（商品列表里已有这件商品）')
    const untitled = await sampleDraft({ values: {} })
    expect((await run(mall, ['check', '--account', 'a', '--draft', untitled.path])).code).toBe(EXIT.usage)
  })

  it('refuses a draft that is not ready, rules of another platform, and an unreadable draft', async () => {
    const mall = new Mall()
    const setup = await sampleDraft()
    const unready = await run(mall, ['save', '--account', 'a', '--draft', setup.path, '--rules', setup.rules, '--out', setup.out])
    expect(unready.err).toBe('还不能保存到草稿箱：\n- 缺失：每个 SKU 的库存（用 --stock 给出）\n')
    const priced = await sampleDraft({ checks: CHECKS.filter(check => check.key !== 'marketPrice') })
    expect((await run(mall, save(priced))).err).toBe('还不能保存到草稿箱：\n- 不符合：参考价（元）应高于最高的单买价 74.90\n')
    const tmall = join(setup.dir, 'tmall.json')
    await writeFile(tmall, JSON.stringify(RULES))
    expect((await run(mall, ['save', '--account', 'a', '--draft', setup.path, '--rules', tmall, '--confirmed', '--stock', '1'])).err).toContain('不是拼多多的字段规则')
    expect((await run(mall, ['check', '--account', 'a', '--draft', join(setup.dir, 'none.json')])).err).toContain('读不到商品草稿')
    const { checks: _checks, ...unchecked } = JSON.parse(await readFile(setup.path, 'utf8')) as DraftFile
    await writeFile(setup.path, JSON.stringify(unchecked))
    expect((await run(mall, save(setup))).err).toContain('商品草稿没有按类目 18770 的字段规则检查过')
    expect((await run(mall, ['publish', '--account', 'a'])).code).toBe(EXIT.usage)
    expect((await run(mall, [])).err).toContain('缺少或认不出子命令：（无）')
    expect(mall.saves).toHaveLength(0)
  })

  it('records a refusal as failed, a lost answer as unknown, and saves again only after the user checked', async () => {
    const mall = new Mall()
    const setup = await sampleDraft()
    mall.saving = 'refused'
    expect((await run(mall, save(setup))).err).toContain('拼多多接口 /glide/mms/goodsCommit/action/edit 拒绝了请求（价格参数不完整）。\n')
    expect((await records(setup.out)).at(-1)).toMatchObject({ status: 'failed', draftId: '203110000' })
    mall.saving = 'lost'
    expect((await run(mall, save(setup))).err).toContain('保存后没有拿到拼多多的答复（Network Error），结果不明。不要重试，先运行 check 查店里。')
    expect((await records(setup.out)).at(-1)).toMatchObject({ status: 'unknown' })
    mall.saving = 'drafts'
    const refused = await run(mall, save(setup))
    expect([refused.code, refused.err]).toEqual([EXIT.usage, expect.stringContaining('那次保存结果不明，店里暂时查不到它') as string])
    expect((await run(mall, ['check', '--account', 'a', '--draft', setup.path, '--out', setup.out])).out).toContain('注意：')
    expect((await run(mall, save(setup, '--unknown-checked'))).code).toBe(0)
  })

  it('takes the stock from the SKU table when it has one', async () => {
    const mall = new Mall()
    const { path } = await sampleDraft()
    const draft = JSON.parse(await readFile(path, 'utf8')) as DraftFile
    const setup = await sampleDraft({ skus: draft.skus.map((sku, at) => ({ ...sku, stock: 10 + at })) })
    expect((await run(mall, ['save', '--account', 'a', '--draft', setup.path, '--rules', setup.rules, '--confirmed', '--out', setup.out])).code).toBe(0)
    expect(mall.saves[0]?.skus).toEqual([expect.objectContaining({ quantity_delta: 10 }), expect.objectContaining({ quantity_delta: 11 })])
  })

  it('records a draft the 草稿箱 does not list as unknown, and a failure before saving as failed', async () => {
    const mall = new Mall()
    const setup = await sampleDraft()
    mall.saving = 'nowhere'
    expect((await run(mall, save(setup))).err).toContain('拼多多答复已保存（草稿 ID 203110000），但草稿箱里暂时查不到它。')
    expect((await records(setup.out)).at(-1)).toMatchObject({ status: 'unknown', draftId: '203110000' })
    const bad = await sampleDraft({ images: { main: ['方图/1.png'], main34: [], white: [], transparent: [], detail: ['bad.png'], sku: [], other: [], unknown: [] } })
    await writeFile(join(bad.dir, 'bad.png'), png(2, 2))
    const failed = await run(new Mall(), save(bad))
    expect(failed.err).toContain('上传图片 bad.png 失败（图片违规）。')
    expect((await records(bad.out)).map(record => record.status)).toEqual(['submitting', 'failed'])
  })

  it('stops on a signed-out account and reports other failures', async () => {
    const mall = new Mall()
    mall.signedOut = true
    const setup = await sampleDraft()
    expect((await run(mall, ['check', '--account', 'a', '--draft', setup.path])).code).toBe(EXIT.signedOut)
    expect((await run(mall, ['rules', '--account', 'a', '--cat', '18770'])).code).toBe(EXIT.signedOut)
    const broken = await run(new Mall(), ['rules', '--account', 'a', '--cat', '1'], { openPage: () => Promise.reject(new Error('CDP 断开')) })
    expect(broken.err).toBe('失败：CDP 断开\n')
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- a non-Error rejection is the scenario under test.
    const odd = await run(new Mall(), ['rules', '--account', 'a', '--cat', '1'], { takeOver: () => Promise.reject('down') })
    expect(odd.err).toBe('失败：down\n')
  })
})
