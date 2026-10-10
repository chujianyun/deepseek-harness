/** MO WorkAI brand, browser half: the 名流蓝 token layer and the product mark in the sidebar brand row. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import { MoBrandMark } from './BrandMark.tsx'
import { MO_THEME_TOKENS } from './tokens.ts'

/** Override-layer source id; the theme runtime replaces an earlier layer with the same id. */
export const MO_THEME_SOURCE = '@deepseek-ai/dsh-client-ui-brand-mo'

/** Required services: the theme runtime that owns token layers, and the UI slot registry. */
export const inject = ['theme', 'slots']

/**
 * Apply the MO token layer and occupy `sidebar.brand.mark` for exactly the plugin lifetime. The
 * tenant's name beside the mark comes from the Hub account UI.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.theme.overrideTokens(MO_THEME_SOURCE, MO_THEME_TOKENS), 'ui-brand-mo: theme tokens')
  ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.register({ name: 'sidebar.brand.mark' }, MoBrandMark))
}
