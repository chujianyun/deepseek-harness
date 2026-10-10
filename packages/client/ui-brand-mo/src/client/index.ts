/** MO WorkAI brand, browser half: the 名流蓝 token layer and the sidebar brand row. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import { BRAND_SETTINGS_NAMESPACE, type QuickTaskId } from '../quick-tasks.ts'
import { MoBrandMark, MoWordmark } from './Brand.tsx'
import { en, zh, type BrandLocaleKey } from './locales.ts'
import { QuickTasks, type QuickTasksInjected } from './QuickTasks.tsx'
import { MO_THEME_TOKENS } from './tokens.ts'

export type { BrandLocaleKey } from './locales.ts'
export type { QuickTasksInjected, QuickTasksProps } from './QuickTasks.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** MO brand copy. */
    'ui-brand-mo': BrandLocaleKey
  }
}

const NS = 'ui-brand-mo'

/** Override-layer source id; the theme runtime replaces an earlier layer with the same id. */
export const MO_THEME_SOURCE = '@deepseek-ai/dsh-client-ui-brand-mo'

/** Required services: the theme runtime, the UI slot registry, the locale registry, and the settings forms. */
export const inject = ['theme', 'slots', 'locale', 'configForms']

/**
 * Apply the MO token layer and occupy both sidebar brand slots for exactly the plugin lifetime:
 * the wordmark in the expanded row, the app icon on the collapsed rail; offer the configured quick
 * tasks under the blank new-session composer.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.theme.overrideTokens(MO_THEME_SOURCE, MO_THEME_TOKENS), 'ui-brand-mo: theme tokens')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-brand-mo: dictionaries')
  const brandSettings = ctx.configForms.get<{ quickTasks?: readonly QuickTaskId[] }>(BRAND_SETTINGS_NAMESPACE)
  const quickTasksFace: QuickTasksInjected = { hooks: { brandSettings } }
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock', id: 'mo-quick-tasks', order: 10, locale: NS, inject: () => quickTasksFace,
  }, QuickTasks))
  ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.inject('sidebar.brand.name', function* () {
    yield ctx.slots.register({ name: 'sidebar.brand.mark' }, MoBrandMark)
    yield ctx.slots.register({ name: 'sidebar.brand.name' }, MoWordmark)
  }))
}
