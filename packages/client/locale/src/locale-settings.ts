/** Locale preference stored in the Host user-settings document. */

import z from '@deepseek-ai/schemastery'

/** Settings namespace owned by the locale plugin. */
export const LOCALE_SETTINGS_NAMESPACE = 'locale'

/** Field carrying an explicit locale selection; absence delegates to the browser. */
export const LOCALE_PREFERENCE_FIELD = 'preference'

/** Accepted BCP 47-style language ids. */
export const LOCALE_ID_PATTERN = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u

/** Locale identifiers shipped by the browser client. */
export const LOCALE_IDS = ['zh', 'en'] as const

/** Locale identifier shipped by the browser client. */
export type BuiltInLocaleId = typeof LOCALE_IDS[number]

/** Open locale identifier accepted from language-pack plugins. */
export type LocaleId = string

/** Durable locale section shared by the Host schema and the browser scope. */
export interface LocaleSettings {
  /** Explicit locale selection; absence delegates to the browser. */
  preference?: LocaleId
}

/** Durable locale schema; also the wire envelope the browser scope validates against. */
export const LocaleSettingsFields = {
  [LOCALE_PREFERENCE_FIELD]: z.string().pattern(LOCALE_ID_PATTERN).required(false),
}

/**
 * `<html lang>` value for a locale id: the built-in `zh` pack is Simplified Chinese as used in mainland China.
 * @param id - locale id.
 * @returns the BCP 47 tag for the document element.
 */
export function documentLanguage(id: LocaleId): string {
  return id === 'zh' ? 'zh-CN' : id
}

/** Schema for the shared locale preference. */
export const LocaleSettingsSchema = z.object(LocaleSettingsFields)
