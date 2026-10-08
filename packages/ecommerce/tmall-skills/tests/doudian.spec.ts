import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { takeOverMerchant, type EcommerceCommandResult } from '../src/account.ts'
import type { FieldCheck } from '../src/draft.ts'
import { doudianDeps, main, parseCategoryOptions } from '../src/doudian-cli.ts'
import {
  categoryById, categoryOfLine, childCategories, doudianRules, openedTops, predictCategories, READ_FORM, readForm, searchCategories,
  type DoudianForm,
} from '../src/doudian-category.ts'
import {
  extras, findProducts, formValues, listDrafts, onSale, saveDraft, uploadDoudianImage,
} from '../src/doudian-publish.ts'
import { createUrl, DOUDIAN_CREATE_URL, DOUDIAN_DRAFTS_URL, doudianCall, DoudianRefusal, FIND_STORE, GUARD, isDoudianSignIn, openDoudian } from '../src/doudian.ts'
import { EXIT, SkillError } from '../src/errors.ts'
import type { DraftFile, PublishRecord } from '../src/publish-common.ts'
import type { PublishRules } from '../src/publish-rules.ts'
import { jpeg, png } from './images.ts'
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

const ok = (data: unknown, total?: number) => ({ code: 0, msg: '', data, ...total === undefined ? {} : { total } })

/** The 避孕套 (1000000638) form, trimmed. */
const FORM: DoudianForm = {
  properties: [
    { id: '1687', label: '品牌', required: true, options: [{ value_id: '1275155012', value_name: '名流', additions: { brand_cn_name: '名流' } }] },
    { id: '3990', label: '医疗器械备案/注册号', required: true },
    { id: '4613', label: '器械所属分类', required: true, options: [{ value_id: '223755', value_name: '二类' }] },
    { id: '4100', label: '功效', required: false, options: [{ value_id: '1', value_name: '超薄' }, { value_id: '2', value_name: '润滑' }], additions: { ui_type: 'multi_select' } },
  ],
  qualifications: [
    { id: '699', label: '医疗器械注册证', required: true, options: [{ value: '767', label: '医疗器械注册证_20260817_112810', urls: ['https://img/q1.png'] }] },
    { id: '694', label: '赠品资质', required: false, options: [] },
  ],
  freight: [{ label: '偏远地区不包邮模板', value: '4068008546' }, { label: '包邮', value: '0' }],
  delivery: [{ label: '次日发', value: '1' }, { label: '48小时', value: '2' }],
  proofTypes: [{ label: '官网零售价', value: '4' }, { label: '吊牌价', value: '2' }],
}

const LINE = { first_cid: 1000000480, second_cid: 1000000495, third_cid: 1000000638, fourth_cid: 0, first_name: '医疗器械及保健用品', second_name: '计生用品', third_name: '避孕套' }

/** The Douyin shop backend as its seller pages call it. */
class Shop {
  products: { product_id: string; name: string; draft_status: number; status: number; check_status: number }[] = [
    { product_id: '3837442346664984946', name: '名流天使玻尿酸避孕套', draft_status: 1, status: 0, check_status: 1 },
  ]
  readonly uploads: string[] = []
  readonly saves: { first: Record<string, unknown>; second: Record<string, unknown> }[] = []
  /** What the page's own save does. */
  saving: 'drafts' | 'on-sale' | 'nowhere' | 'refused' | 'silent' | 'lost' | 'not-off-sale' | 'needs-weight' | 'dropped' = 'drafts'
  signedOut = false
  hasStore = true
  /** Polls a prediction takes. */
  predictPolls = 1

  routes(): Route[] {
    return [
      expression => expression === FIND_STORE ? this.hasStore : undefined,
      expression => expression === GUARD ? true : undefined,
      on('__dshGoodsStore.publishId', '1949'),
      expression => expression === READ_FORM ? (this.hasStore ? FORM : null) : undefined,
      on("document.readyState === 'complete'", true),
      on('batchupload', (expression: string) => {
        const name = JSON.parse(/new Blob\(\[bytes\]\), ("[^"]*")\)/u.exec(expression)?.[1] as string) as string
        this.uploads.push(name)
        return name.startsWith('bad') ? { code: 1, msg: '图片违规' } : ok([`https://p3-aio.ecombdimg.com/${name}`])
      }),
      on('publishStore.saveGoods', (expression: string) => {
        const literal = /Object\.entries\((\{.*?\})\)\) s\.form/su.exec(expression)?.[1] as string
        const first = JSON.parse(literal) as Record<string, unknown>
        const secondValues = JSON.parse(/const second = (\{.*?\})\n/su.exec(expression)?.[1] as string) as Record<string, unknown>
        this.saves.push({ first, second: secondValues })
        const id = `38471${String(this.saves.length).padStart(14, '0')}`
        switch (this.saving) {
          case 'not-off-sale': return { notOffSale: true }
          case 'needs-weight': return { needsWeight: true }
          case 'dropped': return { dropped: 'reference_price' }
          case 'refused': return { refused: '设置参考价时须提供相关凭证' }
          case 'silent': return {}
          case 'lost': return new Error('Network Error')
          case 'nowhere': return { product_id: id }
          default:
            this.products.unshift({ product_id: id, name: String(first.title), draft_status: this.saving === 'drafts' ? 1 : 0, status: 0, check_status: this.saving === 'drafts' ? 1 : 3 })
            return { product_id: id }
        }
      }),
      on('new XMLHttpRequest()', (expression: string) => {
        const [, method = '', literal = '""'] = /x\.open\("(\w+)", ("[^"]*") \+/u.exec(expression) ?? []
        const body = /x\.send\((.*)\)\n\}\)$/su.exec(expression)?.[1] ?? 'null'
        return this.answer(method, JSON.parse(literal) as string, body === 'null' ? undefined : JSON.parse(JSON.parse(body) as string) as Record<string, unknown>)
      }),
    ]
  }

  answer(method: string, path: string, body?: Record<string, unknown>): unknown {
    const [route = '', query = ''] = path.split('?')
    const params = new URLSearchParams(query)
    switch (`${method} ${route}`) {
      case 'GET /product/tproduct/categoryOptionsN':
        return ok(params.get('cid') === '0' ? [{ id: 1000000480, name: '医疗器械及保健用品', is_leaf: false }]
          : params.get('cid') === '1000000495' ? [{ id: 1000000638, name: '避孕套', is_leaf: true }, { id: 7, name: '更多', is_leaf: false }] : null)
      case 'GET /product/tproduct/searchCategoryN':
        return ok([LINE, { first_cid: 1000005784, second_cid: 1000005794, third_cid: 1000005946, first_name: '母婴用品', second_name: '孕产妇用品', third_name: '待产用品' }, { first_cid: 0 }])
      case 'GET /product/tproduct/getCategoryDetail':
        return ok(params.get('category_leaf_ids') === '1000000638'
          ? [{ first_cid: 1000000480, second_cid: 1000000495, third_cid: 1000000638, fourth_cid: 0, first_cname: '医疗器械及保健用品', second_cname: '计生用品', third_cname: '避孕套' }]
          : params.get('category_leaf_ids') === '9' ? [{ first_cid: 9, first_cname: '药品' }] : [])
      case 'POST /product/tproduct/predictCategoryN': {
        if (body?.async_task_id === undefined) return ok({ async_task_id: 't1', async_task_status: 'init', candidate_category_details: null })
        this.predictPolls -= 1
        return ok(this.predictPolls > 0 ? { async_task_status: 'running', candidate_category_details: null } : { async_task_status: 'success', candidate_category_details: [LINE, { first_cid: 0 }] })
      }
      case 'GET /product/tproduct/list': {
        const query = params.get('product_id_and_name')
        let rows = this.products
        if (params.get('is_drafting') === '1') rows = rows.filter(row => row.draft_status === 1)
        if (params.get('check_status') === '3') rows = rows.filter(row => row.check_status === 3)
        if (query !== null) rows = rows.filter(row => row.product_id === query || row.name.includes(query))
        const at = Number(params.get('page'))
        return ok(rows.slice(at * 50, at * 50 + 50))
      }
      default: return { code: 10_004, msg: `no route ${route}` }
    }
  }

  page(): FakePage {
    return new FakePage(this.routes(), (_url, tab) => { if (this.signedOut) tab.href = 'https://fxg.jinritemai.com/login/common' })
  }
}

const filled = (key: string, label: string, values: readonly string[], status: FieldCheck['status'] = '已填'): FieldCheck => ({
  key, label, required: true, status, value: values.join('、'), filled: values,
})

const RULES: PublishRules = doudianRules('1000000638', ['医疗器械及保健用品', '计生用品', '避孕套'], FORM)

const CHECKS: FieldCheck[] = [
  filled('title', '商品标题', ['名流水多多三合一玻尿酸避孕套'], '已确认'),
  filled('mainImagesGroup', '主图', ['2 张']),
  filled('descRepublicOfSell', '商品详情', ['1 张']),
  filled('p-1687', '品牌', ['名流']),
  filled('p-3990', '医疗器械备案/注册号', ['皖械注准20182180006']),
  filled('p-4613', '器械所属分类', ['二类']),
  filled('p-4100', '功效', ['超薄', '润滑']),
  filled('q-699', '资质：医疗器械注册证', ['医疗器械注册证_20260817_112810']),
  filled('sku', '商品规格', ['2 个 SKU']),
  { key: 'quantity', label: '库存', required: true, status: '缺失' },
  filled('freight', '运费模板', ['包邮']),
  filled('delivery', '现货发货时间', ['48小时']),
  filled('weight', '商品重量（克）', ['50克']),
  filled('referencePrice', '参考价（元）', ['99.9']),
  filled('referenceProofType', '参考价凭证类型', ['吊牌价']),
  filled('referenceProof', '参考价凭证图（素材文件）', ['素材图/吊牌.jpeg']),
]

async function sampleDraft(overrides: Partial<DraftFile> = {}): Promise<{ dir: string; path: string; rules: string; out: string }> {
  const dir = await folder()
  for (const file of ['方图/1.png', '方图/2.png', '详情页/1.png', 'sku图/a.png', '素材图/吊牌.jpeg']) {
    await mkdir(dirname(join(dir, file)), { recursive: true })
    await writeFile(join(dir, file), file.endsWith('.jpeg') ? jpeg(20, 20) : png(20, 20))
  }
  const draft: DraftFile = {
    folder: dir,
    images: { main: ['方图/1.png', '方图/2.png'], main34: [], white: [], transparent: [], detail: ['详情页/1.png'], sku: ['sku图/a.png'], other: ['素材图/吊牌.jpeg'], unknown: [] },
    skus: [
      { index: 'SKU1', name: '1盒【到手18只】', code: 'mldx238a', count: 18, price: 42.9, image: 'sku图/a.png' },
      { index: 'SKU2', name: '2盒【到手40只】', code: 'mldx238b', count: 40, price: 69.9 },
    ],
    values: { 商品标题: { value: '名流水多多三合一玻尿酸避孕套', source: '模型生成' } },
    missing: [], problems: [], notes: [], catId: '1000000638', checks: CHECKS,
    ...overrides,
  }
  const path = join(dir, '商品草稿.json')
  await writeFile(path, JSON.stringify(draft))
  const rules = join(dir, '字段规则_1000000638.json')
  await writeFile(rules, JSON.stringify({ platform: 'doudian', ...RULES }))
  return { dir, path, rules, out: join(dir, '抖店发品') }
}

describe('Douyin shop pages', () => {
  it('opens a seller page once it is ready, and stops on the sign-in page', async () => {
    const shop = new Shop()
    const page = shop.page()
    await openDoudian(page, DOUDIAN_DRAFTS_URL)
    expect(page.visited).toEqual([DOUDIAN_DRAFTS_URL])
    await openDoudian(page, createUrl('1000000638'), FIND_STORE)
    expect(page.visited.at(-1)).toBe('https://fxg.jinritemai.com/ffa/g/create?category_leaf_id=1000000638')
    shop.signedOut = true
    expect((await stopped(openDoudian(shop.page(), DOUDIAN_DRAFTS_URL))).exitCode).toBe(EXIT.signedOut)
    expect((await stopped(openDoudian(new FakePage([on('', false)]), DOUDIAN_CREATE_URL))).message).toContain('打不开或已改版')
    expect(isDoudianSignIn('https://fxg.jinritemai.com/login/common')).toBe(true)
  })

  it('answers a call result and names a refusal', async () => {
    const page = new FakePage([on('XMLHttpRequest', (e: string) => e.includes('/a') ? ok(1, 3) : e.includes('/b') ? { code: 10_004, msg: '请选择商品' }
      : e.includes('/c') ? { code: 3, msg: '请重新登录' } : e.includes('/d') ? { code: 3 } : e.includes('/e') ? { unanswered: 'HTTP 502' } : null)])
    expect(await doudianCall(page, 'GET', '/a?x=1')).toBe(1)
    expect(await stopped(doudianCall(page, 'POST', '/b', { a: 1 }))).toBeInstanceOf(DoudianRefusal)
    expect((await stopped(doudianCall(page, 'POST', '/b', {}))).message).toBe('抖店接口 /b 拒绝了请求（请选择商品）。')
    expect((await stopped(doudianCall(page, 'GET', '/c'))).exitCode).toBe(EXIT.signedOut)
    expect((await stopped(doudianCall(page, 'GET', '/d'))).message).toContain('（无应答）')
    expect((await stopped(doudianCall(page, 'GET', '/e'))).message).toBe('抖店接口 /e 没有给出可读的答复（HTTP 502）。')
    expect((await stopped(doudianCall(page, 'GET', '/f'))).message).toBe('抖店接口 /f 没有给出可读的答复（无应答）。')
    expect(await doudianCall(new FakePage([on('XMLHttpRequest', { code: 0 })]), 'GET', '/g')).toBeUndefined()
  })
})

describe('Douyin shop categories', () => {
  it('reads category lines against the opened top-level categories', () => {
    const opened = new Set(['1000000480'])
    expect(categoryOfLine(LINE, opened)).toEqual({ id: '1000000638', path: ['医疗器械及保健用品', '计生用品', '避孕套'], usable: true })
    expect(categoryOfLine({ first_cid: 2, first_cname: '药品' }, opened)).toEqual({ id: '2', path: ['药品'], usable: false })
    expect(categoryOfLine({ first_cid: 3, second_cid: 4 }, opened)?.path).toEqual(['', ''])
    expect(categoryOfLine({ first_cid: 0 }, opened)).toBeUndefined()
  })

  it('searches, walks, reads, and predicts categories', async () => {
    const shop = new Shop()
    const page = shop.page()
    expect(await openedTops(page)).toEqual(new Set(['1000000480']))
    expect(await childCategories(page, '1000000495')).toEqual([{ id: '1000000638', name: '避孕套', leaf: true }, { id: '7', name: '更多', leaf: false }])
    expect(await childCategories(page, '1')).toEqual([])
    expect((await searchCategories(page, '避孕套')).map(category => [category.id, category.usable])).toEqual([['1000000638', true], ['1000005946', false]])
    expect(await categoryById(page, '1000000638')).toEqual({ id: '1000000638', path: ['医疗器械及保健用品', '计生用品', '避孕套'], usable: true })
    expect((await stopped(categoryById(page, '1'))).exitCode).toBe(EXIT.usage)
    shop.predictPolls = 2
    const polling = new FakePage([on('publishId', '1949'), ...shop.routes()])
    polling.waitFor = async (condition) => { for (let i = 0; i < 3; i++) if (await condition()) return true; return false }
    expect((await predictCategories(polling, 'u', 't')).map(category => category.id)).toEqual(['1000000638'])
    const stuck = new FakePage([on('publishId', null), on('predictCategoryN', ok({ async_task_id: 't', async_task_status: 'running' })), ...shop.routes()])
    expect((await stopped(predictCategories(stuck, 'u', 't'))).message).toContain('超时')
    const direct = new FakePage([on('publishId', '1'), on('predictCategoryN', ok({ candidate_category_details: [LINE] })), ...shop.routes()])
    expect(await predictCategories(direct, 'u', 't')).toHaveLength(1)
    const failed = new FakePage([on('publishId', '1'), on('predictCategoryN', (e: string) => ok(e.includes('async_task_id')
      ? { async_task_status: 'failed' } : { async_task_id: 't' })), ...shop.routes()])
    expect(await predictCategories(failed, 'u', 't')).toEqual([])
    const blank = new FakePage([on('XMLHttpRequest', ok(null))])
    expect(await searchCategories(blank, 'x')).toEqual([])
    expect(await childCategories(blank, '0')).toEqual([])
  })

  it('reads the form and writes it as field rules', async () => {
    const shop = new Shop()
    expect(await readForm(shop.page())).toEqual(FORM)
    shop.hasStore = false
    expect((await stopped(readForm(shop.page()))).message).toContain('没有给出表单')
    expect(RULES.fields.map(field => [field.key, field.uiType, field.required])).toEqual([
      ['title', 'input', true], ['mainImagesGroup', 'image', true], ['descRepublicOfSell', 'image', true],
      ['p-1687', 'select', true], ['p-3990', 'input', true], ['p-4613', 'select', true], ['p-4100', 'checkbox', false],
      ['q-699', 'select', true], ['sku', 'sku', true], ['quantity', 'input', true], ['freight', 'select', true], ['delivery', 'radio', true],
      ['weight', 'input', false], ['referencePrice', 'input', false], ['referenceProofType', 'select', false], ['referenceProof', 'input', false],
    ])
    expect(RULES.fields.find(field => field.key === 'q-699')?.options).toEqual([{ value: '767', text: '医疗器械注册证_20260817_112810' }])
    expect(RULES.fields.find(field => field.key === 'title')?.maxLength).toBe(120)
  })
})

describe('Douyin shop form', () => {
  it('reads the weight and the reference price with its proof', () => {
    expect(extras(CHECKS, [42.9, 69.9], RULES)).toEqual({ weightGrams: 50, referencePrice: 99.9, proofType: '2', proofFile: '素材图/吊牌.jpeg' })
    expect(extras([], [10], RULES)).toEqual({})
    expect(extras([filled('weight', 'w', ['0']), filled('referencePrice', 'r', ['5'])], [10], RULES)).toEqual({ problems: [
      '商品重量（克）应是大于 0 的数', '参考价（元）应不低于最高售价 10.00，且低于它的 10 倍',
      '设置参考价时，抖店要求同时给出参考价凭证类型和凭证图（素材文件）；不设参考价就把它去掉',
    ] })
    expect(extras([filled('referencePrice', 'r', ['100'])], [10], RULES)).toMatchObject({ problems: [expect.stringContaining('低于它的 10 倍'), expect.stringContaining('凭证')] })
  })

  it('sets the draft into the form in two passes, 下架', async () => {
    const { path } = await sampleDraft()
    const draft = JSON.parse(await readFile(path, 'utf8')) as DraftFile
    const images = { '方图/1.png': 'u1', '方图/2.png': 'u2', '详情页/1.png': 'd1', 'sku图/a.png': 's1', '素材图/吊牌.jpeg': 'p1' }
    const values = formValues({ draft, checks: CHECKS, rules: RULES, form: FORM, images, extras: { weightGrams: 50, referencePrice: 99.9, proofType: '2', proofFile: '素材图/吊牌.jpeg' }, stock: 1000, idBase: 100 })
    expect(values.first).toEqual({
      pic: [{ url: 'u1' }, { url: 'u2' }], title: '名流水多多三合一玻尿酸避孕套',
      category_properties: {
        1687: [{ diy_type: 0, measure_info: null, tags: { brand_cn_name: '名流' }, value_id: '1275155012', value_name: '名流' }],
        3990: [{ diy_type: 0, measure_info: null, tags: null, value_id: '', value_name: '皖械注准20182180006' }],
        4613: [{ diy_type: 0, measure_info: null, tags: null, value_id: '223755', value_name: '二类' }],
        4100: [{ diy_type: 0, measure_info: null, tags: null, value_id: '1', value_name: '超薄' }, { diy_type: 0, measure_info: null, tags: null, value_id: '2', value_name: '润滑' }],
      },
      qualification: { 699: { select_attachments: [{
        quality_attachment_id: '767', quality_attachments: [{ media_type: 1, url: 'https://img/q1.png' }], quality_content_name: '医疗器械注册证_20260817_112810', quality_key: '699', quality_name: '医疗器械注册证',
      }] } },
      spec_detail: [{ id: '100', name: '规格', spec_values: [{ id: '101', img_url: 's1', name: '1盒【到手18只】' }, { id: '102', img_url: 'u1', name: '2盒【到手40只】' }] }],
      sku_detail: [
        { id: '101', code: 'mldx238a', price: '42.90', sku_status: true, spec_detail_ids: ['101'], stock_info: { stock_inc_num: 0, stock_num: 1000, use_cargo_stock: false } },
        { id: '102', code: 'mldx238b', price: '69.90', sku_status: true, spec_detail_ids: ['102'], stock_info: { stock_inc_num: 0, stock_num: 1000, use_cargo_stock: false } },
      ],
      description: '<p><img src="d1" style="max-width:100%;"/></p>', freight_id: '0', delivery_delay_day: '2', reference_price_enable: true, start_sale_type: '1',
    })
    expect(values.second).toEqual({ weight_unit: '1', weight_value: '50', reference_price: '99.90', reference_price_certificate_type: '2', reference_price_certificate_urls: ['p1'] })
    const bare = formValues({
      draft: { ...draft, skus: [{ index: '1', name: 'a', price: 1, stock: 3 }] }, checks: [filled('q-699', 'q', ['别的资质'])], rules: { ...RULES, fields: [] }, form: FORM, images, extras: {}, stock: 0, idBase: 1,
    })
    expect(bare.first).toMatchObject({ category_properties: {}, qualification: {}, reference_price_enable: false, sku_detail: [{ code: '', stock_info: { stock_num: 3 } }] })
    expect(bare.first.freight_id).toBeUndefined()
    expect(bare.second).toEqual({})
  })

  it('uploads images, saves through the page store, and lists drafts and products', async () => {
    const shop = new Shop()
    const page = shop.page()
    expect(await uploadDoudianImage(page, png(2, 2), 'a.png')).toBe('https://p3-aio.ecombdimg.com/a.png')
    expect((await stopped(uploadDoudianImage(page, png(2, 2), 'bad.png'))).message).toBe('上传图片 bad.png 失败（图片违规）。')
    expect((await stopped(uploadDoudianImage(new FakePage([on('batchupload', {})]), png(2, 2), 'c.png'))).message).toContain('（无应答）')
    const values = { first: { title: 't', start_sale_type: '1' }, second: {} }
    expect(await saveDraft(page, values)).toBe('3847100000000000001')
    shop.hasStore = false
    expect((await stopped(saveDraft(shop.page(), values))).message).toContain('没有给出表单')
    expect(await listDrafts(page)).toEqual([
      { productId: '3847100000000000001', title: 't', draftStatus: 1, status: 0 }, { productId: '3837442346664984946', title: '名流天使玻尿酸避孕套', draftStatus: 1, status: 0 },
    ])
    shop.products = Array.from({ length: 60 }, (_, at) => ({ product_id: String(at), name: 'x', draft_status: 1, status: 0, check_status: 1 }))
    expect(await listDrafts(page)).toHaveLength(60)
    expect(await listDrafts(page, 50)).toHaveLength(50)
    expect(await findProducts(page, '7')).toEqual([{ productId: '7', title: 'x', draftStatus: 1, status: 0 }])
    expect(await onSale(page, '7')).toEqual([])
    const sparse = new FakePage([on('XMLHttpRequest', ok([{ product_id: '1', name: 'y' }]))])
    expect(await findProducts(sparse, 'y')).toEqual([{ productId: '1', title: 'y', draftStatus: 0, status: 0 }])
    expect(await listDrafts(new FakePage([on('XMLHttpRequest', ok(null))]))).toEqual([])
    expect(await findProducts(new FakePage([on('XMLHttpRequest', ok(null))]), 'y')).toEqual([])
    expect(await onSale(new FakePage([on('XMLHttpRequest', ok(null))]), 'y')).toEqual([])
  })
})

describe('doudian-publish script', () => {
  it('reads category command lines', () => {
    expect(parseCategoryOptions(['resolve', '--account', 'a', '--keyword', '避孕套'])).toEqual({ command: 'resolve', account: 'a', source: { kind: 'keyword', keyword: '避孕套' } })
    expect(parseCategoryOptions(['resolve', '--account', 'a', '--line', '水多多'])).toMatchObject({ source: { kind: 'line' } })
    expect(parseCategoryOptions(['resolve', '--account', 'a', '--keyword', '', '--cat', '1000000638'])).toMatchObject({ source: { kind: 'id', id: '1000000638' } })
    expect(parseCategoryOptions(['resolve', '--account', 'a', '--image', 'a.png'])).toMatchObject({ source: { kind: 'image', image: 'a.png', title: '' } })
    expect(parseCategoryOptions(['resolve', '--account', 'a', '--image', 'a.png', '--title', 't'])).toMatchObject({ source: { title: 't' } })
    expect(parseCategoryOptions(['children', '--account', 'a'])).toEqual({ command: 'children', account: 'a', parent: '0' })
    expect(parseCategoryOptions(['children', '--account', 'a', '--parent', '1000000495'])).toMatchObject({ parent: '1000000495' })
    expect(parseCategoryOptions(['rules', '--account', 'a', '--cat', '1'])).toEqual({ command: 'rules', account: 'a', catId: '1', out: '抖店发品' })
    expect(parseCategoryOptions(['rules', '--account', 'a', '--cat', '1', '--out', 'o'])).toMatchObject({ out: 'o' })
    for (const argv of [
      ['resolve', '--bogus'], ['resolve'], ['resolve', '--account', ''], ['resolve', '--account', 'a'], ['resolve', '--account', 'a', '--keyword', 'x', '--line', 'y'],
      ['resolve', '--account', 'a', '--cat', 'x'], ['rules', '--account', 'a'], ['children', '--account', 'a', '--parent', 'x'],
    ]) {
      expect(() => parseCategoryOptions(argv), argv.join(' ')).toThrow(expect.objectContaining({ exitCode: EXIT.usage }) as Error)
    }
  })

  it('takes over Douyin shop merchant accounts only', async () => {
    const ran = (stdout: object) => (): Promise<EcommerceCommandResult> => Promise.resolve({ code: 0, stdout: JSON.stringify(stdout), stderr: '' })
    const shop = { id: 'd', platform: 'doudian', kind: 'merchant', store: '名流欣屹专卖店', account: 'x', cdpUrl: 'http://127.0.0.1:9' }
    expect((await takeOverMerchant('d', ran(shop), 'doudian')).store).toBe('名流欣屹专卖店')
    expect((await stopped(takeOverMerchant('d', ran({ ...shop, platform: 'pinduoduo' }), 'doudian'))).message).toContain('不是抖店商家账号')
    const path = process.env.PATH
    process.env.PATH = '/nowhere'
    try {
      await expect(doudianDeps.takeOver('d')).rejects.toThrow('找不到 dsh-ecommerce 命令')
    } finally {
      process.env.PATH = path
    }
  })

  const run = async (shop: Shop, argv: string[], overrides = {}) => {
    const deps = fakeDeps(shop.page(), { takeOver: id => Promise.resolve({ id, store: '名流欣屹专卖店', account: 'x', cdpUrl: 'http://127.0.0.1:9' }), ...overrides })
    const code = await main(argv, deps)
    return { code, out: deps.out.join(''), err: deps.err.join('') }
  }

  it('resolves categories, lists children, and saves a category\'s rules', async () => {
    const shop = new Shop()
    const dir = await folder()
    expect((await run(shop, ['resolve', '--account', 'a', '--keyword', '避孕套'])).out).toBe([
      '1. 医疗器械及保健用品 > 计生用品 > 避孕套（类目 id 1000000638）—— 抖店类目搜索「避孕套」', '这家店没有开通：母婴用品 > 孕产妇用品 > 待产用品', '',
    ].join('\n'))
    expect((await run(shop, ['resolve', '--account', 'a', '--cat', '1000000638'])).out).toContain('—— 用户指定的类目')
    const memory = {
      stores: {}, columns: {}, declarations: {},
      categories: { 水多多: { platform: 'doudian', catId: '1000000638', categoryPath: 'x', updatedAt: '2026-10-08T14:00:00Z' }, 拼团: { platform: 'pinduoduo', catId: '18770', categoryPath: 'y', updatedAt: 't' } },
    }
    const remembered = { memory: () => Promise.resolve(memory) }
    expect((await run(shop, ['resolve', '--account', 'a', '--line', '水多多'], remembered)).out).toContain('（2026-10-08 22:00 北京时间保存）')
    expect((await run(shop, ['resolve', '--account', 'a', '--line', '拼团'], remembered)).out).toBe('记住的产品线「拼团」类目在 pinduoduo（18770），不是抖店的。\n')
    expect((await run(shop, ['resolve', '--account', 'a', '--line', '无'], remembered)).out).toBe('DSH 里还没有记住产品线「无」的类目。\n')
    const image = join(dir, 'main.png')
    await writeFile(image, png(4, 4))
    const predicting = new Shop()
    predicting.predictPolls = 0
    expect((await run(predicting, ['resolve', '--account', 'a', '--image', image, '--title', 't'])).out).toContain('抖店按主图和标题推荐')
    expect((await run(shop, ['resolve', '--account', 'a', '--image', join(dir, 'none.png')])).code).toBe(EXIT.usage)
    expect((await run(shop, ['children', '--account', 'a', '--parent', '1000000495'])).out).toBe('- 避孕套（1000000638），可发布\n- 更多（7）\n')
    expect((await run(shop, ['children', '--account', 'a', '--parent', '1'])).out).toBe('类目 1 下面没有这家店开通的子类目。\n')
    const rules = await run(shop, ['rules', '--account', 'a', '--cat', '1000000638', '--out', dir])
    expect(rules.out).toContain('类目：医疗器械及保健用品 > 计生用品 > 避孕套（1000000638），共 16 个字段。')
    expect(rules.out).toContain('- 运费模板，可选：偏远地区不包邮模板、包邮')
    const saved = JSON.parse(await readFile(join(dir, '字段规则_1000000638.json'), 'utf8')) as { platform: string; qualificationImages: object }
    expect(saved).toMatchObject({ platform: 'doudian', qualificationImages: { 医疗器械注册证_20260817_112810: ['https://img/q1.png'] } })
    expect((await run(shop, ['rules', '--account', 'a', '--cat', '9'])).err).toBe('这家店没有开通类目 9（药品）。\n')
  })

  it('names many unopened categories in short, and none at all', async () => {
    const many = (n: number) => new FakePage([on('searchCategoryN', ok(Array.from({ length: n }, (_, at) => ({ first_cid: 2, second_cid: at + 10, first_name: '药品', second_name: `药${String(at)}` })))), ...new Shop().routes()])
    const deps = fakeDeps(many(7))
    expect(await main(['resolve', '--account', 'a', '--keyword', 'x'], deps)).toBe(0)
    expect(deps.out.join('')).toBe('这家店都没有开通这些类目。\n这家店没有开通：药品 > 药0；药品 > 药1；药品 > 药2；药品 > 药3；药品 > 药4 等 7 个\n')
    const none = fakeDeps(many(0))
    expect(await main(['resolve', '--account', 'a', '--keyword', 'x'], none)).toBe(0)
    expect(none.out.join('')).toBe('没有找到类目（抖店类目搜索「x」）。\n')
  })

  it('shows at most six options of a long choice in the rules summary', async () => {
    const wide = { ...FORM, delivery: Array.from({ length: 8 }, (_, at) => ({ label: `选项${String(at)}`, value: String(at) })) }
    const page = new FakePage([expression => expression === READ_FORM ? wide : undefined, ...new Shop().routes()])
    const deps = fakeDeps(page)
    expect(await main(['rules', '--account', 'a', '--cat', '1000000638', '--out', await folder()], deps)).toBe(0)
    expect(deps.out.join('')).toContain('- 现货发货时间，可选（共 8 项，前 6 项）：选项0、选项1、选项2、选项3、选项4、选项5')
  })

  const records = async (out: string) => JSON.parse(await readFile(join(out, '发品记录.json'), 'utf8')) as PublishRecord[]
  const save = (setup: { path: string; rules: string; out: string }, ...more: string[]) => [
    'save', '--account', 'a', '--draft', setup.path, '--rules', setup.rules, '--confirmed', '--stock', '1000', '--out', setup.out, ...more,
  ]

  it('saves a confirmed draft to the 草稿箱 as 下架 and refuses to save it twice', async () => {
    const shop = new Shop()
    const setup = await sampleDraft()
    const saved = await run(shop, save(setup))
    expect(saved.code).toBe(0)
    expect(saved.out).toBe([
      '已保存到店铺 名流欣屹专卖店 的草稿箱（商品状态：下架，没有提交审核）：商品 ID 3847100000000000001，标题「名流水多多三合一玻尿酸避孕套」。',
      `- 草稿箱：${DOUDIAN_DRAFTS_URL}`, '请到抖店后台草稿箱确认后再由用户自己提交发布。', '',
    ].join('\n'))
    expect(saved.err).toBe(['[2026-10-08 11:00] 打开抖店发品页', '[2026-10-08 11:00] 上传 5 张图片', '[2026-10-08 11:00] 保存到草稿箱（商品状态：下架）', ''].join('\n'))
    expect(shop.uploads).toEqual(['1.png', '2.png', '1.png', 'a.png', '吊牌.jpg'])
    expect(shop.saves[0]?.first).toMatchObject({ start_sale_type: '1', freight_id: '0', title: '名流水多多三合一玻尿酸避孕套' })
    expect(shop.saves[0]?.second).toMatchObject({ reference_price: '99.90', reference_price_certificate_urls: ['https://p3-aio.ecombdimg.com/吊牌.jpg'] })
    expect((await records(setup.out)).map(record => [record.status, record.itemId])).toEqual([['submitting', undefined], ['saved', '3847100000000000001']])
    const again = await run(shop, save(setup))
    expect(again.out).toContain('没有重复保存：店铺 名流欣屹专卖店 里已有「名流水多多三合一玻尿酸避孕套」，商品 ID 3847100000000000001（2026-10-08 11:00（北京时间）DSH 存过，仍在店里）。')
    expect(shop.saves).toHaveLength(1)
    expect((await run(shop, ['check', '--account', 'a', '--draft', setup.path, '--out', setup.out])).out).toContain('DSH 存过，仍在店里')
  })

  it('saves without a reference price, taking the stock from the SKU table', async () => {
    const shop = new Shop()
    const { path } = await sampleDraft()
    const skus = (JSON.parse(await readFile(path, 'utf8')) as DraftFile).skus.map(sku => ({ ...sku, stock: 9 }))
    const setup = await sampleDraft({ skus, checks: CHECKS.filter(check => !check.key.startsWith('reference')) })
    expect((await run(shop, ['save', '--account', 'a', '--draft', setup.path, '--rules', setup.rules, '--confirmed', '--out', setup.out])).code).toBe(0)
    expect(shop.saves[0]?.first).toMatchObject({ sku_detail: [{ stock_info: { stock_num: 9 } }, { stock_info: { stock_num: 9 } }] })
    expect(shop.uploads).not.toContain('吊牌.jpg')
    expect(shop.saves[0]?.first).toMatchObject({ reference_price_enable: false })
  })

  it('finds the same product by title among drafts and products, and says when there is none', async () => {
    const shop = new Shop()
    const setup = await sampleDraft()
    expect((await run(shop, ['check', '--account', 'a', '--draft', setup.path, '--out', setup.out])).out).toBe(
      '店铺 名流欣屹专卖店 的草稿箱和商品列表里都没有「名流水多多三合一玻尿酸避孕套」，DSH 也没有存过它。\n',
    )
    shop.products.push({ product_id: '5', name: '名流水多多三合一玻尿酸避孕套', draft_status: 1, status: 0, check_status: 1 })
    expect((await run(shop, ['check', '--account', 'a', '--draft', setup.path])).out).toContain('商品 ID 5（草稿箱里已有同名草稿）')
    shop.products.at(-1)!.draft_status = 0
    expect((await run(shop, ['check', '--account', 'a', '--draft', setup.path])).out).toContain('商品 ID 5（商品列表里已有同名商品）')
    await mkdir(setup.out, { recursive: true })
    const gone: PublishRecord = { store: '名流欣屹专卖店', title: '名流水多多三合一玻尿酸避孕套', catId: 'x', status: 'saved', itemId: '404', at: 't' }
    await writeFile(join(setup.out, '发品记录.json'), JSON.stringify([gone, { ...gone, itemId: undefined }]))
    expect((await run(shop, ['check', '--account', 'a', '--draft', setup.path, '--out', setup.out])).out).toContain('商品 ID 5')
    const untitled = await sampleDraft({ values: {} })
    expect((await run(shop, ['check', '--account', 'a', '--draft', untitled.path])).code).toBe(EXIT.usage)
  })

  it('refuses a draft that is not ready, rules of another platform, and an unreadable draft', async () => {
    const shop = new Shop()
    const setup = await sampleDraft()
    expect((await run(shop, ['save', '--account', 'a', '--draft', setup.path, '--rules', setup.rules, '--out', setup.out])).err).toBe(
      '还不能保存到草稿箱：\n- 缺失：每个 SKU 的库存（用 --stock 给出）\n',
    )
    const priced = await sampleDraft({ checks: CHECKS.filter(check => check.key !== 'referenceProof') })
    expect((await run(shop, save(priced))).err).toContain('不符合：设置参考价时，抖店要求同时给出参考价凭证类型和凭证图')
    const pdd = join(setup.dir, 'pdd.json')
    await writeFile(pdd, JSON.stringify({ platform: 'pinduoduo', ...RULES }))
    expect((await run(shop, ['save', '--account', 'a', '--draft', setup.path, '--rules', pdd, '--confirmed', '--stock', '1'])).err).toContain('不是抖店的字段规则')
    expect((await run(shop, ['check', '--account', 'a', '--draft', join(setup.dir, 'none.json')])).err).toContain('读不到商品草稿')
    expect((await run(shop, ['publish', '--account', 'a'])).code).toBe(EXIT.usage)
    expect((await run(shop, [])).err).toContain('缺少或认不出子命令：（无）')
    const { checks: _checks, ...unchecked } = JSON.parse(await readFile(setup.path, 'utf8')) as DraftFile
    await writeFile(setup.path, JSON.stringify(unchecked))
    expect((await run(shop, save(setup))).err).toContain('商品草稿没有按类目 1000000638 的字段规则检查过')
    expect(shop.saves).toHaveLength(0)
  })

  it('records a refusal or a form not ready as failed, a lost answer as unknown, and saves again only after the user checked', async () => {
    const shop = new Shop()
    const setup = await sampleDraft()
    for (const [saving, message] of [
      ['refused', '抖店没有保存草稿，原因：设置参考价时须提供相关凭证'], ['not-off-sale', '表单的商品状态不是「下架」，没有保存。'],
      ['needs-weight', '选的运费模板要按重量计费'], ['dropped', '抖店发品页没有接受 reference_price 的值'], ['silent', '抖店没有保存草稿，原因：无应答'],
    ] as const) {
      shop.saving = saving
      expect((await run(shop, save(setup))).err).toContain(message)
      expect((await records(setup.out)).at(-1)).toMatchObject({ status: 'failed' })
    }
    shop.saving = 'lost'
    expect((await run(shop, save(setup))).err).toContain('保存后没有拿到抖店的答复（Network Error），结果不明。')
    expect((await records(setup.out)).at(-1)).toMatchObject({ status: 'unknown' })
    shop.saving = 'drafts'
    expect((await run(shop, save(setup))).code).toBe(EXIT.usage)
    expect((await run(shop, ['check', '--account', 'a', '--draft', setup.path, '--out', setup.out])).out).toContain('注意：')
    expect((await run(shop, save(setup, '--unknown-checked'))).code).toBe(0)
  })

  it('reports a product on sale loudly, one nowhere as unknown, a failed lookup, and a failure before saving', async () => {
    const live = new Shop()
    live.saving = 'on-sale'
    const setup = await sampleDraft()
    expect((await run(live, save(setup))).err).toContain('放到了「售卖中」！请用户立即到抖店后台下架它。')
    expect((await records(setup.out)).at(-1)).toMatchObject({ status: 'on-sale' })
    const lost = new Shop()
    lost.saving = 'nowhere'
    const second = await sampleDraft()
    expect((await run(lost, save(second))).err).toContain('但草稿箱里暂时查不到它')
    expect((await records(second.out)).at(-1)).toMatchObject({ status: 'unknown', itemId: '3847100000000000001' })
    const flaky = new Shop()
    const third = await sampleDraft()
    const page = flaky.page()
    const lookup = { failing: false }
    const base = page.evaluate.bind(page)
    page.evaluate = <T>(expression: string) => {
      if (expression.includes('publishStore.saveGoods')) lookup.failing = true
      if (lookup.failing && expression.includes('status=0&check_status=3')) return Promise.resolve({ code: 3, msg: '系统繁忙' } as T)
      return base<T>(expression)
    }
    const deps = fakeDeps(page, { takeOver: id => Promise.resolve({ id, store: '名流欣屹专卖店', account: 'x', cdpUrl: 'h' }) })
    expect(await main(save(third), deps)).toBe(EXIT.failed)
    expect(deps.err.join('')).toContain('但核验时出错（抖店接口 /product/tproduct/list 拒绝了请求（系统繁忙）。）')
    const bad = await sampleDraft({ images: { main: ['方图/1.png'], main34: [], white: [], transparent: [], detail: ['bad.png'], sku: [], other: [], unknown: [] } })
    await writeFile(join(bad.dir, 'bad.png'), png(2, 2))
    expect((await run(new Shop(), save(bad))).err).toContain('上传图片 bad.png 失败（图片违规）。')
    expect((await records(bad.out)).map(record => record.status)).toEqual(['submitting', 'failed'])
  })

  it('stops on a signed-out account and reports other failures', async () => {
    const shop = new Shop()
    shop.signedOut = true
    const setup = await sampleDraft()
    expect((await run(shop, ['check', '--account', 'a', '--draft', setup.path])).code).toBe(EXIT.signedOut)
    expect((await run(shop, ['rules', '--account', 'a', '--cat', '1000000638'])).code).toBe(EXIT.signedOut)
    expect((await run(new Shop(), ['rules', '--account', 'a', '--cat', '1'], { openPage: () => Promise.reject(new Error('CDP 断开')) })).err).toBe('失败：CDP 断开\n')
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- a non-Error rejection is the scenario under test.
    expect((await run(new Shop(), ['rules', '--account', 'a', '--cat', '1'], { takeOver: () => Promise.reject('down') })).err).toBe('失败：down\n')
  })
})
