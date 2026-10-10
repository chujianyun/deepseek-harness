/** Host registration for the browser locale preference. */
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-host-webserver'

import type { Volatile, Context } from '@deepseek-ai/cordis'

import z from '@deepseek-ai/schemastery'
import { LOCALE_PREFERENCE_FIELD, documentLanguage } from './locale-settings.ts'

import { LocaleSettingsFields } from './locale-settings.ts'

export {
  LOCALE_IDS, LOCALE_PREFERENCE_FIELD, LOCALE_SETTINGS_NAMESPACE, documentLanguage,
  type BuiltInLocaleId, type LocaleId, type LocaleSettings,
} from './locale-settings.ts'

/** Runtime preferences projected to the browser. */
export interface Config {
  /** Explicit locale; omission follows the browser. */
  preference: Volatile<string | undefined>
}

/** Live preferences projected to the browser. */
export const Config = z.object({
  preference: LocaleSettingsFields[LOCALE_PREFERENCE_FIELD].volatile(),
})

/**
 * Host preferences are consumed through the configuration form projection. An explicit preference
 * is also written into `<html lang>` by each index render, marked `data-dsh-locale-explicit`, so
 * pages that run before the client locale plugin (the boot page) read the user's language.
 * @param ctx Plugin context used for optional settings presentation.
 * @param config Live locale preference.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  ctx.on('webserver/index-inject', (table) => {
    const preference = config.preference.get()
    if (preference === undefined) return
    const language = JSON.stringify(documentLanguage(preference))
    table.push({ kind: 'script', placement: 'head', text: `document.documentElement.lang = ${language}; document.documentElement.dataset.dshLocaleExplicit = ''` })
  })
}
