/**
 * Turn-tail entry showing the images the Turn generated, below its answer.
 * The pictures render through the `tool.call.generated-images` slot this
 * entry declares, which the attachment presentation plugin fills.
 */

import type { InjectFace, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { MessageImageLoader } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { generatedImagesForClosing } from './generated-images.ts'
import css from './GeneratedImagesTail.module.css'

/** What the entry's inject face supplies: the session-authorized image loader. */
export interface GeneratedImagesTailInjected {
  loadImage: MessageImageLoader
}

/** Props of {@link GeneratedImagesTail}. */
export type GeneratedImagesTailProps = PropsRuntime<'conversation.chat.turnTail'>
  & Partial<InjectFace<GeneratedImagesTailInjected>>
  & PropsRenderSlots<'tool.call.generated-images'>

/**
 * Render the Turn's generated images, or nothing when it generated none.
 * @param props - the Turn tail owner, the image loader, and the gallery slot dispatch.
 * @returns the gallery, or null.
 */
export function GeneratedImagesTail(props: GeneratedImagesTailProps) {
  const images = generatedImagesForClosing(props)
  if (images.length === 0 || props.loadImage === undefined) return null
  return (
    <div className={css['root']} data-generated-images>
      {props.renderSlot('tool.call.generated-images', {
        images: images.map(image => ({ attachment: image.attachment })),
        loadImage: props.loadImage,
        align: 'start',
      })}
    </div>
  )
}
