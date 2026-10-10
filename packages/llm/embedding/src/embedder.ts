/**
 * Text embedding with a decoder-only ONNX export (Qwen3-Embedding): tokenize, run the model once
 * per text with an empty key/value cache, take the last token's hidden state (the tokenizer
 * appends the end-of-text token), and L2-normalize it.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Tokenizer } from '@huggingface/tokenizers'
import { z } from 'zod'
import type { OrtModule, OrtSession } from './runtime.ts'

/** Loaded local model. */
export interface LocalEmbedder {
  /** Vector size. */
  readonly dimensions: number
  /**
   * Embed texts one after another.
   * @param texts - inputs; each is cut to the model's token limit, keeping its final token.
   * @param signal - stops between texts.
   * @returns one unit vector per text.
   */
  embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]>
  /** Release the native session's resources. */
  release(): Promise<void>
}

const size = z.number().int().positive()
const modelConfig = z.object({ hidden_size: size, num_key_value_heads: size, head_dim: size })

/**
 * Load a model directory holding `config.json`, `tokenizer.json`, `tokenizer_config.json`, and the weights.
 * @param ort - the onnxruntime-node module.
 * @param dir - model directory.
 * @param weights - weights path inside it.
 * @param maxTokens - longest token sequence fed to the model.
 * @returns the embedder.
 */
export async function loadEmbedder(ort: OrtModule, dir: string, weights: string, maxTokens: number): Promise<LocalEmbedder> {
  const json = async (name: string): Promise<unknown> => JSON.parse(await readFile(join(dir, name), 'utf8'))
  const config = modelConfig.parse(await json('config.json'))
  const tokenizer = new Tokenizer(await json('tokenizer.json') as object, await json('tokenizer_config.json') as object)
  const session: OrtSession = await ort.InferenceSession.create(join(dir, weights))
  const int64 = (values: readonly number[]): unknown => new ort.Tensor('int64', BigInt64Array.from(values, BigInt), [1, values.length])
  const emptyCache = new ort.Tensor('float32', new Float32Array(0), [1, config.num_key_value_heads, 0, config.head_dim])
  let queue: Promise<unknown> = Promise.resolve()
  const embedOne = async (text: string): Promise<number[]> => {
    const encoded = tokenizer.encode(text).ids
    const ids = encoded.length > maxTokens ? [...encoded.slice(0, maxTokens - 1), ...encoded.slice(-1)] : encoded
    const feeds: Record<string, unknown> = {}
    for (const name of session.inputNames) {
      if (name === 'input_ids') feeds[name] = int64(ids)
      else if (name === 'attention_mask') feeds[name] = int64(ids.map(() => 1))
      else if (name === 'position_ids') feeds[name] = int64(ids.map((_, index) => index))
      else feeds[name] = emptyCache
    }
    const hidden = (await session.run(feeds)).last_hidden_state
    const width = config.hidden_size
    const last = Array.from({ length: width }, (_, index) => Number(hidden.data[(ids.length - 1) * width + index]))
    const norm = Math.hypot(...last)
    return last.map(value => value / norm)
  }
  return {
    dimensions: config.hidden_size,
    embed(texts, signal) {
      // One run at a time: the session is shared, and runs are CPU-bound.
      const run = queue.then(async () => {
        const vectors: number[][] = []
        for (const text of texts) {
          signal?.throwIfAborted()
          vectors.push(await embedOne(text))
        }
        return vectors
      })
      queue = run.catch(() => undefined)
      return run
    },
    async release() { await session.release?.() },
  }
}
