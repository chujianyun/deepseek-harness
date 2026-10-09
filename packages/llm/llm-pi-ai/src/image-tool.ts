/**
 * `generate_image`: GPT Image generation through the ChatGPT (Codex) account
 * signed in on the Models page. The request goes to the `openai-codex`
 * route's Codex Responses endpoint with OpenAI's hosted `image_generation`
 * tool forced, so it spends the subscription rather than an API key; the image
 * is stored as an attachment. The tool is offered only while the setting is on
 * and a Codex sign-in is stored, so a deployment nobody signed in to offers
 * the model no tool it cannot use.
 *
 * @module dsh-llm-pi-ai/image-tool
 */

import { arch, platform, release } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { AttachmentError, AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-credentials'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { PiAiAuthInjection } from './adapter.ts'
import { recordKeyFor } from './auth.ts'
import { catalogProvider } from './catalog.ts'
import type { ImageGenerationConfig } from './config.ts'
import { readBounded } from './discovery.ts'
import { createModels } from './models.ts'

/** The pi-ai provider whose sign-in this tool spends. */
export const IMAGE_PROVIDER = 'openai-codex'
/** The endpoint every installed Codex model names, for a route whose profile sets no base URL. */
export const CODEX_BASE_URL = 'https://chatgpt.com/backend-api'
const KEY = recordKeyFor(IMAGE_PROVIDER)
/** The JWT claim ChatGPT access tokens carry the account id under. */
const ACCOUNT_CLAIM = 'https://api.openai.com/auth'

/** What the model reads when no usable sign-in exists. */
export const NOT_SIGNED_IN = 'Cannot generate images: no ChatGPT (Codex) account is signed in. '
  + 'Ask the user to sign in to ChatGPT Codex in Settings → Models, then try again.'

/** A failure this tool already worded for the model. */
class ImageToolError extends Error {}

const SIZES = ['1024x1024', '1536x1024', '1024x1536'] as const
const QUALITIES = ['low', 'medium', 'high'] as const
const BACKGROUNDS = ['auto', 'opaque', 'transparent'] as const
/** The request a call with no size, quality, or background resolves to. */
const DEFAULT_REQUEST = { size: '1024x1024', quality: 'medium', background: 'auto' } as const
const MEDIA_TYPES: Readonly<Record<string, ImageMediaType>> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' }

/** One generation as the endpoint receives it. */
export interface ImageRequestSpec {
  prompt: string
  size: typeof SIZES[number]
  quality: typeof QUALITIES[number]
  background: typeof BACKGROUNDS[number]
}

/**
 * Resolve a call's arguments into the request it sends, filling the defaults the schema describes.
 * @param args - the validated call arguments; the enums are checked by the tool schema.
 * @returns the complete request.
 */
export function resolveImageRequest(args: {
  prompt: string
  size?: string | undefined
  quality?: string | undefined
  background?: string | undefined
}): ImageRequestSpec {
  return {
    prompt: args.prompt.trim(),
    size: (args.size ?? DEFAULT_REQUEST.size) as ImageRequestSpec['size'],
    quality: (args.quality ?? DEFAULT_REQUEST.quality) as ImageRequestSpec['quality'],
    background: (args.background ?? DEFAULT_REQUEST.background) as ImageRequestSpec['background'],
  }
}

/** The stored image a generation produced. */
export interface GeneratedImageRecord {
  attachmentId: string
  mediaType: ImageMediaType
  bytes: number
  width: number
  height: number
}

/** The tool's settled value. */
export interface GeneratedImageValue {
  prompt: string
  revisedPrompt?: string
  /** Whether the calling route takes image input; otherwise the model reads text only. */
  shownToModel: boolean
  image: GeneratedImageRecord
}

const IMAGE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: true,
  properties: {
    attachmentId: { type: 'string', required: true },
    mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], required: true },
    bytes: { type: 'integer', required: true },
    width: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
  },
} as const

/**
 * Read the ChatGPT account id from an access token's claims.
 * @param token - the signed-in access token.
 * @returns the account id, or undefined when the token carries none.
 */
export function chatgptAccountId(token: string): string | undefined {
  const payload = token.split('.')[1]
  if (payload === undefined) return undefined
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>
    const auth = claims[ACCOUNT_CLAIM] as { chatgpt_account_id?: unknown } | undefined
    return typeof auth?.chatgpt_account_id === 'string' && auth.chatgpt_account_id.length > 0 ? auth.chatgpt_account_id : undefined
  } catch {
    // A token that is not a JWT names no account; the caller reports the sign-in as unusable.
    return undefined
  }
}

/** The finished image call a Responses stream reported, or the failure it ended with. */
type StreamOutcome =
  | { kind: 'image'; data: string; format: string; revisedPrompt?: string }
  | { kind: 'failed'; message: string }
  | { kind: 'none' }

/**
 * Find the generated image in a Responses SSE body.
 * @param body - the complete event stream text.
 * @returns the image, the reported failure, or none.
 */
export function readImageStream(body: string): StreamOutcome {
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (data === '' || data === '[DONE]') continue
    let event: { type?: unknown; item?: Record<string, unknown>; response?: { error?: { message?: unknown } }; message?: unknown }
    try {
      event = JSON.parse(data) as typeof event
    } catch {
      // A line that is not JSON carries no event this reader needs.
      continue
    }
    if (event.type === 'response.output_item.done' && event.item?.['type'] === 'image_generation_call') {
      const { result, output_format: format, revised_prompt: revised } = event.item
      if (typeof result === 'string' && result.length > 0) {
        return {
          kind: 'image', data: result, format: typeof format === 'string' ? format : 'png',
          ...typeof revised === 'string' && revised.length > 0 ? { revisedPrompt: revised } : {},
        }
      }
    }
    if (event.type === 'response.failed' || event.type === 'error') {
      const message = event.type === 'error' ? event.message : event.response?.error?.message
      return { kind: 'failed', message: typeof message === 'string' ? message : 'the image service reported a failure' }
    }
  }
  return { kind: 'none' }
}

/** The text the model reads beside (or instead of) the image. */
function summary(value: GeneratedImageValue): string {
  const { width, height, mediaType } = value.image
  const lines = [`Generated a ${String(width)}x${String(height)} ${mediaType} image; it is shown to the user.`]
  if (!value.shownToModel) lines.push('The current model cannot view images, so only this description is returned to you.')
  if (value.revisedPrompt !== undefined) lines.push(`Revised prompt: ${value.revisedPrompt}`)
  return lines.join('\n')
}

function imageRef(image: GeneratedImageRecord): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(image.attachmentId),
    mediaType: image.mediaType,
    bytes: image.bytes,
    width: image.width,
    height: image.height,
  }
}

/**
 * Whether the route making this call declares image input. Only a positive
 * answer returns the image to the model: a route that does not declare it
 * (or cannot be resolved) would refuse the image on its next request.
 */
async function routeTakesImages(ctx: Context, exec: ToolExecution): Promise<boolean> {
  const routed = exec.agent?.session.requestHeader()?.config
  const provider = routed?.provider ?? exec.agent?.options.provider
  const model = routed?.model ?? exec.agent?.options.model
  const llm = ctx.get('llm')
  if (provider === undefined || model === undefined || llm === undefined) return false
  try {
    return (await llm.resolveModelInfo(provider, model, exec.signal)).inputModalities?.includes('image') === true
  } catch {
    // An unresolvable route is treated as text-only, the answer that cannot break the next request.
    return false
  }
}

/** What the tool needs from the plugin that offers it. */
export interface ImageToolOptions {
  /** The credential store and ambient context the sign-in resolves through. */
  auth: PiAiAuthInjection
  /** The current image-generation settings. */
  settings: () => ImageGenerationConfig
  /** The `openai-codex` route's base URL, configured or catalog. */
  baseURL: () => string
}

/** Send one generation and return its event stream text, wording every failure for the model. */
async function requestImage(
  request: ImageRequestSpec, token: string, account: string, options: ImageToolOptions, signal: AbortSignal,
): Promise<string> {
  const settings = options.settings()
  const timeout = AbortSignal.timeout(settings.timeoutMs)
  try {
    const response = await fetch(`${options.baseURL().replace(/\/+$/u, '')}/codex/responses`, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${token}`,
        'chatgpt-account-id': account,
        // The client identity the Codex chat transport presents with the same token.
        'originator': 'pi',
        'user-agent': `pi (${platform()} ${release()}; ${arch()})`,
        'openai-beta': 'responses=experimental',
        'accept': 'text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: settings.model,
        instructions: 'Generate the requested image and return the image result only.',
        input: [{ role: 'user', content: [{ type: 'input_text', text: request.prompt }] }],
        tools: [{ type: 'image_generation', size: request.size, quality: request.quality, background: request.background }],
        tool_choice: { type: 'image_generation' },
        stream: true,
        store: false,
      }),
      signal: AbortSignal.any([signal, timeout]),
    })
    if (response.status === 401) {
      await response.body?.cancel()
      throw new ImageToolError('Cannot generate images: ChatGPT no longer accepts the signed-in account. '
        + 'Ask the user to sign in to ChatGPT Codex again in Settings → Models.')
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new ImageToolError(`Image generation failed: the ChatGPT image service refused the request (HTTP ${String(response.status)}).`)
    }
    return await readBounded(response, settings.maxResponseBytes, () =>
      new ImageToolError(`Image generation failed: the ChatGPT image service sent more than ${String(settings.maxResponseBytes)} bytes.`))
  } catch (error) {
    if (error instanceof ImageToolError || signal.aborted) throw error
    if (timeout.aborted) {
      throw new ImageToolError(`Image generation failed: no image arrived within ${String(Math.round(settings.timeoutMs / 1000))} seconds.`, { cause: error })
    }
    throw new ImageToolError('Image generation failed: the ChatGPT image service could not be reached.', { cause: error })
  }
}

/**
 * Build the `generate_image` tool.
 * @param ctx - context holding the attachment and llm services.
 * @param options - the sign-in, settings, and endpoint sources.
 * @returns the tool definition to register.
 */
export function generateImageTool(ctx: Context, options: ImageToolOptions): ToolDefinition {
  // Built once: a call only needs the Codex provider's sign-in, not the whole catalog.
  const models = createModels(options.auth)
  const provider = catalogProvider(IMAGE_PROVIDER)
  /* v8 ignore next -- the installed catalog ships openai-codex; the guard keeps one without it from crashing */
  if (provider !== undefined) models.setProvider(provider)
  return defineTool({
    name: 'generate_image',
    description: 'Generate an image from a text description with GPT Image, using the ChatGPT account the user signed in to. '
      + 'Use it when the user asks you to create, draw, or render an image. The image is shown to the user.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'A detailed description of the image to generate.' },
      size: { type: 'string', enum: [...SIZES], description: `Width x height in pixels; ${DEFAULT_REQUEST.size} when omitted.` },
      quality: { type: 'string', enum: [...QUALITIES], description: `Rendering quality; ${DEFAULT_REQUEST.quality} when omitted.` },
      background: { type: 'string', enum: [...BACKGROUNDS], description: `Background treatment; ${DEFAULT_REQUEST.background} when omitted.` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          prompt: { type: 'string', required: true },
          revisedPrompt: { type: 'string' },
          shownToModel: { type: 'boolean', required: true },
          image: IMAGE_VALUE_SCHEMA,
        },
      },
      render: (_args, value): ContentBlock[] => [
        { type: 'text', text: summary(value) },
        ...value.shownToModel ? [{ type: 'image' as const, attachment: imageRef(value.image) }] : [],
      ],
      // The conversation shows the image from here whether or not the model received it.
      presentationMeta: (_args, value) => ({ image: { ...value.image } }),
    },
    async execute(args, exec): Promise<GeneratedImageValue> {
      const request = resolveImageRequest(args)
      if (request.prompt.length === 0) throw new Error('prompt must describe the image to generate')
      const attachments = ctx.get('attachments')
      /* v8 ignore next -- the tool is registered only while the attachment service is injected */
      if (attachments === undefined) throw new Error('image generation needs the attachment service')
      let token: string | undefined
      try {
        token = (await models.getAuth(IMAGE_PROVIDER))?.auth.apiKey
      } catch (error) {
        // A refresh the service refused leaves no usable sign-in.
        throw new Error(NOT_SIGNED_IN, { cause: error })
      }
      const account = token === undefined ? undefined : chatgptAccountId(token)
      if (token === undefined || account === undefined) throw new Error(NOT_SIGNED_IN)
      const outcome = readImageStream(await requestImage(request, token, account, options, exec.signal))
      if (outcome.kind === 'failed') throw new Error(`Image generation failed: ${outcome.message}`)
      if (outcome.kind === 'none') throw new Error('Image generation failed: the ChatGPT image service returned no image.')
      const mediaType = MEDIA_TYPES[outcome.format] ?? 'image/png'
      let ref: ImageAttachmentRef
      try {
        ref = await attachments.saveImage({
          data: Buffer.from(outcome.data, 'base64'),
          mediaType,
          name: `generated-image.${mediaType.slice('image/'.length)}`,
        })
      } catch (error) {
        if (!(error instanceof AttachmentError)) throw error
        throw new Error(`Image generation failed: the generated image could not be stored (${error.code}).`, { cause: error })
      }
      return {
        prompt: request.prompt,
        ...outcome.revisedPrompt === undefined ? {} : { revisedPrompt: outcome.revisedPrompt },
        shownToModel: await routeTakesImages(ctx, exec),
        image: { attachmentId: ref.attachmentId, mediaType: ref.mediaType, bytes: ref.bytes, width: ref.width, height: ref.height },
      }
    },
  })
}

/**
 * Offer `generate_image` while the setting is on and a Codex sign-in is stored, re-checking on
 * every sign-in change, and withdrawing it with the calling fiber. A settings change reaches only
 * the plugin's own fiber, so the plugin calls the returned check itself.
 * @param ctx - context with the tool registry, attachments, and credentials.
 * @param options - the sign-in, settings, and endpoint sources.
 * @returns the check to run after the settings change.
 */
export function registerImageTool(ctx: Context, options: ImageToolOptions): () => void {
  const tool = generateImageTool(ctx, options)
  let registered: (() => void) | undefined
  let disposed = false
  // One check at a time, so a burst of updates settles on the latest state.
  let pending = Promise.resolve()
  const sync = (): void => {
    pending = pending.then(async () => {
      const wanted = options.settings().enabled && (await ctx.credentials.describeRecord(KEY)).configured
      // A check that finishes after disposal must not register into a fiber that is gone.
      if (disposed) return
      if (wanted && registered === undefined) registered = ctx.tools.register(tool)
      else if (!wanted && registered !== undefined) {
        registered()
        registered = undefined
      }
    }).catch((error: unknown) => {
      ctx.logger.warn('llm-pi-ai: could not read the ChatGPT (Codex) sign-in; generate_image stays as it was')
      ctx.logger.warn(error)
    })
  }
  ctx.on('credentials/record-updated', (key) => { if (key === KEY) sync() })
  ctx.effect(() => {
    sync()
    return () => {
      disposed = true
      registered?.()
      registered = undefined
    }
  }, 'llm-pi-ai: generate_image')
  return sync
}
