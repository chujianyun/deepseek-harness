// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BOOT_BRAND_GLOBAL, BootPage } from '../src/boot-page.ts'

afterEach(() => { document.body.innerHTML = '' })

function mount() {
  const el = document.createElement('div')
  document.body.append(el)
  return { el, page: new BootPage(el) }
}

describe('BootPage', () => {
  it('draws the loading skeleton before any plugin state arrives', () => {
    const { el } = mount()
    expect(el.firstElementChild?.getAttribute('data-dsh-boot')).toBe('')
    expect(el.textContent).toContain('HARNESS')
    expect(el.textContent).toContain('Loading plugins…')
  })

  it('keeps loading while entries are active or loading', () => {
    const { el, page } = mount()
    page.setTotal(2)
    const spinner = el.querySelector<HTMLElement>('[data-dsh-boot-spinner]')
    expect(spinner?.style.getPropertyValue('--dsh-boot-arc')).toBe('72deg')
    page.setState('a', 'active')
    expect(spinner?.style.getPropertyValue('--dsh-boot-arc')).toBe('180deg')
    page.setState('b', 'loading')
    expect(el.querySelector('[data-dsh-boot-spinner]')).toBe(spinner)
    page.setState('b', 'active')
    expect(spinner?.style.getPropertyValue('--dsh-boot-arc')).toBe('288deg')
    expect(el.textContent).toContain('Loading plugins…')
    expect(el.textContent).not.toContain('Failed to load plugins')
  })

  it('lists failed entries', () => {
    const { el, page } = mount()
    page.setState('@deepseek-ai/dsh-client-ui-layout', 'failed')
    page.setState('ok', 'active')
    page.setState('@deepseek-ai/dsh-client-ui-tool', 'failed')
    expect(el.textContent).toContain('@deepseek-ai/dsh-client-ui-layout')
    expect(el.textContent).toContain('@deepseek-ai/dsh-client-ui-tool')
    expect(el.textContent).not.toContain('ok')
    expect(el.textContent).not.toContain('Loading plugins…')
  })

  it('shows the complete sweep report', () => {
    const { el, page } = mount()
    const report = 'web boot: 1 entry did not activate\nx: pending (waiting for service: y)'
    page.fail(report)
    page.setState('a', 'active')
    expect(el.textContent).toContain(report)
    expect(el.textContent).not.toContain('Loading plugins…')
  })

  it('detaches on disposal', () => {
    const { el, page } = mount()
    page.dispose()
    expect(el.childNodes).toHaveLength(0)
  })
})

describe('BootPage brand', () => {
  const BRAND = {
    mark: 'data:image/png;base64,iVBORw0KGgo=',
    name: 'MO WorkAI',
    hint: { en: 'Starting MO WorkAI…', zh: '正在启动 MO WorkAI…' },
  }

  afterEach(() => {
    Reflect.deleteProperty(globalThis, BOOT_BRAND_GLOBAL)
    document.documentElement.removeAttribute('lang')
    document.documentElement.removeAttribute('data-dsh-locale-explicit')
  })

  it('reads the global that deployment index injections set', () => {
    expect(BOOT_BRAND_GLOBAL).toBe('__DSH_BOOT_BRAND__')
  })

  it('shows the injected mark, name, and the hint for the document language', () => {
    Reflect.set(globalThis, BOOT_BRAND_GLOBAL, BRAND)
    document.documentElement.lang = 'zh-CN'
    document.documentElement.dataset.dshLocaleExplicit = ''
    const { el, page } = mount()
    expect(el.querySelector('[data-dsh-boot-mark]')?.getAttribute('src')).toBe(BRAND.mark)
    expect(el.querySelector('[data-dsh-boot-wordmark]')?.textContent).toBe('MO WorkAI')
    expect(el.querySelector('[data-dsh-boot-hint]')?.textContent).toBe('正在启动 MO WorkAI…')
    expect(el.textContent).not.toContain('HARNESS')
    page.setState('x', 'failed')
    expect(el.querySelector('[data-dsh-boot-mark]')).not.toBeNull()
  })

  it('falls back to English for an explicit language it has no hint for', () => {
    Reflect.set(globalThis, BOOT_BRAND_GLOBAL, BRAND)
    document.documentElement.lang = 'pt-BR'
    document.documentElement.dataset.dshLocaleExplicit = ''
    expect(mount().el.querySelector('[data-dsh-boot-hint]')?.textContent).toBe('Starting MO WorkAI…')
  })

  it('follows the browser languages when no explicit preference marked <html lang>', () => {
    Reflect.set(globalThis, BOOT_BRAND_GLOBAL, BRAND)
    document.documentElement.lang = 'en'
    const languages = vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['fr-FR', 'zh-CN'])
    expect(mount().el.querySelector('[data-dsh-boot-hint]')?.textContent).toBe('正在启动 MO WorkAI…')
    document.body.innerHTML = ''
    languages.mockReturnValue(['fr-FR'])
    expect(mount().el.querySelector('[data-dsh-boot-hint]')?.textContent).toBe('Starting MO WorkAI…')
    languages.mockRestore()
  })

  it('does not rebuild a brand that is already shown', () => {
    Reflect.set(globalThis, BOOT_BRAND_GLOBAL, BRAND)
    const { el, page } = mount()
    const heading = el.querySelector('[data-dsh-boot-mark]')
    page.applyBrand()
    expect(el.querySelector('[data-dsh-boot-mark]')).toBe(heading)
  })

  it('keeps the default page when the injected brand is malformed', () => {
    Reflect.set(globalThis, BOOT_BRAND_GLOBAL, { name: 42 })
    const { el } = mount()
    expect(el.textContent).toContain('HARNESS')
    expect(el.querySelector('[data-dsh-boot-mark]')).toBeNull()
  })
})

describe('BootPage brand applied after construction', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, BOOT_BRAND_GLOBAL)
    document.documentElement.removeAttribute('lang')
    document.documentElement.removeAttribute('data-dsh-locale-explicit')
  })

  it('swaps in a brand and language that index rows set after the page was drawn', () => {
    const { el, page } = mount()
    expect(el.textContent).toContain('HARNESS')
    Reflect.set(globalThis, BOOT_BRAND_GLOBAL, { mark: 'data:image/png;base64,AA==', name: 'MO WorkAI', hint: { en: 'Starting', zh: '正在启动' } })
    document.documentElement.lang = 'zh-CN'
    document.documentElement.dataset.dshLocaleExplicit = ''
    page.applyBrand()
    expect(el.querySelector('[data-dsh-boot-wordmark]')?.textContent).toBe('MO WorkAI')
    expect(el.querySelector('[data-dsh-boot-hint]')?.textContent).toBe('正在启动')
    expect(el.textContent).not.toContain('HARNESS')
    page.setState('x', 'failed')
    expect(el.querySelector('[data-dsh-boot-mark]')).not.toBeNull()
  })

  it('leaves the default page when no brand arrived', () => {
    const { el, page } = mount()
    page.applyBrand()
    expect(el.textContent).toContain('HARNESS')
    expect(el.textContent).toContain('Loading plugins…')
  })
})
