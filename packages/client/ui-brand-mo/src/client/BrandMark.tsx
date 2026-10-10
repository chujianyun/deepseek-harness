/** MO WorkAI product mark for the sidebar brand row and the collapsed rail. */
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { MO_MARK } from '../mark.ts'

/**
 * Render the navy MO app icon at the size the sidebar requests, beside the name and on the rail alike.
 * @param props - Host-supplied mark size.
 * @returns the mark image.
 */
export function MoBrandMark({ size }: SidebarBrandMarkOwnerProps) {
  return <img src={MO_MARK} alt="" width={size} height={size} draggable={false} style={{ display: 'block', borderRadius: '22%' }} />
}
