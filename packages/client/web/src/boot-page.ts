/**
 * Framework-free boot page and failure report. It remains available when a
 * client plugin fails because React arrives only with the UI renderer.
 * @module @deepseek-ai/dsh-client-web/src/boot-page
 */
import type { LoaderEntryState } from './loader-status.ts'
import css from './boot-page.module.css'

/** Global a deployment's index injection may set to brand the boot page. */
export const BOOT_BRAND_GLOBAL = '__DSH_BOOT_BRAND__'

/** Boot page brand: a mark image, a product name, and the loading hint by language tag. */
export interface BootBrand {
  /** Image URL or data URI drawn above the name. */
  mark: string
  /** Product name in place of the default wordmark. */
  name: string
  /** Loading hint keyed by language tag (`zh-CN`) or primary subtag (`zh`); `en` is the fallback. */
  hint: Readonly<Record<string, string>>
}

/** Read the injected brand; an absent or malformed value keeps the default page. */
function injectedBrand(): BootBrand | undefined {
  const value: unknown = Reflect.get(globalThis, BOOT_BRAND_GLOBAL)
  if (typeof value !== 'object' || value === null) return undefined
  const { mark, name, hint } = value as Partial<Record<keyof BootBrand, unknown>>
  if (typeof mark !== 'string' || typeof name !== 'string' || typeof hint !== 'object' || hint === null) return undefined
  const hints = Object.entries(hint).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  return { mark, name, hint: Object.fromEntries(hints) }
}

/**
 * Pick the hint for the user's language: `<html lang>` when the locale host marked it as an explicit
 * preference (`data-dsh-locale-explicit`), otherwise the browser languages in order, as the client
 * locale plugin resolves them; each tag by full value, then primary subtag; English last.
 */
function brandHint(brand: BootBrand): string {
  const root = document.documentElement
  const languages = 'dshLocaleExplicit' in root.dataset ? [root.lang] : navigator.languages
  for (const language of languages) {
    const hint = brand.hint[language] ?? brand.hint[language.split('-')[0] ?? '']
    if (hint !== undefined) return hint
  }
  return brand.hint.en ?? DEFAULT_HINT
}

const DEFAULT_WORDMARK = 'HARNESS'
const DEFAULT_HINT = 'Loading plugins…'

/** Create a div with one module class and optional text. */
function div(className: string | undefined, text?: string): HTMLDivElement {
  const el = document.createElement('div')
  el.className = className ?? ''
  if (text !== undefined) el.textContent = text
  return el
}

/** Stack the brand mark above the name. */
function brandHeading(src: string, name: HTMLElement): HTMLElement {
  const mark = document.createElement('img')
  mark.className = css.mark ?? ''
  mark.src = src
  mark.alt = ''
  mark.dataset.dshBootMark = ''
  const heading = div(css.heading)
  heading.append(mark, name)
  return heading
}

/** Kernel-owned page mounted below the application's root element. */
export class BootPage {
  private readonly root: HTMLDivElement
  private readonly card: HTMLDivElement
  private wordmark: HTMLElement
  private applied: string | undefined
  private readonly spinner: HTMLDivElement
  private readonly hint: HTMLDivElement
  private readonly states = new Map<string, LoaderEntryState>()
  private readonly active = new Set<string>()
  private total = 0
  private failure: string | undefined

  /**
   * Build and attach the boot page.
   * @param container - Application mount point.
   */
  constructor(container: HTMLElement) {
    this.root = div(css.boot)
    this.root.dataset.dshBoot = ''
    this.card = div(css.card)
    this.wordmark = div(css.wordmark, DEFAULT_WORDMARK)
    this.wordmark.dataset.dshBootWordmark = ''
    this.spinner = div(css.spinner)
    this.spinner.dataset.dshBootSpinner = ''
    this.hint = div(css.hint, DEFAULT_HINT)
    this.hint.dataset.dshBootHint = ''
    this.card.append(this.wordmark, this.spinner, this.hint)
    this.root.append(this.card)
    container.append(this.root)
    this.updateProgress()
    this.applyBrand()
  }

  /**
   * Show the deployment brand from {@link BOOT_BRAND_GLOBAL} and pick its hint for `<html lang>`.
   * Served pages carry the rows before the page is drawn; Desktop applies them afterwards, so the
   * boot entry calls this again once the readiness gate resolves. Without a brand nothing changes.
   */
  applyBrand(): void {
    const brand = injectedBrand()
    if (brand === undefined) return
    const key = JSON.stringify(brand)
    if (key === this.applied) return
    this.applied = key
    const name = div(css.wordmark, brand.name)
    name.dataset.dshBootWordmark = ''
    const heading = brandHeading(brand.mark, name)
    this.wordmark.replaceWith(heading)
    this.wordmark = heading
    this.hint.textContent = brandHint(brand)
  }

  /**
   * Set the number of loader entries represented by the progress arc.
   * @param total - Complete boot roster size.
   */
  setTotal(total: number): void {
    this.total = total
    this.updateProgress()
  }

  /**
   * Project one loader entry's fiber state.
   * @param id - Loader entry name.
   * @param state - Projected fiber state.
   */
  setState(id: string, state: LoaderEntryState): void {
    this.states.set(id, state)
    if (state === 'active') this.active.add(id)
    this.updateProgress()
    this.render()
  }

  /**
   * Display the boot failure report.
   * @param message - Failure report text.
   */
  fail(message: string): void {
    this.failure = message
    this.render()
  }

  /** Detach the page before or after the UI renderer takes the mount point. */
  dispose(): void {
    this.root.remove()
  }

  /** Redraw the state-dependent content below the wordmark. */
  private render(): void {
    const failed = [...this.states].filter(([, state]) => state === 'failed').map(([id]) => id)
    if (this.failure === undefined && failed.length === 0) {
      if (this.spinner.parentElement !== this.card) {
        this.card.replaceChildren(this.wordmark, this.spinner, this.hint)
      }
      return
    }
    const report = div(css.failed)
    report.append(div(css.failedTitle, 'Failed to load plugins'))
    for (const id of failed) report.append(div(css.failedItem, id))
    if (this.failure !== undefined) report.append(div(css.failedItem, this.failure))
    this.card.replaceChildren(this.wordmark, report)
  }

  /** Grow the rotating arc monotonically as loader entries activate. */
  private updateProgress(): void {
    const ratio = this.total === 0 ? 0 : Math.min(this.active.size / this.total, 1)
    this.spinner.style.setProperty('--dsh-boot-arc', `${String(Math.round(72 + ratio * 216))}deg`)
  }
}
