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
// FAKE_CHROME_NO_BODY loses the check body; FAKE_CHROME_NO_CLOSE refuses to close tabs. Its tabs are
// kept in `<user-data-dir>/fake-tabs.json` and come back with --restore-last-session. As in Chrome, a
// closed tab is still listed once by Target.getTargets, but has no window any more.
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

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
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
      case 'Network.enable': return reply({})
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
