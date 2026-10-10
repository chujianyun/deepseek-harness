/** MO WorkAI theme tokens: the 名流蓝 accent and the brand greys over the platform palette. */
import type { ThemeTokenOverrides } from '@deepseek-ai/dsh-client-ui-theme/client'

/** Repeat one value for both palettes. */
const both = (value: string) => ({ light: value, dark: value })

/**
 * 名流蓝 accent ramp. It replaces the platform accent ramp, so every alias that reads the ramp
 * (send button, links, focus rings, business state) follows: 500 in the light palette, 400 in the dark.
 * The dark palette darkens 800/900 (badge and tint fills under 400 text) and keeps 500 (the dark
 * info-button hover under its near-black label) light enough for WCAG AA.
 */
const ACCENT_RAMP: ThemeTokenOverrides = {
  '--dsw-static-deepseek-50': both('#EEF2FF'),
  '--dsw-static-deepseek-100': both('#E6ECFE'),
  '--dsw-static-deepseek-200': both('#C9D5FE'),
  '--dsw-static-deepseek-300': both('#A3B6FD'),
  '--dsw-static-deepseek-400': both('#5C7CFF'),
  '--dsw-static-deepseek-450': both('#4268FB'),
  '--dsw-static-deepseek-500': { light: '#2A55F9', dark: '#4F70FF' },
  '--dsw-static-deepseek-600': both('#1E44E0'),
  '--dsw-static-deepseek-800': { light: '#142C8F', dark: '#121A3E' },
  '--dsw-static-deepseek-900': { light: '#10215F', dark: '#0E1430' },
}

/**
 * Token layer applied over the active theme. Primary buttons take the accent instead of the
 * platform's ink, and the ink itself (`--dsw-alias-brand-primary`, read as a foreground by text and
 * controls) takes the brand's primary text grey. The light palette's accent alias is a literal color
 * rather than a ramp reference, so it is set here too. Dark values that the brand does not change
 * repeat the platform's own reference.
 */
export const MO_THEME_TOKENS: ThemeTokenOverrides = {
  ...ACCENT_RAMP,
  '--dsw-alias-brand-primary-new-colorprimary-new-color': { light: '#2A55F9', dark: 'var(--dsw-static-deepseek-450)' },
  '--dsw-alias-button-primary-fill': { light: '#2A55F9', dark: '#5C7CFF' },
  '--dsw-alias-button-primary-hover': { light: '#1E44E0', dark: '#7B95FF' },
  '--dsw-specific-sidebar-panel-active': { light: '#E6ECFE', dark: 'rgba(92, 124, 255, 0.18)' },
  '--dsw-specific-sidebar-panel-active-label': { light: '#2A55F9', dark: '#A9BAFF' },
  '--dsw-specific-sidebar-fill': { light: '#F5F6F8', dark: 'var(--dsw-static-neutral-bluish-900)' },
  '--dsw-alias-brand-primary': { light: '#343434', dark: 'var(--dsw-static-neutral-bluish-50)' },
  '--dsw-alias-brand-text': { light: '#343434', dark: 'var(--dsw-static-neutral-bluish-50)' },
  '--dsw-alias-label-primary': { light: '#343434', dark: 'var(--dsw-static-neutral-bluish-50)' },
  '--dsw-alias-label-secondary': { light: '#4D4D4D', dark: 'var(--dsw-static-neutral-bluish-300)' },
  '--dsw-alias-label-tertiary': { light: '#767676', dark: 'var(--dsw-static-neutral-bluish-400)' },
}
