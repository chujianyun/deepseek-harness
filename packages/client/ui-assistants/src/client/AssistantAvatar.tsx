/** An assistant's avatar: an uploaded image, or a preset drawn as a colored disc with the name's first character. */

import type { AssistantAvatar as Avatar } from '@deepseek-ai/dsh-assistants/types'
import css from './AssistantAvatar.module.css'

/** Built-in preset keys, in the order the creation wizard offers them. */
export const PRESET_AVATAR_KEYS = [
  'sun', 'ocean', 'forest', 'grape', 'rose', 'slate', 'amber', 'mint',
  'sky', 'berry', 'coral', 'olive', 'ink', 'peach', 'teal', 'lilac',
] as const

const KNOWN = new Set<string>(PRESET_AVATAR_KEYS)

/**
 * Render the avatar.
 * @param props - the avatar, the assistant's name, and the edge length in pixels.
 * @returns the avatar element.
 */
export function AssistantAvatar({ avatar, name, size }: { readonly avatar: Avatar; readonly name: string; readonly size: number }) {
  if (avatar.kind === 'image') {
    return <img className={css.avatar} src={avatar.dataUrl} alt="" width={size} height={size} aria-hidden="true" />
  }
  const initial = Array.from(name.trim())[0] ?? ''
  return (
    <span
      className={css.avatar}
      data-tone={KNOWN.has(avatar.key) ? avatar.key : 'neutral'}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.5) }}
      aria-hidden="true"
    >
      {initial}
    </span>
  )
}
