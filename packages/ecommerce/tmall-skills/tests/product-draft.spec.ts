import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import { buildDraft, checkDraft, numberIn, optionKey, parseAnswers, titleWidth, type Answers, type Draft } from '../src/draft.ts'
import { EXIT } from '../src/errors.ts'
import { imageFormat, measure, readImage } from '../src/images.ts'
import { classifyImage, headerKey, readCsv, suggestField, tableOf, takeInventory, type Inventory } from '../src/materials.ts'
import { draftText, inventoryText, main, parseProductDraftOptions, parseRulesFile } from '../src/product-draft-cli.ts'
import type { FieldRule, PublishRules } from '../src/publish-rules.ts'
import { readSheets } from '../src/sheet.ts'
import { jpeg, png } from './images.ts'
import { fakeDeps, FakePage, tempDir, xlsxOf } from './support.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function folder(): Promise<string> {
  const { dir, cleanup } = await tempDir()
  cleanups.push(cleanup)
  return dir
}

async function put(root: string, file: string, bytes: Uint8Array | string): Promise<void> {
  await mkdir(dirname(join(root, file)), { recursive: true })
  await writeFile(join(root, file), bytes)
}

/** A folder laid out like 510107068-新品准备, at a small scale. */
async function sampleFolder(): Promise<string> {
  const root = await folder()
  for (const n of [1, 2]) await put(root, `方图/主图-1${String(n)}.png`, png(120, 120))
  for (const n of [1, 2]) await put(root, `长图/主图-0${String(n)}.png`, png(90, 120))
  await put(root, '素材图/800_800-纯白.jpeg', png(100, 100, 'white'))
  await put(root, '素材图/800_800透明图.png', png(80, 80, 'clear'))
  await put(root, '素材图/场景图.jpeg', jpeg(100, 100))
  for (const n of [1, 2]) await put(root, `详情页/${String(n)}.png`, png(60, 100))
  await put(root, '详情页/3.png', png(90, 120))
  for (const n of [1, 2, 3]) await put(root, `sku图/sku${String(n)}.png`, png(100, 100, 'clear'))
  await put(root, '.DS_Store', 'x')
  await put(root, 'sku.xlsx', xlsxOf([
    ['SKU序号', '商家编码', '上架名称', '只数', '片单价', '到手价'],
    ['SKU1', 'm-a', '1盒【18只】', '18', '2.38333333333333', '42.9'],
    ['SKU2', 'm-b', '2盒【40只】', '40', '1.7475', '69.9'],
    ['SKU3', 'm-c', '组合【48只】', '48', '1.51875', '72.9'],
  ]))
  return root
}

const rule = (field: Partial<FieldRule> & Pick<FieldRule, 'key' | 'label'>): FieldRule => ({ uiType: 'input', required: true, visible: true, ...field })

/** Field rules shaped like the real 50024154 rules, trimmed. */
const RULES: PublishRules = {
  catId: '50024154', categoryPath: '计生用品 > 避孕套',
  fields: [
    rule({ key: 'category', label: '当前类目', required: false }),
    rule({ key: 'mainImagesGroup', label: '1:1主图' }),
    rule({ key: 'title', label: '商品标题' }),
    rule({ key: 'shopping_title', label: '导购标题', required: false }),
    rule({ key: 'tmSubTitle', label: '商品卖点', required: false }),
    rule({ key: 'p-20000', label: '品牌', uiType: 'combobox', options: [{ value: 1, text: '名流' }], allowsCustom: true }),
    rule({ key: 'p-8484762', label: '安全套 外观形状', uiType: 'select', options: [{ value: 1, text: '其他' }, { value: 2, text: '大颗粒' }] }),
    rule({ key: 'p-8484761', label: '安全套 厚薄', uiType: 'select', options: [{ value: 1, text: '超薄型' }] }),
    rule({ key: 'p-31889', label: '颜色', uiType: 'sequentialCheckbox', required: false, options: [{ value: 1, text: '透明' }] }),
    rule({ key: 'p-132644733', label: '注册证号', uiType: 'combobox', options: [{ value: 'x', text: '粤械' }], allowsCustom: true }),
    rule({ key: 'p-168920851', label: '产品标准' }),
    rule({ key: 'qualification', label: '商品资质', visible: false }),
    rule({ key: 'personalUseConfirm', label: 'personalUseConfirm', uiType: 'checkbox', declaration: true, options: [{ value: '1', text: '确认个人可自行使用。' }] }),
    rule({ key: 'productConfirm', label: '产品确认', uiType: 'checkbox', declaration: true }),
    rule({ key: 'p-1627207', label: '颜色分类', required: false }),
    rule({ key: 'sku', label: '销售规格', required: false }),
    rule({ key: 'price', label: '一口价' }),
    rule({ key: 'quantity', label: '商品数量', conditions: ['${sku.props.hasValue}'] }),
    rule({ key: 'outerId', label: '商家编码', required: false }),
    rule({ key: 'shelfTime', label: '上架时间', options: [{ value: 2, text: '放入仓库' }] }),
    rule({ key: 'tmDeliveryTime', label: '发货时间' }),
    rule({ key: 'threeToFourImages', label: '3:4主图', required: false }),
    rule({ key: 'yinHeWhiteBgImage', label: '白底图', required: false }),
    rule({ key: 'guideImageGroup', label: '导购素材', required: false }),
    rule({ key: 'descRepublicOfSell', label: '宝贝详情' }),
    rule({ key: 'auctionVideos', label: '商品视频', required: false }),
  ],
}

const ANSWERS: Answers = {
  values: {
    商品标题: { value: '名流水多多三合一玻尿酸避孕套', source: '模型生成' },
    商品卖点: { value: '玻尿酸润滑', source: '模型生成' },
    导购标题: { value: '名流水多多', source: '模型生成' },
    品牌: { value: '名流', source: '店铺资料' },
    '安全套 外观形状': { value: '其它', source: '沿用旧商品' },
    '安全套　厚薄': { value: '超薄　型', source: '沿用旧商品' },
    注册证号: { value: '皖械注准20182180006', source: '店铺资料' },
  },
}

describe('images', () => {
  it('tells PNG and JPEG by their bytes and measures transparency and the white border', () => {
    expect(imageFormat(png(4, 4))).toBe('png')
    expect(imageFormat(jpeg(8, 8))).toBe('jpeg')
    expect(imageFormat(strToU8('GIF89a'))).toBeUndefined()
    expect(() => readImage(strToU8('GIF89a'))).toThrow('不是 PNG 或 JPEG')
    expect(readImage(png(100, 100, 'clear'))).toMatchObject({ format: 'png', width: 100, height: 100, whiteBorderShare: 0 })
    expect(readImage(png(100, 100, 'clear')).transparentShare).toBeGreaterThan(0.5)
    const white = readImage(jpeg(64, 48, 'white'))
    expect(white).toMatchObject({ format: 'jpeg', width: 64, height: 48, transparentShare: 0 })
    expect(white.whiteBorderShare).toBeGreaterThan(0.95)
    expect(measure({ width: 1, height: 1, data: new Uint8Array([0, 0, 0, 255]) }))
      .toEqual({ width: 1, height: 1, transparentShare: 0, whiteBorderShare: 0 })
  })
})

describe('sorting', () => {
  const facts = (width: number, height: number, more: { transparentShare?: number; whiteBorderShare?: number } = {}) =>
    ({ format: 'png' as const, width, height, transparentShare: 0, whiteBorderShare: 0, ...more })

  it('trusts the file name first, then the folders, and checks the pixels against it', () => {
    expect(classifyImage('sku图/a.png', facts(10, 10))).toEqual({ kind: 'sku', reason: '名称「sku图」', warnings: [] })
    expect(classifyImage('详情页/6.png', facts(1086, 1448)).kind).toBe('detail')
    expect(classifyImage('x/白底.png', facts(10, 10)).warnings).toEqual(['名称是白底图，但边缘不是纯白'])
    expect(classifyImage('x/透明.png', facts(10, 10)).warnings).toEqual(['名称是透明图，但图片没有透明区域'])
    expect(classifyImage('x/透明.png', undefined)).toEqual({ kind: 'transparent', reason: '名称「透明」', warnings: [] })
    expect(classifyImage('场景/a.png', facts(10, 10)).kind).toBe('other')
  })

  it('splits main images by shape and leaves a main image of another shape undecided', () => {
    expect(classifyImage('方图/主图-11.png', facts(1254, 1254))).toEqual({ kind: 'main', reason: '名称「主图-11」+ 1:1（1254×1254）', warnings: [] })
    expect(classifyImage('长图/主图-01.png', facts(1440, 1920)).kind).toBe('main34')
    expect(classifyImage('主图/a.png', facts(500, 500)).warnings).toEqual(['1:1 主图建议至少 800×800，这张只有 500×500'])
    expect(classifyImage('主图/a.png', facts(16, 9))).toMatchObject({ kind: 'unknown', reason: '名称「主图」像主图，但 16×9 既不是 1:1 也不是 3:4' })
    expect(classifyImage('主图/a.webp', undefined)).toMatchObject({ kind: 'unknown', reason: '名称「主图」像主图，但无法读取像素判断比例' })
    expect(classifyImage('a.webp', undefined)).toMatchObject({ kind: 'unknown', reason: '没有名称线索，且无法读取像素' })
  })

  it('sorts unnamed images by their pixels', () => {
    expect(classifyImage('1.png', facts(800, 800, { transparentShare: 0.4 })).kind).toBe('transparent')
    expect(classifyImage('1.png', facts(800, 800, { whiteBorderShare: 0.99 })).kind).toBe('white')
    expect(classifyImage('1.png', facts(800, 800))).toEqual({ kind: 'main', reason: '1:1（800×800）', warnings: [] })
    expect(classifyImage('1.png', facts(750, 1000)).kind).toBe('main34')
    expect(classifyImage('1.png', facts(750, 1600)).kind).toBe('detail')
    expect(classifyImage('1.png', facts(1600, 900))).toMatchObject({ kind: 'unknown', reason: '没有名称线索，1600×900 不是常见的主图或详情比例' })
  })

  it('suggests the SKU field of a header', () => {
    expect(headerKey(' 到手价（元） ')).toBe('到手价')
    expect(headerKey('ＳＫＵ名称')).toBe('sku名称')
    expect(['SKU序号', '商家编码', '上架名称', '只数', '片单价', '到手价', '库存', '备注'].map(suggestField))
      .toEqual(['index', 'code', 'name', 'count', 'unitPrice', 'price', 'stock', undefined])
  })

  it('finds the header row of a sheet', () => {
    expect(tableOf('a.xlsx', 'S', [['标题'], [], ['名称', '', '价格'], ['甲', 'x', '1'], ['', '', ''], ['乙']])).toEqual({
      file: 'a.xlsx', sheet: 'S',
      columns: [{ header: '名称', field: 'name', samples: ['甲', '乙'] }, { header: '价格', field: 'price', samples: ['1', ''] }],
      rows: [['甲', '1'], ['乙', '']],
    })
    expect(tableOf('a.xlsx', 'S', [['只有一格']])).toBeUndefined()
  })

  it('reads CSV with quotes, a byte-order mark, and CRLF', () => {
    expect(readCsv('﻿a,"b,""c"""\r\n x ,y\nz')).toEqual([['a', 'b,"c"'], ['x', 'y'], ['z']])
    expect(readCsv('a,b\n')).toEqual([['a', 'b']])
  })

  it('reads every worksheet by its workbook name, and numbers them without a workbook', () => {
    const sheet = (text: string) => strToU8(`<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${text}</t></is></c></row></sheetData></worksheet>`)
    const named = zipSync({
      'xl/workbook.xml': strToU8('<workbook><sheets><sheet name="规格 &amp; 价格" r:id="rId2"/><sheet r:id="rId1"/><sheet name="丢" r:id="rId9"/><sheet name="无"/></sheets></workbook>'),
      'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/><Relationship Id="rId9"/></Relationships>'),
      'xl/worksheets/sheet1.xml': sheet('一'), 'xl/worksheets/sheet2.xml': sheet('二'),
    })
    expect(readSheets(named)).toEqual([{ name: '规格 & 价格', rows: [['二']] }, { name: '', rows: [['一']] }])
    expect(readSheets(zipSync({ 'xl/worksheets/sheet3.xml': sheet('三') }))).toEqual([{ name: 'Sheet3', rows: [['三']] }])
  })
})

describe('takeInventory', () => {
  it('takes stock of a folder like 510107068-新品准备', async () => {
    const root = await sampleFolder()
    await put(root, '说明.docx', 'x')
    await put(root, '视频/主图.mp4', 'x')
    await put(root, 'a.zip', 'x')
    await put(root, '主图/坏.webp', 'x')
    await put(root, '坏表.xlsx', 'x')
    await put(root, '空表.csv', '只有一格\n')
    await put(root, '真.png', jpeg(10, 20))
    const inventory = await takeInventory(root)
    const kinds = (kind: string) => inventory.images.filter(image => image.kind === kind).map(image => image.file)
    expect(kinds('main')).toEqual(['方图/主图-11.png', '方图/主图-12.png'])
    expect(kinds('main34')).toEqual(['长图/主图-01.png', '长图/主图-02.png'])
    expect([kinds('white'), kinds('transparent'), kinds('other')]).toEqual([['素材图/800_800-纯白.jpeg'], ['素材图/800_800透明图.png'], ['素材图/场景图.jpeg']])
    expect(kinds('detail')).toEqual(['详情页/1.png', '详情页/2.png', '详情页/3.png', '真.png'])
    expect(kinds('sku')).toEqual(['sku图/sku1.png', 'sku图/sku2.png', 'sku图/sku3.png'])
    expect(kinds('unknown')).toEqual(['主图/坏.webp'])
    expect(inventory.images.find(image => image.file === '素材图/800_800-纯白.jpeg')?.warnings).toEqual(['扩展名是 .jpeg，实际是 PNG'])
    expect(inventory.images.find(image => image.file === '真.png')?.warnings).toEqual(['扩展名是 .png，实际是 JPEG'])
    expect(inventory.images.find(image => image.file === '素材图/场景图.jpeg')?.warnings).toEqual([])
    expect(inventory.tables.map(table => [table.file, table.sheet, table.columns.map(column => column.field)])).toEqual([
      ['sku.xlsx', 'Sheet1', ['index', 'code', 'name', 'count', 'unitPrice', 'price']],
    ])
    expect([inventory.documents, inventory.videos, inventory.others]).toEqual([['说明.docx'], ['视频/主图.mp4'], ['a.zip']])
    expect(inventory.unreadable.map(entry => entry.file)).toEqual(['坏表.xlsx', '主图/坏.webp'])
  })
})

describe('answers', () => {
  it('reads valid answers and names the first wrong entry', () => {
    expect(parseAnswers('{}')).toEqual({})
    expect(parseAnswers(JSON.stringify({ columns: { 价: 'price', 备注: 'ignore' }, images: { 'a.png': 'other' }, skuImages: { 'b.png': 'SKU1' }, values: { 产地: { value: ['大陆'], source: '店铺资料' } } })))
      .toMatchObject({ columns: { 价: 'price' } })
    for (const [text, message] of [
      ['[]', '答案文件 应是对象'], ['{"columns":null}', 'columns 应是对象'], ['{"columns":{"价":"money"}}', 'columns.价 应是'],
      ['{"images":{"a":"cover"}}', 'images.a 应是'], ['{"skuImages":{"a":1}}', 'skuImages.a 应是'],
      ['{"values":{"产地":{"value":1,"source":"店铺资料"}}}', 'values.产地.value 应是'], ['{"values":{"产地":{"value":"大陆","source":"猜的"}}}', 'values.产地.source 应是'],
      ['{"values":{"产地":"大陆"}}', 'values.产地 应是对象'],
    ] as const) {
      expect(() => parseAnswers(text), text).toThrow(message)
    }
  })

  it('reads prices and counts from cells', () => {
    expect(['42.9', '￥42.90', '1,000 元', '¥ 3', 'abc', '', '-1'].map(numberIn)).toEqual([42.9, 42.9, 1000, 3, undefined, undefined, undefined])
  })
})

describe('buildDraft', () => {
  it('builds the draft with every value sourced, and lists what the model still has to write', async () => {
    const inventory = await takeInventory(await sampleFolder())
    const draft = buildDraft(inventory, {})
    expect(draft.images).toMatchObject({ main: ['方图/主图-11.png', '方图/主图-12.png'], white: ['素材图/800_800-纯白.jpeg'], unknown: [] })
    expect(draft.skuTable).toBe('sku.xlsx#Sheet1')
    expect(draft.skus).toEqual([
      { index: 'SKU1', name: '1盒【18只】', code: 'm-a', count: 18, price: 42.9, image: 'sku图/sku1.png' },
      { index: 'SKU2', name: '2盒【40只】', code: 'm-b', count: 40, price: 69.9, image: 'sku图/sku2.png' },
      { index: 'SKU3', name: '组合【48只】', code: 'm-c', count: 48, price: 72.9, image: 'sku图/sku3.png' },
    ])
    expect(draft.missing).toEqual(['商品标题（由模型根据素材生成，标「待确认」）', '商品卖点（由模型根据素材生成，标「待确认」）', '导购标题（由模型根据素材生成，标「待确认」）'])
    expect(draft.problems).toEqual([])
    expect(draft.notes).toEqual([
      '方图/主图-11.png：1:1 主图建议至少 800×800，这张只有 120×120', '方图/主图-12.png：1:1 主图建议至少 800×800，这张只有 120×120',
      '素材图/800_800-纯白.jpeg：扩展名是 .jpeg，实际是 PNG',
    ])
    expect(buildDraft(inventory, ANSWERS).missing).toEqual([])
  })

  const inventoryOf = (rows: string[][], images: Inventory['images'] = [], header = ['规格名称', '编码', '数量', '售价', '库存', '单只价']): Inventory => ({
    folder: '/f', images, documents: [], videos: [], others: [], unreadable: [{ file: 'x.webp', error: '坏' }],
    tables: [
      { file: 'notes.csv', sheet: '', columns: [{ header: '名称', field: 'name', samples: [] }, { header: '价格', field: 'price', samples: [] }], rows: [['x', '1']] },
      tableOf('规格.csv', '', [header, ...rows]) as Inventory['tables'][number],
    ],
  })
  const image = (file: string, kind: Inventory['images'][number]['kind']) => ({ file, kind, reason: '', warnings: [] })

  it('checks every SKU value by rule', () => {
    const draft = buildDraft(inventoryOf([
      ['甲', 'c1', '10', '20', '5', '3'], ['', 'c2', '1', '1'], ['乙', 'c3', '1', '免费'], ['丙', 'c1', '2.5', '9.9', 'x'], ['甲', '', '', '9'],
    ]), {})
    expect(draft.skuTable).toBe('规格.csv')
    expect(draft.skus.map(sku => sku.name)).toEqual(['甲', '丙', '甲'])
    expect(draft.skus[2]).toEqual({ index: '3', name: '甲', price: 9 })
    expect(draft.problems).toEqual([
      'SKU 表第 3 行没有 规格名称', 'SKU「乙」的售价「免费」不是有效价格', 'SKU「丙」的数量「2.5」不是整数', 'SKU「丙」的库存「x」不是整数',
      'SKU 名称「甲」重复', '商家编码「c1」重复',
    ])
    expect(draft.notes).toEqual(['x.webp 读不出来：坏', 'SKU「甲」：售价 20 ÷ 数量 10 ≠ 单只价 3，请核对'])
    expect(draft.missing.slice(0, 3)).toEqual(['SKU「甲」的 SKU 图', 'SKU「丙」的 SKU 图', 'SKU「甲」的 SKU 图'])
  })

  it('takes the model\'s columns, image kinds, and SKU images over the rules', () => {
    const images = [image('a/1.png', 'unknown'), image('b/sku-2.png', 'sku'), image('b/sku-1.png', 'sku'), image('b/封面.png', 'sku'), image('b/多余.png', 'sku')]
    const lettered = buildDraft(inventoryOf([['A款', '甲', '20']], [image('s/1.png', 'sku')], ['序号', '款', '售价']), { columns: { 款: 'name' } })
    expect(lettered.skus).toEqual([{ index: 'A款', name: '甲', price: 20, image: 's/1.png' }])
    const draft = buildDraft(inventoryOf([['甲', 'c1', '', '20'], ['乙', 'c2', '', '30']], images, ['款', '编码', '数量', '售价']), {
      columns: { 款: 'name', 编码: 'ignore' }, images: { 'a/1.png': 'main', 'nope.png': 'main' }, skuImages: { 'b/封面.png': '乙', 'b/多余.png': 'nobody' },
    })
    expect(draft.images.main).toEqual(['a/1.png'])
    expect(draft.skus).toEqual([{ index: '1', name: '甲', price: 20, image: 'b/sku-1.png' }, { index: '2', name: '乙', price: 30, image: 'b/封面.png' }])
    expect(draft.problems).toEqual(['答案里的图片 nope.png 不在素材文件夹里', '这些 SKU 图对不上任何 SKU：b/sku-2.png、b/多余.png'])
  })

  it('names images left undecided and a missing SKU table', () => {
    const draft = buildDraft({ folder: '/f', images: [image('a.webp', 'unknown')], tables: [], documents: [], videos: [], others: [], unreadable: [] }, {})
    expect(draft.problems).toEqual(['有 1 张图片还没归类：a.webp'])
    expect(draft.missing[0]).toBe('SKU 表（需要至少有 SKU 名称和价格两列）')
    expect(draft.skuTable).toBeUndefined()
  })
})

describe('checkDraft', () => {
  const draftOf = (more: Partial<Draft> = {}): Draft => ({
    folder: '/f', images: { main: ['m1', 'm2'], main34: [], white: ['w'], transparent: [], detail: [], sku: [], other: [], unknown: [] },
    skus: [{ index: '1', name: '甲', price: 42.9, stock: 5 }, { index: '2', name: '乙', price: 69.9, stock: 7 }],
    values: ANSWERS.values ?? {}, missing: [], problems: [], notes: [], ...more,
  })
  const byKey = (draft: Draft, rules = RULES) => Object.fromEntries(checkDraft(draft, rules).map(check => [check.key, check]))

  it('fills the form from images, SKUs, and sourced values, normalizing options', () => {
    const checks = byKey(draftOf())
    expect(Object.keys(checks)).toEqual([
      'mainImagesGroup', 'title', 'shopping_title', 'tmSubTitle', 'p-20000', 'p-8484762', 'p-8484761', 'p-132644733', 'p-168920851',
      'personalUseConfirm', 'productConfirm', 'sku', 'price', 'quantity', 'shelfTime', 'tmDeliveryTime', 'yinHeWhiteBgImage', 'descRepublicOfSell',
    ])
    expect(checks.mainImagesGroup).toMatchObject({ status: '已填', source: '素材原值', value: '2 张' })
    expect(checks.title).toMatchObject({ status: '待确认', source: '模型生成', value: '名流水多多三合一玻尿酸避孕套' })
    expect(checks['p-20000']).toMatchObject({ status: '已填', source: '店铺资料', value: '名流' })
    expect(checks['p-8484762']).toMatchObject({ status: '已填', value: '其他', note: '「其它」已按平台可选值写成「其他」' })
    expect(checks['p-8484761']).toMatchObject({ status: '已填', value: '超薄型', note: '「超薄 型」已按平台可选值写成「超薄型」' })
    expect(checks['p-132644733']).toMatchObject({ status: '已填', note: '「皖械注准20182180006」不在可选值里，作为自定义值' })
    expect(checks['p-168920851']).toEqual({ key: 'p-168920851', label: '产品标准', required: true, status: '缺失' })
    expect(checks.personalUseConfirm).toMatchObject({ status: '待店铺确认', value: '确认个人可自行使用。' })
    expect(checks.productConfirm).toMatchObject({ status: '待店铺确认', value: '产品确认' })
    expect(checks.sku).toMatchObject({ status: '已填', value: '2 个 SKU' })
    expect(checks.price).toMatchObject({ status: '已填', value: '42.9', source: '素材原值', note: '取最低的 SKU 价格' })
    expect(checks.quantity).toMatchObject({ status: '已填', value: '12' })
    expect(checks.shelfTime).toMatchObject({ status: '已填', source: '发品规则', value: '放入仓库' })
    expect(checks.descRepublicOfSell).toMatchObject({ status: '缺失', note: '素材里没有详情图' })
  })

  it('refuses a closed option, an over-wide title, and a price that is no SKU price', () => {
    const values = {
      商品标题: { value: '名'.repeat(31), source: '模型生成' as const }, '安全套 外观形状': { value: '螺纹', source: '店铺资料' as const },
      一口价: { value: '50', source: '店铺资料' as const }, 颜色: { value: ['透明', '其它'], source: '店铺资料' as const },
    }
    const checks = byKey(draftOf({ values }))
    expect(checks.title).toMatchObject({ status: '不符合', note: '标题宽度 62，天猫最多 60（汉字算 2）' })
    expect(checks['p-8484762']).toMatchObject({ status: '不符合', note: '「螺纹」不在可选值里' })
    expect(checks.price).toMatchObject({ status: '不符合', value: '50', note: '一口价必须等于某个 SKU 的价格（42.9、69.9）' })
    expect(checks['p-31889']).toMatchObject({ status: '不符合', value: '透明、其它' })
    expect(byKey(draftOf({ values: { 一口价: { value: '69.9', source: '店铺资料' } } })).price).toEqual({
      key: 'price', label: '一口价', required: true, status: '已填', source: '店铺资料', value: '69.9',
    })
    expect(byKey(draftOf({ values: { 一口价: { value: '贵', source: '店铺资料' } } })).price).toMatchObject({ status: '不符合', note: '一口价不是数字' })
  })

  it('marks what is missing, notes the page conditions, and caps images at what the platform takes', () => {
    const images = { main: ['1', '2', '3', '4', '5', '6'], main34: [], white: [], transparent: [], detail: ['d'], sku: [], other: [], unknown: [] }
    const checks = byKey(draftOf({ images, skus: [], values: {} }))
    expect(checks.mainImagesGroup).toMatchObject({ value: '5 张', note: '有 6 张，平台最多 5 张，只用前 5 张' })
    expect(checks.sku).toBeUndefined()
    expect(checks.price).toMatchObject({ status: '缺失', note: '没有 SKU 价格' })
    expect(checks.quantity).toMatchObject({ status: '缺失', note: '需要每个 SKU 的库存；页面有显示/必填条件，条件不成立时不需要' })
    expect(checks.title).toMatchObject({ status: '缺失' })
    const required = byKey(draftOf({ skus: [] }), { ...RULES, fields: [rule({ key: 'sku', label: '销售规格' })] })
    expect(required.sku).toMatchObject({ status: '缺失', note: '没有 SKU' })
    const stockless = byKey(draftOf({ skus: [{ index: '1', name: '甲', price: 1 }], values: { 库存: { value: '100', source: '店铺资料' } } }))
    expect(stockless.quantity).toMatchObject({ status: '已填', value: '100', source: '店铺资料' })
    const hidden = byKey(draftOf({ values: { 商品资质: { value: '有', source: '店铺资料' } } }))
    expect(hidden.qualification).toMatchObject({ status: '已填', value: '有' })
  })

  it('compares texts the way the platform\'s options are, and counts a title the way Tmall does', () => {
    expect(optionKey(' 其它　款 ')).toBe('其他款')
    expect(titleWidth('名流ab')).toBe(6)
  })
})

describe('product-draft script', () => {
  it('reads the command line', () => {
    expect(parseProductDraftOptions(['inventory', '--folder', 'f'])).toEqual({ command: 'inventory', folder: 'f', out: '发品草稿' })
    expect(parseProductDraftOptions(['draft', '--folder', 'f', '--answers', 'a.json', '--rules', 'r.json', '--out', 'o']))
      .toEqual({ command: 'draft', folder: 'f', out: 'o', answers: 'a.json', rules: 'r.json' })
    for (const argv of [['inventory', '--bogus'], [], ['publish', '--folder', 'f'], ['inventory'], ['draft', '--folder', '']]) {
      expect(() => parseProductDraftOptions(argv), argv.join(' ')).toThrow(expect.objectContaining({ exitCode: EXIT.usage }) as Error)
    }
  })

  it('reads a field-rules file', () => {
    expect(parseRulesFile('{"catId":"1","fields":[]}')).toEqual({ catId: '1', categoryPath: '', fields: [] })
    expect(() => parseRulesFile('{"fields":[]}')).toThrow('不是字段规则文件')
  })

  it('takes stock of a folder and saves the inventory', async () => {
    const root = await sampleFolder()
    const out = await folder()
    const deps = fakeDeps(new FakePage([]))
    expect(await main(['inventory', '--folder', root, '--out', out], deps)).toBe(0)
    const text = deps.out.join('')
    expect(text).toContain('图片 13 张、表格 1 张、文档 0 个、视频 0 个、其他文件 0 个。')
    expect(text).toContain('- 1:1 主图（2）：\n  - 方图/主图-11.png ← 名称「主图-11」+ 1:1（120×120）')
    expect(text).toContain('| 上架名称 | SKU 名称 | 1盒【18只】 / 2盒【40只】 / 组合【48只】 |')
    expect(text).toContain('- 素材图/800_800-纯白.jpeg：扩展名是 .jpeg，实际是 PNG')
    expect(JSON.parse(await readFile(join(out, '素材清点.json'), 'utf8'))).toMatchObject({ folder: root })
  })

  it('builds the draft, checks it against the rules, and saves the draft and the checklist', async () => {
    const root = await sampleFolder()
    const out = await folder()
    await writeFile(join(out, 'answers.json'), JSON.stringify(ANSWERS))
    await writeFile(join(out, 'rules.json'), JSON.stringify(RULES))
    const deps = fakeDeps(new FakePage([]))
    expect(await main(['draft', '--folder', root, '--answers', join(out, 'answers.json'), '--rules', join(out, 'rules.json'), '--out', out], deps)).toBe(0)
    const text = deps.out.join('')
    expect(text).toContain('图片：1:1 主图 2、3:4 主图 2、白底图 1、透明素材图 1、详情图 3、SKU 图 3（其他素材 1 张不使用：素材图/场景图.jpeg）')
    expect(text).toContain('| SKU1 | 1盒【18只】 | m-a | 18 | 42.9 |  | sku图/sku1.png |')
    expect(text).toContain('待确认（模型生成）：\n- 商品标题：名流水多多三合一玻尿酸避孕套')
    expect(text).toContain('按类目 计生用品 > 避孕套（50024154）的字段规则检查：缺失 3、不符合 0、待店铺确认 2、待确认 3、已填 12')
    expect(text).toContain('- personalUseConfirm：确认个人可自行使用。')
    expect(text).toContain('- 安全套 外观形状（p-8484762）：其他〔沿用旧商品〕 —— 「其它」已按平台可选值写成「其他」')
    const draft = JSON.parse(await readFile(join(out, '商品草稿.json'), 'utf8')) as { catId: string; checks: unknown[]; createdAt: string }
    expect([draft.catId, draft.checks.length, draft.createdAt]).toEqual(['50024154', 20, '2026-10-08T03:00:00.000Z'])
    expect(await readFile(join(out, '待确认清单.md'), 'utf8')).toMatch(/^# 待确认清单\n\n商品草稿/u)
  })

  it('builds a draft without answers or rules', async () => {
    const root = await sampleFolder()
    const out = await folder()
    const deps = fakeDeps(new FakePage([]))
    expect(await main(['draft', '--folder', root, '--out', out], deps)).toBe(0)
    expect(deps.out.join('')).not.toContain('字段规则检查')
    expect(JSON.parse(await readFile(join(out, '商品草稿.json'), 'utf8'))).not.toHaveProperty('checks')
  })

  it('describes a draft without rules or SKUs', () => {
    const draft: Draft = {
      folder: '/f', images: { main: [], main34: [], white: [], transparent: [], detail: [], sku: [], other: [], unknown: [] },
      skus: [], values: { 商品标题: { value: ['a', 'b'], source: '模型生成' }, 产地: { value: '大陆', source: '店铺资料' } },
      missing: ['详情图'], problems: ['p'], notes: ['n'],
    }
    expect(draftText(draft)).toBe([
      '商品草稿（素材 /f）', '图片：1:1 主图 0、3:4 主图 0、白底图 0、透明素材图 0、详情图 0、SKU 图 0', '', 'SKU（0）：', '', '待确认（模型生成）：', '- 商品标题：a、b',
      '', '缺失（需要用户补充或模型生成，不拿别的素材顶替）：', '- 详情图', '', '问题：', '- p', '', '提示：', '- n',
    ].join('\n'))
    const listed = draftText({ ...draft, skus: [{ index: '1', name: '甲', price: 1 }, { index: '2', name: '乙', price: 2, stock: 9 }], values: {}, missing: [], problems: [], notes: [] })
    expect(listed).toContain('| 1 | 甲 |  |  | 1 |  | 缺 |\n| 2 | 乙 |  |  | 2 | 9 | 缺 |')
  })

  it('describes documents, videos, other files, and unreadable files', () => {
    const text = inventoryText({ folder: '/f', images: [], tables: [{ file: 'a.csv', sheet: '', columns: [{ header: '备注', samples: ['x'] }], rows: [] }], documents: ['d.pdf'], videos: ['v.mp4'], others: ['o.zip'], unreadable: [{ file: 'b.xlsx', error: '坏' }] })
    expect(text).toContain('表格 a.csv（0 行）：')
    expect(text).toContain('| 备注 | 未识别 | x |')
    expect(text).toContain('文档：d.pdf\n\n视频：v.mp4\n\n其他文件：o.zip\n\n读不出来的文件：\n- b.xlsx：坏')
  })

  it('refuses wrong inputs with the reason', async () => {
    const root = await sampleFolder()
    const out = await folder()
    await writeFile(join(out, 'bad.json'), '{"images":{"a":"cover"}}')
    await writeFile(join(out, 'rules.json'), '{"fields":[]}')
    const run = async (argv: string[]) => {
      const deps = fakeDeps(new FakePage([]))
      return [await main(argv, deps), deps.err.join('')] as const
    }
    expect(await run(['draft', '--folder', join(out, 'none'), '--out', out])).toEqual([EXIT.usage, expect.stringContaining('读不到素材文件夹')])
    expect(await run(['draft', '--folder', root, '--answers', join(out, 'none.json'), '--out', out])).toEqual([EXIT.usage, expect.stringContaining('读不到答案文件')])
    expect(await run(['draft', '--folder', root, '--answers', join(out, 'bad.json'), '--out', out])).toEqual([EXIT.usage, expect.stringContaining('答案文件')])
    expect(await run(['draft', '--folder', root, '--rules', join(out, 'none.json'), '--out', out])).toEqual([EXIT.usage, expect.stringContaining('读不到字段规则文件')])
    expect(await run(['draft', '--folder', root, '--rules', join(out, 'rules.json'), '--out', out])).toEqual([EXIT.usage, expect.stringContaining('不是字段规则文件')])
    expect(await run(['draft'])).toEqual([EXIT.usage, expect.stringContaining('缺少 --folder')])
    expect(await run(['inventory', '--folder', root, '--out', join(out, 'bad.json')])).toEqual([EXIT.failed, expect.stringContaining('失败：')])
    const odd = fakeDeps(new FakePage([]), {
      now: () => {
        throw 'clock'
      },
    })
    expect(await main(['inventory', '--folder', root, '--out', out], odd)).toBe(EXIT.failed)
    expect(odd.err.join('')).toBe('失败：clock\n')
  })
})
