/**
 * `generate_image`: GPT Image generation through the ChatGPT (Codex) account
 * signed in on the Models page. The request goes to the Codex Responses
 * endpoint with OpenAI's hosted `image_generation` tool forced, so it spends
 * the subscription rather than an API key; the image is stored as an
 * attachment and returned to the conversation. The tool is registered only
 * while a Codex sign-in is stored, so a deployment nobody signed in to offers
 * the model no tool it cannot use.
 *
 * @module @deepseek-ai/dsh-llm-pi-ai/image-tool
 */

import type { Context } from '@deepseek-ai/cordis'
import { AttachmentError, AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-credentials'
import Schema from '@deepseek-ai/schemastery'
import { authContextFrom, credentialStoreFrom, recordKeyFor } from './auth.ts'
import { catalogProvider } from './catalog.ts'
import { createModels } from './models.ts'

/** The pi-ai provider whose sign-in this tool spends. */
const PROVIDER = 'openai-codex'
const KEY = recordKeyFor(PROVIDER)
/** The JWT claim ChatGPT access tokens carry the account id under. */
const ACCOUNT_CLAIM = 'https://api.openai.com/auth'

/** What the model reads when no usable sign-in exists. */
export const NOT_SIGNED_IN = 'Cannot generate images: no ChatGPT (Codex) account is signed in. '
  + 'Ask the user to sign in to ChatGPT Codex in Settings → Models, then try again.'

/** Plugin name. */
export const name = 'llm-pi-ai-image-tool'

/** The tool registry, the attachment store the image lands in, and the store holding the sign-in. */
export const inject = ['tools', 'attachments', 'credentials']

/** Deployment configuration of the image tool (all optional — `Config` supplies the defaults). */
export interface Config {
  /** Codex model that runs the hosted image generation call. */
  model?: string
  /** ChatGPT backend base URL; requests go to `<baseURL>/codex/responses`. */
  baseURL?: string
  /** Upper bound of one generation, in milliseconds. */
  timeoutMs?: number
}

/** The configuration with every default filled. */
type ResolvedConfig = Required<Config>

/** Validated configuration. */
export const Config: Schema<Config> = Schema.object({
  // The Codex CLI's default model, which the hosted image tool is served for.
  model: Schema.string().default('gpt-5.6-sol').description('Codex model that runs the hosted image generation call.'),
  baseURL: Schema.string().default('https://chatgpt.com/backend-api').description('ChatGPT backend base URL.'),
  timeoutMs: Schema.natural().min(1).default(300_000).description('Upper bound of one generation, in milliseconds.'),
})

const SIZES = ['1024x1024', '1536x1024', '1024x1536'] as const
const QUALITIES = ['low', 'medium', 'high'] as const
const BACKGROUNDS = ['auto', 'opaque', 'transparent'] as const
const MEDIA_TYPES: Readonly<Record<string, ImageMediaType>> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' }

/** The tool's settled value: the prompt it ran, what the service made of it, and the stored image. */
export interface GeneratedImageValue {
  prompt: string
  revisedPrompt?: string
  image: {
    attachmentId: string
    mediaType: ImageMediaType
    bytes: number
    width: number
    height: number
  }
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

/** The text the model reads beside the image. */
function summary(value: GeneratedImageValue): string {
  const { width, height, mediaType } = value.image
  const lines = [`Generated a ${String(width)}x${String(height)} ${mediaType} image; it is shown to the user.`]
  if (value.revisedPrompt !== undefined) lines.push(`Revised prompt: ${value.revisedPrompt}`)
  return lines.join('\n')
}

function imageRef(image: GeneratedImageValue['image']): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(image.attachmentId),
    mediaType: image.mediaType,
    bytes: image.bytes,
    width: image.width,
    height: image.height,
  }
}

/**
 * Build the `generate_image` tool.
 * @param ctx - context holding the credential and attachment services.
 * @param config - the validated configuration.
 * @returns the tool definition to register.
 */
export function generateImageTool(ctx: Context, config: ResolvedConfig): ToolDefinition {
  const auth = { credentials: credentialStoreFrom(ctx), authContext: authContextFrom(ctx) }
  const provider = catalogProvider(PROVIDER)
  return defineTool({
    name: 'generate_image',
    description: 'Generate an image from a text description with GPT Image, using the ChatGPT account the user signed in to. '
      + 'Use it when the user asks you to create, draw, or render an image. The image is shown to the user and returned to you.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'A detailed description of the image to generate.' },
      size: { type: 'string', enum: [...SIZES], description: 'Width x height in pixels; 1024x1024 when omitted.' },
      quality: { type: 'string', enum: [...QUALITIES], description: 'Rendering quality; medium when omitted.' },
      background: { type: 'string', enum: [...BACKGROUNDS], description: 'Background treatment; auto when omitted.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          prompt: { type: 'string', required: true },
          revisedPrompt: { type: 'string' },
          image: IMAGE_VALUE_SCHEMA,
        },
      },
      render: (_args, value): ContentBlock[] => [
        { type: 'text', text: summary(value) },
        { type: 'image', attachment: imageRef(value.image) },
      ],
    },
    async execute(args, exec): Promise<GeneratedImageValue> {
      const prompt = args.prompt.trim()
      if (prompt.length === 0) throw new Error('prompt must describe the image to generate')
      const attachments = ctx.get('attachments')
      /* v8 ignore next -- the tool is registered only while the attachment service is injected */
      if (attachments === undefined || provider === undefined) throw new Error('image generation needs the attachment service and the Codex provider')
      const models = createModels(auth)
      models.setProvider(provider)
      let token: string | undefined
      try {
        token = (await models.getAuth(PROVIDER))?.auth.apiKey
      } catch (error) {
        // A refresh the service refused leaves no usable sign-in.
        throw new Error(NOT_SIGNED_IN, { cause: error })
      }
      const account = token === undefined ? undefined : chatgptAccountId(token)
      if (token === undefined || account === undefined) throw new Error(NOT_SIGNED_IN)

      const response = await fetch(`${config.baseURL.replace(/\/+$/u, '')}/codex/responses`, {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${token}`,
          'chatgpt-account-id': account,
          'openai-beta': 'responses=experimental',
          'accept': 'text/event-stream',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: config.model,
          instructions: 'Generate the requested image and return the image result only.',
          input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }],
          tools: [{
            type: 'image_generation',
            size: args.size ?? '1024x1024',
            quality: args.quality ?? 'medium',
            background: args.background ?? 'auto',
          }],
          tool_choice: { type: 'image_generation' },
          stream: true,
          store: false,
        }),
        signal: AbortSignal.any([exec.signal, AbortSignal.timeout(config.timeoutMs)]),
      })
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel()
        throw new Error('Cannot generate images: ChatGPT refused the signed-in account. Ask the user to sign in to ChatGPT Codex again in Settings → Models.')
      }
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error(`Image generation failed: the ChatGPT image service answered HTTP ${String(response.status)}.`)
      }
      const outcome = readImageStream(await response.text())
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
        prompt,
        ...outcome.revisedPrompt === undefined ? {} : { revisedPrompt: outcome.revisedPrompt },
        image: {
          attachmentId: ref.attachmentId,
          mediaType: ref.mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
        },
      }
    },
  })
}

/**
 * Offer `generate_image` while a Codex sign-in is stored, and withdraw it when the sign-in goes.
 * @param ctx - plugin context with the tool registry, attachments, and credentials.
 * @param config - the validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  // schemastery (Config) has already filled every defaulted field.
  const tool = generateImageTool(ctx, config as ResolvedConfig)
  let registered: (() => void) | undefined
  // One check at a time, so a burst of record updates settles on the latest state.
  let pending = Promise.resolve()
  const sync = (): void => {
    pending = pending.then(async () => {
      const signedIn = (await ctx.credentials.describeRecord(KEY)).configured
      if (signedIn && registered === undefined) registered = ctx.tools.register(tool)
      else if (!signedIn && registered !== undefined) {
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
      registered?.()
      registered = undefined
    }
  }, 'llm-pi-ai: generate_image')
}
