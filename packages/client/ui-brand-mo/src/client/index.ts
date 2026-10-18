/** MO WorkAI brand, browser half: the 名流蓝 token layer and the sidebar brand row. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-assistants/client'
import type {} from '@deepseek-ai/dsh-client-ui-commands/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-deliverables/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { BRAND_SETTINGS_NAMESPACE } from '../quick-tasks.ts'
import { MoBrandMark, MoWordmark } from './Brand.tsx'
import { en, zh, type BrandLocaleKey } from './locales.ts'
import { OpenWithMenu } from './OpenWithMenu.tsx'
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
 * composer and apply the configured default grouping and rows per group to the sidebar, and, while the command UI is
 * mounted, leave the configured commands out of the composer's + menu; their absence leaves the theme and the brand row in place.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.theme.overrideTokens(MO_THEME_SOURCE, MO_THEME_TOKENS), 'ui-brand-mo: theme tokens')
  // Ahead of the official brand (priority 0), which the official client build also registers where both run.
  ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.inject('sidebar.brand.name', function* () {
    yield ctx.slots.register({ name: 'sidebar.brand.mark', priority: -1 }, MoBrandMark)
    yield ctx.slots.register({ name: 'sidebar.brand.name', priority: -1 }, MoWordmark)
  }))
  ctx.inject(['locale', 'configForms'], (scope: ClientContext) => {
    scope.effect(() => scope.locale.register(NS, { zh, en }), 'ui-brand-mo: dictionaries')
    const brandSettings = scope.configForms.get<BrandSettings>(BRAND_SETTINGS_NAMESPACE)
    const quickTasksFace: QuickTasksInjected = {
      hooks: { brandSettings },
      // The assistants UI is optional and read at click time; without it there is nothing to pick.
      pickAssistant: templateId => ctx.get('assistantPicker')?.pickTemplate(templateId) ?? Promise.resolve(true),
    }
    // "打开方式" on delivered and changed files: the enterprise Desktop mounts no Open In, so this is the only file action.
    scope.slots.inject('deliverables.file.actions', () => scope.slots.inject('deliverables.review.file.actions', function* () {
      yield scope.slots.register({ name: 'deliverables.file.actions', id: 'mo-open-with', locale: NS }, OpenWithMenu)
      yield scope.slots.register({ name: 'deliverables.review.file.actions', id: 'mo-open-with', locale: NS }, OpenWithMenu)
    }))
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
            // The new value is in place before the old one is withdrawn, so the sidebar never shows its own default between them.
            const previous = withdraw
            current = next
            withdraw = next === undefined ? undefined : apply(next)
            previous?.()
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
    // The configured commands stay out of the composer's + menu while both this plugin and the command UI are mounted.
    scope.inject(['commandUi'], (commands: ClientContext) => {
      commands.effect(() => {
        let current = ''
        let withdraw: readonly (() => void)[] = []
        const sync = (): void => {
          const names = brandSettings.getSnapshot().value?.menuHiddenCommands ?? []
          const next = names.join('\n')
          if (next === current) return
          current = next
          const previous = withdraw
          withdraw = names.map(name => commands.commandUi.hideFromMenu(name))
          for (const release of previous) release()
        }
        sync()
        const stop = brandSettings.subscribe(sync)
        return () => {
          stop()
          for (const release of withdraw) release()
        }
      }, 'ui-brand-mo: commands left out of the + menu')
    })
  })
}
