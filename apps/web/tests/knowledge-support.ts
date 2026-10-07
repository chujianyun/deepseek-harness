// Shared by the knowledge e2e specs: a mock OpenAI-compatible endpoint for embeddings and chat.
import { once } from 'node:events'
import { createServer, type ServerResponse } from 'node:http'
import { terms } from '../../../packages/knowledge/knowledge-base/src/terms.ts'

/** One chat completion request the mock received. */
export interface ChatRequest {
  readonly messages: readonly { readonly role: string; readonly content?: unknown }[]
  readonly tools?: readonly { readonly function: { readonly name: string; readonly description?: string } }[]
}

/**
 * The chat model's script: with `knowledge_search` offered and no tool result yet, it searches for
 * `query`; after a tool result it answers with `answer`; without the tool it says `noTool`.
 */
export interface ChatScript { query: string; answer: string; noTool: string }

function streamChat(res: ServerResponse, request: ChatRequest, script: ChatScript): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const chunk = (delta: Record<string, unknown>, finish: string | null) => `data: ${JSON.stringify({
    id: 'chatcmpl-knowledge', object: 'chat.completion.chunk', created: 0, model: 'acme-chat',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`
  const usage = `data: ${JSON.stringify({
    id: 'chatcmpl-knowledge', object: 'chat.completion.chunk', created: 0, model: 'acme-chat', choices: [],
    usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
  })}\n\n`
  const searching = request.tools?.some(tool => tool.function.name === 'knowledge_search') === true
  if (searching && request.messages.at(-1)?.role !== 'tool') {
    res.write(chunk({ role: 'assistant', tool_calls: [{
      index: 0, id: `call_kb_${String(request.messages.length)}`, type: 'function',
      function: { name: 'knowledge_search', arguments: JSON.stringify({ query: script.query }) },
    }] }, null))
    res.end(`${chunk({}, 'tool_calls')}${usage}data: [DONE]\n\n`)
    return
  }
  res.write(chunk({ role: 'assistant', content: searching ? script.answer : script.noTool }, null))
  res.end(`${chunk({}, 'stop')}${usage}data: [DONE]\n\n`)
}

/**
 * A mock `/v1/embeddings` — a 64-dimension bag of hashed terms, so texts sharing words point the same
 * way — and a scripted `/v1/chat/completions` that records each request.
 * @param script - the chat model's script.
 * @returns the base URL, the chat requests received, and a closer.
 */
export async function startEmbeddingsEndpoint(script: ChatScript = { query: '', answer: '', noTool: '' }) {
  const chats: ChatRequest[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => { raw += chunk.toString() })
    req.on('end', () => {
      if (req.url === '/v1/chat/completions') {
        const request = JSON.parse(raw) as ChatRequest
        chats.push(request)
        streamChat(res, request, script)
        return
      }
      const body = JSON.parse(raw) as { input: string[] }
      const data = body.input.map((text, index) => {
        const embedding = new Array<number>(64).fill(0)
        for (const term of terms(text)) {
          let hash = 0
          for (const char of term) hash = (hash * 31 + char.codePointAt(0)!) % 64
          embedding[hash]! += 1
        }
        return { index, embedding }
      })
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data }))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    baseURL: `http://127.0.0.1:${String((server.address() as { port: number }).port)}/v1`,
    chats,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => { resolve() }) }),
  }
}
