/** MO WorkAI brand, browser half: the 名流蓝 token layer and the sidebar brand row. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import { MoBrandMark, MoWordmark } from './Brand.tsx'
import { MO_THEME_TOKENS } from './tokens.ts'

/** Override-layer source id; the theme runtime replaces an earlier layer with the same id. */
export const MO_THEME_SOURCE = '@deepseek-ai/dsh-client-ui-brand-mo'

/** Required services: the theme runtime that owns token layers, and the UI slot registry. */
export const inject = ['theme', 'slots']

/**
 * Apply the MO token layer and occupy both sidebar brand slots for exactly the plugin lifetime:
 * the wordmark in the expanded row, the app icon on the collapsed rail.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.theme.overrideTokens(MO_THEME_SOURCE, MO_THEME_TOKENS), 'ui-brand-mo: theme tokens')
  ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.inject('sidebar.brand.name', function* () {
    yield ctx.slots.register({ name: 'sidebar.brand.mark' }, MoBrandMark)
    yield ctx.slots.register({ name: 'sidebar.brand.name' }, MoWordmark)
  }))
}
