import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EXIT, SkillError } from '../src/errors.ts'
import { CACHE_DAYS, main, parsePublishCategoryOptions, resolutionText, rulesText } from '../src/publish-category-cli.ts'
import {
  categoryOf, childCategories, ENTRY_URL, isSignIn, MANAGER_URL, ownItems, ownItemsExpression, resolveCategory, searchCategories,
  storeCategories, type TmallCategory,
} from '../src/publish-category.ts'
import { conditionsByField, parseRules, publishUrl, readRules, type PageForm } from '../src/publish-rules.ts'
import { fakeDeps, FakePage, on, tempDir, type Route } from './support.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function outDir(): Promise<string> {
  const { dir, cleanup } = await tempDir()
  cleanups.push(cleanup)
  return dir
}

/** A tab whose waits poll a few times, as a real page's do. */
class PollingPage extends FakePage {
  override async waitFor(condition: () => boolean | Promise<boolean>): Promise<boolean> {
    for (let i = 0; i < 3; i++) if (await condition()) return true
    return false
  }
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

/** The category tree as Tmall's endpoint answers it for 名流旗舰店 (trimmed). */
const TREE: Record<string, object[]> = {
  '': [
    { id: 50023717, name: '计生用品', path: ['计生用品'], idpath: [50023717], publish: false, isAuthorized: true },
    { id: 50012082, name: '家用电器', path: ['家用电器'], idpath: [50012082], publish: false, isAuthorized: false },
  ],
  50023717: [
    { id: 50024154, name: '避孕套', path: ['计生用品', '避孕套'], idpath: [50023717, 50024154], publish: true, isAuthorized: true, tips: '' },
    { id: 50019642, name: '润滑剂', path: ['计生用品', '润滑剂'], idpath: [50023717, 50019642], publish: true, isAuthorized: true, tips: '需医疗器械资质' },
    { id: 9, name: '名流', isBrand: true, publish: true, isAuthorized: true },
  ],
  50012082: [{ id: 350301, name: '电吹风', path: ['家用电器', '电吹风'], idpath: [50012082, 350301], publish: true, isAuthorized: false }],
}

const CONDOMS: TmallCategory = {
  id: '50024154', name: '避孕套', path: ['计生用品', '避孕套'], idPath: ['50023717', '50024154'], publishable: true, authorized: true,
}
const LUBE: TmallCategory = {
  id: '50019642', name: '润滑剂', path: ['计生用品', '润滑剂'], idPath: ['50023717', '50019642'], publishable: true, authorized: true, tips: '需医疗器械资质',
}

const tree: Route = on('categorySelectChildren', (expression: string) => {
  const parent = /catId=(\d+)/u.exec(expression)?.[1] ?? ''
  return { success: true, data: { dataSource: TREE[parent] ?? [] } }
})

const search: Route = on('retrievalDataAsyncOpt', {
  success: true,
  data: {
    category: [
      { id: 50024154, name: '避孕套', path: ['计生用品', '避孕套'], idpath: [50023717, 50024154], publish: true, isAuthorized: true },
      { id: 125322008, name: '安全套', path: ['医疗器械', '安全套'], idpath: [1, 125322008], publish: true, isAuthorized: false },
      { id: 50023717, name: '计生用品', publish: false, isAuthorized: true },
    ],
  },
})

const ROWS = [
  { itemId: 823072723001, catId: 50024154, itemDesc: { desc: [{ text: '名流 水多多 避孕套 10只' }] } },
  { itemId: 823072723002, catId: 50024154, itemDesc: { desc: [{ text: '名流 水多多 避孕套 20只' }] } },
  { itemId: 823072723003, catId: 50019642, itemDesc: { desc: [{ text: '名流 水多多 润滑剂' }] } },
  { itemId: 823072723004, catId: 777 },
]

function manager(rows: readonly object[]): Route {
  return on('mtop.tmall.sell.pc.manage.async', (expression: string) => {
    const id = /\\"queryItemId\\":\\"(\d+)\\"/u.exec(expression)?.[1]
    return { rows: id === undefined ? rows : rows.filter(row => String((row as { itemId: number }).itemId) === id) }
  })
}

const ready: Route = expression => expression.startsWith('document.readyState') || expression.startsWith('Boolean(window.lib') ? true : undefined

/** A trimmed `window.Json2` of the 50024154 publish page. */
const FORM: PageForm = {
  components: {
    root: { type: 'struct', props: { name: 'root' } },
    nameless: { type: 'input', props: {} },
    title: { type: 'input', props: { name: 'title', label: '宝贝标题', required: true, maxLength: 60 } },
    shelfTime: {
      type: 'radio',
      props: { name: 'shelfTime', label: '上架时间', required: true, dataSource: [{ value: 0, text: '立刻上架' }, { value: 2, text: '放入仓库' }, 'x', { value: true, text: 'y' }] },
    },
    tmDescription: { type: 'tmDesc', props: { name: 'tmDescription', label: '电脑端描述', required: true, visible: false } },
    newProductConfirmation: { type: 'checkbox', props: { name: 'newProductConfirmation', descriptions: { data: { label: '新品确认' } }, dataSource: [] } },
    personalUseConfirm: {
      type: 'checkbox',
      props: { name: 'personalUseConfirm', label: '', uiType: 'checkbox', required: true, dataSource: [{ value: '1', text: '确认可由消费者个人自行使用。' }] },
    },
    productConfirm: { type: 'checkbox', props: { name: 'productConfirm', label: '产品确认', required: true, readonly: true, dataSource: [{ value: '1', text: '信息准确无误' }] } },
    keyProp: {
      type: 'catProp',
      props: {
        name: 'keyProp',
        dataSource: [
          { name: 'p-20000', label: '品牌', uiType: 'select', required: true, readonly: true, dataSource: [{ value: 1, text: '名流' }] },
          { name: 'p-1', label: '', uiType: 'combobox', dataSource: [{ value: 'a', text: '其他' }] },
          { name: 'p-2', maxLength: 20 },
        ],
      },
    },
    itemProp: { type: 'catProp', props: { name: 'itemProp', visible: false } },
    color: { type: 'newColorSelect', props: { name: 'color', label: '颜色' } },
  },
  models: { catpath: { value: '当前类目：计生用品>>避孕套' } },
  rules: [
    { condition: '$.descType == 1', target: { tmDescription: { props: { visible: true } } } },
    { nested: [{ condition: '$.descType == 1', target: { tmDescription: {} } }, { condition: '$.isNew', target: { newProductConfirmation: {} } }] },
    { condition: 1, target: { ignored: {} } },
    null,
  ],
}

describe('categories', () => {
  it('reads a node, filling a missing path and dropping an empty tip', () => {
    expect(categoryOf({ id: 5, name: '避孕套', tips: '' })).toEqual({
      id: '5', name: '避孕套', path: ['避孕套'], idPath: ['5'], publishable: false, authorized: false,
    })
    expect(isSignIn('https://login.taobao.com/x')).toBe(true)
    expect(isSignIn(ENTRY_URL)).toBe(false)
  })

  it('walks the tree down to the publishable categories the store is authorized for, brands left out', async () => {
    const page = new FakePage([tree])
    expect(await storeCategories(page, 0)).toEqual([CONDOMS, LUBE])
    expect(page.evaluated.filter(e => e.includes('categorySelectChildren')).map(e => /catId=(\d+)/u.exec(e)?.[1])).toEqual([undefined, '50023717', '50012082'])
  })

  it('fails loudly when the tree endpoint refuses', async () => {
    const page = new FakePage([on('categorySelectChildren', { success: false })])
    expect((await stopped(childCategories(page, '1'))).message).toContain('上级类目 1')
    expect((await stopped(childCategories(page))).message).toContain('顶层')
    expect(await childCategories(new FakePage([on('categorySelectChildren', { success: true })]))).toEqual([])
  })

  it('splits a search into the categories the store may use and those it may not', async () => {
    const found = await searchCategories(new FakePage([search]), '避孕套')
    expect(found.authorized.map(c => c.id)).toEqual(['50024154'])
    expect(found.unauthorized.map(c => c.id)).toEqual(['125322008'])
    expect(await searchCategories(new FakePage([on('retrievalDataAsyncOpt', { success: true })]), 'x')).toEqual({ authorized: [], unauthorized: [] })
    await expect(searchCategories(new FakePage([on('retrievalDataAsyncOpt', {})]), 'x')).rejects.toMatchObject({ exitCode: EXIT.failed })
  })

  it('lists own items through the manager page and fails loudly when it cannot', async () => {
    expect(ownItemsExpression({ queryTitle: '水多多' }, 5)).toContain('\\"queryTitle\\":\\"水多多\\"')
    expect(ownItemsExpression({}, 5)).toContain('\\"tab\\":\\"all\\"')
    expect(await ownItems(new FakePage([manager(ROWS)]), { queryTitle: '水多多' })).toContainEqual({ itemId: '823072723004', catId: '777', title: '' })
    expect((await stopped(ownItems(new FakePage([on('mtop', { ret: 'FAIL_SYS_SESSION_EXPIRED' })]), {}))).message).toContain('FAIL_SYS_SESSION_EXPIRED')
    expect((await stopped(ownItems(new FakePage([on('mtop', {})]), {}))).message).toContain('无应答')
  })
})

const MEMORY = {
  stores: {}, columns: {}, declarations: {},
  categories: {
    // One product line keeps a category on each platform.
    水多多: {
      pinduoduo: { catId: '18770', categoryPath: 'y', updatedAt: 't' },
      tmall: { catId: '50024154', categoryPath: '计生用品 > 避孕套', updatedAt: '2026-10-08T11:00:00.000Z' },
      doudian: { catId: '1000000638', categoryPath: 'z', updatedAt: 't' },
    },
    颗粒: { tmall: { catId: '126198864', categoryPath: 'x', updatedAt: 't' } },
    拼团: { pinduoduo: { catId: '18770', categoryPath: 'y', updatedAt: 't' }, doudian: { catId: '1000000638', categoryPath: 'z', updatedAt: 't' } },
    // A platform name an older remember saved is shown as it was saved.
    旧线: { 淘宝店: { catId: '1', categoryPath: 'w', updatedAt: 't' } },
  },
}

describe('resolveCategory', () => {
  const context = { categories: () => Promise.resolve([CONDOMS, LUBE]), memory: () => Promise.resolve(MEMORY) }

  it('takes the category the company remembered for a product line, while the store may still publish in it', async () => {
    const line = (name: string) => resolveCategory(new FakePage([]), { kind: 'line', line: name }, context)
    expect((await line('水多多')).candidates).toEqual([{ category: CONDOMS, reason: '记住的产品线「水多多」类目（2026-10-08 19:00 北京时间保存）' }])
    expect((await line('无')).note).toBe('DSH 里还没有记住产品线「无」的类目。')
    expect((await line('颗粒')).note).toBe('记住的产品线「颗粒」类目 126198864 现在不能在这家店发布（可能授权已变化）。')
    // Another platform's category id never stands in for Tmall's.
    expect((await line('旧线')).note).toBe('DSH 记住了产品线「旧线」在淘宝店的类目，还没有记住天猫的；按商品名或主图找天猫类目，用户确认后再记下。')
    expect((await line('拼团')).note).toBe('DSH 记住了产品线「拼团」在拼多多、抖店的类目，还没有记住天猫的；按商品名或主图找天猫类目，用户确认后再记下。')
  })

  it('takes only the requested item from the manager answer', async () => {
    const loose = new FakePage([ready, on('mtop.tmall.sell.pc.manage.async', { rows: ROWS.slice(0, 1) })])
    expect((await resolveCategory(loose, { kind: 'item', input: '823072723003' }, context)).note).toContain('不是这家店的商品')
  })

  it('checks a given id against the store categories', async () => {
    expect((await resolveCategory(new FakePage([]), { kind: 'id', id: '50024154' }, context)).candidates).toEqual([{ category: CONDOMS, reason: '用户指定的类目' }])
    expect((await stopped(resolveCategory(new FakePage([]), { kind: 'id', id: '126198864' }, context))).exitCode).toBe(EXIT.usage)
  })

  it('takes the category of an own item, and explains an item from another store or a lost category', async () => {
    const page = new FakePage([ready, manager(ROWS)])
    const own = await resolveCategory(page, { kind: 'item', input: 'https://detail.tmall.com/item.htm?id=823072723003' }, context)
    expect(own.candidates).toEqual([{ category: LUBE, reason: '本店商品 823072723003「名流 水多多 润滑剂」所在类目' }])
    expect(page.visited).toEqual([MANAGER_URL])
    expect((await resolveCategory(page, { kind: 'item', input: '823072723004' }, context)).note).toContain('类目 777 现在不能发布')
    expect((await resolveCategory(page, { kind: 'item', input: '999999' }, context)).note).toContain('不是这家店的商品')
  })

  it('groups own items by category, most items first', async () => {
    const page = new FakePage([ready, manager(ROWS)])
    const found = await resolveCategory(page, { kind: 'own', keyword: '水多多' }, context)
    expect(found.candidates.map(c => [c.category.id, c.reason])).toEqual([
      ['50024154', '本店标题含「水多多」的 2 个商品在此类目，如「名流 水多多 避孕套 10只」'],
      ['50019642', '本店标题含「水多多」的 1 个商品在此类目，如「名流 水多多 润滑剂」'],
    ])
    expect(found.note).toBe('本店标题含「水多多」的商品还有 1 个类目现在不能发布（可能授权已变化）：777')
    const usable = await resolveCategory(new FakePage([ready, manager(ROWS.slice(0, 3))]), { kind: 'own', keyword: '水多多' }, context)
    expect(usable.note).toBeUndefined()
    expect((await resolveCategory(new FakePage([ready, manager([])]), { kind: 'own', keyword: '无' }, context)).note).toBe('本店没有标题含「无」的商品。')
  })

  it('searches by product name and names the categories the store may not use', async () => {
    const page = new FakePage([ready, search])
    const found = await resolveCategory(page, { kind: 'keyword', keyword: '避孕套' }, context)
    expect(found.candidates.map(c => c.category.id)).toEqual(['50024154'])
    expect(found.note).toBe('另有 1 个类目这家店未授权，不能用：医疗器械 > 安全套')
    expect(page.visited).toEqual([ENTRY_URL])
    const plain = await resolveCategory(new FakePage([ready, on('retrievalDataAsyncOpt', { success: true, data: { category: [] } })]), { kind: 'keyword', keyword: 'x' }, context)
    expect(plain).toEqual({ source: { kind: 'keyword', keyword: 'x' }, candidates: [] })
  })

  it('stops on a sign-in page and on a page that never becomes ready', async () => {
    const signIn = new FakePage([], (_url, page) => { page.href = 'https://login.taobao.com/member/login.jhtml' })
    expect((await stopped(resolveCategory(signIn, { kind: 'keyword', keyword: 'x' }, context))).exitCode).toBe(EXIT.signedOut)
    const stuck = new FakePage([expression => expression.startsWith('Boolean(window.lib') ? false : undefined])
    expect((await stopped(resolveCategory(stuck, { kind: 'own', keyword: 'x' }, context))).message).toContain(MANAGER_URL)
  })
})

describe('field rules', () => {
  it('collects the conditions that change each field', () => {
    expect(conditionsByField(FORM.rules)).toEqual(new Map([['tmDescription', ['$.descType == 1']], ['newProductConfirmation', ['$.isNew']]]))
  })

  it('turns the page form into fields, declarations, and category properties', () => {
    const rules = parseRules(FORM, '50024154')
    expect(rules.categoryPath).toBe('计生用品>>避孕套')
    expect(rules.fields).toEqual([
      { key: 'title', label: '宝贝标题', uiType: 'input', required: true, maxLength: 60, visible: true },
      {
        key: 'shelfTime', label: '上架时间', uiType: 'radio', required: true, visible: true,
        options: [{ value: 0, text: '立刻上架' }, { value: 2, text: '放入仓库' }],
      },
      { key: 'tmDescription', label: '电脑端描述', uiType: 'tmDesc', required: true, visible: false, conditions: ['$.descType == 1'] },
      { key: 'newProductConfirmation', label: '新品确认', uiType: 'checkbox', required: false, visible: true, conditions: ['$.isNew'] },
      {
        key: 'personalUseConfirm', label: 'personalUseConfirm', uiType: 'checkbox', required: true, visible: true, declaration: true,
        options: [{ value: '1', text: '确认可由消费者个人自行使用。' }],
      },
      {
        key: 'productConfirm', label: '产品确认', uiType: 'checkbox', required: true, readonly: true, visible: true, declaration: true,
        options: [{ value: '1', text: '信息准确无误' }],
      },
      { key: 'p-20000', label: '品牌', uiType: 'select', required: true, propGroup: 'keyProp', readonly: true, visible: true, options: [{ value: 1, text: '名流' }] },
      { key: 'p-1', label: 'p-1', uiType: 'combobox', required: false, propGroup: 'keyProp', allowsCustom: true, visible: true, options: [{ value: 'a', text: '其他' }] },
      { key: 'p-2', label: 'p-2', uiType: 'input', required: false, propGroup: 'keyProp', maxLength: 20, visible: true },
      { key: 'color', label: '颜色', uiType: 'newColorSelect', required: false, allowsCustom: true, visible: true },
    ])
    const promises = parseRules({ components: { promise: { type: 'checkbox', props: { name: 'promise', label: '服务承诺', required: true, dataSource: [
      { value: 1, text: '七天退货' }, { value: 2, text: '运费险' },
    ] } } } }, '1')
    expect(promises.fields[0]?.declaration).toBeUndefined()
    expect(parseRules({ components: {} }, '1')).toEqual({ catId: '1', categoryPath: '', fields: [] })
  })

  it('reads the rules from the AI publish page', async () => {
    const page = new FakePage([on('window.Json2', { form: FORM })])
    expect((await readRules(page, '50024154')).fields).toHaveLength(10)
    expect(page.visited).toEqual([publishUrl('50024154')])
    expect(publishUrl('50024154')).toBe('https://sell.publish.tmall.com/tmall/publish.htm?catId=50024154&newRouter=1&fromAIPublish=true')
  })

  it('fails loudly instead of answering an empty rule set', async () => {
    const refused = new FakePage([on('window.Json2', { error: '错误：类目为空或不存在' })])
    expect(await stopped(readRules(refused, '1'))).toMatchObject({ exitCode: EXIT.usage, message: '天猫不让这家店在类目 1 发布：错误：类目为空或不存在' })
    const changed = await stopped(readRules(new FakePage([on('window.Json2', { error: '  页面\n升级中 ' })]), '1'))
    expect(changed).toMatchObject({ exitCode: EXIT.failed, message: '天猫发布页没有给出表单字段（类目 1），页面可能已改版。页面显示：页面 升级中' })
    expect((await stopped(readRules(new FakePage([on('window.Json2', {})]), '1'))).message).toBe('天猫发布页没有给出表单字段（类目 1），页面可能已改版。')
    const empty = new FakePage([on('window.Json2', { form: { components: { root: { type: 'struct', props: { name: 'root' } } } } })])
    expect((await stopped(readRules(empty, '1'))).message).toBe('天猫发布页没有给出表单字段（类目 1），页面可能已改版。')
    let loads = 0
    const later = new PollingPage([on('window.Json2', () => { later.href = 'https://login.taobao.com/'; loads++; return {} })])
    expect((await stopped(readRules(later, '1'))).exitCode).toBe(EXIT.signedOut)
    expect(loads).toBe(1)
    const signIn = new FakePage([], (_url, page) => { page.href = 'https://login.tmall.com/' })
    expect((await stopped(readRules(signIn, '1'))).exitCode).toBe(EXIT.signedOut)
  })
})

describe('publish-category script', () => {
  it('reads the command line', () => {
    expect(parsePublishCategoryOptions(['categories', '--account', 'a1'])).toEqual({ command: 'categories', account: 'a1', out: '天猫发品', refresh: false })
    expect(parsePublishCategoryOptions(['rules', '--account', 'a1', '--cat', '50024154', '--out', 'o', '--refresh'])).toMatchObject({ catId: '50024154', out: 'o', refresh: true })
    expect(parsePublishCategoryOptions(['resolve', '--account', 'a1', '--cat', '5']).source).toEqual({ kind: 'id', id: '5' })
    expect(parsePublishCategoryOptions(['resolve', '--account', 'a1', '--item', '5']).source).toEqual({ kind: 'item', input: '5' })
    expect(parsePublishCategoryOptions(['resolve', '--account', 'a1', '--own', '水']).source).toEqual({ kind: 'own', keyword: '水' })
    expect(parsePublishCategoryOptions(['resolve', '--account', 'a1', '--keyword', '套']).source).toEqual({ kind: 'keyword', keyword: '套' })
    expect(parsePublishCategoryOptions(['resolve', '--account', 'a1', '--line', '水多多']).source).toEqual({ kind: 'line', line: '水多多' })
    for (const argv of [
      ['categories', '--bogus'], [], ['publish', '--account', 'a1'], ['categories'], ['categories', '--account', ''],
      ['rules', '--account', 'a1'], ['rules', '--account', 'a1', '--cat', 'abc'],
      ['resolve', '--account', 'a1'], ['resolve', '--account', 'a1', '--cat', '1', '--own', 'x'], ['resolve', '--account', 'a1', '--own', ''],
    ]) {
      expect(() => parsePublishCategoryOptions(argv), argv.join(' ')).toThrow(expect.objectContaining({ exitCode: EXIT.usage }) as Error)
    }
  })

  it('describes resolutions and rules for the model', () => {
    expect(resolutionText({ source: { kind: 'own', keyword: 'x' }, candidates: [], note: '本店没有。' })).toBe('没有找到这家店可以使用的类目。\n\n本店没有。')
    expect(resolutionText({ source: { kind: 'id', id: '1' }, candidates: [{ category: LUBE, reason: '指定' }, { category: CONDOMS, reason: '另' }] })).toBe(
      '1. 计生用品 > 润滑剂（类目 id 50019642）—— 指定；提示：需医疗器械资质\n2. 计生用品 > 避孕套（类目 id 50024154）—— 另')
    const many = Array.from({ length: 7 }, (_, i) => ({ value: i, text: `选项${String(i)}` }))
    const text = rulesText({
      ...parseRules(FORM, '50024154'),
      fields: [...parseRules(FORM, '50024154').fields, { key: 'p-3', label: '规格', uiType: 'select', required: true, visible: true, options: many }],
    })
    expect(text).toBe([
      '类目：计生用品>>避孕套（50024154），共 11 个字段。',
      '',
      '必填字段（4）：',
      '- 宝贝标题（title，input）',
      '- 上架时间（shelfTime，radio），可选 2 项：立刻上架、放入仓库',
      '- 品牌（p-20000，select，只读），可选 1 项：名流',
      '- 规格（p-3，select），可选 7 项：选项0、选项1、选项2、选项3、选项4、选项5…',
      '',
      '需要店铺确认的声明（2）：',
      '- 确认可由消费者个人自行使用。（personalUseConfirm）',
      '- 产品确认：信息准确无误（productConfirm）',
      '',
      '满足条件才出现的必填字段（1）：',
      '- 电脑端描述（tmDescription，tmDesc，条件显示）',
    ].join('\n'))
    const conditional = rulesText({ catId: '1', categoryPath: 'x', fields: [
      { key: 'h', label: 'H', uiType: 'checkbox', required: true, visible: false, declaration: true, options: [{ value: '1', text: '隐藏声明' }] },
      { key: 'a', label: 'A', uiType: 'combobox', required: true, visible: true, conditions: ['$.b'], options: [{ value: 1, text: '甲' }], allowsCustom: true },
      { key: 'd', label: 'd', uiType: 'checkbox', required: true, visible: true, declaration: true },
    ] })
    expect(conditional).toContain('- A（a，combobox，受条件影响），可选 1 项（可自定义）：甲')
    expect(conditional).toContain('- d（d）')
    expect(conditional).not.toContain('满足条件才出现')
    expect(conditional.match(/隐藏声明/gu)).toHaveLength(1)
  })

  const routes = (): Route[] => [ready, tree, search, manager(ROWS), on('window.Json2', { form: { ...FORM, models: {} } })]

  it('lists the store categories and caches them per store', async () => {
    const out = await outDir()
    const page = new FakePage(routes())
    const deps = fakeDeps(page)
    expect(await main(['categories', '--account', 'a1', '--out', out], deps)).toBe(0)
    expect(deps.out.join('')).toBe([
      '店铺 名流旗舰店（主账号）（账号 名流成人用品旗舰店:小美），2026-10-08 11:00（北京时间）。',
      '这家店可以发布的类目共 2 个（刚从天猫读取）：',
      '- 计生用品 > 避孕套（50024154）',
      '- 计生用品 > 润滑剂（50019642） —— 需医疗器械资质',
      '',
    ].join('\n'))
    expect(page.closed).toBe(true)
    const cache = JSON.parse(await readFile(join(out, '类目缓存_名流旗舰店（主账号）.json'), 'utf8')) as { store: string; categories: unknown[] }
    expect(cache).toMatchObject({ store: '名流旗舰店（主账号）', categories: [CONDOMS, LUBE] })

    const again = fakeDeps(new FakePage([]))
    expect(await main(['categories', '--account', 'a1', '--out', out], again)).toBe(0)
    expect(again.out.join('')).toContain('（用 2026-10-08 11:00 的缓存）')

    const later = fakeDeps(new FakePage(routes()), { now: () => new Date(Date.parse('2026-10-08T03:00:00Z') + CACHE_DAYS * 86_400_000) })
    expect(await main(['categories', '--account', 'a1', '--out', out], later)).toBe(0)
    expect(later.out.join('')).toContain('刚从天猫读取')

    const refreshed = fakeDeps(new FakePage(routes()))
    expect(await main(['categories', '--account', 'a1', '--out', out, '--refresh'], refreshed)).toBe(0)
    expect(refreshed.out.join('')).toContain('刚从天猫读取')
  })

  it('reads the categories again when the cache lacks the one asked for, and never caches an empty list', async () => {
    const out = await outDir()
    const path = join(out, '类目缓存_名流旗舰店（主账号）.json')
    await writeFile(path, JSON.stringify({ store: 's', fetchedAt: '2026-10-08T02:00:00Z', categories: [LUBE] }))
    const deps = fakeDeps(new FakePage(routes()))
    expect(await main(['resolve', '--account', 'a1', '--cat', '50024154', '--out', out], deps)).toBe(0)
    expect(deps.out.join('')).toContain('1. 计生用品 > 避孕套（类目 id 50024154）—— 用户指定的类目')
    expect((JSON.parse(await readFile(path, 'utf8')) as { categories: unknown[] }).categories).toHaveLength(2)

    const missing = fakeDeps(new FakePage(routes()))
    expect(await main(['resolve', '--account', 'a1', '--cat', '126198864', '--out', out], missing)).toBe(EXIT.usage)

    const empty = await outDir()
    const none = fakeDeps(new FakePage([ready, on('categorySelectChildren', { success: true, data: { dataSource: [] } })]))
    expect(await main(['categories', '--account', 'a1', '--out', empty], none)).toBe(EXIT.failed)
    expect(none.err.join('')).toContain('天猫没有列出这家店可以发布的任何类目')
    await expect(readFile(join(empty, '类目缓存_名流旗舰店（主账号）.json'))).rejects.toThrow()
  })

  it('reads a damaged cache again from Tmall', async () => {
    const out = await outDir()
    const path = join(out, '类目缓存_名流旗舰店（主账号）.json')
    for (const text of ['not json', '{"fetchedAt":"2026-10-08T00:00:00Z"}']) {
      await writeFile(path, text)
      const deps = fakeDeps(new FakePage(routes()))
      expect(await main(['categories', '--account', 'a1', '--out', out], deps)).toBe(0)
      expect(deps.out.join('')).toContain('刚从天猫读取')
    }
  })

  it('resolves a category, reading the store categories once', async () => {
    const out = await outDir()
    const page = new FakePage(routes())
    const deps = fakeDeps(page)
    expect(await main(['resolve', '--account', 'a1', '--own', '水多多', '--out', out], deps)).toBe(0)
    expect(deps.out.join('')).toContain('1. 计生用品 > 避孕套（类目 id 50024154）—— 本店标题含「水多多」的 2 个商品在此类目')
    expect(page.evaluated.filter(e => e.includes('categorySelectChildren') && !e.includes('catId='))).toHaveLength(1)
    const remembered = fakeDeps(new FakePage(routes()), { memory: () => Promise.resolve(MEMORY) })
    expect(await main(['resolve', '--account', 'a1', '--line', '水多多', '--out', out], remembered)).toBe(0)
    expect(remembered.out.join('')).toContain('1. 计生用品 > 避孕套（类目 id 50024154）—— 记住的产品线「水多多」类目')
  })

  it('saves the rules of a store category, naming the category from the store list when the page does not', async () => {
    const out = await outDir()
    const deps = fakeDeps(new FakePage(routes()))
    expect(await main(['rules', '--account', 'a1', '--cat', '50024154', '--out', out], deps)).toBe(0)
    const json = join(out, '字段规则_50024154.json')
    expect(deps.out.join('')).toContain('类目：计生用品 > 避孕套（50024154），共 10 个字段。')
    expect(deps.out.join('')).toContain(`已保存：${json}`)
    expect(JSON.parse(await readFile(json, 'utf8'))).toMatchObject({ store: '名流旗舰店（主账号）', readAt: '2026-10-08T03:00:00.000Z', catId: '50024154' })

    const own = fakeDeps(new FakePage([ready, tree, on('window.Json2', { form: FORM })]))
    expect(await main(['rules', '--account', 'a1', '--cat', '50024154', '--out', out, '--refresh'], own)).toBe(0)
    expect(own.out.join('')).toContain('类目：计生用品>>避孕套（50024154）')
  })

  it('refuses rules for a category the store may not publish in, and reports failures', async () => {
    const out = await outDir()
    const deps = fakeDeps(new FakePage(routes()))
    expect(await main(['rules', '--account', 'a1', '--cat', '126198864', '--out', out], deps)).toBe(EXIT.usage)
    expect(deps.err.join('')).toContain('类目 126198864 不在这家店可以发布的类目里')

    const usage = fakeDeps(new FakePage([]))
    expect(await main(['rules'], usage)).toBe(EXIT.usage)

    const broken = fakeDeps(new FakePage([]), { openPage: () => Promise.reject(new Error('CDP 断开')) })
    expect(await main(['categories', '--account', 'a1', '--out', out], broken)).toBe(EXIT.failed)
    expect(broken.err.join('')).toBe('失败：CDP 断开\n')
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- a non-Error rejection is the scenario under test.
    const odd = fakeDeps(new FakePage([]), { takeOver: () => Promise.reject('down') })
    expect(await main(['categories', '--account', 'a1', '--out', out], odd)).toBe(EXIT.failed)
    expect(odd.err.join('')).toBe('失败：down\n')
  })
})
