#!/usr/bin/env node
// A stand-in for Google Chrome in tests: it answers `--version`, serves the DevTools HTTP endpoints
// and the browser WebSocket on --remote-debugging-port, and plays the Tmall check: the home page
// sends `mtop.user.getusersimple`, signed in while `<user-data-dir>/fake-signed-in` holds a nick.
// FAKE_CHROME_VERSION sets the reported version (empty prints none); FAKE_CHROME_SILENT never sends
// the check response; FAKE_CHROME_BASE64 encodes bodies; FAKE_CHROME_STUBBORN ignores Browser.close;
// FAKE_CHROME_NO_BODY loses the check body; FAKE_CHROME_NO_CLOSE refuses to close tabs.
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
let next = 1
const addTarget = (url) => {
  const id = `t${String(next++)}`
  targets.set(id, { id, url })
  return id
}
addTarget(args.at(-1)?.startsWith('-') ? 'about:blank' : args.at(-1))
// A sign-in tab moves on to the home page once the user has signed in.
const urlOf = target => target.url.startsWith('https://login.') && signedInAs() !== undefined ? 'https://www.tmall.com/' : target.url

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
  socket.on('message', (data) => {
    const { id, method, params = {}, sessionId } = JSON.parse(String(data))
    const reply = result => { socket.send(JSON.stringify({ id, result })) }
    const target = sessionId === undefined ? undefined : targets.get(sessionId.slice(2))
    switch (method) {
      case 'Target.createTarget': return reply({ targetId: addTarget(params.url) })
      case 'Target.attachToTarget': return reply({ sessionId: `s-${params.targetId}` })
      case 'Target.closeTarget':
        if (process.env.FAKE_CHROME_NO_CLOSE !== undefined) return socket.send(JSON.stringify({ id, error: { message: 'No target with given id found' } }))
        targets.delete(params.targetId)
        return reply({ success: true })
      case 'Target.activateTarget': return reply({})
      case 'Target.getTargets': return reply({ targetInfos: [...targets.values()].map(t => ({ targetId: t.id, type: 'page', url: urlOf(t) })) })
      case 'Network.enable': return reply({})
      case 'Page.navigate': {
        target.url = params.url
        reply({ frameId: 'f' })
        if (process.env.FAKE_CHROME_SILENT !== undefined) return
        const nick = signedInAs()
        const body = nick === undefined
          ? 'mtopjsonp1({"ret":["FAIL_SYS_SESSION_EXPIRED::Session过期"],"data":{}})'
          : `mtopjsonp1(${JSON.stringify({ ret: ['SUCCESS::调用成功'], data: { nick, userNumId: '1' } })})`
        if (process.env.FAKE_CHROME_NO_BODY === undefined) bodies.set('r2', body)
        emit('Network.responseReceived', { requestId: 'r1', response: { url: 'https://www.tmall.com/other.js' } }, sessionId)
        emit('Network.loadingFinished', { requestId: 'r1' }, sessionId)
        emit('Network.responseReceived', { requestId: 'r2', response: { url: `${CHECK}?t=1&sign=x` } }, 'other-session')
        emit('Network.responseReceived', { requestId: 'r2', response: { url: `${CHECK}?t=1&sign=x` } }, sessionId)
        emit('Network.loadingFinished', { requestId: 'r2' }, sessionId)
        return
      }
      case 'Network.getResponseBody': {
        const body = bodies.get(params.requestId)
        if (body === undefined) return socket.send(JSON.stringify({ id, error: { message: 'No resource with given identifier found' } }))
        const base64 = process.env.FAKE_CHROME_BASE64 !== undefined
        return reply({ body: base64 ? Buffer.from(body).toString('base64') : body, base64Encoded: base64 })
      }
      case 'Browser.getWindowForTarget': return reply({ windowId: 1 })
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
