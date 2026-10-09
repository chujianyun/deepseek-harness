import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { FieldCheck } from '../src/draft.ts'
import { EXIT, SkillError } from '../src/errors.ts'
import { fitImage, readImage } from '../src/images.ts'
import { main } from '../src/publish-cli.ts'
import { blockers, parsePublishOptions, type DraftFile, type PublishRecord } from '../src/publish-common.ts'
import { MANAGER_URL } from '../src/publish-category.ts'
import { publishUrl, type FieldRule, type PublishRules } from '../src/publish-rules.ts'
import {
  buildForm, ensureFolder, FOLDER_NAME, folderImages, listed, MANAGER_ROWS, optionValue, readBase, readSubmitAnswer, submit, uploadImage,
  within,
  type PageBase, type Uploaded,
} from '../src/publish-submit.ts'
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

const rule = (field: Partial<FieldRule> & Pick<FieldRule, 'key' | 'label'>): FieldRule => ({ uiType: 'input', required: false, visible: true, ...field })

/** The 50024154 rules the form uses, trimmed. */
const RULES: PublishRules = {
  catId: '50024154', categoryPath: '计生用品 > 避孕套',
  fields: [
    rule({ key: 'title', label: '商品标题', required: true, maxLength: 60 }),
    rule({ key: 'shopping_title', label: '导购标题', maxLength: 50 }),
    rule({ key: 'tmSubTitle', label: '商品卖点', maxLength: 40 }),
    rule({ key: 'p-20000', label: '品牌', uiType: 'combobox', propGroup: 'keyProp', options: [{ value: 30111, text: '名流' }], allowsCustom: true }),
    rule({ key: 'p-122216608', label: '功能', uiType: 'checkbox', propGroup: 'bindProp', options: [{ value: 1, text: '超薄' }, { value: 2, text: '润滑' }] }),
    rule({ key: 'p-132644733', label: '注册证号', uiType: 'combobox', propGroup: 'itemProp', options: [{ value: 7, text: '粤械' }], allowsCustom: true }),
    rule({ key: 'p-168920851', label: '产品标准', propGroup: 'bindProp' }),
    rule({ key: 'p-9', label: '页面模板', propGroup: 'enhancedPageTemplate' }),
    rule({ key: 'personalUseConfirm', label: 'personalUseConfirm', uiType: 'checkbox', required: true, declaration: true, options: [{ value: '1', text: '确认个人可自行使用。' }] }),
    rule({ key: 'productConfirm', label: '产品确认', uiType: 'checkbox', required: true, declaration: true }),
    rule({ key: 'tmDeliveryTime', label: '发货时间', required: true, options: [{ value: 2, text: '48小时' }] }),
    rule({ key: 'auctionPoint', label: '返点比例', required: true }),
    rule({ key: 'quantity', label: '商品数量', required: true }),
    rule({ key: 'shelfTime', label: '上架时间', required: true, options: [{ value: 2, text: '放入仓库' }] }),
  ],
}

const filled = (key: string, label: string, values: readonly string[], status: FieldCheck['status'] = '已填'): FieldCheck => ({
  key, label, required: true, status, value: values.join('、'), filled: values,
})

const CHECKS: FieldCheck[] = [
  filled('title', '商品标题', ['名流水多多玻尿酸3合1避孕套'], '已确认'),
  filled('shopping_title', '导购标题', ['水多多 超薄超润'], '已确认'),
  filled('tmSubTitle', '商品卖点', ['1200mg玻尿酸'], '已确认'),
  filled('p-20000', '品牌', ['名流']),
  filled('p-122216608', '功能', ['超薄', '持久']),
  filled('p-132644733', '注册证号', ['皖械注准20182180006']),
  filled('p-168920851', '产品标准', ['GB/T', '7544']),
  filled('p-9', '页面模板', ['默认']),
  { key: 'personalUseConfirm', label: 'personalUseConfirm', required: true, status: '已确认', value: '确认个人可自行使用。' },
  { key: 'productConfirm', label: '产品确认', required: true, status: '已确认', value: '产品确认' },
  filled('tmDeliveryTime', '发货时间', ['48小时']),
  filled('auctionPoint', '返点比例', ['1']),
  { key: 'quantity', label: '商品数量', required: true, status: '缺失', note: '按 SKU 库存合计' },
  { key: 'newProductConfirmation', label: '新品材料证明', required: true, status: '缺失', note: '页面有显示/必填条件，满足时才需要' },
  filled('shelfTime', '上架时间', ['放入仓库']),
]

/** A material folder with every kind of image the form takes. */
async function sampleDraft(overrides: Partial<DraftFile> = {}): Promise<{ dir: string; path: string; draft: DraftFile }> {
  const dir = await folder()
  const files: Record<string, Uint8Array> = {
    '方图/1.png': png(120, 120), '方图/2.jpeg': jpeg(120, 120), '长图/1.png': png(90, 120), '素材图/白底.png': png(100, 100, 'white'),
    '素材图/透明.png': png(800, 800, 'clear'), '详情页/1.png': png(60, 100), '详情页/2.png': png(60, 80), 'sku图/a.png': png(50, 50), 'sku图/b.png': png(50, 50, 'white'),
  }
  for (const [file, bytes] of Object.entries(files)) {
    await mkdir(dirname(join(dir, file)), { recursive: true })
    await writeFile(join(dir, file), bytes)
  }
  const draft: DraftFile = {
    folder: dir,
    images: {
      main: ['方图/1.png', '方图/2.jpeg'], main34: ['长图/1.png'], white: ['素材图/白底.png'], transparent: ['素材图/透明.png'],
      detail: ['详情页/1.png', '详情页/2.png'], sku: ['sku图/a.png', 'sku图/b.png'], other: [], unknown: [],
    },
    skus: [
      { index: 'SKU1', name: '1盒【18只】', code: 'mldx238a', count: 18, price: 42.9, image: 'sku图/a.png' },
      { index: 'SKU2', name: '2盒【40只】', code: 'mldx238b', count: 40, price: 69.9, image: 'sku图/b.png' },
    ],
    values: { 商品标题: { value: '名流水多多玻尿酸3合1避孕套', source: '模型生成' } },
    missing: [], problems: [], notes: [], catId: '50024154', checks: CHECKS,
    ...overrides,
  }
  const path = join(dir, '商品草稿.json')
  await writeFile(path, JSON.stringify(draft))
  return { dir, path, draft }
}

const BASE: PageBase = {
  global: { id: 1088292691011, catId: 50024154, gpfRenderTrace: 'trace-1' },
  defaults: {
    shelfTime: { type: 0, shelfTime: null }, location: { value: 340100, text: '合肥' },
    descRepublicOfSell: { descPageCommitParam: { kept: true }, descPageRenderParam: { catId: 50024154, descDomain: 'desc.alicdn.com', descVersion: '2.0.9' } },
  },
  measurement: { name: 'skuParam_p-409464968', unit: { value: 528, text: '只' } },
}

const image = (id: string, width = 800, height = 800): Uploaded => ({ id, url: `https://img.alicdn.com/${id}.png`, width, height, size: 1000 })

/** A Tmall store as the publish, image space, and item manager pages show it. */
class Store {
  folders = [{ id: '7', name: '默认' }]
  /** Files already in the DSH folder, by page. */
  files: { md5: string; pictureId: string; fullUrl: string; pixel: string; sizes: string }[] = []
  readonly uploads: string[] = []
  readonly submits: { query: URLSearchParams; form: Record<string, unknown> }[] = []
  /** The store's items, each in the item manager tab it shows in. */
  items: { itemId: string; title: string; tab?: 'on_sale' }[] = []
  /** What submit.htm answers; an Error rejects the evaluation. */
  answer: unknown = { models: { globalMessage: { successUrl: 'https://x/success.htm?primaryId=1088292691011&auctionStatus=-2' } } }
  /** Where a saved item lands. */
  lands: 'in_stock' | 'on_sale' | 'nowhere' = 'in_stock'
  /** What an upload answers instead of the file, when set. */
  refusesUploads?: object

  routes(): Route[] {
    return [
      expression => expression.startsWith('document.readyState') || expression.startsWith('Boolean(window.lib') ? true : undefined,
      on('window.Json2', BASE),
      on('picturecenter.console.dir.query', () => ({ data: { dirs: { children: this.folders } } })),
      on('picturecenter.console.dir.add', () => {
        this.folders.push({ id: '1010618857445826282', name: FOLDER_NAME })
        return { data: { jsPictureCategoryDO: { pictureCategoryId: '1010618857445826282' } } }
      }),
      on('picturecenter.console.file.query', (expression: string) => ({ data: { fileModule: /"page":1,/u.test(expression) ? this.files : [] } })),
      on('upload.api', (expression: string) => {
        if (this.refusesUploads !== undefined) return this.refusesUploads
        const name = JSON.parse(/form\.append\('name', ("[^"]*")\)/u.exec(expression)?.[1] as string) as string
        this.uploads.push(name)
        return { object: { fileId: String(this.uploads.length), url: `https://img.alicdn.com/${name}`, pix: '800x800', size: '2048' } }
      }),
      on('GlobalStore', (expression: string) => {
        const literal = /new URLSearchParams\(("(?:[^"\\]|\\.)*")\)/u.exec(expression)?.[1] as string
        const query = new URLSearchParams(JSON.parse(literal) as string)
        this.submits.push({ query, form: JSON.parse(query.get('jsonBody') as string) as Record<string, unknown> })
        const title = ((this.submits.at(-1)?.form.title as { title: string[] } | undefined)?.title[0]) ?? ''
        if (this.lands !== 'nowhere' && !(this.answer instanceof Error) && JSON.stringify(this.answer).includes('primaryId')) {
          this.items.push({ itemId: '1088292691011', title, ...this.lands === 'on_sale' ? { tab: 'on_sale' as const } : {} })
        }
        return this.answer
      }),
      on('mtop.tmall.sell.pc.manage.async', (expression: string) => {
        const tab = /\\"tab\\":\\"(\w+)\\"/u.exec(expression)?.[1]
        const id = /\\"queryItemId\\":\\"(\d+)\\"/u.exec(expression)?.[1]
        const title = /\\"queryTitle\\":\\"([^\\]+)\\"/u.exec(expression)?.[1]
        const rows = this.items.filter(item => (tab === 'all' || (item.tab ?? 'in_stock') === tab) && (id === undefined || item.itemId === id)
          && (title === undefined || item.title.includes(title))).slice(0, MANAGER_ROWS)
        return { rows: rows.map(item => ({ itemId: Number(item.itemId), catId: 50024154, itemDesc: { desc: [{ text: item.title }] } })) }
      }),
    ]
  }
}

describe('publish page', () => {
  it('reads the page base and fails loudly when the page carries no form', async () => {
    expect(await readBase(new FakePage([on('window.Json2', BASE)]))).toEqual(BASE)
    expect((await stopped(readBase(new FakePage([on('window.Json2', null)])))).message).toContain('页面可能已改版')
  })

  it('gives up on a call that takes too long', async () => {
    expect(await within(Promise.resolve(1), 1000, '读取')).toBe(1)
    expect(await stopped(within(new Promise(() => {}), 5, '读取图片空间'))).toMatchObject({ exitCode: EXIT.failed, message: '读取图片空间超过 0 秒没有结果。' })
  })

  it('finds or makes the DSH folder, and names the refusal', async () => {
    const store = new Store()
    const page = new FakePage(store.routes())
    expect(await ensureFolder(page)).toBe('1010618857445826282')
    expect(await ensureFolder(page)).toBe('1010618857445826282')
    expect(page.evaluated.filter(e => e.includes('dir.add'))).toHaveLength(1)
    expect((await stopped(ensureFolder(new FakePage([on('dir.query', { ret: 'FAIL_SYS_SESSION_EXPIRED' })])))).message).toBe('读取图片空间失败（FAIL_SYS_SESSION_EXPIRED）。')
    expect((await stopped(ensureFolder(new FakePage([on('dir.query', {})])))).message).toBe('读取图片空间失败（）。')
    const refused = new FakePage([on('dir.query', { data: {} }), on('dir.add', { ret: 'FAIL_BIZ' })])
    expect((await stopped(ensureFolder(refused))).message).toBe(`在图片空间新建「${FOLDER_NAME}」文件夹失败（FAIL_BIZ）。`)
    expect((await stopped(ensureFolder(new FakePage([on('dir.query', { data: {} }), on('dir.add', { data: {} })])))).message).toContain('（无应答）')
  })

  it('lists the folder images by MD5, page by page', async () => {
    const store = new Store()
    store.files = [{ md5: 'm1', pictureId: '11', fullUrl: 'https://img/1.png', pixel: '800x800', sizes: '99' }]
    expect(await folderImages(new FakePage(store.routes()), 'f')).toEqual(new Map([['m1', { id: '11', url: 'https://img/1.png', width: 800, height: 800, size: 99 }]]))
    expect(await folderImages(new FakePage([on('file.query', {})]), 'f')).toEqual(new Map())
    const odd = new FakePage([on('file.query', { data: { fileModule: [{ md5: 'm', pictureId: '1', fullUrl: 'u', pixel: '', sizes: '1' }] } })])
    expect((await folderImages(odd, 'f')).get('m')).toMatchObject({ width: 0, height: 0 })
    expect(odd.evaluated).toHaveLength(20)
  })

  it('uploads an image and names a refused upload', async () => {
    const store = new Store()
    expect(await uploadImage(new FakePage(store.routes()), png(2, 2), 'a.png', 'f')).toEqual({
      id: '1', url: 'https://img.alicdn.com/a.png', width: 800, height: 800, size: 2048,
    })
    expect((await stopped(uploadImage(new FakePage([on('upload.api', { message: '图片存在安全问题' })]), png(2, 2), 'b.png', 'f'))).message)
      .toBe('上传图片 b.png 失败（图片存在安全问题）。')
    expect((await stopped(uploadImage(new FakePage([on('upload.api', {})]), png(2, 2), 'c.png', 'f'))).message).toBe('上传图片 c.png 失败（无应答）。')
    const flat = await uploadImage(new FakePage([on('upload.api', { object: { fileId: '9', url: 'u', pix: '', size: '1' } })]), png(2, 2), 'd.png', 'f')
    expect(flat).toMatchObject({ width: 0, height: 0 })
  })

  it('reads submit answers', () => {
    expect(readSubmitAnswer({ models: { globalMessage: { successUrl: 'https://x?primaryId=12&auctionStatus=-2' } } })).toEqual({ itemId: '12', auctionStatus: '-2' })
    expect(readSubmitAnswer({ models: { globalMessage: { successUrl: 'https://x?primaryId=12' } } })).toEqual({ itemId: '12', auctionStatus: '' })
    expect(readSubmitAnswer({ models: {
      globalMessage: { successUrl: 'https://x/fail', message: '' },
      formError: { tmSubTitle: { message: [{ msg: '不能超过<b>20</b>个汉字' }, { msg: '不能超过<b>20</b>个汉字' }] }, itemMessage: { message: '详情内容不能为空' } },
    } })).toEqual({ errors: ['不能超过20个汉字', '详情内容不能为空'] })
    expect(readSubmitAnswer({ odd: true })).toEqual({ errors: ['{"odd":true}'] })
    expect(readSubmitAnswer(null)).toEqual({ errors: ['null'] })
  })

  it('submits through the page request helper with the reserved item id and trace', async () => {
    const store = new Store()
    const answer = await submit(new FakePage(store.routes()), BASE, { title: { title: ['名流'] } })
    expect(answer).toEqual({ itemId: '1088292691011', auctionStatus: '-2' })
    const { query, form } = store.submits[0] as { query: URLSearchParams; form: object }
    expect(Object.fromEntries(query)).toMatchObject({ catId: '50024154', itemId: '1088292691011', copyItemMode: '0' })
    expect(JSON.parse(query.get('globalExtendInfo') as string)).toEqual({ startTraceId: 'trace-1', fromAIPublish: 'true', id: '1088292691011', noIcmp: 'true' })
    expect(form).toEqual({ title: { title: ['名流'] } })
  })

  it('looks in one tab of the item manager', async () => {
    const store = new Store()
    store.items = [{ itemId: '5', title: '名流 水多多' }]
    const page = new FakePage(store.routes())
    expect(await listed(page, { queryItemId: '5' }, 'in_stock')).toEqual([{ itemId: '5', catId: '50024154', title: '名流 水多多' }])
    expect(page.evaluated.at(-1)).toContain('\\"tab\\":\\"in_stock\\"')
    expect(await listed(page, { queryItemId: '5' }, 'on_sale')).toEqual([])
  })
})

describe('buildForm', () => {
  it('writes option fields as the platform lists them, custom values as their text', () => {
    const field = (patch: Partial<FieldRule>) => rule({ key: 'k', label: 'k', ...patch })
    expect(optionValue(field({}), ['GB/T', '7544'])).toBe('GB/T7544')
    expect(optionValue(field({ uiType: 'combobox', options: [{ value: 1, text: '名流' }] }), ['名流'])).toEqual({ value: 1, text: '名流' })
    expect(optionValue(field({ uiType: 'combobox', options: [] }), ['自定'])).toEqual({ value: '自定', text: '自定' })
    expect(optionValue(field({ uiType: 'sequentialCheckbox', options: [{ value: 1, text: '超薄' }] }), ['超薄', '新'])).toEqual([
      { value: 1, text: '超薄' }, { value: '新', text: '新' },
    ])
  })

  it('sets the draft into the page form, kept in the warehouse', async () => {
    const { draft } = await sampleDraft()
    const images = Object.fromEntries([
      '方图/1.png', '方图/2.jpeg', '长图/1.png', '素材图/白底.png', '素材图/透明.png', 'sku图/a.png', 'sku图/b.png',
    ].map((file, at) => [file, image(String(at + 1))]))
    const form = buildForm(BASE, {
      draft, checks: CHECKS, rules: RULES, stock: 1000,
      images: { ...images, '详情页/1.png': image('21', 750, 1200), '详情页/2.png': image('22', 750, 800) },
    })
    expect(form).toMatchObject({
      id: 1088292691011, location: { value: 340100, text: '合肥' },
      title: { title: ['名流水多多玻尿酸3合1避孕套'] }, shopping_title: { title: ['水多多 超薄超润'] }, tmSubTitle: '1200mg玻尿酸',
      mainImagesGroup: { images: [{ url: 'https://img.alicdn.com/1.png' }, { url: 'https://img.alicdn.com/2.png' }] },
      threeToFourImages: [{ url: 'https://img.alicdn.com/3.png', pix: '800x800', width: 800, height: 800, size: 1000 }],
      yinHeWhiteBgImage: [{ url: 'https://img.alicdn.com/4.png' }], guideImageGroup: { whiteBgImage: [{ url: 'https://img.alicdn.com/5.png' }] },
      keyProp: { 'p-20000': { value: 30111, text: '名流' } },
      bindProp: { 'p-122216608': [{ value: 1, text: '超薄' }, { value: '持久', text: '持久' }], 'p-168920851': 'GB/T7544' },
      itemProp: { 'p-132644733': { value: '皖械注准20182180006', text: '皖械注准20182180006' } },
      personalUseConfirm: [{ value: '1' }], productConfirm: [{ value: '1' }],
      tmDeliveryTime: { type: '2', value: null, setBySku: false }, auctionPoint: '1',
      saleProp: { 'p-1627207': [{ text: '1盒【18只】', value: -1, img: 'https://img.alicdn.com/6.png', pix: '800x800' }, { text: '2盒【40只】', value: -2 }] },
      price: 42.9, quantity: '2000', outerId: 'mldx238', shelfTime: { type: 2, shelfTime: null },
    })
    expect(form.enhancedPageTemplate).toBeUndefined()
    expect((form.sku as object[])[0]).toEqual({
      cspuId: null, skuId: null, skuStatus: 1, action: { selected: true }, skuPrice: '42.90', skuStock: '1000', skuQuality: { value: 'mainSku', text: '单品' },
      props: [{ text: '1盒【18只】', value: -1, name: 'p-1627207', label: '颜色分类', img: 'https://img.alicdn.com/6.png', pix: '800x800' }],
      salePropKey: '1627207--1', skuOuterId: 'mldx238a',
      'skuParam_p-409464968': { text: '18只', isEmptyItem: false, structItems: { 'ts-1': '18', 'ts-2': { value: 528, text: '只' } } },
    })
    const commit = (form.descRepublicOfSell as { descPageCommitParam: Record<string, unknown> }).descPageCommitParam
    expect(commit).toMatchObject({ kept: true, opt: 2, changed: true, editType: 'lite', catId: 50024154, descDomain: 'desc.alicdn.com', descVersion: '2.0.9', detailHeight: 2000 })
    type Group = { groupId: string; components: { componentId: string; picMeta: object }[] }
    const template = JSON.parse(commit.templateContent as string) as { groups: Group[]; sellergroups: unknown[] }
    expect(template.sellergroups).toEqual([])
    expect(template.groups.map(group => [group.groupId.replace(/\d{6,}/u, 'T'), group.components[0]?.componentId.replace(/\d{6,}/u, 'T')])).toEqual([
      ['groupT', 'componentT'], ['groupT-1', 'componentT-1'],
    ])
    expect(template.groups[1]?.components[0]?.picMeta).toEqual({ width: 750, height: 800, size: 1000, id: 22 })
    expect(JSON.parse(commit.detailParam as string)).toMatchObject({ params: [{ width: 750, height: 1200, imageUrls: ['https://img.alicdn.com/21.png'] }, { height: 800 }] })
  })

  it('leaves out what the draft does not have', async () => {
    const { draft } = await sampleDraft({
      images: { main: ['方图/1.png'], main34: [], white: [], transparent: [], detail: [], sku: [], other: [], unknown: [] },
      skus: [{ index: 'SKU1', name: '单只', price: 9.9, stock: 5 }],
    })
    const checks = [filled('price', '一口价', ['9.9']), filled('outerId', '商家编码', ['own']), filled('tmDeliveryTime', '发货时间', ['7天'])]
    const form = buildForm({ global: { id: 1 }, defaults: {} }, { draft, checks, rules: RULES, stock: 0, images: { '方图/1.png': image('1') } })
    expect(form).toMatchObject({ price: 9.9, quantity: '5', outerId: 'own', shelfTime: { type: 2 } })
    for (const key of ['title', 'shopping_title', 'tmSubTitle', 'threeToFourImages', 'yinHeWhiteBgImage', 'guideImageGroup', 'tmDeliveryTime', 'auctionPoint', 'personalUseConfirm']) {
      expect(form[key], key).toBeUndefined()
    }
    expect((form.sku as object[])[0]).toEqual(expect.not.objectContaining({ skuOuterId: expect.anything() as unknown }))
    const commit = (form.descRepublicOfSell as { descPageCommitParam: object }).descPageCommitParam
    expect(commit).toMatchObject({ detailHeight: 0, catId: undefined })
    const nameless = buildForm({ global: {}, defaults: {} }, { draft: { ...draft, skus: [{ index: '1', name: 'a', code: 'x1', price: 1 }, { index: '2', name: 'b', price: 2 }] }, checks: [], rules: RULES, stock: 3, images: { '方图/1.png': image('1') } })
    expect(nameless).toMatchObject({ outerId: 'x1', quantity: '6' })
    const uncoded = buildForm({ global: {}, defaults: {} }, { draft: { ...draft, skus: [{ index: '1', name: 'a', price: 1 }] }, checks: [], rules: RULES, stock: 3, images: { '方图/1.png': image('1') } })
    expect(uncoded.outerId).toBeUndefined()
  })
})

describe('tmall-publish script', () => {
  it('reads the command line', () => {
    expect(parsePublishOptions(['check', '--account', 'a1', '--draft', 'd.json'])).toEqual({ command: 'check', account: 'a1', draft: 'd.json', confirmed: false, unknownChecked: false, out: '天猫发品' })
    expect(parsePublishOptions(['save', '--account', 'a1', '--draft', 'd', '--rules', 'r', '--confirmed', '--stock', '1000', '--out', 'o'])).toEqual({
      command: 'save', account: 'a1', draft: 'd', rules: 'r', confirmed: true, stock: 1000, unknownChecked: false, out: 'o',
    })
    expect(parsePublishOptions(['save', '--account', 'a1', '--draft', 'd', '--rules', 'r', '--unknown-checked']).unknownChecked).toBe(true)
    for (const argv of [
      ['save', '--bogus'], [], ['publish', '--account', 'a1', '--draft', 'd'], ['check', '--draft', 'd'], ['check', '--account', '', '--draft', 'd'],
      ['check', '--account', 'a1'], ['check', '--account', 'a1', '--draft', ''], ['save', '--account', 'a1', '--draft', 'd'], ['save', '--account', 'a1', '--draft', 'd', '--rules', ''],
      ['save', '--account', 'a1', '--draft', 'd', '--rules', 'r', '--stock', '0'], ['save', '--account', 'a1', '--draft', 'd', '--rules', 'r', '--stock', '1.5'],
    ]) {
      expect(() => parsePublishOptions(argv), argv.join(' ')).toThrow(expect.objectContaining({ exitCode: EXIT.usage }) as Error)
    }
  })

  it('lists what stops a save', async () => {
    const { draft } = await sampleDraft()
    expect(blockers(draft, RULES, { confirmed: true, stock: 1000 })).toEqual([])
    const { checks: _checks, ...unchecked } = draft
    expect(blockers(unchecked, RULES, { confirmed: true })).toEqual(['商品草稿没有按类目 50024154 的字段规则检查过，请用 product-draft draft --rules 重新生成。'])
    expect(blockers({ ...draft, catId: '1' }, RULES, { confirmed: true })).toHaveLength(1)
    expect(blockers({ ...draft, skus: draft.skus.map(sku => ({ ...sku, stock: 3 })) }, RULES, { confirmed: true })).toEqual([])
    const blocked = blockers({
      ...draft, missing: ['详情图'], problems: ['SKU 表有空价格'],
      checks: [
        ...CHECKS,
        { key: 'p-1', label: '产地', required: true, status: '缺失' },
        { key: 'p-2', label: '颜色', required: false, status: '缺失' },
        { key: 'p-3', label: '外观', required: true, status: '不符合', note: '「螺纹」不在可选值里' },
        { key: 'p-4', label: '厚薄', required: true, status: '不符合' },
        { key: 'd1', label: 'd1', required: true, status: '待店铺确认', value: '确认个人可自行使用。' },
        { key: 'd2', label: '产品确认', required: true, status: '待店铺确认' },
        { key: 'title', label: '商品标题', required: true, status: '待确认', value: 't' },
      ],
    }, RULES, { confirmed: false })
    expect(blocked).toEqual([
      '缺失：详情图', '问题：SKU 表有空价格', '缺失：产地', '不符合：外观（「螺纹」不在可选值里）', '不符合：厚薄',
      '声明还没有确认：确认个人可自行使用。', '声明还没有确认：产品确认', '缺失：每个 SKU 的库存（用 --stock 给出）',
      '还有模型生成的值待用户确认：用户在确认卡片里认可后才能加 --confirmed',
    ])
  })

  interface SetUp { store: Store; out: string; draft: string; rules: string; dir: string }
  async function setUp(store = new Store(), overrides: Partial<DraftFile> = {}): Promise<SetUp> {
    const { dir, path } = await sampleDraft(overrides)
    const rules = join(dir, '字段规则_50024154.json')
    await writeFile(rules, JSON.stringify(RULES))
    return { store, out: join(dir, '天猫发品'), draft: path, rules, dir }
  }

  const records = async (out: string) => JSON.parse(await readFile(join(out, '发品记录.json'), 'utf8')) as PublishRecord[]

  it('saves a confirmed draft to the warehouse, reusing images already uploaded, and refuses to save it twice', async () => {
    const { store, out, draft, rules, dir } = await setUp()
    store.files = [{ md5: createHash('md5').update(await readFile(join(dir, '方图/1.png'))).digest('hex'), pictureId: '900', fullUrl: 'https://img/old.png', pixel: '120x120', sizes: '5' }]
    const page = new FakePage(store.routes())
    const deps = fakeDeps(page)
    const argv = ['save', '--account', 'a1', '--draft', draft, '--rules', rules, '--confirmed', '--stock', '1000', '--out', out]
    expect(await main(argv, deps)).toBe(0)
    expect(deps.out.join('')).toBe([
      '已保存到店铺 名流旗舰店（主账号） 的仓库（未上架）：商品 ID 1088292691011，标题「名流水多多玻尿酸3合1避孕套」。',
      '图片 9 张已传到图片空间的「DSH发品」文件夹。',
      '- 编辑：https://sell.publish.tmall.com/tmall/publish.htm?id=1088292691011',
      '- 仓库：https://qn.taobao.com/home.htm/sell-manage-tm/in_stock',
      '请到千牛仓库确认后再上架。',
      '',
    ].join('\n'))
    expect(deps.err.join('')).toBe([
      '[2026-10-08 11:00] 打开天猫发布页', '[2026-10-08 11:00] 图片空间「DSH发品」已有 1 张图，需要 9 张', '[2026-10-08 11:00] 上传 方图/2.jpeg',
      '[2026-10-08 11:00] 上传 长图/1.png', '[2026-10-08 11:00] 上传 素材图/白底.png', '[2026-10-08 11:00] 上传 素材图/透明.png', '[2026-10-08 11:00] 上传 sku图/a.png',
      '[2026-10-08 11:00] 上传 sku图/b.png', '[2026-10-08 11:00] 上传 详情页/1.png', '[2026-10-08 11:00] 上传 详情页/2.png', '[2026-10-08 11:00] 提交到天猫（放入仓库）', '',
    ].join('\n'))
    expect(store.uploads).toEqual(['2.jpg', '1.png', '白底-800.png', '透明.png', 'a.png', 'b.png', '1.png', '2.png'])
    expect(page.visited).toEqual([MANAGER_URL, publishUrl('50024154'), MANAGER_URL])
    expect(store.submits[0]?.form).toMatchObject({ shelfTime: { type: 2 }, mainImagesGroup: { images: [{ url: 'https://img/old.png' }, { url: 'https://img.alicdn.com/2.jpg' }] } })
    expect(await records(out)).toEqual([
      { store: '名流旗舰店（主账号）', title: '名流水多多玻尿酸3合1避孕套', catId: '50024154', codes: ['mldx238a', 'mldx238b'], status: 'submitting', at: '2026-10-08T03:00:00.000Z' },
      {
        store: '名流旗舰店（主账号）', title: '名流水多多玻尿酸3合1避孕套', catId: '50024154', codes: ['mldx238a', 'mldx238b'], status: 'saved', itemId: '1088292691011',
        at: '2026-10-08T03:00:00.000Z',
      },
    ])

    const again = fakeDeps(new FakePage(store.routes()))
    expect(await main(argv, again)).toBe(0)
    expect(again.out.join('')).toContain('没有重复保存：店铺 名流旗舰店（主账号） 里已有「名流水多多玻尿酸3合1避孕套」，商品 ID 1088292691011（2026-10-08 11:00（北京时间）DSH 已存过，仍在店里）。')
    expect(store.submits).toHaveLength(1)
    expect((await records(out)).at(-1)).toMatchObject({ status: 'exists', itemId: '1088292691011', message: '2026-10-08 11:00（北京时间）DSH 已存过，仍在店里' })
    const checked = fakeDeps(new FakePage(store.routes()))
    expect(await main(['check', '--account', 'a1', '--draft', draft, '--out', out], checked)).toBe(0)
    expect(checked.out.join('')).toContain('里已有「名流水多多玻尿酸3合1避孕套」：商品 ID 1088292691011（2026-10-08 11:00（北京时间）DSH 已存过，仍在店里）')

    // Put on sale with a new title, the same SKU codes still name it.
    store.items = [{ itemId: '1088292691011', title: '新标题', tab: 'on_sale' }]
    const renamed = JSON.parse(await readFile(draft, 'utf8')) as DraftFile
    await writeFile(draft, JSON.stringify({ ...renamed, values: { 商品标题: { value: '新标题二', source: '模型生成' } } }))
    const moved = fakeDeps(new FakePage(store.routes()))
    expect(await main(argv, moved)).toBe(0)
    expect(moved.out.join('')).toContain('没有重复保存：店铺 名流旗舰店（主账号） 里已有「新标题二」，商品 ID 1088292691011')
    expect(store.submits).toHaveLength(1)
  })

  it('cuts the white image to 800×800 and reuses the cut image by its MD5', async () => {
    const { store, out, draft, rules, dir } = await setUp()
    const cut = fitImage(await readFile(join(dir, '素材图/白底.png')), 800, 800)
    expect(readImage(cut)).toMatchObject({ format: 'png', width: 800, height: 800 })
    store.files = [{ md5: createHash('md5').update(cut).digest('hex'), pictureId: '901', fullUrl: 'https://img/white.png', pixel: '800x800', sizes: '5' }]
    expect(await main(['save', '--account', 'a1', '--draft', draft, '--rules', rules, '--confirmed', '--stock', '1', '--out', out], fakeDeps(new FakePage(store.routes())))).toBe(0)
    expect(store.uploads).not.toContain('白底-800.png')
    expect(store.submits[0]?.form.yinHeWhiteBgImage).toEqual([{ url: 'https://img/white.png', pix: '800x800', width: 800, height: 800, size: 5 }])
  })

  it('takes the stock from the SKU table when it has one, and SKUs without an image', async () => {
    const { draft: sample } = await sampleDraft()
    const skus = sample.skus.map((sku, at) => at === 0
      ? { ...sku, stock: 7 }
      : { index: sku.index, name: sku.name, price: sku.price, stock: 8 })
    const setup = await setUp(new Store(), { skus })
    const deps = fakeDeps(new FakePage(setup.store.routes()))
    expect(await main(['save', '--account', 'a1', '--draft', setup.draft, '--rules', setup.rules, '--confirmed', '--out', setup.out], deps)).toBe(0)
    expect(setup.store.submits[0]?.form).toMatchObject({ quantity: '15', sku: [{ skuStock: '7' }, { skuStock: '8' }] })
    expect(setup.store.uploads).not.toContain('b.png')
  })

  it('finds an item already in the warehouse by its title, and says when there is none', async () => {
    const { store, out, draft } = await setUp()
    const none = fakeDeps(new FakePage(store.routes()))
    expect(await main(['check', '--account', 'a1', '--draft', draft, '--out', out], none)).toBe(0)
    expect(none.out.join('')).toBe('店铺 名流旗舰店（主账号） 的仓库和出售中都没有「名流水多多玻尿酸3合1避孕套」，DSH 也没有存过它。\n')
    store.items = [{ itemId: '961117235837', title: '名流水多多玻尿酸3合1避孕套', tab: 'on_sale' }]
    await mkdir(out, { recursive: true })
    const gone: PublishRecord = { store: '名流旗舰店（主账号）', title: '名流水多多玻尿酸3合1避孕套', catId: '50024154', status: 'saved', itemId: '1', at: '2026-10-01T00:00:00Z' }
    await writeFile(join(out, '发品记录.json'), JSON.stringify([gone, { ...gone, store: '别家', itemId: '961117235837' }]))
    const found = fakeDeps(new FakePage(store.routes()))
    expect(await main(['check', '--account', 'a1', '--draft', draft, '--out', out], found)).toBe(0)
    expect(found.out.join('')).toContain('商品 ID 961117235837（店里已有同名商品）')
    store.items = Array.from({ length: MANAGER_ROWS }, (_, at) => ({ itemId: String(500 + at), title: `名流水多多玻尿酸3合1避孕套 ${String(at)}` }))
    const crowded = fakeDeps(new FakePage(store.routes()))
    expect(await main(['check', '--account', 'a1', '--draft', draft, '--out', out], crowded)).toBe(EXIT.failed)
    expect(crowded.err.join('')).toBe('店里标题含「名流水多多玻尿酸3合1避孕套」的商品超过 20 个，没法确认有没有同一商品；请用户到千牛按标题确认。\n')
  })

  it('reads a draft title written as parts, and a record file that is not a list or not JSON', async () => {
    const { store, out, draft } = await setUp(new Store(), { values: { 商品标题: { value: ['名流', '水多多'], source: '模型生成' } } })
    store.items = [{ itemId: '3', title: '名流水多多' }]
    await mkdir(out, { recursive: true })
    for (const text of ['{}', 'not json']) {
      await writeFile(join(out, '发品记录.json'), text)
      const deps = fakeDeps(new FakePage(store.routes()))
      expect(await main(['check', '--account', 'a1', '--draft', draft, '--out', out], deps)).toBe(0)
      expect(deps.out.join('')).toContain('商品 ID 3（店里已有同名商品）')
    }
    const untitled = await setUp(new Store(), { values: {}, skus: [{ index: '1', name: 'a', price: 1 }] })
    const deps = fakeDeps(new FakePage(untitled.store.routes()))
    expect(await main(['check', '--account', 'a1', '--draft', untitled.draft, '--out', untitled.out], deps)).toBe(EXIT.usage)
    expect(deps.err.join('')).toBe('商品草稿还没有商品标题，没法到店里查重；请先补上标题重新生成草稿。\n')
  })

  it('refuses a draft that is not ready, and an unreadable draft', async () => {
    const { store, out, draft, rules } = await setUp()
    const deps = fakeDeps(new FakePage(store.routes()))
    expect(await main(['save', '--account', 'a1', '--draft', draft, '--rules', rules, '--out', out], deps)).toBe(EXIT.usage)
    expect(deps.err.join('')).toBe('还不能保存到仓库：\n- 缺失：每个 SKU 的库存（用 --stock 给出）\n')
    expect(store.submits).toHaveLength(0)
    const missing = fakeDeps(new FakePage([]))
    expect(await main(['check', '--account', 'a1', '--draft', join(out, 'none.json')], missing)).toBe(EXIT.usage)
    expect(missing.err.join('')).toContain('读不到商品草稿')
  })

  const save = (setup: { out: string; draft: string; rules: string }) => ['save', '--account', 'a1', '--draft', setup.draft, '--rules', setup.rules, '--confirmed', '--stock', '1', '--out', setup.out]

  it('records a refusal as failed and says why', async () => {
    const setup = await setUp()
    setup.store.answer = { models: { formError: { title: { message: [{ msg: '标题不能为空' }] } } } }
    const deps = fakeDeps(new FakePage(setup.store.routes()))
    expect(await main(save(setup), deps)).toBe(EXIT.failed)
    expect(deps.err.join('')).toContain('天猫没有保存，原因：\n- 标题不能为空\n')
    expect((await records(setup.out)).at(-1)).toMatchObject({ status: 'failed', message: '标题不能为空' })
  })

  it('records a submit without an answer as unknown, and saves again only after the user checked', async () => {
    const setup = await setUp()
    setup.store.answer = new Error('Network Error')
    const deps = fakeDeps(new FakePage(setup.store.routes()))
    expect(await main(save(setup), deps)).toBe(EXIT.failed)
    expect(deps.err.join('')).toContain('提交后没有拿到天猫的答复（Network Error），结果不明。不要重试，先运行 check 查店里。')
    expect((await records(setup.out)).at(-1)).toMatchObject({ status: 'unknown', message: 'Network Error' })

    setup.store.answer = new Store().answer
    const retried = fakeDeps(new FakePage(setup.store.routes()))
    expect(await main(save(setup), retried)).toBe(EXIT.usage)
    expect(retried.err.join('')).toContain('没有保存：2026-10-08 11:00（北京时间）那次提交结果不明，店里暂时查不到它，可能还在处理。')
    expect(setup.store.submits).toHaveLength(1)
    const checked = fakeDeps(new FakePage(setup.store.routes()))
    expect(await main(['check', '--account', 'a1', '--draft', setup.draft, '--out', setup.out], checked)).toBe(0)
    expect(checked.out.join('')).toContain('注意：2026-10-08 11:00（北京时间）那次提交结果不明')
    expect(await main([...save(setup), '--unknown-checked'], fakeDeps(new FakePage(setup.store.routes())))).toBe(0)
    expect(setup.store.submits).toHaveLength(2)

    // A run stopped while submitting left no answer either.
    const cut = await setUp()
    await mkdir(cut.out, { recursive: true })
    const started: PublishRecord = { store: '名流旗舰店（主账号）', title: 'x', catId: '50024154', codes: ['mldx238a', 'mldx238b'], status: 'submitting', at: '2026-10-08T02:00:00Z' }
    await writeFile(join(cut.out, '发品记录.json'), JSON.stringify([started]))
    expect(await main(save(cut), fakeDeps(new FakePage(cut.store.routes())))).toBe(EXIT.usage)
    expect(cut.store.submits).toHaveLength(0)
  })

  it('records an item the store does not show as unknown, and one put on sale loudly', async () => {
    const setup = await setUp()
    setup.store.lands = 'nowhere'
    const deps = fakeDeps(new FakePage(setup.store.routes()))
    expect(await main(save(setup), deps)).toBe(EXIT.failed)
    expect(deps.err.join('')).toContain('天猫答复已保存（商品 ID 1088292691011），但仓库里暂时查不到它。不要重试，稍后运行 check 查店里。')
    expect((await records(setup.out)).at(-1)).toMatchObject({ status: 'unknown', itemId: '1088292691011' })

    const live = await setUp()
    live.store.lands = 'on_sale'
    const loud = fakeDeps(new FakePage(live.store.routes()))
    expect(await main(save(live), loud)).toBe(EXIT.failed)
    expect(loud.err.join('')).toContain('天猫把商品 ID 1088292691011 放到了「出售中」，没有放进仓库！请用户立即到千牛下架它。')
    expect((await records(live.out)).at(-1)).toMatchObject({ status: 'on-sale', itemId: '1088292691011' })
  })

  it('records a failure before submitting as failed', async () => {
    const setup = await setUp()
    setup.store.refusesUploads = { message: '图片存在安全问题' }
    const deps = fakeDeps(new FakePage(setup.store.routes()))
    expect(await main(save(setup), deps)).toBe(EXIT.failed)
    expect(deps.err.join('')).toContain('上传图片 1.png 失败（图片存在安全问题）。')
    expect((await records(setup.out)).map(record => record.status)).toEqual(['submitting', 'failed'])
    expect(setup.store.submits).toHaveLength(0)
  })

  it('stops when the publish page asks to sign in, and reports other failures', async () => {
    const setup = await setUp()
    const page = new FakePage(setup.store.routes(), (url, tab) => { if (url.startsWith(publishUrl('50024154'))) tab.href = 'https://login.taobao.com/x' })
    const deps = fakeDeps(page)
    expect(await main(save(setup), deps)).toBe(EXIT.signedOut)
    expect(page.closed).toBe(true)
    expect((await records(setup.out)).at(-1)).toMatchObject({ status: 'failed' })
    const broken = fakeDeps(new FakePage([]), { openPage: () => Promise.reject(new Error('CDP 断开')) })
    expect(await main(['check', '--account', 'a1', '--draft', setup.draft], broken)).toBe(EXIT.failed)
    expect(broken.err.join('')).toBe('失败：CDP 断开\n')
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- a non-Error rejection is the scenario under test.
    const odd = fakeDeps(new FakePage([]), { takeOver: () => Promise.reject('down') })
    expect(await main(['check', '--account', 'a1', '--draft', setup.draft], odd)).toBe(EXIT.failed)
    expect(odd.err.join('')).toBe('失败：down\n')
  })
})
