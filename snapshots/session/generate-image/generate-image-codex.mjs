/**
 * Deterministic ChatGPT (Codex) boundary for the generate-image scenario. It stores a Codex
 * sign-in, so llm-pi-ai offers `generate_image`, and answers the Codex image endpoint in this
 * process with one 2x2 PNG. The tool itself, its request, and the attachment store are shipped.
 */

/** A 2x2 PNG, so the attachment store's decode and dimension checks pass. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP4z8DwnwGMgRQAH+4D/dJQfRoAAAAASUVORK5CYII='
const ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses'

/** An access token shaped like ChatGPT's: the tool reads the account id from its claims. */
function token() {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-snapshot' } })}.sig`
}

const event = value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`
const STREAM = event({ type: 'response.created', response: { id: 'resp_snapshot' } })
  + event({
    type: 'response.output_item.done', output_index: 0,
    item: { type: 'image_generation_call', id: 'ig_snapshot', status: 'completed', output_format: 'png', result: PNG },
  })
  + event({ type: 'response.completed', response: { id: 'resp_snapshot', status: 'completed' } })

export const inject = ['credentials']

export async function apply(ctx) {
  const original = globalThis.fetch
  globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    return url === ENDPOINT
      ? Promise.resolve(new Response(STREAM, { headers: { 'content-type': 'text/event-stream' } }))
      : original(input, init)
  }
  ctx.effect(() => () => { globalThis.fetch = original })
  await ctx.credentials.modifyRecord('llm-pi-ai/openai-codex', () => Promise.resolve({
    kind: 'grant', payload: { type: 'oauth', access: token(), refresh: 'refresh-snapshot', expires: Date.now() + 3_600_000 },
  }))
}
