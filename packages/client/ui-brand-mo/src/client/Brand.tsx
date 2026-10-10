/** MO WorkAI sidebar brand: the wire-frame wordmark in the expanded row, the app icon on the collapsed rail. */
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { MO_MARK } from '../mark.ts'
import { MO_WORDMARK } from '../wordmark.ts'
import css from './Brand.module.css'

/**
 * Render the navy app icon alone on the collapsed rail; beside the expanded wordmark, nothing.
 * @param props - Host-supplied mark size and placement.
 * @returns the rail mark, or null in the expanded row.
 */
export function MoBrandMark({ size, placement }: SidebarBrandMarkOwnerProps) {
  if (placement === 'row') return null
  return <img className={css.mark} src={MO_MARK} alt="" width={size} height={size} draggable={false} />
}

/**
 * Render the MO wire-frame wordmark as the expanded brand: light on the dark theme, inverted to
 * dark on the light theme. It is decorative: the sidebar hides the brand row from assistive
 * technology. The build version is not shown here; General Settings shows it.
 * @returns the wordmark.
 */
export function MoWordmark() {
  return <img className={css.wordmark} src={MO_WORDMARK} alt="" draggable={false} />
}
