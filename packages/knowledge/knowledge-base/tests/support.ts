/** Stand-ins shared by the knowledge base specs: the embedding models, the web service, and pushable states. */
import type { EmbeddingState } from '@deepseek-ai/dsh-embedding'
import { terms } from '../src/terms.ts'

export const LOCAL = 'local/qwen3-embedding-0.6b'
export const API = 'acme/bge-m3'

/** A pushable state with a Remote-style watch stream. */
export class Watched<T> {
  private readonly listeners = new Set<() => void>()
  constructor(public value: T) {}
  set(next: T): void { this.value = next; for (const listener of this.listeners) listener() }
  async *watch(signal: AbortSignal): AsyncIterable<T> {
    let dirty = true
    let wake: (() => void) | undefined
    const changed = (): void => { dirty = true; wake?.() }
    this.listeners.add(changed)
    signal.addEventListener('abort', changed, { once: true })
    try {
      while (!signal.aborted) {
        if (dirty) { dirty = false; yield this.value; continue }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally { this.listeners.delete(changed) }
  }
}

/** A 64-dimension bag of hashed terms: texts sharing words point the same way. */
export function vectorize(text: string): number[] {
  const vector = new Array<number>(64).fill(0)
  for (const term of terms(text)) {
    let hash = 0
    for (const char of term) hash = (hash * 31 + char.codePointAt(0)!) % 64
    vector[hash]! += 1
  }
  return vector
}

export function embeddingState(localStatus: EmbeddingState['local']['status'] = 'installed'): EmbeddingState {
  return {
    local: { id: LOCAL, name: 'Qwen3-Embedding-0.6B', status: localStatus, receivedBytes: 0, totalBytes: 1, dimensions: 64, error: null },
    apiModels: [{ id: API, provider: 'acme', providerName: 'Acme', model: 'bge-m3', dimensions: 64, available: true }],
  }
}

/** A stand-in for `ctx.web`: pages by URL, each a page, a thrown error, or missing (an error too). */
export function fakeWeb() {
  const pages = new Map<string, { statusCode?: number; kind?: 'html' | 'text'; content: string } | Error>()
  return {
    pages,
    fetched: [] as string[],
    async fetch(request: { url: string }) {
      this.fetched.push(request.url)
      const page = pages.get(request.url) ?? new Error(`could not reach ${request.url}`)
      if (page instanceof Error) throw page
      return { url: request.url, statusCode: page.statusCode ?? 200, truncated: false, body: { kind: page.kind ?? 'html', content: page.content } }
    },
  }
}

/** A stand-in for `ctx.embedding` over a pushable state: embeddings can be held at a gate or made to fail. */
export function fakeEmbedding(watched: Watched<EmbeddingState>) {
  const usages: ((id: string) => Promise<readonly string[]>)[] = []
  const embedding = {
    usages,
    gate: undefined as Promise<unknown> | undefined,
    entered: undefined as (() => void) | undefined,
    failure: undefined as Error | undefined,
    calls: [] as { id: string; texts: readonly string[] }[],
    getState: () => Promise.resolve(watched.value),
    watch: (signal: AbortSignal) => watched.watch(signal),
    registerUsage: (usage: (id: string) => Promise<readonly string[]>) => { usages.push(usage) },
    async embed(id: string, texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
      embedding.calls.push({ id, texts })
      // The trial embedding of a model change is never held.
      if (embedding.gate !== undefined && texts[0]?.includes('probe') !== true) {
        embedding.entered?.()
        await Promise.race([embedding.gate, new Promise((_, reject) => {
          if (signal?.aborted === true) reject(signal.reason as Error)
          signal?.addEventListener('abort', () => { reject(signal.reason as Error) }, { once: true })
        })])
      }
      if (embedding.failure !== undefined) throw embedding.failure
      return texts.map(vectorize)
    },
  }
  return embedding
}
