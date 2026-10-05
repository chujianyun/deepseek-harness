import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { expect, it, onTestFinished, vi } from 'vitest'
import { desktopHubBackend, hubView } from '../src/hub-backend.ts'

const profile = { nickname: '李雷', phone: '138****0001', tenantId: 't-a', tenantName: '甲公司', isTenantAdmin: false }
const signedOut = { status: 'signed-out', profile: null, reason: null, attempt: null }

it('projects only the sign-in fields and refuses non-browser authorization pages', () => {
  const state = { ...signedOut, token: 'not-for-the-renderer',
    attempt: { id: 'a1', phase: 'waiting-browser', authorizeUrl: 'https://hub.example/oauth/authorize?x', verifier: 'private' } }
  expect(hubView(state)).toEqual({ ...signedOut, attempt: { id: 'a1', phase: 'waiting-browser', authorizeUrl: 'https://hub.example/oauth/authorize?x' } })
  expect(hubView({ ...signedOut, status: 'signed-in', profile: { ...profile, extra: 1 } })).toEqual({ ...signedOut, status: 'signed-in', profile })
  expect(hubView({ ...signedOut, reason: 'expired', attempt: { id: 'a1', phase: 'failed', error: 'denied' } }))
    .toEqual({ ...signedOut, reason: 'expired', attempt: { id: 'a1', phase: 'failed', error: 'denied' } })
  expect(hubView({ ...signedOut, attempt: { id: 'a1', phase: 'waiting-browser', authorizeUrl: 'http://localhost:8080/oauth/authorize' } }).attempt?.authorizeUrl)
    .toBe('http://localhost:8080/oauth/authorize')
  for (const authorizeUrl of ['file:///tmp/example', 'javascript:alert(1)', 'http://example.com/login', 'https://user:pass@hub.example/']) {
    expect(() => hubView({ ...state, attempt: { ...state.attempt, authorizeUrl } })).toThrow()
  }
  for (const invalid of [
    null, { ...signedOut, status: 'unknown' }, { ...signedOut, reason: 'revoked' }, { ...signedOut, profile: { ...profile, nickname: 1 } },
    { ...signedOut, profile: { ...profile, isTenantAdmin: 'no' } }, { ...signedOut, attempt: { id: 'a1', phase: 'later' } },
    { ...signedOut, attempt: { id: 'a1', phase: 'failed', error: 'raw-server-message' } }, { ...signedOut, attempt: { id: 'a1', phase: 'waiting-browser', authorizeUrl: 1 } },
  ]) expect(() => hubView(invalid)).toThrow()
})

it('uses the hubAccount Remote commands', async () => {
  const requests: unknown[] = []
  const backend = desktopHubBackend('http://127.0.0.1:1234', (request) => {
    requests.push(request)
    return Promise.resolve(signedOut)
  }, () => Promise.resolve(''))
  expect(await backend.state()).toEqual(signedOut)
  await backend.start()
  await backend.cancel('a1')
  expect(requests).toEqual([
    { namespace: 'hubAccount', method: 'getState', args: {} },
    { namespace: 'hubAccount', method: 'signIn', args: {} },
    { namespace: 'hubAccount', method: 'cancelSignIn', args: { attemptId: 'a1' } },
  ])
})

it('streams sign-in state and the collection policy, and reconnects after a broken stream', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  onTestFinished(async () => {
    for (const client of server.clients) client.terminate()
    await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
  })
  const address = server.address()
  if (typeof address === 'string' || address === null) throw new Error('missing server address')
  const sockets: { socket: import('ws').WebSocket; streams: Map<string, string>; opened: Promise<void> }[] = []
  server.on('connection', (socket, request) => {
    expect(request.headers.cookie).toBe('dsh=1')
    const streams = new Map<string, string>()
    const opened = Promise.withResolvers<undefined>()
    socket.on('message', (data) => {
      if (!Buffer.isBuffer(data)) throw new Error('expected a Buffer WebSocket frame')
      const frame = JSON.parse(data.toString('utf8')) as { endpoint: string; streamId: string }
      streams.set(frame.endpoint, frame.streamId)
      if (streams.size === 2) opened.resolve(undefined)
    })
    sockets.push({ socket, streams, opened: opened.promise.then(() => undefined) })
  })
  const listener = vi.fn()
  const failed = vi.fn()
  const policy = vi.fn()
  const backend = desktopHubBackend(`http://127.0.0.1:${address.port}`, () => Promise.resolve(signedOut), () => Promise.resolve('dsh=1'))
  const stop = backend.watch(listener, failed, policy)
  onTestFinished(stop)
  await vi.waitFor(() => { expect(sockets).toHaveLength(1) })
  const first = sockets[0]!
  await first.opened
  first.socket.send(JSON.stringify({ type: 'item', streamId: first.streams.get('hubAccount/watch'), value: signedOut }))
  await vi.waitFor(() => { expect(listener).toHaveBeenCalledExactlyOnceWith(signedOut) })
  first.socket.send(JSON.stringify({ type: 'item', streamId: first.streams.get('productAnalytics/watchPolicy'), value: true }))
  await vi.waitFor(() => { expect(policy).toHaveBeenLastCalledWith(true) })
  first.socket.send(JSON.stringify({ type: 'item', streamId: first.streams.get('productAnalytics/watchPolicy'), value: 'invalid policy' }))
  await vi.waitFor(() => { expect(policy).toHaveBeenLastCalledWith(false) })
  // An invalid state closes the socket; the backend reports the failure and reconnects.
  first.socket.send(JSON.stringify({ type: 'item', streamId: first.streams.get('hubAccount/watch'), value: { status: 'bogus' } }))
  await vi.waitFor(() => { expect(failed).toHaveBeenCalledOnce() }, { timeout: 3000 })
  await vi.waitFor(() => { expect(sockets).toHaveLength(2) }, { timeout: 3000 })
  const second = sockets[1]!
  await second.opened
  second.socket.send(JSON.stringify({ type: 'end', streamId: second.streams.get('hubAccount/watch') }))
  await vi.waitFor(() => { expect(failed).toHaveBeenCalledTimes(2) }, { timeout: 3000 })
  stop()
  expect(policy).toHaveBeenLastCalledWith(false)
})

it('reconnects when the cookie read fails, and stops without the analytics recipient', async () => {
  vi.useFakeTimers()
  onTestFinished(() => { vi.useRealTimers() })
  const cookies = vi.fn(() => Promise.reject(new Error('no session')))
  const failed = vi.fn()
  const stop = desktopHubBackend('http://127.0.0.1:1', () => Promise.resolve(signedOut), cookies).watch(vi.fn(), failed)
  await vi.advanceTimersByTimeAsync(0)
  expect(failed).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(1000)
  expect(cookies).toHaveBeenCalledTimes(2)
  stop()
  await vi.advanceTimersByTimeAsync(5000)
  expect(cookies).toHaveBeenCalledTimes(2)
})
