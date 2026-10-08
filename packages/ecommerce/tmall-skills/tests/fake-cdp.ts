import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'

/** One CDP call the fake received. */
export interface Call {
  readonly method: string
  readonly params: Record<string, unknown>
  readonly sessionId?: string
}

/** Sends a CDP event to the client. */
export type Emit = (method: string, params: object, sessionId?: string) => void

/** Answers a CDP call: a result object, or an Error for an error reply. */
export type Handler = (call: Call, emit: Emit) => object | Error

/**
 * A local Chrome stand-in that speaks the browser-level DevTools WebSocket.
 * @param handler - answers each call; unknown methods get `{}`.
 * @returns its `http://127.0.0.1:<port>` address, the calls it received, and a close function.
 */
export async function fakeCdp(handler: Handler): Promise<{ url: string; calls: Call[]; close: () => Promise<void> }> {
  const calls: Call[] = []
  const http = createServer((_request, response) => {
    const { port } = http.address() as { port: number }
    response.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${String(port)}/devtools/browser/fake` }))
  })
  const wss = new WebSocketServer({ server: http })
  wss.on('connection', (socket) => {
    const emit: Emit = (method, params, sessionId) => {
      socket.send(JSON.stringify({ method, params, ...sessionId === undefined ? {} : { sessionId } }))
    }
    socket.on('message', (data: Buffer) => {
      const { id, method, params, sessionId } = JSON.parse(data.toString('utf8')) as Call & { id: number }
      const call = { method, params, ...sessionId === undefined ? {} : { sessionId } }
      calls.push(call)
      const answer = handler(call, emit)
      socket.send(JSON.stringify(answer instanceof Error ? { id, error: { message: answer.message } } : { id, result: answer }))
    })
  })
  await new Promise<void>((resolve) => { http.listen(0, '127.0.0.1', resolve) })
  const { port } = http.address() as { port: number }
  return {
    url: `http://127.0.0.1:${String(port)}`,
    calls,
    close: async () => {
      for (const client of wss.clients) client.terminate()
      await new Promise<void>((resolve) => { wss.close(() => { resolve() }) })
      http.closeAllConnections()
      await new Promise<void>((resolve) => { http.close(() => { resolve() }) })
    },
  }
}
