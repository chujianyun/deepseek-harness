#!/usr/bin/env node
// A stand-in for Google Chrome in tests: it answers `--version`, serves the DevTools HTTP endpoints
// and the browser WebSocket on --remote-debugging-port, and plays the Tmall check: the home page
// sends `mtop.user.getusersimple`, signed in while `<user-data-dir>/fake-signed-in` holds a nick; the
// Taobao, Pinduoduo, and Douyin shop pages answer their own checks, and the Taobao and Douyin shop
// pages go to sign in while signed out; the Pinduoduo and Douyin shop pages also name the store, which
// FAKE_CHROME_NO_STORE leaves out and FAKE_CHROME_NO_STORE_BODY loses. FAKE_CHROME_OFFLINE fails every
// navigation. A connection that sets auto-attach watches every tab, as DSH's guard does: each tab's
// page loads pause until it continues or fails them; an item.taobao.com page redirects to Tmall,
// and a page whose address has risk=1 also loads a risk-control frame.
// FAKE_CHROME_VERSION sets the reported version (empty prints none); FAKE_CHROME_SILENT never sends
// the check response; FAKE_CHROME_BASE64 encodes bodies; FAKE_CHROME_STUBBORN ignores Browser.close;
// FAKE_CHROME_NO_BODY loses the check body; FAKE_CHROME_NO_CLOSE refuses to close tabs. For the Tmall
// data skills, Alimama's report page sends its scene query, and `Runtime.evaluate` answers the page
// APIs those skills call — Alimama's report query and Business Advisor's self-service export, whose
// .xlsx this server hands out — with one day's figures for scenes 371 and 436. An item page renders its
// item, fetches its description, and answers its 问大家 and review APIs, with images this server hands
// out; on item 600000000004 the APIs answer with risk control. Tmall's publish entry answers its category tree
// and search with the store's 计生用品 > 避孕套, and that category's publish page carries its form; the publish
// page also answers its image space folders and uploads and saves what its request helper submits to the
// warehouse, which the item manager lists under in_stock and all. Pinduoduo's seller pages answer the
// backend calls the pdd-publish skill makes: the 避孕套 category and its template, image uploads, and a
// 草稿箱 that a save adds to. A Douyin shop's new-item page has a form store DSH finds, its 避孕套 form,
// a draft save that adds a 下架 draft, and the category, list, and upload calls the doudian-publish skill
// makes. Its tabs are
// kept in `<user-data-dir>/fake-tabs.json` and come back with --restore-last-session. As in Chrome, a
// closed tab is still listed once by Target.getTargets, but has no window any more.
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'

const args = process.argv.slice(2)
if (args.includes('--version')) {
  const version = process.env.FAKE_CHROME_VERSION ?? '141.0.7390.65'
  if (version !== '') process.stdout.write(`Google Chrome ${version}\n`)
  process.exit(0)
}
const option = name => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const port = Number(option('remote-debugging-port'))
const dataDir = option('user-data-dir')
mkdirSync(dataDir, { recursive: true })
writeFileSync(join(dataDir, 'fake-args.json'), JSON.stringify(args))
const signedInAs = () => existsSync(join(dataDir, 'fake-signed-in')) ? readFileSync(join(dataDir, 'fake-signed-in'), 'utf8').trim() : undefined
const CHECK = 'https://h5api.m.tmall.com/h5/mtop.user.getusersimple/1.0/'

const targets = new Map()
/** Tabs closed since the last Target.getTargets, which still lists them. */
let closing = []
const tabsFile = join(dataDir, 'fake-tabs.json')
const saveTabs = () => { writeFileSync(tabsFile, JSON.stringify([...targets.values()].map(target => target.url))) }
let next = 1
/** Connections watching every tab, and the paused loads waiting for them. */
const watchers = new Set()
const paused = new Map()
let pausedId = 0
const attachWatcher = (socket, target, waiting) => {
  socket.send(JSON.stringify({ method: 'Target.attachedToTarget', params: { sessionId: `g-${target.id}`, targetInfo: { targetId: target.id, type: 'page', url: target.url }, waitingForDebugger: waiting } }))
}
const addTarget = (url) => {
  const id = `t${String(next++)}`
  targets.set(id, { id, url })
  saveTabs()
  for (const socket of watchers) attachWatcher(socket, targets.get(id), true)
  return id
}
/** Pause one load for the tab's watcher; resolves to whether it may go on. */
const pause = (target, url, frameId, networkId) => {
  const socket = target.watcher
  if (socket === undefined || !watchers.has(socket)) return Promise.resolve(true)
  const requestId = `p${String(++pausedId)}`
  return new Promise((resolve) => {
    paused.set(requestId, resolve)
    socket.send(JSON.stringify({ method: 'Fetch.requestPaused', params: { requestId, request: { url }, frameId, networkId, resourceType: 'Document' }, sessionId: `g-${target.id}` }))
  })
}
if (args.includes('--restore-last-session') && existsSync(tabsFile)) for (const url of JSON.parse(readFileSync(tabsFile, 'utf8'))) addTarget(url)
addTarget(args.at(-1)?.startsWith('-') ? 'about:blank' : args.at(-1))
/** Each platform's sign-in page and the page a sign-in tab moves on to once the user has signed in. */
const LOGINS = [
  ['https://login.tmall.com/', 'https://www.tmall.com/'],
  ['https://login.taobao.com/', 'https://qn.taobao.com/home.htm/QnworkbenchHome/'],
  ['https://mms.pinduoduo.com/login', 'https://mms.pinduoduo.com/home/'],
  ['https://fxg.jinritemai.com/login', 'https://fxg.jinritemai.com/ffa/mshop/homepage/index'],
]
const urlOf = (target) => {
  const home = LOGINS.find(([login]) => target.url.startsWith(login))?.[1]
  return home !== undefined && signedInAs() !== undefined ? home : target.url
}
/**
 * What a business page sends while it loads: its responses in order, the check among them, or the
 * sign-in page it goes to instead.
 */
const pageLoad = (url, nick) => {
  const store = name => process.env.FAKE_CHROME_NO_STORE === undefined ? [{ ...name, store: true }] : []
  if (url.startsWith('https://qn.taobao.com/')) {
    return nick === undefined
      ? { redirect: 'https://loginmyseller.taobao.com/?from=taobaoindex&sub=true' }
      : { responses: [{ url: 'https://h5api.m.taobao.com/h5/mtop.taobao.jdy.resource.shop.info.get/1.0/', body: `mtopjsonp2(${JSON.stringify({ ret: ['SUCCESS::调用成功'], data: { shopName: nick } })})` }] }
  }
  if (url.startsWith('https://www.taobao.com/')) {
    return {
      responses: [{
        url: 'https://h5api.m.taobao.com/h5/mtop.user.getusersimple/1.0/',
        body: nick === undefined ? 'mtopjsonp3({"ret":["FAIL_SYS_SESSION_EXPIRED::Session过期"]})' : `mtopjsonp3(${JSON.stringify({ ret: ['SUCCESS::调用成功'], data: { nick } })})`,
      }],
    }
  }
  if (url.startsWith('https://mms.pinduoduo.com/')) {
    return nick === undefined
      ? { redirect: 'https://mms.pinduoduo.com/login/?redirectUrl=x' }
      : { responses: [
        ...store({ url: 'https://mms.pinduoduo.com/earth/api/mallInfo/querySimpleCredential', body: JSON.stringify({ success: true, result: { merchantMainSimpleVO: { mallName: `${nick}店` } } }) }),
        { url: 'https://mms.pinduoduo.com/janus/api/checkLogin', body: JSON.stringify({ success: true, result: { login: true } }) },
      ] }
  }
  if (url.startsWith('https://fxg.jinritemai.com/')) {
    return nick === undefined
      ? { redirect: 'https://fxg.jinritemai.com/login/common' }
      : { responses: [
        { url: 'https://fxg.jinritemai.com/byteshop/menu/list/v2', body: JSON.stringify({ code: 0, data: { menu_list: [{ name: '首页' }] } }) },
        ...store({ url: 'https://fxg.jinritemai.com/center/qualification/shop/info', body: JSON.stringify({ code: 0, data: { shop_name: `${nick}店` } }) }),
      ] }
  }
  return {
    responses: [{
      url: CHECK,
      body: nick === undefined
        ? 'mtopjsonp1({"ret":["FAIL_SYS_SESSION_EXPIRED::Session过期"],"data":{}})'
        : `mtopjsonp1(${JSON.stringify({ ret: ['SUCCESS::调用成功'], data: { nick, userNumId: '1' } })})`,
    }],
  }
}

/** Alimama's figures for a day, the same whatever day is asked. */
const SCENES = [
  { sceneId: 371, scene1Name: '关键词推广', charge: 650, adPv: 3626, click: 198, alipayInshopAmt: 615.87, alipayInshopNum: 23, alipayInshopUv: 22, cartInshopNum: 22, inshopPotentialUvRate: 0.7764, orgNaturalPv: 2931, naturalPayAmt: 40.23 },
  { sceneId: 436, scene1Name: '货品全站推广', charge: 10151.4, adPv: 93003, click: 6214, alipayInshopAmt: 25904.68, alipayInshopNum: 638, alipayInshopUv: 596, cartInshopNum: 427, inshopPotentialUvRate: 0.82742, orgNaturalPv: 90350, naturalPayAmt: 607.35 },
]
/** Business Advisor's 「店铺经营核心日报」 export of two days, with the same spend as Alimama. */
const exportXlsx = async () => {
  const { strToU8, zipSync } = await import('fflate')
  const rows = [
    ['统计日期', '店铺名称', '访客数', '支付金额', '支付买家数', '支付转化率', '客单价', '关键词推广花费', '精准人群推广花费', '全站推广花费'],
    ['2026-10-07', '名流旗舰店', '7,872', '45,459.18', '1,015', '12.89%', '44.79', '650.00', '0.00', '10,151.40'],
    ['2026-10-06', '名流旗舰店', '6,787', '34,000.20', '681', '10.03%', '49.93', '650.00', '0.00', '10,151.40'],
  ]
  const xml = rows.map((row, r) => `<row r="${String(r + 1)}">${row.map((cell, c) => `<c r="${String.fromCharCode(65 + c)}${String(r + 1)}" t="inlineStr"><is><t>${cell}</t></is></c>`).join('')}</row>`).join('')
  return zipSync({ 'xl/worksheets/sheet1.xml': strToU8(`<worksheet><sheetData>${xml}</sheetData></worksheet>`) })
}
/** The answer to an expression a data skill evaluates in a tab. */
/** An item page's server-rendered data, with images this server hands out. */
const renderedItem = () => {
  const image = name => `http://127.0.0.1:${String(port)}/fake-img/${name}.jpg`
  return {
    item: { title: '名流 超薄避孕套 【10只】', vagueSellCount: '1万+', images: [image('main1'), image('main2')] },
    seller: { shopName: '名流旗舰店', shopId: 1 },
    componentsVO: { priceVO: { price: { priceTitle: '价格', priceText: '29.9' } } },
    skuBase: { props: [{ pid: 1, name: '规格', values: [{ vid: 1, name: '【10只】超薄', image: image('sku1') }, { vid: 2, name: '共20只' }] }],
      skus: [{ skuId: 's1', propPath: '1:1' }, { skuId: 's2', propPath: '1:2' }] },
    skuCore: { sku2info: { s1: { price: { priceText: '29.9' }, subPrice: { priceTitle: '券后', priceText: '19.9' }, quantityText: '有货' }, s2: { price: { priceText: '49.9' }, quantityText: '有货' } } },
  }
}
/** The publish entry's category nodes: one top-level category, and under it 避孕套 with a brand node and an unauthorized category. */
const CONDOMS = { id: 50024154, name: '避孕套', path: ['计生用品', '避孕套'], idpath: [50023717, 50024154], publish: true, isAuthorized: true }
const categoryApi = (expression) => {
  if (expression.includes('retrievalDataAsyncOpt')) {
    return { success: true, data: { category: [CONDOMS, { id: 125322008, name: '安全套', path: ['医疗器械', '安全套'], idpath: [1, 125322008], publish: true, isAuthorized: false }] } }
  }
  if (!expression.includes('catId=')) return { success: true, data: { dataSource: [{ id: 50023717, name: '计生用品', path: ['计生用品'], idpath: [50023717], publish: false, isAuthorized: true }] } }
  return { success: true, data: { dataSource: expression.includes('catId=50023717') ? [CONDOMS, { id: 1, name: '名流', isBrand: true, publish: true }] : [] } }
}
/** The 避孕套 publish page's form: title, shelf time, the brand property, and the two declarations. */
const publishForm = () => ({ form: { components: {
  title: { type: 'input', props: { name: 'title', label: '宝贝标题', required: true } },
  shelfTime: { type: 'radio', props: { name: 'shelfTime', label: '上架时间', required: true, dataSource: [{ value: 0, text: '立刻上架' }, { value: 2, text: '放入仓库' }] } },
  keyProp: { type: 'catProp', props: { name: 'keyProp', dataSource: [{ name: 'p-20000', label: '品牌', uiType: 'select', required: true, readonly: true, dataSource: [{ value: 1, text: '名流' }] }] } },
  personalUseConfirm: { type: 'checkbox', props: { name: 'personalUseConfirm', label: '', required: true, dataSource: [{ value: '1', text: '请检查产品标签和说明书，确认发布的医疗器械可以由消费者个人自行使用。' }] } },
  productConfirm: { type: 'checkbox', props: { name: 'productConfirm', label: '产品确认', required: true, readonly: true, dataSource: [{ value: '1', text: '您已确认所发布的产品信息都准确无误。' }] } },
}, models: {}, rules: [] } })
/** The publish page's own values: the item id it reserved, its defaults, and the SKU measurement column. */
const publishBase = () => ({
  global: { id: 1088292691011, catId: 50024154, gpfRenderTrace: 'fake-trace' },
  defaults: { shelfTime: { type: 0 }, descRepublicOfSell: { descPageRenderParam: { catId: 50024154, descDomain: 'fake', descVersion: '2.0.9' } } },
  measurement: { name: 'skuParam_p-409464968', unit: { value: 528, text: '只' } },
})
/** The store's image space folders and files, and the items saved to its warehouse. */
const shop = { folders: [{ id: '1', name: '默认' }], files: [], warehouse: [] }
const sellerApi = (expression) => {
  if (expression.includes('picturecenter.console.dir.query')) return { data: { dirs: { children: shop.folders } } }
  if (expression.includes('picturecenter.console.dir.add')) {
    shop.folders.push({ id: '9001', name: /"name":"([^"]+)"/u.exec(expression)?.[1] })
    return { data: { jsPictureCategoryDO: { pictureCategoryId: '9001' } } }
  }
  if (expression.includes('picturecenter.console.file.query')) return { data: { fileModule: /"page":1,/u.test(expression) ? shop.files : [] } }
  const id = /\\"queryItemId\\":\\"(\d+)\\"/u.exec(expression)?.[1]
  const title = /\\"queryTitle\\":\\"([^\\]+)\\"/u.exec(expression)?.[1]
  // Every saved item is in the warehouse, which the all tab lists too; nothing is on sale.
  const rows = !expression.includes('\\"tab\\":\\"on_sale\\"') ? shop.warehouse.filter(item => (id === undefined || item.itemId === id) && (title === undefined || item.title.includes(title))) : []
  return { rows: rows.map(item => ({ itemId: Number(item.itemId), catId: 50024154, itemDesc: { desc: [{ text: item.title }] } })) }
}
const upload = (expression) => {
  const bytes = Buffer.from(/atob\("([^"]*)"\)/u.exec(expression)?.[1] ?? '', 'base64')
  const name = JSON.parse(/form\.append\('name', ("[^"]*")\)/u.exec(expression)?.[1] ?? '""')
  const file = { md5: createHash('md5').update(bytes).digest('hex'), pictureId: String(shop.files.length + 1), fullUrl: `https://img.alicdn.com/fake/${name}`, pixel: '800x800', sizes: String(bytes.length) }
  shop.files.push(file)
  return { object: { fileId: file.pictureId, url: file.fullUrl, pix: file.pixel, size: file.sizes } }
}
const submitItem = (expression) => {
  const query = new URLSearchParams(JSON.parse(/new URLSearchParams\(("(?:[^"\\]|\\.)*")\)/u.exec(expression)?.[1] ?? '""'))
  const form = JSON.parse(query.get('jsonBody') ?? '{}')
  if (form.shelfTime?.type !== 2) return { models: { globalMessage: { message: '测试店铺只收放入仓库的商品' } } }
  shop.warehouse.push({ itemId: query.get('itemId'), title: form.title?.title?.[0] ?? '' })
  return { models: { globalMessage: { successUrl: `https://sell.publish.tmall.com/tmall/success.htm?primaryId=${query.get('itemId')}&auctionStatus=-2` } } }
}
/** A Pinduoduo store's 草稿箱 and edit sessions. */
const mall = { drafts: [], sessions: 0 }
const PDD_LINE = { cat_id_1: 16237, cat_id_2: 18768, cat_id_3: 18770, cat_id_4: 0, cat_name_1: '成人用品', cat_name_2: '计生用品', cat_name_3: '避孕套', optional: true }
const pddApi = (expression) => {
  const [, method, path, body] = /^window\.__dshPdd\("(\w+)", ("(?:[^"\\]|\\.)*"), (.*)\)$/su.exec(expression) ?? []
  const route = JSON.parse(path ?? '""').split('?')[0]
  const data = body === undefined || body === 'undefined' ? {} : JSON.parse(body)
  const ok = result => ({ success: true, error_code: 1000000, result })
  switch (`${method} ${route}`) {
    case 'GET /vodka/v2/mms/search/categories/v2': return ok({ cat_info_v2_lists: [PDD_LINE] })
    case 'GET /vodka/v2/mms/category/detail': return ok({ id: 18770, cat_id_1: 16237, cat_id_2: 18768, cat_id_3: 18770, cat_id_4: 0, cat_id_1_name: '成人用品', cat_id_2_name: '计生用品', cat_id_3_name: '避孕套' })
    case 'GET /draco-ms/mms/template/mall': return ok({ id: 55906, modules: [{ id: 77408, propertys: [
      { id: 510122, ref_pid: 310, pid: 5, name_alias: '品牌', required: true, control_type: 1, choose_max_num: 1, values: { content: [{ vid: 3954, value: 'Personage/名流' }] } },
      { id: 510123, ref_pid: 842, pid: 234, name_alias: '注册证号', required: true, control_type: 0, choose_max_num: 0 },
    ] }] })
    case 'POST /glide/v2/mms/query/rules/limit/new': return ok({ shipment_limit_second: [86400, 172800], goods_title_length_limit: 60 })
    case 'POST /glide/v2/mms/edit/commit/create_new': mall.sessions++; return ok({ goods_commit_id: 203110000 + mall.sessions, goods_id: 1013940000 + mall.sessions })
    case 'POST /glide/mms/goodsCommit/action/update_goods_commit_info': return ok(true)
    case 'POST /galerie/business/get_signature': return ok({ signature: 'fake-sign' })
    case 'POST /glide/v2/mms/query/spec/by/name': return ok(31406958000 + data.name.length)
    case 'POST /glide/v2/mms/query/commit/detail': return ok({ goods_id: data.goods_commit_id - 203110000 + 1013940000, check_status: 9, cost_template_id: 1, groups: {} })
    case 'POST /glide/mms/goodsCommit/action/edit':
      mall.drafts.unshift({ id: Number(data.goods_commit_id), goods_id: data.goods_id, goods_name: data.goods_name, check_status: 0 })
      return ok(true)
    case 'POST /glide/v2/mms/query/commit/list': return ok({ total: mall.drafts.length, list: mall.drafts.slice(data.start, data.start + data.length) })
    case 'POST /vodka/v2/mms/query/display/mall/goodsList': return ok({ goods_list: [] })
    default: return { success: false, error_code: 50000, error_msg: `fake chrome has no ${route}` }
  }
}
/** A Douyin shop's drafts. */
const dyShop = { drafts: [] }
const DY_FORM = {
  properties: [
    { id: '1687', label: '品牌', required: true, options: [{ value_id: '1275155012', value_name: '名流', additions: { brand_cn_name: '名流' } }] },
    { id: '3990', label: '医疗器械备案/注册号', required: true },
  ],
  qualifications: [{ id: '6994739134078140716', label: '医疗器械注册证', required: true, options: [{ value: '7674837201351786794', label: '医疗器械注册证_20260817_112810', urls: ['https://p3-aio.ecombdimg.com/fake-q.png'] }] }],
  freight: [{ label: '包邮', value: '0' }],
  delivery: [{ label: '48小时', value: '2' }],
  proofTypes: [{ label: '吊牌价', value: '2' }],
}
const dyApi = (expression) => {
  const [, method, literal] = /x\.open\("(\w+)", ("[^"]*") \+/u.exec(expression) ?? []
  const [route, query = ''] = JSON.parse(literal ?? '""').split('?')
  const params = new URLSearchParams(query)
  const ok = data => ({ code: 0, msg: '', data })
  const line = { first_cid: 1000000480, second_cid: 1000000495, third_cid: 1000000638, fourth_cid: 0, first_name: '医疗器械及保健用品', second_name: '计生用品', third_name: '避孕套' }
  switch (`${method} ${route}`) {
    case 'GET /product/tproduct/categoryOptionsN': return ok(params.get('cid') === '0' ? [{ id: 1000000480, name: '医疗器械及保健用品', is_leaf: false }] : [])
    case 'GET /product/tproduct/searchCategoryN': return ok([line])
    case 'GET /product/tproduct/getCategoryDetail': return ok([{ ...line, first_cname: line.first_name, second_cname: line.second_name, third_cname: line.third_name }])
    case 'GET /product/tproduct/list': {
      const query = params.get('product_id_and_name')
      const rows = params.get('check_status') === '3' ? [] : dyShop.drafts
      return ok(query === null ? rows : rows.filter(row => row.product_id === query || row.name.includes(query)))
    }
    default: return { code: 10004, msg: `fake chrome has no ${route}` }
  }
}
const dySave = (expression) => {
  const first = JSON.parse(/Object\.entries\((\{.*?\})\)\) s\.form/su.exec(expression)?.[1] ?? '{}')
  if (first.start_sale_type !== '1') return { notOffSale: true }
  const id = `38471000000000000${String(dyShop.drafts.length + 1).padStart(2, '0')}`
  dyShop.drafts.unshift({ product_id: id, name: first.title, draft_status: 1, status: 0, check_status: 1 })
  return { product_id: id }
}
/** An item page's 问大家 and review APIs: two questions, two main reviews, one negative tag, and a follow-up. */
const itemApi = (target, expression) => {
  const success = data => ({ ret: 'SUCCESS::调用成功', data, punish: false })
  if (target.url.includes('id=600000000004')) return { ret: 'RGV587_ERROR::SM::哎哟喂,被挤爆啦', data: null, punish: false }
  if (expression.includes('mtop.taobao.wdj.list.merge.search')) {
    return success({ hasNext: 'false', questionList: [
      { questionId: 1, questionTitle: '会不会破？', gmtCreate: '2026-09-01', answerCount: 12, topAnswerList: [{ answerTitle: '用了很多次没破过', answerUserInfo: { userNick: 'a**1' } }] },
      { questionId: 2, questionTitle: '尺寸大小合适吗', gmtCreate: '2026-08-01', answerCount: 3, topAnswerList: [] },
    ] })
  }
  const review = (id, fields) => ({ id, rateType: 1, feedbackDate: '2026年9月3日', userNick: 'u**1', skuValueStr: '规格:【10只】超薄', feedback: '很薄很润滑，回购了', ...fields })
  if (expression.includes('2-13')) return success({ hasNext: 'false', rateList: [review(9, { rateType: -1, feedback: '用了一次就破了，质量太差' })] })
  if (expression.includes('\\"rateType\\":\\"2\\"')) return success({ hasNext: 'false', rateList: [review(8, { appendedFeed: { appendedFeedback: '后来用的时候有异味，不推荐', intervalDay: 20 } })] })
  return success({ hasNext: 'false', rateList: [review(1), review(2, { skuValueStr: '规格:共20只', feedback: '物流很快，包装隐私' })], imprNewItemVOS: [
    { title: '很薄', count: 30, labelId: '1-11', extraInfo: { labelType: 'impr' } }, { title: '容易破', labelId: '2-13', extraInfo: { labelType: 'impr', gray: 'true' } },
  ] })
}
const evaluateIn = (target, expression) => {
  if (expression === 'location.href') return target.url
  if (expression.includes('__ICE_APP_CONTEXT__')) return renderedItem()
  if (expression.includes('#nocaptcha')) return false
  if (expression === "document.readyState === 'complete'") return true
  if (expression.includes('categorySelectChildren') || expression.includes('retrievalDataAsyncOpt')) return categoryApi(expression)
  if (expression.includes('window.__dshGoodsStore = value') || expression.includes('window.__dshDraftGuard = true')) return true
  if (expression.includes("extra('category_properties')")) return DY_FORM
  if (expression.includes('publishStore.saveGoods')) return dySave(expression)
  if (expression.includes('/product/img/batchupload')) return { code: 0, data: [`https://p3-aio.ecombdimg.com/fake-${String(Date.now())}.png`] }
  if (expression.includes('new XMLHttpRequest()') && expression.includes('/product/tproduct/')) return dyApi(expression)
  if (expression.includes('if (window.__dshPdd) return true')) return true
  if (expression.startsWith('window.__dshPdd(')) return pddApi(expression)
  if (expression.includes('file.pinduoduo.com/v3/store_image')) return { url: `https://pfs.pinduoduo.com/fake-${String(Date.now())}.png` }
  if (expression.startsWith('Boolean(window.lib')) return true
  if (expression.includes('j.models.global')) return target.url.includes('catId=50024154') ? publishBase() : null
  if (expression.includes('window.Json2')) return target.url.includes('catId=50024154') ? publishForm() : { error: '类目为空或不存在' }
  if (expression.includes('picturecenter.console') || expression.includes('mtop.tmall.sell.pc.manage.async')) return sellerApi(expression)
  if (expression.includes('upload.api')) return upload(expression)
  if (expression.includes('GlobalStore')) return submitItem(expression)
  if (expression.includes('window.lib.mtop.request')) return itemApi(target, expression)
  const api = [
    ['/report/query.json', { data: { list: SCENES }, info: { ok: true } }],
    ['/fetchData/template/list.json', { success: true, data: [{ id: 210, templateName: '店铺经营核心日报' }] }],
    ['/fetchData/download.json', { success: true, data: true }],
    ['/fetchData/queryDownloadUrl.json', { success: true, data: { status: '1', url: `http://127.0.0.1:${String(port)}/fake-export/core.xlsx` } }],
    ['commDateByLocation.json', { data: {} }],
  ].find(([path]) => expression.includes(path))
  return api?.[1]
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  if (url.pathname === '/fake-export/core.xlsx') return void exportXlsx().then((xlsx) => { res.end(Buffer.from(xlsx)) })
  if (url.pathname.startsWith('/fake-img/')) return res.end(Buffer.from([0xFF, 0xD8, 0xFF, 0xD9]))
  res.setHeader('content-type', 'application/json')
  if (url.pathname === '/json/version') return res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${String(port)}/devtools/browser/fake` }))
  if (url.pathname === '/json' || url.pathname === '/json/list') return res.end(JSON.stringify([...targets.values()].map(t => ({ id: t.id, type: 'page', url: urlOf(t) }))))
  if (url.pathname === '/json/new') return res.end(JSON.stringify({ id: addTarget(url.search.slice(1) || 'about:blank') }))
  res.statusCode = 404
  res.end('{}')
})
const wss = new WebSocketServer({ server })
const bodies = new Map()
wss.on('connection', (socket) => {
  const emit = (method, params, sessionId) => { socket.send(JSON.stringify({ method, params, sessionId })) }
  socket.on('close', () => { watchers.delete(socket) })
  socket.on('message', async (data) => {
    const { id, method, params = {}, sessionId } = JSON.parse(String(data))
    const reply = result => { socket.send(JSON.stringify({ id, result })) }
    const target = sessionId === undefined ? undefined : targets.get(sessionId.slice(2))
    switch (method) {
      case 'Target.createTarget': return reply({ targetId: addTarget(params.url) })
      case 'Target.attachToTarget': return reply({ sessionId: `s-${params.targetId}` })
      case 'Target.closeTarget':
        if (process.env.FAKE_CHROME_NO_CLOSE !== undefined) return socket.send(JSON.stringify({ id, error: { message: 'No target with given id found' } }))
        if (targets.has(params.targetId)) closing.push(targets.get(params.targetId))
        targets.delete(params.targetId)
        saveTabs()
        return reply({ success: true })
      case 'Target.activateTarget': return reply({})
      case 'Target.setAutoAttach':
        watchers.add(socket)
        for (const existing of targets.values()) attachWatcher(socket, existing, false)
        // An extension's worker is attached too, though the watch leaves it alone.
        emit('Target.attachedToTarget', { sessionId: 'w-worker', targetInfo: { targetId: 'worker', type: 'service_worker', url: 'chrome-extension://x/sw.js' }, waitingForDebugger: false })
        return reply({})
      case 'Runtime.runIfWaitingForDebugger':
        if (sessionId === 'w-worker') return socket.send(JSON.stringify({ id, error: { message: 'Not waiting for the debugger' } }))
        return reply({})
      case 'Fetch.enable':
        target.watcher = socket
        return reply({})
      case 'Fetch.continueRequest':
      case 'Fetch.failRequest':
        paused.get(params.requestId)?.(method === 'Fetch.continueRequest')
        paused.delete(params.requestId)
        return reply({})
      case 'Target.getTargets': {
        const listed = [...targets.values(), ...closing]
        closing = []
        return reply({ targetInfos: listed.map(t => ({ targetId: t.id, type: 'page', url: urlOf(t) })) })
      }
      case 'Network.enable':
      case 'Page.enable': return reply({})
      case 'Runtime.evaluate': return reply({ result: { value: evaluateIn(target, params.expression) } })
      case 'Page.navigate': {
        const networkId = `n${String(++pausedId)}`
        if (!await pause(target, params.url, target.id, networkId)) return reply({ frameId: 'f', errorText: 'net::ERR_BLOCKED_BY_CLIENT' })
        if (params.url.startsWith('https://item.taobao.com/') && !await pause(target, params.url.replace('https://item.taobao.com/', 'https://detail.tmall.com/'), target.id, networkId)) {
          return reply({ frameId: 'f', errorText: 'net::ERR_BLOCKED_BY_CLIENT' })
        }
        // Every page embeds a frame of its own, which is not a page.
        await pause(target, 'https://g.alicdn.com/frame.html', 'child', 'n-frame')
        if (params.url.includes('risk=1')) await pause(target, 'https://h5api.m.taobao.com/_____tmd_____/punish?x5secdata=1', 'child', 'n-risk')
        target.url = params.url
        if (process.env.FAKE_CHROME_OFFLINE !== undefined) return reply({ frameId: 'f', errorText: 'net::ERR_INTERNET_DISCONNECTED' })
        reply({ frameId: 'f' })
        if (params.url.startsWith('https://one.alimama.com/index.html#!/report/account')) {
          const scene = { queryDomains: ['scene'], queryFieldIn: ['charge'], csrfId: 'fake-csrf', loginPointId: 'fake-point' }
          return emit('Network.requestWillBeSent', { requestId: 'q1', request: { url: 'https://one.alimama.com/report/query.json?csrfId=fake-csrf', method: 'POST', postData: JSON.stringify(scene) } }, sessionId)
        }
        if (params.url.startsWith('https://sycm.taobao.com/') || params.url.startsWith('https://sell.publish.tmall.com/')) return
        if (params.url.includes('/item.htm?id=')) {
          const desc = { data: { components: { layout: [{ ID: 'd1' }], componentData: { d1: { model: { picUrl: `http://127.0.0.1:${String(port)}/fake-img/desc1.jpg` } } } } } }
          bodies.set('desc', `mtopjsonp3(${JSON.stringify(desc)})`)
          const id = /id=(\d+)/u.exec(params.url)?.[1] ?? ''
          emit('Network.responseReceived', { requestId: 'desc', response: { url: `https://h5api.m.tmall.com/h5/mtop.taobao.detail.getdesc/7.0/?data=%7B%22id%22%3A%22${id}%22%7D` } }, sessionId)
          return emit('Network.loadingFinished', { requestId: 'desc' }, sessionId)
        }
        if (process.env.FAKE_CHROME_SILENT !== undefined) return
        const load = pageLoad(params.url, signedInAs())
        emit('Network.requestWillBeSent', { requestId: 'r0', type: 'Script', request: { url: 'https://login.taobao.com/x.js' } }, sessionId)
        // A page embeds a sign-in frame whether or not the user is signed in.
        emit('Network.requestWillBeSent', { requestId: 'r4', type: 'Document', frameId: 'child', request: { url: 'https://login.taobao.com/frame.htm' } }, sessionId)
        if (load.redirect !== undefined) {
          const frameId = sessionId.slice(2)
          emit('Network.requestWillBeSent', { requestId: 'r3', type: 'Document', frameId, request: { url: load.redirect } }, 'other-session')
          emit('Network.requestWillBeSent', { requestId: 'r3', type: 'Document', frameId, request: { url: load.redirect } }, sessionId)
          return
        }
        emit('Network.responseReceived', { requestId: 'r1', response: { url: 'https://www.tmall.com/other.js' } }, sessionId)
        emit('Network.loadingFinished', { requestId: 'r1' }, sessionId)
        load.responses.forEach((response, index) => {
          const requestId = `r2-${String(index)}`
          const lost = process.env.FAKE_CHROME_NO_BODY !== undefined || (response.store === true && process.env.FAKE_CHROME_NO_STORE_BODY !== undefined)
          if (!lost) bodies.set(requestId, response.body)
          emit('Network.responseReceived', { requestId, response: { url: `${response.url}?t=1&sign=x` } }, 'other-session')
          emit('Network.responseReceived', { requestId, response: { url: `${response.url}?t=1&sign=x` } }, sessionId)
          emit('Network.loadingFinished', { requestId }, 'other-session')
          emit('Network.loadingFinished', { requestId }, sessionId)
        })
        return
      }
      case 'Network.getResponseBody': {
        const body = bodies.get(params.requestId)
        if (body === undefined) return socket.send(JSON.stringify({ id, error: { message: 'No resource with given identifier found' } }))
        const base64 = process.env.FAKE_CHROME_BASE64 !== undefined
        return reply({ body: base64 ? Buffer.from(body).toString('base64') : body, base64Encoded: base64 })
      }
      case 'Browser.getWindowForTarget':
        if (!targets.has(params.targetId)) return socket.send(JSON.stringify({ id, error: { message: 'No target with given id found' } }))
        return reply({ windowId: 1 })
      case 'Browser.setWindowBounds': {
        const path = join(dataDir, 'fake-window.json')
        const bounds = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
        writeFileSync(path, JSON.stringify({ ...bounds, ...params.bounds }))
        return reply({})
      }
      case 'Browser.close':
        if (process.env.FAKE_CHROME_STUBBORN !== undefined) return
        reply({})
        setTimeout(() => { process.exit(0) }, 50)
        return
      default: return socket.send(JSON.stringify({ id, error: { message: `unknown method ${method}` } }))
    }
  })
})
server.listen(port, '127.0.0.1')
