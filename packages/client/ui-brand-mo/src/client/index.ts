/** MO WorkAI brand, browser half: the 名流蓝 token layer and the sidebar brand row. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-assistants/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { BRAND_SETTINGS_NAMESPACE } from '../quick-tasks.ts'
import { MoBrandMark, MoWordmark } from './Brand.tsx'
import { en, zh, type BrandLocaleKey } from './locales.ts'
import { QuickTasks, type BrandSettings, type QuickTasksInjected } from './QuickTasks.tsx'
import { MO_THEME_TOKENS } from './tokens.ts'

export type { BrandLocaleKey } from './locales.ts'
export type { BrandSettings, QuickTasksInjected, QuickTasksProps } from './QuickTasks.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** MO brand copy. */
    'ui-brand-mo': BrandLocaleKey
  }
}

const NS = 'ui-brand-mo'

/** Override-layer source id; the theme runtime replaces an earlier layer with the same id. */
export const MO_THEME_SOURCE = '@deepseek-ai/dsh-client-ui-brand-mo'

/** Required services: the theme runtime and the UI slot registry; the quick tasks also need the locale registry and the settings forms. */
export const inject = ['theme', 'slots']

/**
 * Apply the MO token layer and occupy both sidebar brand slots for exactly the plugin lifetime:
 * the wordmark in the expanded row, the app icon on the collapsed rail. While the locale registry
 * and the settings forms are present, offer the configured quick tasks under the blank new-session
 * composer and apply the configured default grouping and rows per group to the sidebar; their absence leaves the theme
 * and the brand row in place.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.theme.overrideTokens(MO_THEME_SOURCE, MO_THEME_TOKENS), 'ui-brand-mo: theme tokens')
  ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.inject('sidebar.brand.name', function* () {
    yield ctx.slots.register({ name: 'sidebar.brand.mark' }, MoBrandMark)
    yield ctx.slots.register({ name: 'sidebar.brand.name' }, MoWordmark)
  }))
  ctx.inject(['locale', 'configForms'], (scope: ClientContext) => {
    scope.effect(() => scope.locale.register(NS, { zh, en }), 'ui-brand-mo: dictionaries')
    const brandSettings = scope.configForms.get<BrandSettings>(BRAND_SETTINGS_NAMESPACE)
    const quickTasksFace: QuickTasksInjected = {
      hooks: { brandSettings },
      // The assistants UI is optional and read at click time; without it there is nothing to pick.
      pickAssistant: templateId => ctx.get('assistantPicker')?.pickTemplate(templateId) ?? Promise.resolve(true),
    }
    scope.slots.inject('conversation.hero.dock', () => scope.slots.register({
      name: 'conversation.hero.dock', id: 'mo-quick-tasks', order: 10, locale: NS, inject: () => quickTasksFace,
    }, QuickTasks))
    // The configured grouping and rows per group apply while both this plugin and the sidebar are mounted.
    scope.inject(['uiWorkspace'], (sidebar: ClientContext) => {
      /** Keep one sidebar setting equal to a brand setting, withdrawing it when unset or on dispose. */
      const follow = <T>(
        read: (settings: BrandSettings | undefined) => T | undefined, apply: (value: T) => () => void, label: string,
      ): void => {
        sidebar.effect(() => {
          let current: T | undefined
          let withdraw: (() => void) | undefined
          const sync = (): void => {
            const next = read(brandSettings.getSnapshot().value)
            if (next === current) return
            withdraw?.()
            current = next
            withdraw = next === undefined ? undefined : apply(next)
          }
          sync()
          const stop = brandSettings.subscribe(sync)
          return () => {
            stop()
            withdraw?.()
          }
        }, label)
      }
      follow(
        settings => (settings?.defaultSessionGrouping === '' ? undefined : settings?.defaultSessionGrouping),
        id => sidebar.uiWorkspace.setDefaultSessionGrouping(id), 'ui-brand-mo: default session grouping',
      )
      follow(settings => settings?.sessionsPerGroup, limit => sidebar.uiWorkspace.setSessionGroupLimit(limit), 'ui-brand-mo: sessions per group')
    })
  })
}
