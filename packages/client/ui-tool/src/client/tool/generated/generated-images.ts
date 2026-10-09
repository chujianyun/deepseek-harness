/**
 * The images `generate_image` calls produced in one Turn, published as Turn
 * data so the Turn's tail can show them under the answer. A generated picture
 * is the answer itself, while the Tool row that produced it sits inside the
 * Turn's collapsed process.
 */

import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import type { TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { imageReferences } from '../models/image-card-model.ts'

/** One generated image and the result event that carried it. */
export interface GeneratedImage {
  readonly seq: number
  readonly attachment: ImageAttachmentRef
}

/** Generated images accumulated in one Turn, in result order. */
export interface GeneratedImagesTurnData {
  readonly images: readonly GeneratedImage[]
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationTurnDataMap {
    /** Images the Turn's `generate_image` calls produced. */
    'generated-images': GeneratedImagesTurnData
  }
}

interface GeneratedImagesState extends GeneratedImagesTurnData {
  readonly turn: number
  /** Call ids of this Turn's `generate_image` calls. */
  readonly calls: ReadonlySet<string>
}

/** Folds each Turn's `generate_image` calls and their image results into Turn data. */
export const generatedImagesDefinition: ConversationNodeDefinition<GeneratedImagesState> = {
  kind: 'generated-images',
  match: (event) => {
    if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
    if (event.type === 'tool/call' && event.data.name === 'generate_image') return { id: String(event.data.turn), role: 'update' }
    if (event.type === 'tool/result' && isAppendSurfaceEvent(event)) return { id: String(event.data.turn), role: 'update' }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'turn/start') throw new Error('generated-images start requires turn/start')
    return { turn: match.event.data.turn, calls: new Set(), images: [] }
  },
  update: (context, match) => {
    const { event } = match
    if (event.type === 'tool/call') {
      return { ...context.state, calls: new Set([...context.state.calls, String(event.data.callId)]) }
    }
    if (event.type !== 'tool/result' || event.data.message.isError === true) return context.state
    if (!context.state.calls.has(String(event.data.message.source.callId))) return context.state
    const refs = imageReferences(event.data.message.content)
    if (refs === null) return context.state
    return { ...context.state, images: [...context.state.images, ...refs.map(attachment => ({ seq: event.seq, attachment }))] }
  },
  buildLocationData: (context, scope, previous) => {
    if (scope !== 'turn' || context.state === undefined || context.state.images.length === 0) return null
    if (previous?.kind === 'turn' && previous.turn === context.state.turn && previous.key === 'generated-images'
      && previous.value.images === context.state.images) return previous
    return { kind: 'turn', turn: context.state.turn, key: 'generated-images', value: { images: context.state.images } }
  },
}

/**
 * The images a Turn's tail shows: those produced before its closing sequence.
 * @param owner - the Turn tail's owner props.
 * @returns the images in result order; empty when the Turn generated none.
 */
export function generatedImagesForClosing(owner: TurnTailOwnerProps): GeneratedImage[] {
  return (owner.turn.data.get('generated-images')?.images ?? []).filter(image => image.seq < owner.seq)
}
