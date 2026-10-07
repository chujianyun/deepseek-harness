/** An assistant's avatar: a built-in preset drawn as a colored disc with the name's first character. */

import type { AssistantAvatar as Avatar } from '@deepseek-ai/dsh-assistants/types'
import css from './AssistantAvatar.module.css'

/** Disc colors of the built-in preset avatars; an unknown key falls back to the neutral disc. */
const PRESET_TONES: Readonly<Record<string, string>> = {
  sun: 'sun',
}

/**
 * Render the avatar.
 * @param props - the avatar, the assistant's name, and the edge length in pixels.
 * @returns the avatar element.
 */
export function AssistantAvatar({ avatar, name, size }: { readonly avatar: Avatar; readonly name: string; readonly size: number }) {
  const initial = Array.from(name.trim())[0] ?? ''
  return (
    <span
      className={css.avatar}
      data-tone={PRESET_TONES[avatar.key] ?? 'neutral'}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.5) }}
      aria-hidden="true"
    >
      {initial}
    </span>
  )
}
