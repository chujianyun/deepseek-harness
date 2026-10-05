// Shared by the knowledge e2e specs: a mock OpenAI-compatible embeddings endpoint.
import { once } from 'node:events'
import { createServer } from 'node:http'
import { terms } from '../../../packages/knowledge/knowledge-base/src/terms.ts'

/** A mock `/v1/embeddings`: a 64-dimension bag of hashed terms, so texts sharing words point the same way. */
export async function startEmbeddingsEndpoint() {
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => { raw += chunk.toString() })
    req.on('end', () => {
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
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => { resolve() }) }),
  }
}
