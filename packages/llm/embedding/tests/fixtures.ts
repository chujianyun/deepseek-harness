/**
 * Test doubles for the local embedding model: a tiny model directory (word-level tokenizer and
 * a stand-in weights file), npm tarballs of a JavaScript stand-in for onnxruntime-node whose
 * session turns token ids into deterministic hidden states, and a loopback mirror that serves
 * both with Range support and injectable failures.
 */
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { create } from 'tar'
import type { LocalModelSpec, RuntimeSpec } from '../src/index.ts'

const FIXTURES = join(import.meta.dirname, 'fixtures')

/** Width of the stand-in model's hidden states. */
export const HIDDEN = 4

/**
 * The stand-in onnxruntime-node: hidden state row i is `[id_i, id_i + 1, …]`, so the last token's
 * vector identifies the input. Sessions over weights containing `slow` set `globalThis.ortWaiting` and wait
 * for `globalThis.ortGate` first, and those containing `broken` fail to load. Every run's feeds are recorded on `globalThis.ortRuns`.
 */
const ORT_STUB = `
class Tensor { constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims } }
const InferenceSession = {
  async create(path) {
    const weights = require('node:fs').readFileSync(path, 'utf8')
    if (weights.includes('slow')) { globalThis.ortWaiting = true; await globalThis.ortGate }
    if (weights.includes('broken')) throw new Error('invalid model')
    return {
      inputNames: ['input_ids', 'attention_mask', 'position_ids', 'past_key_values.0.key'],
      outputNames: ['last_hidden_state'],
      async run(feeds) {
        (globalThis.ortRuns ??= []).push(feeds)
        const ids = Array.from(feeds.input_ids.data, Number)
        const data = new Float32Array(ids.length * ${HIDDEN})
        ids.forEach((id, row) => { for (let col = 0; col < ${HIDDEN}; col++) data[row * ${HIDDEN} + col] = id + col })
        return { last_hidden_state: { dims: [1, ids.length, ${HIDDEN}], data } }
      },
    }
  },
}
module.exports = { InferenceSession, Tensor }
`

const sha = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex')

/** Files the mirror serves, by URL path. */
export type Served = Map<string, Buffer>

/**
 * Build the model files and runtime tarballs.
 * @param weights - stand-in weights content.
 * @returns the specs to configure, and what the mirror must serve for them.
 */
export async function buildFixtures(weights = 'stand-in weights'): Promise<{ model: LocalModelSpec; runtime: RuntimeSpec; served: Served; cleanup: () => Promise<void> }> {
  const served: Served = new Map()
  const files: Record<string, Buffer> = {
    'config.json': Buffer.from(JSON.stringify({ hidden_size: HIDDEN, num_key_value_heads: 1, head_dim: 2 })),
    'tokenizer.json': await readFile(join(FIXTURES, 'tokenizer.json')),
    'tokenizer_config.json': await readFile(join(FIXTURES, 'tokenizer_config.json')),
    'onnx/model.onnx': Buffer.from(weights),
  }
  for (const [path, data] of Object.entries(files)) served.set(`/models/acme/tiny/${path}`, data)
  const build = await mkdtemp(join(tmpdir(), 'dsh-embedding-fixture-'))
  const tarball = async (name: string, entries: Record<string, string>): Promise<Buffer> => {
    const root = join(build, name)
    for (const [path, content] of Object.entries(entries)) {
      await mkdir(join(root, 'package', path, '..'), { recursive: true })
      await writeFile(join(root, 'package', path), content)
    }
    const out = join(build, `${name}.tgz`)
    await create({ gzip: true, file: out, cwd: root }, ['package'])
    return readFile(out)
  }
  const common = await tarball('onnxruntime-common', { 'package.json': JSON.stringify({ name: 'onnxruntime-common', main: 'index.js' }), 'index.js': 'module.exports = {}' })
  const node = await tarball('onnxruntime-node', {
    'package.json': JSON.stringify({ name: 'onnxruntime-node', main: 'dist/index.js' }),
    'dist/index.js': ORT_STUB,
    [`bin/napi-v6/${process.platform}/${process.arch}/onnxruntime_binding.node`]: 'native',
    'bin/napi-v6/other/arch/onnxruntime_binding.node': 'other native',
    'script/install.js': 'throw new Error("never run")',
  })
  served.set('/npm/onnxruntime-common/-/onnxruntime-common-9.9.9.tgz', common)
  served.set('/npm/onnxruntime-node/-/onnxruntime-node-9.9.9.tgz', node)
  return {
    model: {
      id: 'local/tiny', name: 'Tiny', repo: 'acme/tiny', weights: 'onnx/model.onnx', maxTokens: 4,
      files: Object.entries(files).map(([path, data]) => ({ path, size: data.length, sha256: sha(data) })),
    },
    runtime: {
      version: '9.9.9', platforms: [`${process.platform}-${process.arch}`],
      packages: [
        { name: 'onnxruntime-common', size: common.length, sha256: sha(common) },
        { name: 'onnxruntime-node', size: node.length, sha256: sha(node) },
      ],
    },
    served,
    cleanup: () => rm(build, { recursive: true, force: true }),
  }
}

/** A loopback mirror over {@link Served} files. */
export interface Mirror {
  readonly origin: string
  readonly served: Served
  /** Every request: path and Range header. */
  readonly requests: { path: string; range: string | undefined }[]
  /** Answer matching paths with this status instead. */
  fail: ((path: string) => number | undefined) | undefined
  /** Serve this body for matching paths instead of the real one. */
  replace: ((path: string) => Buffer | undefined) | undefined
  /** For matching paths, send half the body and then drop the connection. */
  drop: ((path: string) => boolean) | undefined
  /** Ignore Range headers and always send the whole file. */
  ignoreRange: boolean
  /** When set, a response for a matching path sends its first half, then waits for the promise before the rest. */
  hold: { path: string; release: Promise<undefined>; sent: () => void } | undefined
  close(): Promise<void>
}

/**
 * Start a mirror.
 * @param served - files by URL path.
 * @returns the running mirror.
 */
export async function startMirror(served: Served): Promise<Mirror> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const path = new URL(req.url ?? '/', 'http://x').pathname
      mirror.requests.push({ path, range: req.headers.range })
      const status = mirror.fail?.(path)
      if (status !== undefined) { res.writeHead(status).end(); return }
      const body = mirror.replace?.(path) ?? served.get(path)
      if (body === undefined) { res.writeHead(404).end(); return }
      const start = !mirror.ignoreRange && req.headers.range !== undefined ? Number(/bytes=(\d+)-/u.exec(req.headers.range)![1]) : 0
      const slice = body.subarray(start)
      res.writeHead(start > 0 ? 206 : 200, { 'content-length': String(slice.length) })
      if (mirror.drop?.(path) === true) {
        res.write(slice.subarray(0, Math.floor(slice.length / 2)), () => { res.destroy() })
        return
      }
      const hold = mirror.hold
      if (hold !== undefined && path.endsWith(hold.path)) {
        mirror.hold = undefined
        const half = Math.floor(slice.length / 2)
        res.write(slice.subarray(0, half), () => { hold.sent() })
        await hold.release
        if (!res.destroyed) res.end(slice.subarray(half))
        return
      }
      res.end(slice)
    })()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const mirror: Mirror = {
    origin: `http://127.0.0.1:${String((server.address() as { port: number }).port)}`,
    served, requests: [], fail: undefined, replace: undefined, drop: undefined, ignoreRange: false, hold: undefined,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => { resolve() }) }),
  }
  return mirror
}
