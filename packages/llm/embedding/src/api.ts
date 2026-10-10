/**
 * API embeddings over a configured provider route's OpenAI-compatible `POST <baseURL>/embeddings`.
 */
import type { LlmRouteEndpoint } from '@deepseek-ai/dsh-llm'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'

/** Protocols whose endpoints also serve OpenAI's embeddings API. */
export const OPENAI_PROTOCOLS: ReadonlySet<string> = new Set(['openai-completions', 'openai-responses'])

const reply = z.object({ data: z.array(z.object({ index: z.number().int().nonnegative(), embedding: z.array(z.number()) })) })
const failure = z.object({ error: z.object({ message: z.string() }) }).or(z.object({ message: z.string() }))

/**
 * Embed texts with one model on one endpoint.
 * @param endpoint - the route's endpoint; its credential is resolved here and only sent there.
 * @param model - model id on the provider.
 * @param texts - inputs, in order.
 * @param signal - cancels the request.
 * @returns one vector per text, in input order.
 * @throws RemoteError `embedding/request-failed` with the endpoint's status and message when it refuses, fails,
 *   or answers something unreadable.
 */
export async function requestEmbeddings(
  endpoint: LlmRouteEndpoint, model: string, texts: readonly string[], signal: AbortSignal,
): Promise<number[][]> {
  const headers = new Headers(endpoint.headers === undefined ? undefined : Object.entries(endpoint.headers))
  headers.set('content-type', 'application/json')
  const apiKey = await endpoint.resolveApiKey()
  if (apiKey !== undefined) headers.set('authorization', `Bearer ${apiKey}`)
  /** A transport failure or the request deadline, as the documented refusal; a caller's cancellation stays itself. */
  const unreachable = (error: unknown, status: number | null): unknown => {
    const reason: unknown = signal.reason
    if (signal.aborted && !(reason instanceof DOMException && reason.name === 'TimeoutError')) return reason
    const detail = signal.aborted ? 'the embedding endpoint did not answer in time' : `could not reach the embedding endpoint: ${String(error)}`
    return new RemoteError('embedding/request-failed', detail, { status })
  }
  let res: Response
  let text: string
  try {
    res = await fetch(`${endpoint.baseURL.replace(/\/+$/u, '')}/embeddings`, {
      method: 'POST', headers, signal, body: JSON.stringify({ model, input: texts, encoding_format: 'float' }),
    })
  } catch (error) {
    throw unreachable(error, null)
  }
  try {
    text = await res.text()
  } catch (error) {
    throw unreachable(error, res.status)
  }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch (_notJson: unknown) {
    // A non-JSON body is reported by its status and text below.
    body = undefined
  }
  if (!res.ok) {
    const parsed = failure.safeParse(body)
    const message = parsed.success ? ('error' in parsed.data ? parsed.data.error.message : parsed.data.message) : text.slice(0, 200)
    throw new RemoteError('embedding/request-failed', `HTTP ${String(res.status)}: ${message}`, { status: res.status })
  }
  const parsed = reply.safeParse(body)
  if (!parsed.success || parsed.data.data.length !== texts.length) {
    throw new RemoteError('embedding/request-failed', 'the endpoint did not answer with one embedding per input', { status: res.status })
  }
  return [...parsed.data.data].sort((a, b) => a.index - b.index).map(item => item.embedding)
}
