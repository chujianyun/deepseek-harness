/** Register the Tool call tree, details renderer, and built-in atomic views. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { RemoteHostFacts } from '@deepseek-ai/dsh-api-remotes/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { ToolCallTree } from './tool/ToolCallTree.tsx'
import { CONVERSATION_NS as NS } from './locale.ts'
import { askQuestionToolview } from './tool/toolviews/ask-question-row.tsx'
import { bashToolviewSample } from './tool/toolviews/bash-sample.tsx'
import { fileMutationToolview } from './tool/toolviews/file-mutation-row.tsx'
import { readToolview } from './tool/toolviews/read-row.tsx'
import { readImageToolview } from './tool/toolviews/read-image-row.tsx'
import { generateImageToolview } from './tool/toolviews/generate-image-row.tsx'
import { generatedImagesDefinition } from './tool/generated/generated-images.ts'
import { GeneratedImagesTail } from './tool/generated/GeneratedImagesTail.tsx'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import { searchToolview } from './tool/toolviews/search-row.tsx'
import { detailsToolview } from './tool/toolviews/details-row.tsx'
import { todoToolview } from './tool/toolviews/todo-row.tsx'
import { webToolview } from './tool/toolviews/web-row.tsx'

/**
 * Required services: the slot registry, the Remote face carrying the Host home used for POSIX `~`, and the
 * conversation service the generated-images Turn data and image URLs come from.
 */
export const inject = ['slots', 'remote', 'uiConversation']

/**
 * Mount the whole-Tool renderers and built-in atomic Tool registrations.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  const hostInfo: HostObservable<RemoteHostFacts> = {
    getSnapshot: () => ctx.remote.$host,
    subscribe: listener => ctx.on('connection/reset', listener),
  }
  const toolInject = () => ({ hooks: { hostInfo } })
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'tool-call',
    locale: NS,
    children: {
      'tool.call.toolview': { kind: 'keyed', scope: 'session' },
    },
    inject: toolInject,
  }, ToolCallTree))

  // Generated images show under the Turn's answer, outside the collapsed process holding their Tool rows.
  ctx.effect(() => ctx.uiConversation.events.register(generatedImagesDefinition), 'ui-tool: generated images')
  ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail',
    id: '@deepseek-ai/dsh-client-ui-tool/generated-images',
    locale: NS,
    children: { 'tool.call.generated-images': { kind: 'single', scope: 'session' } },
    inject: sessionId => ({
      loadImage: Object.assign(
        (attachment: ImageAttachmentRef) => ctx.uiConversation.imageUrl(sessionId, attachment),
        { peek: (attachment: ImageAttachmentRef) => ctx.uiConversation.peekImageUrl(sessionId, attachment) },
      ),
    }),
  }, GeneratedImagesTail))

  ctx.plugin(bashToolviewSample)
  ctx.plugin(readToolview)
  ctx.plugin(readImageToolview)
  ctx.plugin(generateImageToolview)
  ctx.plugin(fileMutationToolview)
  ctx.plugin(searchToolview)
  ctx.plugin(webToolview)
  ctx.plugin(todoToolview)
  ctx.plugin(detailsToolview)
  ctx.plugin(askQuestionToolview)
}
