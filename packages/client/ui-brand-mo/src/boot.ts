/**
 * Index injection rows for the interval before the client plugins load: the boot page brand and
 * a stylesheet that paints the boot page navy and seeds the MO token values into the palette.
 */
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import { MO_THEME_TOKENS } from './client/tokens.ts'
import { MO_MARK } from './mark.ts'

/** Global the `dsh-client-web` boot page reads its brand from (`BOOT_BRAND_GLOBAL` there). */
const BOOT_BRAND_GLOBAL = '__DSH_BOOT_BRAND__'

/** Boot page on the navy brand ground: white name, muted hint and ring, lifted-blue progress arc. */
const BOOT_STYLE = '[data-dsh-boot]{background:#0E1430;color-scheme:dark;'
  + '--dsw-alias-label-primary:#FFFFFF;--dsw-alias-label-tertiary:rgba(255, 255, 255, 0.6);'
  + '--dsw-alias-border-l2:rgba(255, 255, 255, 0.16);--dsw-alias-brand-primary:#5C7CFF}'

/** One palette's token declarations. */
function declarations(mode: 'light' | 'dark'): string {
  return Object.entries(MO_THEME_TOKENS).map(([name, modes]) => `${name}:${modes[mode]}`).join(';')
}

/**
 * The rows, built once: `html body` outranks the platform palette's `body` rules, so the first
 * paint uses the brand values that the client token layer later sets inline.
 */
const ROWS: readonly IndexInjection[] = [
  {
    kind: 'global',
    name: BOOT_BRAND_GLOBAL,
    value: { mark: MO_MARK, name: 'MO WorkAI', hint: { en: 'Starting MO WorkAI…', zh: '正在启动 MO WorkAI…' } },
  },
  {
    kind: 'style',
    text: `${BOOT_STYLE}html body{${declarations('light')}}html body[data-ds-dark-theme]{${declarations('dark')}}`,
  },
]

/**
 * Rows for one index render.
 * @returns the boot brand global and the boot stylesheet.
 */
export function moBootInjections(): IndexInjection[] {
  return [...ROWS]
}
